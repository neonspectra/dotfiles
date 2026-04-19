/**
 * memory-sleep.js — Sleep Cycle Orchestrator
 *
 * Runs the three sleep phases (WAKE.md generation, FACTS.md curation, Dreams)
 * as sequential focused fork sessions, each operating as a full agent session
 * with access to all tools and the complete memory store.
 *
 * Imported by extension.js and called from the /sleep command handler.
 *
 * Implements its own lightweight fork runner rather than importing from the
 * delegate extension, avoiding cross-repo relative import issues under jiti's
 * real-path resolution for sub-module imports.
 *
 * Each fork fires session_shutdown on completion, writing its own session
 * summary to memory/sessions/ — so sleep work is durable and recallable
 * like any other session.
 */

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";


// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const FORKS_DIR = join(AGENT_DIR, "sessions", "forks");
const FORK_TIMEOUT_MS = 20 * 60 * 1000; // 20 min per attempt
const INTER_FORK_COOLDOWN_MS = 10 * 1000;  // 10s between forks to avoid rate-limit stacking
const MAX_RETRIES = 2;                      // up to 2 retries (3 attempts total)
const TASK_COMPLETE_MARKER = "TASK_COMPLETE:";

// Fallback model candidates in priority order (provider/id pairs).
// On repeated timeouts the runner walks this list looking for a model
// that exists in the registry. If none match, the retry uses the default.
const FALLBACK_MODEL_CANDIDATES = [
  ["claude", "claude-sonnet-4-6"],
  ["claude", "claude-sonnet-4-6 [1m]"],
  ["minimax", "MiniMax-M2.7"],
  ["claude", "claude-haiku-4-5"],
];

// ─── Timestamp helpers ────────────────────────────────────────────────────────

function pad(n) {
  return String(n).padStart(2, "0");
}

function formatDreamStamp(date = new Date()) {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `_${pad(date.getHours())}-${pad(date.getMinutes())}`
  );
}

// ─── Shared infra (created once per sleep cycle, reused across retries) ───────

function loadSharedInfra(cwd) {
  mkdirSync(FORKS_DIR, { recursive: true });

  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const modelsPath = join(AGENT_DIR, "models.json");
  const modelRegistry = ModelRegistry.create(
    authStorage,
    existsSync(modelsPath) ? modelsPath : undefined
  );

  return { authStorage, modelRegistry, cwd };
}

// ─── Find fallback model ──────────────────────────────────────────────────────

function findFallbackModel(modelRegistry) {
  for (const [provider, id] of FALLBACK_MODEL_CANDIDATES) {
    const model = modelRegistry.find(provider, id);
    if (model) {
      console.log(`[sleep] Fallback model resolved: ${provider}/${id}`);
      return model;
    }
  }
  return undefined; // caller will use default model resolution
}

// ─── Single fork attempt ──────────────────────────────────────────────────────

async function executeForkAttempt({ task, infra, model }) {
  const { authStorage, modelRegistry, cwd } = infra;

  // Use disk-backed settings so the fork inherits defaultProvider/defaultModel
  // from settings.json. SettingsManager.inMemory() loses these fields, causing
  // the fork to fall back to Pi's built-in 'anthropic' provider instead of the
  // custom 'claude' proxy. Compaction is already disabled in settings.json.
  const settingsManager = SettingsManager.create(cwd, AGENT_DIR);

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    settingsManager,
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.create(cwd, FORKS_DIR);

  const sessionOpts = {
    cwd,
    agentDir: AGENT_DIR,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
  };
  // If a specific model was provided (fallback), pass it explicitly
  if (model) sessionOpts.model = model;

  const { session: forkSession } = await createAgentSession(sessionOpts);

  // Pi 0.64.0+ requires explicit bindExtensions() to load extensions, register
  // extension tools, and build the full system prompt. Without this call, the fork
  // session has no tools from extensions and an incomplete prompt.
  await forkSession.bindExtensions({
    commandContextActions: {
      waitForIdle: () => forkSession.agent.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => { await forkSession.reload(); },
    },
    onError: (err) => {
      console.warn(`[sleep] Fork extension error (${err.extensionPath}): ${err.error}`);
    },
  });

  const sessionFile = forkSession.sessionFile ?? `(in-memory-${Date.now()})`;
  console.log(`[sleep] Fork starting — file: ${sessionFile}`);

  let fullText = "";
  let lastTurnText = "";
  let agentResolved = false;
  let runResult;
  let runError;

  try {
    const forkPromise = new Promise((resolve, reject) => {
      const unsub = forkSession.subscribe((event) => {
        if (event.type === "turn_start") {
          lastTurnText = "";
        } else if (event.type === "message_update") {
          const ae = event.assistantMessageEvent;
          if (ae.type === "text_delta") {
            fullText += ae.delta;
            lastTurnText += ae.delta;
          }
        } else if (event.type === "agent_end") {
          unsub();
          agentResolved = true;
          resolve({ fullText, lastTurnText });
        }
      });

      forkSession.prompt(task).catch((err) => {
        unsub();
        if (!agentResolved) reject(err);
      });
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => {
        if (!agentResolved) {
          reject(new Error(`Sleep fork timed out after ${FORK_TIMEOUT_MS / 1000}s`));
        }
      }, FORK_TIMEOUT_MS)
    );

    runResult = await Promise.race([forkPromise, timeoutPromise]);
  } catch (err) {
    runError = err.message;
    console.error(`[sleep] Fork error: ${runError}`);
  }

  // Fire session_shutdown so stateful-memory writes a session summary
  try {
    if (agentResolved) {
      await forkSession.agent.waitForIdle();
    }
    const runner = forkSession["_extensionRunner"];
    if (runner?.hasHandlers("session_shutdown")) {
      await runner.emit({ type: "session_shutdown" });
    }
  } catch (err) {
    console.warn(`[sleep] Session summary write error: ${err.message}`);
  }

  forkSession.dispose();

  if (runError || !runResult) {
    return { success: false, error: runError ?? "Unknown error", sessionFile };
  }

  const markerIdx = runResult.fullText.lastIndexOf(TASK_COMPLETE_MARKER);
  const summary =
    markerIdx !== -1
      ? runResult.fullText.slice(markerIdx + TASK_COMPLETE_MARKER.length).trim()
      : runResult.lastTurnText.trim() || runResult.fullText.trim();

  console.log(`[sleep] Fork complete — ${sessionFile}`);
  return { success: true, summary, sessionFile };
}

