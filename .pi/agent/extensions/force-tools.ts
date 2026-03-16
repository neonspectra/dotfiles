/**
 * force-tools.ts
 *
 * Enforces a fixed active tool set on every session start and switch by calling
 * pi.setActiveTools(). This is required because other extensions (e.g. tools.ts,
 * if present) can restore a persisted tool selection that may not include newer
 * tools added since the selection was saved. Forcing ensures the full intended
 * set is always active.
 *
 * When adding a new extension tool, add its name here so it's picked up
 * automatically on every session start rather than requiring a manual /tools
 * toggle or session restart.
 *
 * Note: This is the local Pi harness version. The monika-core server version
 * uses a check-only variant because tools there are registered via
 * extensionFactories (which setActiveTools would interfere with).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function forceTools(pi: ExtensionAPI) {
  const tools = [
    // Built-in coding tools
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "bash",
    // Custom tools (registered by other extensions)
    "pi_run",
    "web_search",
    // Stateful memory tools (registered by stateful-memory extension)
    "remember",
    "recall",
    // Browser automation (registered by pi-agent-browser package)
    "browser",
    // Fractal delegation (registered by delegate extension)
    "delegate",
  ];

  const enable = () => {
    pi.setActiveTools(tools);
  };

  pi.on("session_start", async () => {
    enable();
  });

  pi.on("session_switch", async () => {
    enable();
  });
}
