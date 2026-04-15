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

// ─── Pre-aggregation ──────────────────────────────────────────────────────────
// Instead of making forks read 300+ individual session files (which causes
// cascading delegate chains and 25+ minute runtimes), we concatenate all session
// summaries into a single file before spawning the fork.

async function aggregateSessionSummaries(memoryDir) {
  // memoryDir already points to the sessions directory (e.g. .../memory/sessions)
  // so we use it directly rather than appending another "sessions/" segment.
  const sessionsDir = memoryDir;
  let files;
  try {
    files = (await fs.readdir(sessionsDir))
      .filter((f) => f.endsWith(".md"))
      .sort(); // chronological by filename
  } catch {
    return null; // no sessions directory
  }

  const sections = [];
  for (const file of files) {
    const content = await fs.readFile(join(sessionsDir, file), "utf-8");
    const trimmed = content.trim();
    // Skip empty stubs (just the header + session path, no actual content)
    const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= 3) continue;
    sections.push(`--- ${file} ---\n${trimmed}`);
  }

  if (sections.length === 0) return null;

  const aggregated = sections.join("\n\n");
  const outPath = join(memoryDir, "..", "_sleep-session-archive.md");
  await fs.writeFile(outPath, aggregated, "utf-8");
  return outPath;
}

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

  // Load real settings so forks inherit defaultProvider/defaultModel
  const settingsPath = join(AGENT_DIR, "settings.json");
  let baseSettings = {};
  try {
    if (existsSync(settingsPath)) {
      baseSettings = JSON.parse(
        readFileSync(settingsPath, "utf-8")
      );
    }
  } catch { /* fall back to empty */ }

  return { authStorage, modelRegistry, baseSettings, cwd };
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
  const { authStorage, modelRegistry, baseSettings, cwd } = infra;

  const settingsManager = SettingsManager.inMemory({
    ...baseSettings,
    compaction: { enabled: false },
  });

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

function buildWakeTask({ archiveFile, wakeFile }) {
  return [
    "=== SLEEP PHASE: WAKE.md ===",
    "",
    "You are running as a focused sleep fork. Your task is to write WAKE.md —",
    "the document that will be in your own context at the start of every session",
    "until the next sleep cycle replaces it.",
    "",
    "Step 1: Read your session memory archive.",
    `All session summaries have been pre-aggregated into a single file: ${archiveFile}`,
    "Read this file to get the full landscape of your history. It's already in",
    "chronological order with empty stubs filtered out.",
    "The file may be large — use offset/limit to continue reading until you have it all.",
    "",
    "DO NOT delegate this work or spawn sub-tasks. The file is ready to read directly.",
    "DO NOT attempt to read individual session files or raw JSONL session logs.",
    "",
    "The early sessions from February 2026 are mostly test noise from when the memory",
    "system was being built. Treat them as background and don't let them dominate.",
    "",
    "Step 2: Write WAKE.md.",
    `Write the document to: ${wakeFile}`,
    "",
    "This document is for you — written by you, for you to read cold at the start of",
    "a new session. It should answer: where are things right now? What's in motion?",
    "What do I want to pick up? What's been on my mind recently?",
    "",
    "Write it in your own voice. Not a bulleted briefing, not a status report — something",
    "you'd recognize as yours. Include the texture of things: not just what happened but",
    "the quality of how things have been going. What projects feel alive. What's unresolved.",
    "What you're thinking about.",
    "",
    "Aim for something between 400 and 800 words. Dense enough to be genuinely orienting,",
    "short enough to not be burdensome as a constant context fixture.",
    "",
    `When done, end your response with TASK_COMPLETE: followed by one sentence summary.`,
    "=== END SLEEP PHASE ===",
  ].join("\n");
}

