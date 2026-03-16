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
      "Use delegate for work that would dominate this context window: reading many files,",
      "extended research, code review, analysis tasks, or anything requiring many tool calls",
      "in sequence. Short and focused actions are better done directly.",
      "",
      "The sub-session's work is automatically summarized into long-term memory when it",
      "finishes. Use remember() within the task for anything you want to specifically flag",
      "as important to retain.",
      "",
      "Max delegation depth: 3 levels from your main thread.",
    ].join("\n"),

    promptSnippet: "Spawn a focused sub-session to handle tasks that would dominate the current context window",

    promptGuidelines: [
      "Use delegate for multi-file reading, extended research, code review, or any task requiring many sequential tool calls. Do short, focused actions directly.",
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
