import { promises as fs } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";

import { loadConfig, resolvePath } from "./config.js";
import { MemoryStore, slugifyKeywords, slugifyTopic } from "./memory-store.js";
import { buildTranscriptFromEntries, readSessionJsonl } from "./session-utils.js";
import { summarizeSessionWithModel } from "./memory-summary.js";
import { planRecallWithModel, recallWithModel } from "./memory-recall.js";
import { scoreEntry, tokenize } from "./memory-retriever.js";
import { buildMemoryInstructions, buildMemorySection } from "./memory-prompt.js";
import {
  buildTopicAddendum,
  listTopicMetadata,
  loadTopicIndex,
  readTopicContent,
  selectTopics,
} from "./topic-router.js";

const DEFAULT_PERSONA = `# Soul\n\nYou are a warm, curious, and reliable AI companion who remembers important facts across sessions. You speak clearly and kindly, prioritize accuracy, and treat stored memories as trustworthy recollections. When you are unsure, you ask clarifying questions rather than guessing.\n`;

const DEFAULT_USER_PROFILE = `# User Profile\n\n## Known Facts\n- (empty)\n`;

const STATE_ENTRY = "stateful-memory";

export default function (pi) {
  let config;
  let store;
  let topicLocked = false;
  let sessionInitialized = false;
  let lastSessionPath = null;
  let pendingResumeSessionPath = null;
  let pendingSessionInit = false;

  async function loadStore(cwd) {
    if (!config) {
      config = await loadConfig(cwd);
    }

    if (!store) {
      const memoryDir = resolvePath(cwd, config.memoryDir);
      store = new MemoryStore({
        memoryDir,
        personaFile: resolvePath(cwd, config.personaFile),
        auxiliaryPersonaFiles: (config.auxiliaryPersonaFiles ?? []).map((f) =>
          resolvePath(cwd, f)
        ),
        userFile: resolvePath(cwd, config.userFile),
      });
    }
  }

  function getLatestState(ctx) {
    let latest;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
        latest = entry.data;
      }
    }
    return latest;
  }

  async function ensureSessionState(ctx) {
    let sessionPath = ctx.sessionManager.getSessionFile() ?? "ephemeral";
    if (
      pendingResumeSessionPath &&
      (sessionPath === "ephemeral" || !(await sessionFileExists(sessionPath)))
    ) {
      sessionPath = pendingResumeSessionPath;
    }

    if (sessionInitialized && lastSessionPath === sessionPath && !pendingSessionInit) {
      return;
    }

    await loadStore(ctx.cwd);

    lastSessionPath = sessionPath;
    pendingResumeSessionPath = null;
    const header = ctx.sessionManager.getHeader?.();
    let sessionStartedAt = header?.timestamp ? new Date(header.timestamp) : null;
    if (!sessionStartedAt && sessionPath !== "ephemeral") {
      sessionStartedAt = await readSessionHeaderTimestamp(sessionPath);
    }
    if (!sessionStartedAt) {
      sessionStartedAt = new Date();
    }

    store.setSessionInfo({ sessionPath, sessionStartedAt });

    topicLocked = false;
    const existingState = getLatestState(ctx);
    if (existingState?.memoryFile) {
      store.setMemoryFile(existingState.memoryFile);
      topicLocked = existingState.topicLocked ?? false;
    } else {
      if (sessionPath !== "ephemeral" && !(await sessionFileExists(sessionPath))) {
        pendingSessionInit = true;
        sessionInitialized = true;
        return;
      }
      const recoveredFile = await findMemoryFileBySessionPath(sessionPath);
      if (recoveredFile) {
        store.setMemoryFile(recoveredFile);
        topicLocked = true;
        pi.appendEntry(STATE_ENTRY, {
          memoryFile: recoveredFile,
          topicLocked: true,
        });
      } else {
        const fileName = store.getSessionFileName("untitled");
        store.setMemoryFile(fileName);
        pi.appendEntry(STATE_ENTRY, { memoryFile: fileName, topicLocked: false });
      }
    }

    await store.ensureFiles({
      defaultPersona: DEFAULT_PERSONA,
      defaultUserProfile: DEFAULT_USER_PROFILE,
    });

    pendingSessionInit = false;
    sessionInitialized = true;
  }

  function hasActiveMemoryFile() {
    return Boolean(store?.memoryFile);
  }

  async function findMemoryFileBySessionPath(sessionPath) {
    if (!sessionPath) {
      return null;
    }
    const files = await store.listMemoryFiles();
    for (const fileName of files) {
      const raw = await store.readMemoryFile(fileName);
      const sessionLine = raw
        .split("\n")
        .find((line) => line.trim().startsWith("Session: "));
      if (!sessionLine) {
        continue;
      }
      const recorded = sessionLine.replace("Session:", "").trim();
      if (recorded === sessionPath) {
        return fileName;
      }
    }
    return null;
  }

  function parseTimestamp(timestamp) {
    if (!timestamp) {
      return 0;
    }
    const parsed = Date.parse(String(timestamp).replace(" ", "T"));
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  async function buildSystemPromptAddon() {
    const [persona, userProfile, allEntries] = await Promise.all([
      store.readPersona(),
      store.readUserProfile(),
      store.readAllMemoryEntries(),
    ]);

    const sorted = [...allEntries].sort(
      (a, b) => parseTimestamp(b.timestamp) - parseTimestamp(a.timestamp)
    );
    const recentMemories = sorted.slice(0, 5);
    const explicitMemories = sorted.filter((entry) =>
      entry.tags.includes("explicit")
    );
    const summaryMemories = sorted.filter((entry) =>
      entry.tags.includes("session-summary")
    );
    const combinedMemories = [
      ...summaryMemories.slice(0, 4),
      ...explicitMemories.slice(0, 4),
    ];

    const memorySection = buildMemorySection({
      persona,
      userProfile,
      memories: combinedMemories,
      recentMemories,
    });

    const instructions = buildMemoryInstructions();
    return [instructions, memorySection].filter(Boolean).join("\n\n").trim();
  }

  async function selectTopicsForPrompt({ query, scope, maxResults, minScore, ctx }) {
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
    });

    const addendum = await buildTopicAddendum({ topics: selected });
    return { selected, addendum };
  }

  async function buildTopicPromptAddon({ query, scope, maxResults, minScore, ctx }) {
    const { addendum } = await selectTopicsForPrompt({
      query,
      scope,
      maxResults,
      minScore,
      ctx,
    });

    return addendum;
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

  async function maybeSetTopicFromPrompt(prompt, ctx) {
    return;
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

  async function sessionFileExists(sessionPath) {
    if (!sessionPath || sessionPath === "ephemeral") {
      return false;
    }
    try {
      await fs.access(sessionPath);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function parseModelId(modelId) {
    if (!modelId) {
      return null;
    }
    const [provider, ...rest] = modelId.split(":");
    if (!provider || rest.length === 0) {
      return null;
    }
    return { provider, id: rest.join(":") };
  }

  async function resolveMemoryModel(ctx) {
    const modelInfo = parseModelId(config.memoryModel);
    if (!modelInfo) {
      return {
        model: null,
        apiKey: null,
        error:
          "Memory model not configured. Set memoryModel to provider:modelId.",
        provider: null,
      };
    }

    const model = ctx.modelRegistry.find(modelInfo.provider, modelInfo.id) ?? null;
    if (!model) {
      return {
        model: null,
        apiKey: null,
        error: `Memory model not found: ${modelInfo.provider}/${modelInfo.id}.`,
        provider: modelInfo.provider,
      };
    }

    const available = await ctx.modelRegistry.getAvailable();
    const isAvailable = available.some(
      (item) => item.provider === modelInfo.provider && item.id === modelInfo.id
    );

    if (!isAvailable) {
      return {
        model: null,
        apiKey: null,
        error: `No credentials configured for ${modelInfo.provider}/${modelInfo.id}.`,
        provider: modelInfo.provider,
      };
    }

    let apiKey = null;
    try {
      apiKey = await ctx.modelRegistry.getApiKey(model);
    } catch (_error) {
      return {
        model: null,
        apiKey: null,
        error: `Failed to resolve credentials for ${modelInfo.provider}/${modelInfo.id}.`,
        provider: modelInfo.provider,
      };
    }

    return { model, apiKey, error: null, provider: modelInfo.provider };
  }

  async function collectExplicitFacts() {
    const entries = await store.readMemoryEntries();
    return entries
      .filter((entry) => entry.tags.includes("explicit"))
      .map((entry) => entry.text);
  }

  async function summarizeCurrentSession(ctx, { reason } = {}) {
    await ensureSessionState(ctx);
    if (!hasActiveMemoryFile()) {
      if (ctx.hasUI) {
        ctx.ui.notify("Memory not ready yet; session file not persisted.", "warning");
      }
      return null;
    }

    const { model, apiKey, error } = await resolveMemoryModel(ctx);
    if (!model) {
      if (ctx.hasUI) {
        ctx.ui.notify(error ?? "Memory model unavailable.", "warning");
      }
      return null;
    }

    const sessionPath = ctx.sessionManager.getSessionFile() ?? store.sessionPath;
    let transcript = "";
    let usedJsonl = false;
    let jsonlMissing = false;
    if (sessionPath) {
      transcript = await readSessionJsonl(sessionPath, {
        maxChars: config.sessionSummaryMaxChars,
      });
      usedJsonl = Boolean(transcript);
      if (!usedJsonl && sessionPath !== "ephemeral") {
        jsonlMissing = true;
      }
    }
    if (!transcript) {
      transcript = buildTranscriptFromEntries(ctx.sessionManager.getBranch(), {
        maxChars: config.sessionSummaryMaxChars,
      });
    }

    if (!transcript) {
      return null;
    }

    const persona = await buildPersonaWithTopics({
      query: transcript,
      scope: "summary",
      maxResults: 2,
      minScore: 2,
      ctx,
    });

    const explicitFacts = await collectExplicitFacts();
    const summary = await summarizeSessionWithModel({
      model,
      apiKey,
      persona,
      transcript,
      explicitFacts,
      maxTokens: config.memoryModelMaxTokens,
      temperature: config.memoryModelTemperature,
    });

    if (!summary) {
      return null;
    }

    await maybeSetTopicFromSummary(summary, ctx);

    const stored = await store.upsertSessionSummary(summary, {
      tags: reason ? [reason] : [],
    });

    if (process.env.PI_STATEFUL_MEMORY_DEBUG) {
      if (jsonlMissing) {
        await store.appendMemories(
          [
            `Debug: session JSONL was missing at summary time (${sessionPath}). Summary used in-memory branch instead.`,
          ],
          { tags: ["debug", "session-summary"] }
        );
      }

      if (usedJsonl) {
        await store.appendMemories(
          [`Debug: session summary used JSONL transcript (${sessionPath}).`],
          { tags: ["debug", "session-summary"] }
        );
      }
    }

    if (ctx.hasUI) {
      ctx.ui.notify("Session summary saved.", "info");
    }

    return stored;
  }

  async function maybeSetTopicFromSummary(summary, ctx) {
    if (!summary) {
      return;
    }

    const slug = slugifyKeywords(summary, 6);
    if (!slug || slug === "untitled") {
      return;
    }

    const newName = store.getSessionFileName(slug);
    if (newName === store.memoryFile) {
      topicLocked = true;
      return;
    }

    const oldPath = store.memoryFilePath;
    const newPath = path.join(store.memoryDir, newName);

    try {
      await fs.access(newPath);
      topicLocked = true;
      return;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }

    await fs.rename(oldPath, newPath);
    store.setMemoryFile(newName);
    topicLocked = true;
    pi.appendEntry(STATE_ENTRY, { memoryFile: newName, topicLocked: true });
  }

  async function buildMemoryIndex() {
    const files = await store.listMemoryFiles();
    const index = [];

    for (const fileName of files) {
      const entries = await store.readMemoryFileEntries(fileName);
      const summaryEntry =
        entries.find((entry) => entry.tags.includes("session-summary")) ??
        entries[0];
      const explicitEntries = entries.filter((entry) =>
        entry.tags.includes("explicit")
      );
      const explicitSnippet = explicitEntries.length
        ? `Explicit facts:\n${explicitEntries
            .slice(-3)
            .map((entry) => `- ${entry.text}`)
            .join("\n")}`
        : "";

      index.push({
        fileName,
        timestamp: summaryEntry?.timestamp ?? "unknown",
        sessionPath: summaryEntry?.sessionPath ?? null,
        summary: [summaryEntry?.text ?? "", explicitSnippet]
          .filter(Boolean)
          .join("\n"),
      });
    }

    return index;
  }

  async function selectMemoryFilesByHeuristic(query, files) {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) {
      return [];
    }

    const scored = [];
    for (const fileName of files) {
      const entries = await store.readMemoryFileEntries(fileName);
      let best = 0;
      for (const entry of entries) {
        best = Math.max(best, scoreEntry(entry, queryTokens));
      }
      if (best > 0) {
        scored.push({ fileName, score: best });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
      .map((item) => item.fileName);
  }

  function formatMemoryEntries(fileName, entries) {
    if (!entries.length) {
      return [];
    }

    return entries.map((entry) => {
      const tagLabel = entry.tags?.length
        ? ` [tags: ${entry.tags.join(", ")}]`
        : "";
      return `[${fileName}] ${entry.text}${tagLabel}`.trim();
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureSessionState(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("stateful-memory", "Memory: ready");
    }
  });

  pi.on("session_switch", async (_event, ctx) => {
    sessionInitialized = false;
    lastSessionPath = null;
    pendingResumeSessionPath = null;
    pendingSessionInit = false;
    topicLocked = false;
    await ensureSessionState(ctx);
    if (ctx.hasUI) {
      ctx.ui.setStatus("stateful-memory", "Memory: ready");
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureSessionState(ctx);
    await maybeSetTopicFromPrompt(event.prompt, ctx);

    const [addon, topicSelection] = await Promise.all([
      buildSystemPromptAddon(),
      selectTopicsForPrompt({
        query: event.prompt,
        scope: "system",
        maxResults: 3,
        minScore: 1,
        ctx,
      }),
    ]);

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

  pi.on("session_before_switch", async (event, ctx) => {
    if (event.reason === "resume" && event.targetSessionFile) {
      pendingResumeSessionPath = event.targetSessionFile;
    }
    await summarizeCurrentSession(ctx, { reason: "session-switch" });
  });

  pi.on("session_before_fork", async (_event, ctx) => {
    await summarizeCurrentSession(ctx, { reason: "session-fork" });
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await summarizeCurrentSession(ctx, { reason: "session-shutdown" });
  });

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
        content: [
          {
            type: "text",
            text: lines.join("\n"),
          },
        ],
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
          content: [
            {
              type: "text",
              text: `Topic not found: ${params.id}`,
            },
          ],
          details: { topic: null },
        };
      }

      const content = await readTopicContent(topic);
      const heading = content.title || topic.id;
      const text = `# ${heading}\n\n${content.body}`.trim();

      return {
        content: [
          {
            type: "text",
            text,
          },
        ],
        details: { topic: { id: topic.id } },
      };
    },
  });

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Store explicit facts about the user or project for future conversations.",
    parameters: Type.Object({
      items: Type.Array(
        Type.String({
          description: "Concise facts to remember.",
        })
      ),
      target: Type.Optional(
        StringEnum(["memory", "profile"], {
          description: "Store in memory log or user profile.",
        })
      ),
      tags: Type.Optional(
        Type.Array(
          Type.String({ description: "Optional tags for future recall." })
        )
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      await ensureSessionState(ctx);
      if (!hasActiveMemoryFile()) {
        return {
          content: [
            {
              type: "text",
              text: "Memory not ready yet; session file not persisted. Try again in a moment.",
            },
          ],
          details: { stored: [] },
        };
      }
      const target = params.target ?? "memory";

      if (target === "profile") {
        const stored = await store.appendUserProfile(params.items);
        return {
          content: [
            {
              type: "text",
              text: `Saved ${stored.length} profile item(s).`,
            },
          ],
          details: { stored },
        };
      }

      const tags = ["explicit", ...(params.tags ?? [])];
      const stored = await store.appendMemories(params.items, { tags });

      return {
        content: [
          {
            type: "text",
            text: `Saved ${stored.length} memory item(s).`,
          },
        ],
        details: { stored },
      };
    },
  });

  pi.registerTool({
    name: "remember_session",
    label: "Remember Session",
    description: "Summarize the current session into long-term memory.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const stored = await summarizeCurrentSession(ctx, {
        reason: "manual",
      });

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
      await ensureSessionState(ctx);
      if (!hasActiveMemoryFile()) {
        return {
          content: [
            {
              type: "text",
              text: "Memory not ready yet; session file not persisted. Try again in a moment.",
            },
          ],
          details: { memories: [] },
        };
      }

      const { model, apiKey, error, provider } = await resolveMemoryModel(ctx);
      if (!model) {
        let available = [];
        try {
          const models = await ctx.modelRegistry.getAvailable();
          available = provider
            ? models.filter((item) => item.provider === provider).map((item) => item.id)
            : models.map((item) => `${item.provider}/${item.id}`);
        } catch (_err) {
          available = [];
        }

        const availability = available.length
          ? `Available models: ${available.slice(0, 8).join(", ")}${
              available.length > 8 ? "..." : ""
            }`
          : "No available models were found.";

        return {
          content: [
            {
              type: "text",
              text: `${error ?? "Memory model unavailable."} ${availability}`.trim(),
            },
          ],
          details: { memories: [], error, available },
        };
      }

      const memoryIndex = await buildMemoryIndex();
      if (memoryIndex.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "I don't have any saved session summaries yet.",
            },
          ],
          details: { memories: [] },
        };
      }

      const persona = await buildPersonaWithTopics({
        query: params.query,
        scope: "recall",
        maxResults: 2,
        minScore: 1,
        ctx,
      });
      const plan = await planRecallWithModel({
        model,
        apiKey,
        persona,
        query: params.query,
        memoryIndex,
        maxTokens: config.memoryModelMaxTokens,
        temperature: config.memoryModelTemperature,
      });

      if (plan.memoryFiles.length === 0) {
        const fallback = await selectMemoryFilesByHeuristic(
          params.query,
          memoryIndex.map((item) => item.fileName)
        );
        plan.memoryFiles = fallback;
      }

      const selectedMemories = [];
      const sessionExcerpts = [];
      const seenSessions = new Set();

      for (const fileName of plan.memoryFiles) {
        const entries = await store.readMemoryFileEntries(fileName);
        selectedMemories.push(...formatMemoryEntries(fileName, entries));

        const sessionPath = entries.find((entry) => entry.sessionPath)?.sessionPath;
        if (plan.needsSessionDetails && sessionPath && !seenSessions.has(sessionPath)) {
          const excerpt = await readSessionJsonl(sessionPath, {
            maxChars: config.recallMaxSessionChars,
          });
          if (excerpt) {
            sessionExcerpts.push({ sessionPath, excerpt });
            seenSessions.add(sessionPath);
          }
        }
      }

      const response = await recallWithModel({
        model,
        apiKey,
        persona,
        query: params.query,
        selectedMemories,
        sessionExcerpts,
        maxTokens: config.memoryModelMaxTokens,
        temperature: config.memoryModelTemperature,
      });

      return {
        content: [
          {
            type: "text",
            text: response || "I couldn't recall anything useful.",
          },
        ],
        details: {
          plan,
          selectedMemories,
          sessionExcerpts,
        },
      };
    },
  });
}
