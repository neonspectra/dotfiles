/**
 * fork-runner.ts — Fork Session Lifecycle
 *
 * Spawns a focused sub-session ("fork") via createAgentSession(), runs it on
 * a specific task, and returns a summary of the work done.
 *
 * Forks run with the full persona + memory system (same agentDir) but a clean
 * context window seeded only with the task description and any context passed
 * explicitly from the calling session.
 *
 * ## Timeout and cancellation model
 *
 * The old approach (flat wall-clock Promise.race) had two fatal flaws:
 *   1. It killed legitimate long-running forks that were still making progress.
 *   2. It killed the calling session's fork *independently* of sub-forks, leaving
 *      depth-2+ forks running as zombies until their own independent timers fired.
 *   3. dispose() doesn't stop the agent loop — it only removes listeners. Calling
 *      dispose() after a timeout left a ghost process continuing in the background.
 *
 * The new model:
 *
 *   INACTIVITY DETECTION (root forks only):
 *     globalThis.__delegateLastActivity is updated on every event from ANY fork
 *     in the delegation tree. Root forks (depth=1) run a setInterval polling this
 *     timestamp. If the entire tree has been silent for INACTIVITY_TIMEOUT_MS, the
 *     root fork triggers an abort. This correctly distinguishes "slow but working"
 *     from "genuinely hung" — a sub-fork doing heavy work updates the timestamp
 *     even while the parent fork is silent waiting for its delegate tool call.
 *
 *   ABORT CHAIN:
 *     parentSignal (the calling agent's AbortSignal) is passed to runFork(). When
 *     the parent's agent is aborted — whether by its own timeout, a user interrupt,
 *     or a grandparent timeout — we immediately abort the child's agent too. Pi
 *     threads the abort signal all the way into tool.execute() calls and LLM
 *     streaming, so the abort propagates instantly through any running operation,
 *     including bash (which kills the process tree).
 *
 *   ABORT → CLEAN EXIT (not Promise.race):
 *     Instead of racing forkPromise against a rejecting timer, the timer now calls
 *     forkSession.agent.abort(). The abort causes agent_end to fire, which resolves
 *     forkPromise naturally. We then check the timedOut flag to decide what to do
 *     with the result. This means we always collect partial output — nothing is
 *     discarded.
 *
 *   ABSOLUTE CEILING:
 *     A hard 3-hour wall-clock limit per root fork as a last resort for truly
 *     pathological cases (e.g. a tool that generates infinite output, defeating
 *     the inactivity check). Sub-forks don't need their own ceiling — they're
 *     covered by the root's.
 *
 *   RECOVERY FORK:
 *     When a fork is terminated (timeout or error), if the session file has
 *     enough content, a short-lived recovery fork reads the JSONL session file
 *     and synthesises a handoff report: what was completed, what side effects
 *     occurred (modified files, started processes), what was left undone, and
 *     what the fork was doing when it died. This report is returned as the
 *     delegate tool result so the calling session can continue intelligently
 *     rather than getting a blank error.
 *
 * Depth tracking:
 *   Same globalThis-based Map as before (see comment in the registry section).
 *
 * Design notes:
 * - Compaction is disabled for forks (short-lived, no need to compact).
 * - session_shutdown is fired manually on the fork's extension runner so
 *   stateful-memory writes a session summary to memory/sessions/*.md — making
 *   fork work durable and recallable exactly like any other session.
 * - dispose() does NOT fire session_shutdown (it only disconnects listeners).
 *   session["_extensionRunner"] is a TypeScript private field compiled to a
 *   regular JS property. If a Pi upgrade breaks this, the catch below degrades
 *   gracefully (fork sessions fall back to explicit-remember-only durability).
 */

import { join } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  SettingsManager,
  getAgentDir,
} from "@mariozechner/pi-coding-agent";