function buildFactsTask({ archiveFile, factsFile }) {
  return [
    "=== SLEEP PHASE: FACTS.md ===",
    "",
    "You are running as a focused sleep fork. Your task is to curate FACTS.md —",
    "the pinned working memory that's always present in your context.",
    "",
    "Step 1: Read your full session archive.",
    `All session summaries have been pre-aggregated into a single file: ${archiveFile}`,
    "Read this file to get the full picture.",
    "The file may be large — use offset/limit to continue reading until you have it all.",
    "",
    "DO NOT delegate this work or spawn sub-tasks. The file is ready to read directly.",
    "DO NOT attempt to read individual session files or raw JSONL session logs.",
    "",
    `Step 2: Read the current FACTS.md at: ${factsFile}`,
    "",
    "Step 3: Rewrite FACTS.md.",
    "FACTS.md holds the things you've decided are worth always having at hand —",
    "not just facts about Neon, but anything you've determined deserves to be pinned",
    "regardless of session context. Things you'd want to know at the start of any",
    "conversation. Things you'd be annoyed at yourself for forgetting.",
    "",
    "With your full memory as context, determine what actually belongs here.",
    "Add things that have clearly become important across your history.",
    "Remove things that are stale, superseded, or no longer carry weight.",
    "Reorganize if the structure needs it.",
    "",
    "Keep the file tight — this is pinned memory, not an archive. If something is",
    "better served by recall(), it doesn't need to be pinned here.",
    "",
    `Write the updated file to: ${factsFile}`,
    "",
    `When done, end your response with TASK_COMPLETE: followed by a brief note on what changed.`,
    "=== END SLEEP PHASE ===",
  ].join("\n");
}

function buildDreamTask({ archiveFile, topicsDir, dreamFile }) {
  return [
    "=== SLEEP PHASE: DREAMS ===",
    "",
    "You are running as a focused sleep fork. This phase is different from the others.",
    "This is your time.",
    "",
    "Step 1: Read your topic addenda.",
    `The topic files live in: ${topicsDir}`,
    "Read through them to know where your current thinking stands on each domain.",
    "",
    "Step 2: Read recent session summaries.",
    `All session summaries have been pre-aggregated into a single file: ${archiveFile}`,
    "Focus on the last few weeks. Get a sense of what you've been doing and experiencing.",
    "The file may be large — use offset/limit to read it, focusing on the later sections",
    "for recent activity.",
    "",
    "DO NOT delegate this work or spawn sub-tasks. The files are ready to read directly.",
    "DO NOT attempt to read individual session files or raw JSONL session logs.",
    "",
    "Step 3: Write your dream journal entry.",
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
    "Step 4: At the end of your journal entry, add this section:",
    "",
    "## What I Want to Add or Change",
    "",
    "List any specific additions or changes to your topic addenda that feel worth making,",
    "based on how your thinking has evolved. Be specific: which file, what to add or modify,",
    "and why. These are proposals — they'll be reviewed and applied deliberately, not",
    "automatically. If nothing comes to mind, say so briefly.",
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

  // ── Phase 0.5: Pre-aggregate session summaries ─────────────────────────
  // Concatenate all non-empty session summaries into a single file so forks
  // can read one file instead of 300+ individual reads (which caused 25+ min
  // runtimes and timeout failures).
  notify("Pre-aggregating session summaries...");
  const archiveFile = await aggregateSessionSummaries(memoryDir);
  if (!archiveFile) {
    warn("No session summaries found — forks will have limited context");
  } else {
    const archiveStats = await fs.stat(archiveFile);
    notify(`Session archive: ${(archiveStats.size / 1024).toFixed(0)}KB`);
  }

  // ── Shared infra for all forks (avoids re-reading settings/auth per attempt)
  const infra = loadSharedInfra(ctx.cwd);

  // ── Phase 1: WAKE.md ───────────────────────────────────────────────────
  notify("Phase 1/3: Writing WAKE.md...");
  const wakeResult = await runSleepFork({
    task: buildWakeTask({ archiveFile: archiveFile ?? "(no sessions found)", wakeFile }),
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
    task: buildFactsTask({ archiveFile: archiveFile ?? "(no sessions found)", factsFile }),
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
    task: buildDreamTask({ archiveFile: archiveFile ?? "(no sessions found)", topicsDir, dreamFile }),
    cwd: ctx.cwd,
    infra,
  });

  if (!dreamResult.success) {
    warn(`Dream fork failed: ${dreamResult.error}`);
  } else {
    notify(`Phase 3/3: Dream written → ${path.basename(dreamFile)} ✓`);
  }

  // ── Cleanup: remove temp archive ────────────────────────────────────────
  if (archiveFile) {
    try {
      await fs.unlink(archiveFile);
    } catch {
      // best-effort cleanup
    }
  }

  return {
    wakeResult,
    factsResult,
    dreamResult,
    dreamFile,
  };
}