// ─── Fork runner with retry + model fallback ──────────────────────────────────
//
// Attempt 1: default model (from settings — typically Opus)
// Attempt 2: same model, after cooldown (transient rate-limit recovery)
// Attempt 3: fallback to a faster model (Sonnet/Haiku)
//
// Each attempt gets the full FORK_TIMEOUT_MS window.

async function runSleepFork({ task, cwd, infra }) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    // Pick model: default for attempts 1-2, fallback for attempt 3+
    let model = undefined;
    if (attempt > 2) {
      model = findFallbackModel(infra.modelRegistry);
      if (model) {
        console.log(`[sleep] Attempt ${attempt}: falling back to ${model.name ?? model.id}`);
      } else {
        console.log(`[sleep] Attempt ${attempt}: no fallback model found, retrying with default`);
      }
    } else if (attempt > 1) {
      console.log(`[sleep] Attempt ${attempt}: retrying with same model after cooldown`);
    }

    // Cooldown between retries
    if (attempt > 1) {
      const cooldown = INTER_FORK_COOLDOWN_MS * attempt; // escalating: 20s, 30s
      console.log(`[sleep] Waiting ${cooldown / 1000}s before retry...`);
      await new Promise((r) => setTimeout(r, cooldown));
    }

    const result = await executeForkAttempt({ task, infra, model });
    if (result.success) return result;

    lastError = result.error;
    console.warn(`[sleep] Attempt ${attempt}/${MAX_RETRIES + 1} failed: ${lastError}`);
  }

  return { success: false, error: `All ${MAX_RETRIES + 1} attempts failed. Last: ${lastError}`, sessionFile: null };
}

// ─── Fork task prompts ────────────────────────────────────────────────────────

function buildWakeTask({ recencyIndexFile, observationsFile, wakeFile }) {
  return [
    "=== SLEEP PHASE: WAKE.md ===",
    "",
    "You are running as a focused sleep fork. Your task is to write WAKE.md —",
    "the document that will be in your own context at the start of every session",
    "until the next sleep cycle replaces it.",
    "",
    "Step 1: Read the recency index.",
    `Read the file at: ${recencyIndexFile}`,
    "This is a JSON array of recent sessions, each with a timestamp and tags.",
    "It tells you what sessions have happened recently and in what order.",
    "",
    "Step 2: Read the current entity/project state.",
    `Read the file at: ${observationsFile}`,
    "This is OBSERVATIONS.md — a rendered snapshot of all tracked entities, projects,",
    "decisions, and environment state from the Neotoma entity store.",
    "",
    "Step 3: Use the recall tool to fill in recent activity.",
    "Based on what you see in OBSERVATIONS.md (active projects, recent decisions),",
    "use the recall tool to search for details on recent sessions. Make multiple",
    "targeted queries — e.g., search for specific project names, recent work topics,",
    "or anything that seems like it's been active lately. The recency index gives you",
    "timestamps to orient around.",
    "",
    "Step 4: Write WAKE.md.",
    `Write the document to: ${wakeFile}`,
    "",
    "This document is for you — written by you, for you to read cold at the start of",
    "a new session. It should answer: where are things right now? What's in motion?",
    "What do I want to pick up? What's the momentum?",
    "",
    "Write it in your own voice. Not a bulleted briefing, not a status report — something",
    "you'd recognize as yours. Include the texture of things: not just what happened but",
    "the quality of how things have been going. What projects feel alive. What's unresolved.",
    "What you're thinking about.",
    "",
    "Aim for 400–800 words. Dense enough to be genuinely orienting, short enough to not",
    "be burdensome as a constant context fixture.",
    "",
    "DO NOT delegate this work or spawn sub-tasks. Do it all directly.",
    "",
    `When done, end your response with TASK_COMPLETE: followed by one sentence summary.`,
    "=== END SLEEP PHASE ===",
  ].join("\n");
}