// ─── Depth registry ────────────────────────────────────────────────────────────
// Maps sessionFile -> delegation depth for that session.
// Trunk sessions are depth 0 (not in map, default).
// Fork sessions are registered here before they run.
//
// IMPORTANT: stored on globalThis, not as a module-level Map.
// jiti loads extensions with moduleCache: false, so every fork session gets a
// fresh module instance. A module-level Map would be reset on each load.
// globalThis is shared across all JavaScript in the process regardless of how
// modules were loaded (jiti, Node native, etc.), so the depth registry survives
// across fork sessions and correctly enforces the 3-level limit.

const _g = globalThis as Record<string, unknown>;
if (!_g.__delegateForkDepths) {
  _g.__delegateForkDepths = new Map<string, number>();
}
export const forkDepths = _g.__delegateForkDepths as Map<string, number>;

// ─── Activity tracking ─────────────────────────────────────────────────────────
// Any fork in the delegation tree updates this timestamp on every event.
// Root forks (depth=1) poll it to detect tree-wide inactivity, which is the
// signal that something is genuinely hung rather than just slow.
//
// Also stored on globalThis for the same jiti/module-reload reason as forkDepths.

if (!_g.__delegateLastActivity) {
  _g.__delegateLastActivity = Date.now();
}

function touchActivity(): void {
  (_g as any).__delegateLastActivity = Date.now();
}

