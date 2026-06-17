/**
 * delegate/index.ts — Fractal Delegate Extension
 *
 * Registers the `delegate` tool, which spawns a focused sub-session (fork) to
 * handle a task independently and returns its summary as a tool result.
 *
 * The calling session stays in a clean tool-call wait state for the fork's
 * entire duration — no race conditions, standard Pi agent loop semantics.
 *
 * Depth tracking:
 *   Delegation depth is tracked via a module-level Map in fork-runner.ts,
 *   keyed on session file path. Trunk sessions default to depth 0 (not in map).
 *   Fork sessions have their depth registered before prompt() runs.
 *   This allows the same extension file (loaded once, shared across sessions in
 *   the process) to know each session's correct depth at tool-call time.
 *
 * Signal threading:
 *   The AbortSignal from Pi's tool execution machinery is passed into runFork()
 *   as parentSignal. If this session's agent is aborted (e.g. user interrupt,
 *   parent timeout cascade), the child fork is aborted immediately rather than
 *   running to completion as a zombie.
 *
 * Partial / recovery results:
 *   When a fork is terminated early (timeout, hang, error), the tool returns the
 *   recovery report or partial output as regular text content — not as an error.
 *   This lets the calling session read the recovery information and decide how to
 *   proceed, rather than receiving an opaque failure it can't act on.
 *
 * Architecture context: see monika-mono/monika-core/ARCHITECTURE.md
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { runFork, forkDepths } from "./fork-runner.js";

export default function delegateExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: [
      "Spawn a focused sub-session to handle a task independently.",
      "",
      "The sub-session runs with your full identity and memory access but a clean context,",
      "free from the current conversation history. It works through the task using all",
      "available tools and returns a summary when done.",
      "",
      "Delegate only when the trunk session needs an answer more than it needs the",
      "understanding, and when the result can be validated from a summary, diff, test,",
      "citation, or log. The trunk session should own orientation, problem framing,",
      "architectural judgment, and context likely to shape later decisions.",
      "",
      "The sub-session's work is automatically summarized into long-term memory when it",
      "finishes. Use remember() within the task for anything you want to specifically flag",
      "as important to retain.",
      "",
      "Max delegation depth: 3 levels from your main thread.",
    ].join("\n"),

    promptSnippet: "Spawn a focused sub-session for bounded tasks whose results can be validated from a summary, diff, test, citation, or log",

    promptGuidelines: [
      "The trunk session owns orientation, problem framing, architectural judgment, and any context likely to shape later decisions. Delegates are for bounded subproblems, not outsourcing the main thread's understanding.",
      "Before delegating, ask: does the trunk need understanding, or only an answer? If the trunk needs to build or refine its working model, do the reading/investigation directly. If it only needs a specific answer, result, or patch, delegation may be appropriate.",
      "Will the raw context matter later? If the details are likely to affect future decisions, keep them in trunk. If the details are disposable after a summary, delegate.",
      "Can the result be validated cleanly? Good delegate tasks can usually be checked by tests, diffs, exact citations, logs, or a concise factual answer. Avoid delegation when success depends on nuance, taste, identity/persona judgment, or broad architectural tradeoffs.",
      "Does the task depend on live session nuance? A small/testable output can still be a poor delegate task if quality depends on accumulated conversation context, intent, wording, or framing that would be lossy to brief. Keep that work in trunk unless the needed nuance can be compressed into a clear, low-loss task description.",
      "Use delegates for bounded, separable work: repetitive searches, mechanical migration sweeps, isolated implementation tasks, test/debug loops, narrow fact-finding, mechanical doc cleanup, or reading a large body of context to answer one specific disposable question.",
      "Do not delegate first-pass project orientation, broad investigation, design synthesis, persona/prompt judgment, nuanced documentation edits, or context that the trunk session will need in order to supervise the work intelligently.",
      "Examples — do not delegate: investigating how a repo works; understanding Pi session lineage to design forum-native handoff; reviewing prompt/persona behavior; choosing feature architecture; reading manageable core docs for a system you are about to modify; rewriting guidance to reflect a nuanced discussion from the current session.",
      "Examples — good delegate candidates: searching files for deprecated imports with exact paths/lines; applying an already-decided migration and running tests; finding exact docs/API references after the trunk has framed the design; reading a large generated log to identify the first causal error; reproducing an isolated bug with commands/output; inspecting many generated files for a specific malformed pattern; fixing typos or applying already-chosen wording across many docs.",
      "Mixed cases depend on phase and nuance: if docs/logs/tests may teach concepts or preserve live-session intent the trunk will use later, handle them directly; if they answer one narrow compatibility, citation, mechanical cleanup, or red/green question, delegate.",
      "Delegated sub-sessions have your full identity and memory but a clean context window. Their work is summarized into long-term memory automatically.",
      "Max delegation depth is 3 levels. At depth 3, complete tasks directly — do not call delegate.",
    ],

    parameters: Type.Object({
      task: Type.String({
        description:
          "Clear description of what the sub-session should accomplish. " +
          "Be specific — it won't have access to your conversation history.",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional: relevant context from the current conversation that the sub-session " +
            "needs to do its job. Excerpt key facts rather than summarizing everything.",
        })
      ),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      // Look up this session's delegation depth.
      // Trunk sessions are not in the map → default 0.
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "trunk";
      const depth = forkDepths.get(sessionFile) ?? 0;

      if (depth >= 3) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Delegation depth limit reached (max 3 levels from trunk). " +
                "Complete this task directly using your tools rather than delegating further.",
            },
          ],
          details: { depth, limitReached: true },
        };
      }

      const result = await runFork({
        task: params.task,
        context: params.context,
        depth: depth + 1,
        cwd: ctx.cwd,
        // Thread the calling agent's abort signal into the child fork.
        // If this session is aborted (timeout cascade, user interrupt, etc.),
        // the child fork aborts too rather than running on as a zombie.
        parentSignal: signal,
        parentSessionFile: sessionFile === "trunk" ? undefined : sessionFile,
      });

      // Partial / recovery results are returned as regular text so the calling
      // session can read the recovery report and continue intelligently.
      // Only hard failures with no output at all are flagged as errors.
      if (!result.success && !result.partial) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `The focused sub-session encountered an error: ${result.error}. ` +
                `Attempt the task directly, or report the failure to the user.`,
            },
          ],
          details: { depth, sessionFile: result.sessionFile, error: result.error },
        };
      }

      return {
        content: [{ type: "text" as const, text: result.summary }],
        details: {
          depth,
          sessionFile: result.sessionFile,
          ...(result.partial ? { partial: true, error: result.error } : {}),
        },
      };
    },
  });
}