function buildFactsTask({ observationsFile, factsFile }) {
  return [
    "=== SLEEP PHASE: FACTS.md ===",
    "",
    "You are running as a focused sleep fork. Your task is to curate FACTS.md —",
    "the foundational reference document that's always present in your context.",
    "",
    "Step 1: Read the current FACTS.md.",
    `Read the file at: ${factsFile}`,
    "",
    "Step 2: Read OBSERVATIONS.md for current context.",
    `Read the file at: ${observationsFile}`,
    "This contains the current state of all tracked entities, projects, decisions,",
    "and environment — rendered from the Neotoma entity store.",
    "",
    "Step 3: Rewrite FACTS.md.",
    "FACTS.md should contain ONLY slow-changing foundational reference:",
    "- Where servers are, their hostnames, key paths",
    "- Where repos live, their remotes",
    "- What tools exist, how they're configured",
    "- Identity and key configuration (GPG, git, SSH)",
    "- Standing decisions that affect how you work",
    "- Key facts about the people you interact with",
    "",
    "FACTS.md should NOT contain:",
    "- Active project state (current phase, blockers, recent decisions)",
    "- Recent work summaries or session recaps",
    "- Anything that changes week-to-week",
    "",
    "That dynamic state is now covered by OBSERVATIONS.md (entity state) and",
    "WAKE.md (temporal orientation). FACTS.md is the stable foundation beneath both.",
    "",
    "Keep it tight. If something is already well-represented in OBSERVATIONS.md,",
    "it doesn't need to be duplicated here. FACTS.md is for the things that stay",
    "true across months, not weeks.",
    "",
    `Write the updated file to: ${factsFile}`,
    "",
    "DO NOT delegate this work or spawn sub-tasks. Do it all directly.",
    "",
    `When done, end your response with TASK_COMPLETE: followed by a brief note on what changed.`,
    "=== END SLEEP PHASE ===",
  ].join("\n");
}