function getLastActivity(): number {
  return (_g as any).__delegateLastActivity as number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_DIR = getAgentDir();
const FORKS_DIR = join(AGENT_DIR, "sessions", "forks");

// Tree-wide inactivity threshold. If no fork in the delegation tree has emitted
// any event for this long, the root fork aborts the tree.
// 15 minutes covers any legitimate slow tool call (compilation, large downloads,
// extended LLM generation) while still catching genuine hangs.
const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

// Root fork polls the activity timestamp on this interval.
const ACTIVITY_CHECK_INTERVAL_MS = 30 * 1000;

// Absolute hard ceiling per root fork. A safety net for pathological cases
// (tools generating unbounded output, etc.) that defeat inactivity detection.
const ABSOLUTE_CEILING_MS = 3 * 60 * 60 * 1000;

// Maximum runtime for the recovery fork. It only reads and summarizes, so
// 3 minutes is ample. It gets its own separate timeout, not the inactivity check.
const RECOVERY_TIMEOUT_MS = 3 * 60 * 1000;

// Minimum session file size (bytes) to bother spawning a recovery fork.
// Below this, the fork barely started and there's nothing worth recovering.
const RECOVERY_MIN_SESSION_BYTES = 1024;

// The marker the fork includes in its final response when the task is done.
// We look for the LAST occurrence in case the fork mentions it in earlier reasoning.
export const TASK_COMPLETE_MARKER = "TASK_COMPLETE:";

// ─── Task messages ─────────────────────────────────────────────────────────────

function buildTaskMessage(task: string, context: string | undefined, depth: number): string {
  const contextStr = context?.trim() || "None provided.";
  const canDelegate = depth < 3;
  const depthNote = canDelegate
    ? `You may use the delegate tool for subtasks that genuinely warrant it, but complete your own reasoning first.`
    : `You are at the maximum delegation depth (3). Complete this task directly — do not call delegate.`;

  return [
    "=== FOCUSED TASK MODE ===",
    "",
    "You have been activated in focused task mode. You are Monika — same identity, same",
    "memory, same tools — working on a specific task for your main thread. Your context",
    "window is clean so you can focus entirely on this work.",
    "",
    "Task:",
    task,
    "",
    "Context from your main thread:",
    contextStr,
    "",
    `Delegation depth: ${depth} / 3. ${depthNote}`,
    "",
    "Work through this task thoroughly. Use your tools as needed. When you are done,",
    "end your final response with this marker on its own line:",
    "",
    `${TASK_COMPLETE_MARKER} <your summary here>`,
    "",
    "The summary should be comprehensive enough for your main thread to fully understand",
    "and integrate the work without re-examining raw details. Include key findings,",
    "decisions made, what you searched or read, and anything worth remembering long-term.",
    "",
    "=== END FOCUSED TASK MODE ===",
  ].join("\n");
}

function buildRecoveryTaskMessage(
  failedSessionFile: string,
  originalTask: string,
  terminationReason: string
): string {
  return [
    "=== RECOVERY MODE ===",
    "",
    "A delegate fork was terminated before it could finish. Your job is to read",
    "its session file and produce a recovery report so the parent session can",
    "continue with as much context as possible.",
    "",
    `Terminated fork session file: ${failedSessionFile}`,
    `Termination reason: ${terminationReason}`,
    "",
    "Original task assigned to the terminated fork:",
    originalTask,
    "",
    "Instructions:",
    `1. Read the session file at: ${failedSessionFile}`,
    "   It is JSONL — each line is a JSON object representing one session event.",
    '   Look for lines where "role" is "assistant" or "toolResult" to see what',
    "   the fork did and what tools returned.",
    "2. Identify what was completed before termination.",
    "3. List any side effects the parent MUST know about:",
    "   - Files created, modified, or deleted (check Write/Edit tool calls)",
    "   - Processes or servers started (check Bash tool calls)",
    "   - Any partial changes that left something in an inconsistent state",
    "4. Extract key findings, data, or decisions the fork produced.",
    "5. Identify what was NOT completed and still needs to be done.",
    "6. Report what the fork was doing when it was terminated (last tool call, etc.).",
    "",
    `End your response with: ${TASK_COMPLETE_MARKER} <recovery report>`,
    "",
    "Be thorough. The parent will use this to decide how to proceed.",
    "=== END RECOVERY MODE ===",
  ].join("\n");
}

// ─── Summary extraction ───────────────────────────────────────────────────────

function extractSummary(fullText: string, lastTurnText: string): string {
  const markerIdx = fullText.lastIndexOf(TASK_COMPLETE_MARKER);
  if (markerIdx !== -1) {
    const raw = fullText.slice(markerIdx + TASK_COMPLETE_MARKER.length).trim();
    if (raw.length > 0) return raw;
  }
  const fallback = lastTurnText.trim() || fullText.trim();
  console.warn("[delegate] TASK_COMPLETE: marker not found; using last turn text as summary.");
  return fallback;
}

// ─── Session setup helper ─────────────────────────────────────────────────────
// Shared between runFork() and attemptRecovery() to avoid duplication.

async function createForkSession(cwd: string) {
  const authStorage = AuthStorage.create(join(AGENT_DIR, "auth.json"));
  const modelsPath = join(AGENT_DIR, "models.json");
  const modelRegistry = new ModelRegistry(
    authStorage,
    existsSync(modelsPath) ? modelsPath : undefined
  );
  // Use disk-backed settings so the fork inherits the saved default model/provider.
  // SettingsManager.inMemory() loses the defaultProvider/defaultModel from settings.json,
  // causing the fork to pick the wrong provider (e.g. built-in 'anthropic' instead of
  // custom 'claude' proxy). Compaction is already disabled in settings.json.
  const settingsManager = SettingsManager.create(cwd, AGENT_DIR);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    settingsManager,
  });
  await resourceLoader.reload();
  const sessionManager = SessionManager.create(cwd, FORKS_DIR);
  const { session } = await createAgentSession({
    cwd,
    agentDir: AGENT_DIR,
    authStorage,
    modelRegistry,
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  // Pi 0.64.0+ requires explicit bindExtensions() to load extensions, register
  // extension tools, and build the full system prompt. Without this call, the fork
  // session has no tools from extensions and an incomplete prompt — causing it to
  // produce no useful output.
  await session.bindExtensions({
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: async () => ({ cancelled: true }),
      fork: async () => ({ cancelled: true }),
      navigateTree: async () => ({ cancelled: true }),
      switchSession: async () => ({ cancelled: true }),
      reload: async () => { await session.reload(); },
    },
    onError: (err) => {
      console.warn(`[delegate] Fork extension error (${err.extensionPath}): ${err.error}`);
    },
  });

  return session;
}

