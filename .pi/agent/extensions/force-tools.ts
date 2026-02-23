import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function forceTools(pi: ExtensionAPI) {
  const tools = [
    "read",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "bash",
    "pi_run",
    "web_search",
    "remember",
    "recall",
    "browser",
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
