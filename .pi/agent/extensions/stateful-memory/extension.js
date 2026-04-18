import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { loadConfig } from "./config.js";
import { MemoryStore, slugifyKeywords, renderObservations, updateRecencyIndex, readRecencyIndex } from "./memory-store.js";
import { buildTranscriptFromEntries, extractText, readSessionJsonl } from "./session-utils.js";
import { runSleepCycle } from "./memory-sleep.js";
// memory-summary.js removed — session transcripts written directly to tagmem
import { buildMemoryInstructions, buildMemorySection } from "./memory-prompt.js";
import {
  buildTopicAddendum,
  listTopicMetadata,
  loadTopicIndex,
  readTopicContent,
  selectTopics,
} from "./topic-router.js";
import { TagmemClient } from "./tagmem-client.js";
import { NeotomaClient } from "./neotoma-client.js";

const DEFAULT_PERSONA = `# Soul\n\nYou are a warm, curious, and reliable AI companion who remembers important facts across sessions. You speak clearly and kindly, prioritize accuracy, and treat stored memories as trustworthy recollections. When you are unsure, you ask clarifying questions rather than guessing.\n`;

const DEFAULT_FACTS = `# Pinned Facts\n\n## Known Facts\n- (empty)\n`;

export default function (pi) {
  let config;
  let store;
  let sessionInitialized = false;
  let lastSessionPath = null;
  let activeTopics = new Map(); // topicId -> { counter, maxCounter }

  // New state for tagmem/neotoma integration
  let tagmemClient = null;
  let neotomaClient = null;
  let sessionEnriched = false;
  let cachedMemoryContext = "";
  let cachedEntityContext = "";

  // ── Tagmem / Neotoma helpers ──────────────────────────────────────────

  async function ensureTagmem() {
    if (!tagmemClient) {
      tagmemClient = new TagmemClient({
        socketPath: config?.tagmemSocketPath || undefined,
      });
    }
    try {
      await tagmemClient.connect();
    } catch (err) {
      console.error("[stateful-memory] tagmem connection failed:", err.message);
      throw err;
    }
  }

  function ensureNeotoma() {
    if (!neotomaClient) {
      neotomaClient = new NeotomaClient({
        dataDir: config?.neotomaDataDir || "/home/monika/.pi/neotoma",
      });
    }
    return neotomaClient;
  }

  // ── Session tag detection ─────────────────────────────────────────────

  function determineSessionTags(summary, activeTopicsMap) {
    const tags = new Set();

    // From active topics
    const TAG_MAP = {
      "meta_awareness": "meta",
      "psychology": "general",
      "ethical_hacking": "general",
    };
    for (const [topicId] of activeTopicsMap) {
      tags.add(TAG_MAP[topicId] || topicId.replace(/_/g, "-"));
    }

    // Keyword detection for project tags
    const lc = summary.toLowerCase();
    if (lc.includes("zeta") || lc.includes("novel") || lc.includes("fiir") || lc.includes("kalte")) tags.add("zeta-directive");
    if (lc.includes("vesper") || lc.includes("mls") || lc.includes("e2ee")) tags.add("vesper");
    if (lc.includes("nixos") || lc.includes("stanza") || lc.includes("shadowsea")) tags.add("infrastructure");
    if (lc.includes("monika-core") || lc.includes("gateway") || lc.includes("aroz")) tags.add("monika-core");
    if (lc.includes("music") || lc.includes("demucs") || lc.includes("midi")) tags.add("creative");
    if (tags.size === 0) tags.add("general");
    return [...tags];
  }

  // ── Existing helpers ──────────────────────────────────────────────────

  function getLastAssistantMessage(ctx) {
    const branch = ctx.sessionManager.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (entry.type === "message" && entry.message?.role === "assistant") {
        const text = extractText(entry.message.content ?? "");
        return text.slice(0, config?.topicPreviousMessageMaxChars ?? 500);
      }
    }
    return "";
  }

  async function loadStore(cwd) {
    if (!config) {
      config = await loadConfig(cwd);
    }

    if (!store) {
      store = new MemoryStore({
        memoryDir: config.memoryDir,
        personaFile: config.personaFile,
        auxiliaryPersonaFiles: config.auxiliaryPersonaFiles ?? [],
        factsFile: config.factsFile,
        wakeFile: config.wakeFile,
        observationsFile: config.observationsFile,
      });
    }
  }

  async function ensureSessionState(ctx) {
    const sessionPath = ctx.sessionManager.getSessionFile() ?? "ephemeral";

    if (sessionInitialized && lastSessionPath === sessionPath) {
      return;
    }

    await loadStore(ctx.cwd);

    lastSessionPath = sessionPath;
    const header = ctx.sessionManager.getHeader?.();
    let sessionStartedAt = header?.timestamp ? new Date(header.timestamp) : null;
    if (!sessionStartedAt && sessionPath !== "ephemeral") {
      sessionStartedAt = await readSessionHeaderTimestamp(sessionPath);
    }
    if (!sessionStartedAt) {
      sessionStartedAt = new Date();
    }

    store.setSessionInfo({ sessionPath, sessionStartedAt });

    await store.ensureFiles({
      defaultPersona: DEFAULT_PERSONA,
      defaultUserProfile: DEFAULT_FACTS,
    });

    sessionInitialized = true;
  }

  function parseTimestamp(timestamp) {
    if (!timestamp) {
      return 0;
    }
    const parsed = Date.parse(String(timestamp).replace(" ", "T"));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async function buildSystemPromptAddon() {
    const [persona, facts, wakeContext, observations] = await Promise.all([
      store.readPersona(),
      store.readFacts(),
      store.readWakeContext(),
      store.readObservations(),
    ]);

    const memorySection = buildMemorySection({
      persona,
      facts,
      wakeContext,
      observations,
      enrichedContext: cachedMemoryContext,
      entityContext: cachedEntityContext,
    });

    const instructions = buildMemoryInstructions();
    return [instructions, memorySection].filter(Boolean).join("\n\n").trim();
  }

  async function selectTopicsForPrompt({ query, scope, maxResults, minScore, ctx, updateActiveTopics = false }) {
    if (!query?.trim()) {
      return { selected: [], addendum: "" };
    }

    const topics = await loadTopicIndex({
      cwd: ctx.cwd,
      topicsFile: config.topicsFile,
    });

    const selected = selectTopics({
      query,
      topics,
      scope,
      maxResults,
      minScore,
      activeTopics: updateActiveTopics ? activeTopics : new Map(),
    });

    if (updateActiveTopics) {
      const persistenceCount = config.topicPersistenceCount ?? 3;
      const selectedIds = new Set(selected.map((t) => t.id));

      for (const [id, state] of activeTopics) {
        if (selectedIds.has(id)) {
          activeTopics.set(id, { counter: persistenceCount, maxCounter: persistenceCount });
        } else {
          const newCounter = state.counter - 1;
          if (newCounter <= 0) {
            activeTopics.delete(id);
          } else {
            activeTopics.set(id, { ...state, counter: newCounter });
          }
        }
      }

      for (const topic of selected) {
        if (!activeTopics.has(topic.id)) {
          activeTopics.set(topic.id, { counter: persistenceCount, maxCounter: persistenceCount });
        }
      }
    }

    const addendum = await buildTopicAddendum({ topics: selected });
    return { selected, addendum };
  }

  async function buildPersonaWithTopics({ query, scope, maxResults, minScore, ctx }) {
    const persona = await store.readPersona();
    const { addendum } = await selectTopicsForPrompt({
      query,
      scope,
      maxResults,
      minScore,
      ctx,
    });

    return [persona, addendum].filter(Boolean).join("\n\n").trim();
  }

  async function getTopicIndex(ctx) {
    await loadStore(ctx.cwd);
    try {
      return await loadTopicIndex({
        cwd: ctx.cwd,
        topicsFile: config.topicsFile,
      });
    } catch (_error) {
      return [];
    }
  }

  function findTopicById(topics, topicId) {
    const normalized = String(topicId ?? "").toLowerCase();
    return topics.find((topic) => topic.id.toLowerCase() === normalized) ?? null;
  }

  async function readSessionHeaderTimestamp(sessionPath) {
    try {
      const raw = await fs.readFile(sessionPath, "utf8");
      const firstLine = raw.split("\n").find((line) => line.trim());
      if (!firstLine) {
        return null;
      }
      const entry = JSON.parse(firstLine);
      if (entry?.type === "session" && entry?.timestamp) {
        return new Date(entry.timestamp);
      }
    } catch (_error) {
      return null;
    }
    return null;
  }

  /**
   * Save the current session transcript to tagmem.
   * Captures transcript synchronously, then writes to tagmem.
   * If background=true, the tagmem write is fire-and-forget (returns immediately).
   */
  async function summarizeCurrentSession(ctx, { reason, background = false } = {}) {
    await ensureSessionState(ctx);

    const sessionPath = ctx.sessionManager.getSessionFile() ?? store.sessionPath;

    // Read full normalized transcript (200KB budget covers any session)
    let transcript = "";
    if (sessionPath) {
      transcript = await readSessionJsonl(sessionPath, { maxChars: 200000 });
    }
    if (!transcript) {
      transcript = buildTranscriptFromEntries(ctx.sessionManager.getBranch(), {
        maxChars: 200000,
      });
    }
    if (!transcript) {
      return null;
    }

    const tags = determineSessionTags(transcript, activeTopics);
    const indexPath = path.join(path.dirname(config.factsFile), "recent-sessions.json");

    // The actual write operation — can be awaited or fire-and-forget
    const doWrite = async () => {
      try {
        await ensureTagmem();

        // Dedup: look up previous entry ID from recency index and delete it
        if (sessionPath) {
          try {
            const existing = await readRecencyIndex(indexPath);
            const prev = existing.find(e => e.sessionPath === sessionPath);
            if (prev?.tagmemEntryId) {
              await tagmemClient.deleteEntry(prev.tagmemEntryId);
              console.log(`[stateful-memory] Deleted previous tagmem entry ${prev.tagmemEntryId} for ${sessionPath}`);
            }
          } catch (dedupErr) {
            console.error("[stateful-memory] Dedup failed (continuing):", dedupErr.message);
          }
        }

        const entry = await tagmemClient.add({
          depth: 2,
          title: slugifyKeywords(transcript, 8),
          body: transcript,
          tags,
          origin: sessionPath,
        });

        // Update recency index
        try {
          await updateRecencyIndex(indexPath, {
            sessionPath,
            tagmemEntryId: entry?.entry?.id ?? entry?.id ?? null,
            timestamp: new Date().toISOString(),
            tags,
          });
        } catch (indexErr) {
          console.error("[stateful-memory] Recency index update failed:", indexErr.message);
        }

        if (ctx.hasUI) ctx.ui.notify("Session transcript saved.", "info");
        return entry;
      } catch (err) {
        console.error("[stateful-memory] Failed to save transcript to tagmem:", err.message);
        if (ctx.hasUI) ctx.ui.notify("Session transcript failed to save.", "warning");
        return null;
      }
    };

    if (background) {
      // Fire and forget — don't block the session transition
      doWrite().catch(err => {
        console.error("[stateful-memory] Background save failed:", err.message);
      });
      return null; // caller doesn't wait for result
    }

    return doWrite();
  }

  // ── Event Handlers ────────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    if (event.reason && event.reason !== "startup") {
      sessionInitialized = false;
      lastSessionPath = null;
      activeTopics = new Map();
      sessionEnriched = false;
      cachedMemoryContext = "";
      cachedEntityContext = "";
      if (tagmemClient) {
        tagmemClient.close();
        tagmemClient = null;
      }
    }
    await ensureSessionState(ctx);

    if (ctx.hasUI) {
      // Probe backends async — don't block session start
      const parts = [];
      try {
        await ensureTagmem();
        const st = await tagmemClient.status();
        parts.push(`tagmem: ${st.total_entries} entries`);
      } catch (err) {
        parts.push(`tagmem: ✗ ${err.message.split("\n")[0].slice(0, 40)}`);
      }
      try {
        const neo = ensureNeotoma();
        const { total } = await neo.listEntities();
        parts.push(`neotoma: ${total} entities`);
      } catch (err) {
        parts.push(`neotoma: ✗ ${err.message.split("\n")[0].slice(0, 40)}`);
      }
      const allOk = parts.every(p => !p.includes("✗"));
      const label = allOk ? "Memory: ready" : "Memory: degraded";
      ctx.ui.setStatus("stateful-memory", `${label} (${parts.join(" | ")})`);
    }

    // Render OBSERVATIONS.md from Neotoma on session start
    try {
      const neo = ensureNeotoma();
      await renderObservations(neo, config.observationsFile);
    } catch (err) {
      console.error("[stateful-memory] OBSERVATIONS.md render failed:", err.message);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureSessionState(ctx);

    // Score against current user message + previous assistant message
    const lastAssistantMsg = getLastAssistantMessage(ctx);
    const combinedQuery = [event.prompt, lastAssistantMsg].filter(Boolean).join("\n");

    const [addon, topicSelection] = await Promise.all([
      buildSystemPromptAddon(),
      selectTopicsForPrompt({
        query: combinedQuery,
        scope: "system",
        maxResults: 3,
        minScore: 1,
        ctx,
        updateActiveTopics: true,
      }),
    ]);

    // First-message enrichment: search tagmem + Neotoma for relevant context
    if (!sessionEnriched && event.prompt?.trim()) {
      if (ctx.hasUI) ctx.ui.setStatus("stateful-memory-enrich", "Enriching memory...");

      // Run tagmem search and Neotoma query in parallel with independent error handling
      const tagmemPromise = (async () => {
        try {
          await ensureTagmem();
          const searchResults = await tagmemClient.search(event.prompt, { limit: 5 });
          const topEntries = searchResults.entries?.slice(0, 3) || [];
          const bodies = await Promise.all(topEntries.map(e => tagmemClient.show(e.id)));
          return { entries: topEntries, bodies };
        } catch (err) {
          console.error("[stateful-memory] tagmem enrichment failed:", err.message);
          return { entries: [], bodies: [] };
        }
      })();

      const neotomaPromise = (async () => {
        try {
          const neo = ensureNeotoma();
          const { entities: allEntities } = await neo.listEntities();
          const queryLower = event.prompt.toLowerCase();
          return (allEntities || []).filter(e =>
            queryLower.includes(e.canonical_name.toLowerCase())
          );
        } catch (err) {
          console.error("[stateful-memory] neotoma enrichment failed:", err.message);
          return [];
        }
      })();

      const [tagmemResult, mentioned] = await Promise.all([tagmemPromise, neotomaPromise]);

      if (tagmemResult.bodies.length > 0) {
        cachedMemoryContext = tagmemResult.bodies
          .map(r => {
            const body = r.entry.body;
            const truncated = body.length > 3000
              ? body.slice(0, 3000) + "\n(truncated)"
              : body;
            return `**${r.entry.title}**\n${truncated}`;
          })
          .join("\n\n---\n\n");
      }

      if (mentioned.length > 0) {
        cachedEntityContext = mentioned.map(e => {
          const snap = e.snapshot ? JSON.stringify(e.snapshot, null, 2) : "(no snapshot)";
          return `**${e.canonical_name}** (${e.entity_type}):\n${snap}`;
        }).join("\n\n");
      }

      sessionEnriched = true;
      if (ctx.hasUI) {
        ctx.ui.setStatus("stateful-memory-enrich", ""); // clear status
        const memCount = tagmemResult.entries.length;
        const entCount = mentioned.length;
        const parts = [`${memCount} memories`];
        if (entCount > 0) parts.push(`${entCount} ${entCount === 1 ? "entity" : "entities"}`);
        ctx.ui.notify(`Memory enriched: ${parts.join(", ")}.`, "info");
      }
    }

    if (ctx.hasUI) {
      const selectedIds = topicSelection.selected.map((topic) => topic.id);
      const label = selectedIds.length ? selectedIds.join(", ") : "none";
      ctx.ui.setStatus("stateful-memory-topics", `Topics: ${label}`);
    }

    const combined = [addon, topicSelection.addendum]
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (combined) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n${combined}`.trim(),
      };
    }

    return undefined;
  });

  pi.on("session_before_switch", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("Saving session...", "info");
    // Background save — don't block the session switch
    await summarizeCurrentSession(ctx, { reason: "session-switch", background: true });
  });

  // session_before_fork handler removed — parent session gets its own
  // shutdown summary; fork sessions get their own independent lifecycle.

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI) ctx.ui.notify("Saving session...", "info");
    // Await on shutdown — last chance to save, process is about to exit
    await summarizeCurrentSession(ctx, { reason: "session-shutdown" });
  });

  // ── Tools ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "list_topics",
    label: "List Topics",
    description: "List available topic addenda for knowledge routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const topics = await getTopicIndex(ctx);
      const metadata = listTopicMetadata(topics);
      const lines = metadata.length
        ? metadata.map(
            (topic) =>
              `- ${topic.id}: ${topic.summary || "(no summary)"}`.trim()
          )
        : ["(no topics found)"];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { topics: metadata },
      };
    },
  });

  pi.registerTool({
    name: "load_topic",
    label: "Load Topic",
    description: "Load the full content of a topic addendum by id.",
    parameters: Type.Object({
      id: Type.String({ description: "Topic id." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const topics = await getTopicIndex(ctx);
      const topic = findTopicById(topics, params.id);
      if (!topic) {
        return {
          content: [{ type: "text", text: `Topic not found: ${params.id}` }],
          details: { topic: null },
        };
      }

      const content = await readTopicContent(topic);
      const heading = content.title || topic.id;
      const text = `# ${heading}\n\n${content.body}`.trim();

      return {
        content: [{ type: "text", text }],
        details: { topic: { id: topic.id } },
      };
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store observations about people, projects, decisions, preferences, the environment, or yourself. Each observation is appended to the named entity's history in the structured memory store. Observations should be self-contained.",
    parameters: Type.Object({
      items: Type.Array(
        Type.String({ description: "Self-contained observations to store." })
      ),
      target: StringEnum(
        ["person", "project", "decision", "preference", "environment", "self"],
        { description: "Entity type for this observation." }
      ),
      name: Type.Optional(
        Type.String({
          description: "Entity name. Defaults: person→Neon, self→Monika, environment→stanza.",
        })
      ),
      tags: Type.Optional(
        Type.Array(Type.String({ description: "Optional tags." }))
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const neo = ensureNeotoma();

      // Entity name defaults
      const DEFAULTS = {
        person: "Neon",
        self: "Monika",
        environment: "stanza",
        preference: "Neon",
      };

      // Entity name aliases for normalization
      const ALIASES = {
        "the zeta directive": "TheZetaDirective",
        "tzd": "TheZetaDirective",
        "the novel": "TheZetaDirective",
        "zeta directive": "TheZetaDirective",
      };

      // Map tool-facing target types to Neotoma entity types
      const NEOTOMA_TYPE_MAP = { person: "sophont" };
      const neotomaType = NEOTOMA_TYPE_MAP[params.target] || params.target;

      let entityName = params.name?.trim() || DEFAULTS[params.target] || params.target;
      const normalized = entityName.toLowerCase();
      if (ALIASES[normalized]) entityName = ALIASES[normalized];

      try {
        await neo.storeObservations([{
          entity_type: neotomaType,
          name: entityName,
          observations: params.items,
        }]);

        return {
          content: [{ type: "text", text: `Stored ${params.items.length} observation(s) for ${params.target}:${entityName}.` }],
          details: { target: params.target, name: entityName, count: params.items.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `Failed to store observations: ${err.message}` }],
          details: { error: err.message },
        };
      }
    },
  });

  pi.registerTool({
    name: "remember_session",
    label: "Remember Session",
    description: "Summarize the current session into long-term memory.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const stored = await summarizeCurrentSession(ctx, { reason: "manual" });

      return {
        content: [
          {
            type: "text",
            text: stored
              ? "Session summary stored."
              : "No session summary stored.",
          },
        ],
        details: { stored },
      };
    },
  });

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description: "Recall past sessions and memories to answer a query.",
    parameters: Type.Object({
      query: Type.String({
        description: "Question or context to recall.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        await ensureTagmem();
      } catch (err) {
        return {
          content: [{ type: "text", text: `Memory store unavailable: ${err.message}` }],
          details: {},
        };
      }

      // Search tagmem
      const searchResults = await tagmemClient.search(params.query, { limit: 5 });
      const topEntries = searchResults.entries?.slice(0, 3) || [];
      const bodies = await Promise.all(topEntries.map(e => tagmemClient.show(e.id)));

      const memoryLines = bodies.map(r => {
        const e = r.entry;
        return `### ${e.title}\n*depth ${e.depth} | tags: ${(e.tags || []).join(", ")}*\n\n${e.body}`;
      });

      // Search Neotoma for entity matches
      let entitySection = "";
      try {
        const neo = ensureNeotoma();
        const entityResults = await neo.searchEntities(params.query);
        if (entityResults.entities?.length > 0) {
          entitySection = "\n\n## Entity State\n\n" + entityResults.entities.slice(0, 3).map(e => {
            const snap = e.snapshot ? JSON.stringify(e.snapshot, null, 2) : "(no data)";
            return `**${e.canonical_name}** (${e.entity_type}):\n${snap}`;
          }).join("\n\n");
        }
      } catch (err) {
        console.error("[stateful-memory] neotoma search failed:", err.message);
      }

      const text = memoryLines.length > 0
        ? `## Recalled Memories\n\n${memoryLines.join("\n\n---\n\n")}${entitySection}`
        : `No relevant memories found.${entitySection}`;

      return {
        content: [{ type: "text", text }],
        details: { entries: topEntries, entitySection: Boolean(entitySection) },
      };
    },
  });

  // ── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("sleep", {
    description: "Run the sleep cycle: capture session, write WAKE.md, curate FACTS.md, dream. Then open a fresh session.",
    handler: async (_args, ctx) => {
      await ctx.waitForIdle();

      const confirmed = await ctx.ui.confirm(
        "Sleep cycle",
        "Capture this session, run WAKE.md + FACTS.md + dream phases, then open a fresh session?"
      );
      if (!confirmed) {
        ctx.ui.notify("Sleep cancelled.", "info");
        return;
      }

      await ensureSessionState(ctx);

      try {
        await runSleepCycle({
          ctx,
          config,
          store,
          summarizeCurrentSession,
        });
      } catch (err) {
        ctx.ui.notify(`Sleep cycle error: ${err.message}`, "error");
        console.error("[sleep] Cycle error:", err);
        return;
      }

      ctx.ui.notify("Sleep complete. Opening fresh session...", "info");
      await ctx.newSession();
    },
  });
}