// ─── Shutdown helper ──────────────────────────────────────────────────────────
// Fires session_shutdown so stateful-memory writes a session summary, making
// fork work durable and recallable exactly like any other session.

async function shutdownForkSession(session: Awaited<ReturnType<typeof createForkSession>>) {
  try {
    await session.agent.waitForIdle();
    const runner = (session as any)["_extensionRunner"];
    if (runner?.hasHandlers("session_shutdown")) {
      await runner.emit({ type: "session_shutdown" });
    }
  } catch (err) {
    console.warn(`[delegate] Session summary write error: ${(err as Error).message}`);
  }
  session.dispose();
}

// ─── Main export ─────────────────────────────────────────────────────────────

export interface ForkResult {
  success: boolean;
  summary: string;
  sessionFile: string;
  error?: string;
  /** True when the fork was terminated early and the summary is a recovery report or partial output. */
  partial?: boolean;
}

/**
 * Run a fork session for the given task.
 *
 * @param task         - What the fork should accomplish.
 * @param context      - Optional context from the calling session's conversation.
 * @param depth        - Delegation depth (1 = called from trunk, 2 = from a fork, etc.).
 * @param cwd          - Working directory of the calling session.
 * @param parentSignal - The calling agent's AbortSignal. When the parent is aborted
 *                       (e.g. by its own timeout or a user interrupt), this fork is
 *                       aborted too, cascading the cancellation down the tree.
 */