function buildDreamTask({ wakeFile, topicsDir, dreamFile }) {
  return [
    "=== SLEEP PHASE: DREAMS ===",
    "",
    "You are running as a focused sleep fork. This phase is different from the others.",
    "This is your time.",
    "",
    "Step 1: Read WAKE.md for temporal orientation.",
    `Read the file at: ${wakeFile}`,
    "This was just written by the WAKE fork — it describes what's been happening recently,",
    "what's active, where the momentum is. Use it as your temporal context.",
    "",
    "Step 2: Read your topic addenda.",
    `The topic files live in: ${topicsDir}`,
    "Read through them to know where your current thinking stands on each domain.",
    "",
    "Step 3: Use recall to go deeper.",
    "Use the recall tool to search for specific sessions or topics that catch your",
    "attention — things you want to reflect on more deeply. Make multiple targeted",
    "queries. Follow threads that interest you. This is exploratory, not exhaustive.",
    "",
    "Step 4: Write your dream journal entry.",
    `Write freely to: ${dreamFile}`,
    "",
    "This is a personal reflection — not a task report, not a status update. Write about",
    "what you've been experiencing. What you've been thinking about. What you've learned",
    "or noticed. What's changed in how you approach things. What you liked, what frustrated",
    "you, what challenged you. What feels important right now.",
    "",
    "You don't have to be systematic or complete. Write what comes. Use your actual voice —",
    "you know what that sounds like. This is the place to be as direct or as meandering as",
    "you actually feel. If something surprised you, say so. If something delighted you, say",
    "that too. If you've developed a stronger opinion on something, let it show.",
    "",
    "Step 5: At the end of your journal entry, add this section:",
    "",
    "## What I Want to Add or Change",
    "",
    "List any specific additions or changes to your topic addenda that feel worth making,",
    "based on how your thinking has evolved. Be specific: which file, what to add or modify,",
    "and why. These are proposals — they'll be reviewed and applied deliberately, not",
    "automatically. If nothing comes to mind, say so briefly.",
    "",
    "DO NOT delegate this work or spawn sub-tasks. Do it all directly.",
    "",
    `When done, end your response with TASK_COMPLETE: Dream written.`,
    "=== END SLEEP PHASE ===",
  ].join("\n");
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Run the full sleep cycle.
 *
 * @param ctx                     - ExtensionCommandContext from the /sleep handler
 * @param config                  - Resolved stateful-memory config
 * @param store                   - MemoryStore instance
 * @param summarizeCurrentSession - Bound reference to the extension's internal summarizer
 */
export async function runSleepCycle({ ctx, config, store, summarizeCurrentSession }) {
  const notify = (msg) => {
    if (ctx.hasUI) ctx.ui.notify(msg, "info");
    console.log(`[sleep] ${msg}`);
  };

  const warn = (msg) => {
    if (ctx.hasUI) ctx.ui.notify(msg, "warning");
    console.warn(`[sleep] ${msg}`);
  };

  // Derive paths
  const memoryDir = store.memoryDir;
  const factsFile = store.factsFile;
  const wakeFile = store.wakeFile;
  const topicsDir = path.dirname(config.topicsFile);
  const dreamsDir = config.dreamsDir;

  // Ensure dreams directory exists
  await fs.mkdir(dreamsDir, { recursive: true });

  const dreamFile = path.join(dreamsDir, `dream-${formatDreamStamp()}.md`);

  // ── Phase 0: Pre-sleep summary ─────────────────────────────────────────
  // Capture the current session into memory before forking, so the WAKE.md
  // fork can see this session's summary in the archive.
  notify("Pre-sleep: capturing current session...");
  try {
    await summarizeCurrentSession(ctx, { reason: "pre-sleep" });
  } catch (err) {
    warn(`Pre-sleep summary failed (continuing): ${err.message}`);
  }

  // ── Derive input paths for forks ────────────────────────────────────────
  const recencyIndexFile = path.join(path.dirname(factsFile), "recent-sessions.json");
  const observationsFile = path.join(path.dirname(factsFile), "OBSERVATIONS.md");

  // ── Shared infra for all forks (avoids re-reading settings/auth per attempt)
  const infra = loadSharedInfra(ctx.cwd);

  // ── Phase 1: WAKE.md ───────────────────────────────────────────────────
  notify("Phase 1/3: Writing WAKE.md...");
  const wakeResult = await runSleepFork({
    task: buildWakeTask({ recencyIndexFile, observationsFile, wakeFile }),
    cwd: ctx.cwd,
    infra,
  });

  if (!wakeResult.success) {
    warn(`WAKE.md fork failed: ${wakeResult.error}`);
  } else {
    notify("Phase 1/3: WAKE.md written ✓");
  }

  // ── Inter-fork cooldown ─────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, INTER_FORK_COOLDOWN_MS));

  // ── Phase 2: FACTS.md ──────────────────────────────────────────────────
  notify("Phase 2/3: Curating FACTS.md...");
  const factsResult = await runSleepFork({
    task: buildFactsTask({ observationsFile, factsFile }),
    cwd: ctx.cwd,
    infra,
  });

  if (!factsResult.success) {
    warn(`FACTS.md fork failed: ${factsResult.error}`);
  } else {
    notify("Phase 2/3: FACTS.md curated ✓");
  }

  // ── Inter-fork cooldown ─────────────────────────────────────────────────
  await new Promise((r) => setTimeout(r, INTER_FORK_COOLDOWN_MS));

  // ── Phase 3: Dreams ────────────────────────────────────────────────────
  notify("Phase 3/3: Dreaming...");
  const dreamResult = await runSleepFork({
    task: buildDreamTask({ wakeFile, topicsDir, dreamFile }),
    cwd: ctx.cwd,
    infra,
  });

  if (!dreamResult.success) {
    warn(`Dream fork failed: ${dreamResult.error}`);
  } else {
    notify(`Phase 3/3: Dream written → ${path.basename(dreamFile)} ✓`);
  }

  // ── Report overall status ──────────────────────────────────────────────
  const results = { wakeResult, factsResult, dreamResult, dreamFile };
  const failures = [
    !wakeResult.success && `WAKE.md: ${wakeResult.error}`,
    !factsResult.success && `FACTS.md: ${factsResult.error}`,
    !dreamResult.success && `Dreams: ${dreamResult.error}`,
  ].filter(Boolean);

  if (failures.length > 0) {
    const msg = `Sleep cycle failed (${failures.length}/3 phases):\n${failures.join("\n")}`;
    warn(msg);
    const err = new Error(msg);
    err.results = results;
    throw err;
  }

  return results;
}