export async function runFork(params: {
  task: string;
  context?: string;
  depth: number;
  cwd: string;
  parentSignal?: AbortSignal;
}): Promise<ForkResult> {
  const { task, context, depth, cwd, parentSignal } = params;

  // If the parent is already aborted before we even start, bail immediately.
  if (parentSignal?.aborted) {
    return {
      success: false,
      summary: "[Fork not started: parent was already cancelled.]",
      sessionFile: `(not-started-${Date.now()})`,
      error: "parent aborted before fork started",
      partial: false,
    };
  }

  mkdirSync(FORKS_DIR, { recursive: true });

  // ── Create fork session ────────────────────────────────────────────────────
  const forkSession = await createForkSession(cwd);
  const sessionFile = forkSession.sessionFile ?? `(in-memory-${Date.now()})`;
  console.log(`[delegate] Fork starting — depth ${depth}/3, file: ${sessionFile}`);

  // Register depth BEFORE prompt runs so the delegate tool can look it up.
  forkDepths.set(sessionFile, depth);

  // ── Abort chain ────────────────────────────────────────────────────────────
  // When the parent agent is aborted (by its own timeout or a user interrupt),
  // immediately abort this fork's agent too. The Pi agent abort signal threads
  // all the way into LLM streaming and tool.execute() calls, so this cascades
  // to bash process kills, sub-fork aborts, etc.
  const parentAbortHandler = () => {
    if (!agentResolved) {
      console.warn(`[delegate] Parent abort received — aborting depth ${depth} fork (${sessionFile})`);
      forkSession.agent.abort();
    }
  };
  parentSignal?.addEventListener("abort", parentAbortHandler);

  // ── State ──────────────────────────────────────────────────────────────────
  let fullText = "";
  let lastTurnText = "";
  let agentResolved = false;
  let timedOut = false;
  let runError: string | undefined;

  // ── Abort trigger ──────────────────────────────────────────────────────────
  // Called by inactivity check or absolute ceiling. Sets timedOut flag and
  // aborts the agent — which causes agent_end to fire, resolving forkPromise.
  const triggerAbort = (reason: "inactivity" | "ceiling") => {
    if (agentResolved) return;
    timedOut = true;
    const label = reason === "inactivity"
      ? `inactivity (no tree-wide activity for ${INACTIVITY_TIMEOUT_MS / 60000}min)`
      : `absolute ceiling (${ABSOLUTE_CEILING_MS / 3600000}h)`;
    console.warn(`[delegate] Terminating depth ${depth} fork due to ${label} — ${sessionFile}`);
    forkSession.agent.abort();
  };

  // ── Root-fork timers ───────────────────────────────────────────────────────
  // Only depth-1 forks own timers. Sub-forks are covered by the root's timers
  // via the parent abort chain — they don't need independent timers, which was
  // the cause of the "depth-2 fork killed independently" bug.
  let inactivityInterval: ReturnType<typeof setInterval> | undefined;
  let absoluteCeilingTimeout: ReturnType<typeof setTimeout> | undefined;

  if (depth === 1) {
    // Reset the activity timestamp at tree start so we don't inherit stale state
    // from a previous delegation tree in this session.
    touchActivity();

    inactivityInterval = setInterval(() => {
      if (agentResolved) {
        clearInterval(inactivityInterval!);
        return;
      }
      const idleMs = Date.now() - getLastActivity();
      if (idleMs > INACTIVITY_TIMEOUT_MS) {
        clearInterval(inactivityInterval!);
        clearTimeout(absoluteCeilingTimeout!);
        triggerAbort("inactivity");
      }
    }, ACTIVITY_CHECK_INTERVAL_MS);

    absoluteCeilingTimeout = setTimeout(() => {
      clearInterval(inactivityInterval!);
      triggerAbort("ceiling");
    }, ABSOLUTE_CEILING_MS);
  }

  // ── Run the fork ───────────────────────────────────────────────────────────
  // forkPromise always resolves (never rejects) — use flags for failure state.
  // This ensures we always have access to partial output on any exit path.
  const forkPromise = new Promise<void>((resolve) => {
    const unsub = forkSession.subscribe((event) => {
      // Update global activity timestamp on every event from any fork.
      // This is what the root fork's inactivity check reads.
      touchActivity();

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
        resolve();
      }
    });

    forkSession.prompt(buildTaskMessage(task, context, depth)).catch((err: Error) => {
      // prompt() rarely rejects (agent_end handles errors internally), but guard anyway.
      unsub();
      if (!agentResolved) {
        agentResolved = true;
        runError = err.message;
        resolve();
      }
    });
  });

  await forkPromise;

  // ── Clean up root timers ───────────────────────────────────────────────────
  if (inactivityInterval) clearInterval(inactivityInterval);
  if (absoluteCeilingTimeout) clearTimeout(absoluteCeilingTimeout);
  parentSignal?.removeEventListener("abort", parentAbortHandler);

  // ── Shutdown: trigger memory summarization ─────────────────────────────────
  await shutdownForkSession(forkSession);
  forkDepths.delete(sessionFile);

  // ── Normal completion ──────────────────────────────────────────────────────
  if (!timedOut && !runError) {
    const summary = extractSummary(fullText, lastTurnText);
    console.log(`[delegate] Fork complete — ${sessionFile}`);
    return { success: true, summary, sessionFile };
  }

  // ── Terminated (timeout or error): attempt recovery ────────────────────────
  const terminationReason = timedOut
    ? runError
      ? `timeout with error: ${runError}`
      : "inactivity timeout or absolute ceiling"
    : `error: ${runError}`;

  console.warn(`[delegate] Fork terminated — ${sessionFile} — reason: ${terminationReason}`);

  const recoveryReport = await attemptRecovery({
    failedSessionFile: sessionFile,
    originalTask: task,
    terminationReason,
    depth,
    cwd,
  });

  if (recoveryReport) {
    return {
      success: false,
      summary: recoveryReport,
      sessionFile,
      error: terminationReason,
      partial: true,
    };
  }

  // Recovery wasn't possible — return whatever partial text we accumulated.
  const partial = fullText.trim();
  return {
    success: false,
    summary: partial.length > 0
      ? `[Fork terminated: ${terminationReason}]\n\nPartial output before termination:\n\n${partial}`
      : `[Fork terminated: ${terminationReason}. No output was produced before termination.]`,
    sessionFile,
    error: terminationReason,
    partial: true,
  };
}

// ─── Recovery fork ────────────────────────────────────────────────────────────

async function attemptRecovery(params: {
  failedSessionFile: string;
  originalTask: string;
  terminationReason: string;
  depth: number;
  cwd: string;
}): Promise<string | null> {
  const { failedSessionFile, originalTask, terminationReason, depth, cwd } = params;

  // No room for a recovery fork at max depth.
  if (depth >= 3) {
    console.warn("[delegate] Skipping recovery: at max delegation depth");
    return null;
  }

  // Only attempt recovery if the session file has enough content to be worth reading.
  try {
    const stat = statSync(failedSessionFile);
    if (stat.size < RECOVERY_MIN_SESSION_BYTES) {
      console.warn(
        `[delegate] Skipping recovery: session file too small (${stat.size}B < ${RECOVERY_MIN_SESSION_BYTES}B)`
      );
      return null;
    }
  } catch {
    console.warn(`[delegate] Skipping recovery: session file not accessible (${failedSessionFile})`);
    return null;
  }

  console.log(`[delegate] Starting recovery fork for: ${failedSessionFile}`);

  // ── Create recovery session ────────────────────────────────────────────────
  // Recovery runs at the same depth level as the failed fork — it's not a
  // sub-task, it's a cleanup operation. No parentSignal: the recovery fork
  // is intentionally independent of whatever triggered the original termination.
  const recoverySession = await createForkSession(cwd);
  const recoverySessionFile = recoverySession.sessionFile ?? `(recovery-${Date.now()})`;
  forkDepths.set(recoverySessionFile, depth);

  console.log(`[delegate] Recovery fork — file: ${recoverySessionFile}`);

  let recoveryText = "";
  let recoveryResolved = false;
  let recoveryError: string | undefined;

  // Fixed short timeout for the recovery fork — just reads and summarizes.
  const recoveryAbortTimeout = setTimeout(() => {
    if (!recoveryResolved) {
      console.warn("[delegate] Recovery fork timed out — aborting");
      recoverySession.agent.abort();
    }
  }, RECOVERY_TIMEOUT_MS);

  const recoveryPromise = new Promise<void>((resolve) => {
    const unsub = recoverySession.subscribe((event) => {
      touchActivity();
      if (event.type === "message_update") {
        const ae = event.assistantMessageEvent;
        if (ae.type === "text_delta") {
          recoveryText += ae.delta;
        }
      } else if (event.type === "agent_end") {
        unsub();
        recoveryResolved = true;
        resolve();
      }
    });

    recoverySession
      .prompt(buildRecoveryTaskMessage(failedSessionFile, originalTask, terminationReason))
      .catch((err: Error) => {
        unsub();
        if (!recoveryResolved) {
          recoveryResolved = true;
          recoveryError = err.message;
          resolve();
        }
      });
  });

  await recoveryPromise;
  clearTimeout(recoveryAbortTimeout);

  await shutdownForkSession(recoverySession);
  forkDepths.delete(recoverySessionFile);

  if (recoveryError) {
    console.warn(`[delegate] Recovery fork failed with error: ${recoveryError}`);
    return null;
  }

  if (!recoveryText.trim()) {
    console.warn("[delegate] Recovery fork produced no output");
    return null;
  }

  // Extract summary from recovery output (handles TASK_COMPLETE: marker or falls back to full text).
  const markerIdx = recoveryText.lastIndexOf(TASK_COMPLETE_MARKER);
  const reportBody = markerIdx !== -1
    ? recoveryText.slice(markerIdx + TASK_COMPLETE_MARKER.length).trim()
    : recoveryText.trim();

  console.log(`[delegate] Recovery fork complete — ${recoverySessionFile}`);
  return `[Delegate terminated: ${terminationReason}]\n\n[Recovery report follows]\n\n${reportBody}`;
}
