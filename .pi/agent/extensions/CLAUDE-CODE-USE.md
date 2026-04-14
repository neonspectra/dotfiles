# Claude Code Use — `claude-code-use.ts`

## Purpose

This extension translates flat-named custom tools into MCP-style aliases when sending requests to the Anthropic API via the pool proxy (`claude` provider, `anthropic-messages` api format). It is a fork of `@benvargas/pi-claude-code-use` that replaces the hardcoded companion list with dynamic tool discovery, so it works with any extension's flat-named tools without coordination.

When the extension is active, flat tool names like `remember` get registered as `mcp__stateful-memory__remember` alongside the original, and the API request payload is rewritten to send only MCP aliases (flat names are filtered out). This prevents Anthropic from flagging unknown flat extension tool names as extra-usage on OAuth paths.

**If Anthropic ever goes away as a provider, delete this file and uninstall the upstream package.** All MCP alias registration disappears; every extension reverts to flat names. No coordination with individual extensions required.

---

## Upstream Reference

**Source:** https://github.com/ben-vargas/pi-packages  
**Package:** `@benvargas/pi-claude-code-use` (v1.0.1)  
**Commit:** `384e595` (latest as of 2026-04-14)

The upstream package intercepts `before_provider_request` and rewrites payloads for Anthropic OAuth subscription use. It rewrites the system prompt (replacing `pi itself` → `the cli itself` etc.), filters unknown flat tools, and remaps message history tool calls.

Our fork keeps the payload transform logic unchanged and replaces only the companion discovery with a dynamic approach.

---

## What This Extension Does

### 1. System prompt rewrite

Replaces three Pi-identifying phrases in system prompt text:
- `pi itself` → `the cli itself`
- `pi .md files` → `cli .md files`
- `pi packages` → `cli packages`

Applies to string system prompts and text blocks within array system prompts.

### 2. Available tools section rewrite

The `rewriteAvailableToolsSection()` function scans the "Available tools:" section of the system prompt text and rewrites flat tool names to MCP aliases. Tools that have no MCP alias (because they failed `deriveMcpAlias`) are removed from the tool list entirely. This prevents the model from learning flat names that would fail at the API layer.

### 3. Tool filtering

In `before_provider_request`, unknown flat-named tools are filtered out of the tools array. Core Claude Code tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `glob`, `webfetch`, `websearch`, etc.) and MCP-prefixed tools always pass through. Native typed tools (with a `type` field) pass through unconditionally.

### 4. Dynamic MCP alias registration

On `session_start` and every `before_agent_start`, the extension scans all registered tools. For any flat-named tool that:
- is not in `CORE_TOOL_NAMES`
- does not already start with `mcp__`
- has a derivable MCP alias

...it registers an MCP alias (`mcp__<namespace>__<flatName>`) using `pi.registerTool()` with a delegation shim that forwards execute calls to the original flat-named tool.

### 5. Alias auto-activation

`syncAliasActivation()` activates MCP aliases in the active tool set whenever `model.api === "anthropic-messages"`. On non-Anthropic requests, auto-activated aliases are removed but user-selected ones are preserved.

### 6. Message history rewriting

`remapMessageToolNames()` rewrites `tool_use` blocks in conversation history to use MCP aliases so the model sees consistent tool names across the conversation.

---

## Architecture

### Files

- **`~/.pi/agent/extensions/claude-code-use.ts`** — the extension itself

No other files are created by this extension.

### State

```typescript
const registeredMcpAliases = Set<string>;      // MCP aliases registered in this session
const autoActivatedAliases = Set<string>;        // MCP aliases auto-activated (not user-selected)
const FLAT_TO_MCP = Map<string, string>;         // flat_name → mcp_alias, rebuilt every turn
const FLAT_TOOL_DEFS = Map<string, ToolInfo>;    // flat_name → original tool def, for execute delegation
const KNOWN_TOOLS = Map<string, string>;          // fallback: flat_name → namespace for tools without sourceInfo
```

`registeredMcpAliases` persists across turns to avoid re-registering aliases. `FLAT_TO_MCP` and `FLAT_TOOL_DEFS` are cleared and rebuilt each turn.

---

## The KNOWN_TOOLS Fallback Map

Pi's resource loader (`resource-loader.js`) calls `applyExtensionSourceInfo()` to attach `sourceInfo` to every tool registered by an extension during the initial load phase. The `sourceInfo` contains `baseDir` (the extension's directory) and `path`.

However, **asynchronously registered tools don't get `sourceInfo`**. The stateful-memory extension registers its tools (`remember`, `recall`, `list_topics`, `load_topic`, `remember_session`) inside its `session_start` handler, which fires after extensions have loaded. By that point, `applyExtensionSourceInfo()` has already run, so those tools have no `sourceInfo`.

`deriveMcpAlias()` first checks `KNOWN_TOOLS` as a fallback before trying `sourceInfo`:

```typescript
function deriveMcpAlias(tool: ToolInfo, flatName: string): string | null {
    const flatNameLc = lower(flatName);
    // Fallback: check known tools map first (for asynchronously-registered tools)
    if (KNOWN_TOOLS.has(flatNameLc)) {
        return `mcp__${KNOWN_TOOLS.get(flatNameLc)}__${flatName}`;
    }
    // ... sourceInfo-based derivation
}
```

**Adding a new tool? Add it to `KNOWN_TOOLS`** in the constants section. The key is the flat tool name, the value is the namespace used in the MCP alias (the directory name of the extension).

Current entries:

```typescript
// stateful-memory
["list_topics", "stateful-memory"]
["load_topic", "stateful-memory"]
["remember", "stateful-memory"]
["remember_session", "stateful-memory"]
["recall", "stateful-memory"]
// delegate
["delegate", "delegate"]
// pi-self
["pi_run", "pi-self"]
// web-search
["web_search", "web-search"]
// pi-agent-browser (npm package)
["browser", "pi-agent-browser"]
```

The `browser` tool deserves special note: it's registered by the npm package `pi-agent-browser` (listed in `settings.json` `packages`), not by a file in `~/.pi/agent/extensions/`. Its `sourceInfo` points to the npm package directory, not an extension directory, so `deriveMcpAlias` via `sourceInfo` would derive `mcp__pi-agent-browser__browser`. The `KNOWN_TOOLS` entry matches this.

---

## The Execute Delegation Shim

When registering an MCP alias, the extension uses a shim that must delegate to the original flat-named tool's `execute`. The plan uses `TOOL_EXECUTES` (a `Map<flatName, executeFn>`):

```typescript
async execute(toolCallId, params, signal, onUpdate, ctx) {
    const executeFn = TOOL_EXECUTES.get(flatKey); // flatKey = flat tool name
    if (!executeFn) return { isError: true, content: [{ type: "text", text: "has no execute function cached" }] };
    return executeFn(toolCallId, params, signal, onUpdate, ctx);
}
```

**Why `TOOL_EXECUTES` is needed:** `ToolInfo` (returned by `getAllTools()`) intentionally omits `execute`. The type is `Pick<ToolDefinition, "name" | "description" | "parameters"> & { sourceInfo }`. The original approach of reading `originalTool.execute` from `FLAT_TOOL_DEFS` always returns `undefined`.

**How `TOOL_EXECUTES` gets populated:**
1. `pi.registerTool` is monkey-patched in the factory function to capture `execute` at tool registration time
2. `captureExecuteFromRunner()` is called on first `getAllTools()` to retroactively find execute via `ExtensionRunner.getToolDefinition` — currently the runner is not accessible, so this returns `undefined`

**Current limitation:** `ExtensionRunner.getToolDefinition(name)` is NOT exposed on `ExtensionAPI`. The `ExtensionRunner` instance is not accessible from extensions (`pi._runner`, `pi.runner`, `pi._extRunner` all return `undefined`). This means `captureExecuteFromRunner()` cannot retrieve execute functions for tools registered before the `registerTool` patch.

The monkey-patch on `registerTool` catches tools registered after the factory function runs (including those in `session_start` handlers), but handler execution order is uncertain — if stateful-memory's `session_start` fires before our handler, the flat tools are registered before our patch is in place.

**Key architectural fact:** `ExtensionRunner` holds the canonical tool registry including execute functions, but this is not accessible from extensions. A new `ExtensionAPI.getToolExecute(toolName)` method would cleanly resolve this.

See `HANDOFF.md` for full analysis and alternative approaches.

---

## Environment Variables

| Variable | Effect |
|---|---|
| `PI_CLAUDE_CODE_USE_DEBUG_LOG=/path/to/file` | Writes per-turn JSON logs with `stage: "before"` and `stage: "after"` payloads, plus `[register]` and `[session_start]` debug lines |
| `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` | Disables tool filtering entirely. All flat tools pass through unchanged. System prompt rewrite still applies. Use for debugging whether filtering is the problem. |

---

## How It Interacts With Your Extensions

### stateful-memory

Tools registered: `list_topics`, `load_topic`, `remember`, `remember_session`, `recall`

These are registered asynchronously in `session_start`. No `sourceInfo` is attached, so `KNOWN_TOOLS` fallback is required for alias derivation.

**Critical:** `FLAT_TOOL_DEFS` must have the original `remember` tool registered so the execute shim can delegate. See "Execute Delegation Shim" above for current status.

### delegate

Tool registered: `delegate`

No `sourceInfo` (directory `~/.pi/agent/extensions/delegate/`). `KNOWN_TOOLS` entry provides namespace.

### pi-self

Tool registered: `pi_run`

Wraps core tools (`read`, `write`, `edit`) and registers its own `pi_run`. The wrapped core tools are on `CORE_TOOL_NAMES` so they pass through the filter without needing aliases.

### web-search

Tool registered: `web_search`

`KNOWN_TOOLS` entry: `["web_search", "web-search"]`.

### ssh

Wraps core tools with SSH variants. Wrapped core tools (`read`, `write`, `edit`, `grep`, `find`, `ls`, `bash`) are on `CORE_TOOL_NAMES` — they pass through filter. The SSH wrapper tool itself is a flat name but has `sourceInfo` from being registered at extension load time, so it derives its alias from `sourceInfo`.

### tools (command extension)

Registers the `/tools` command, not a tool. Doesn't affect this extension.

### handoff, commands, force-tools, interactive-shell, pi-self, web-search

Various commands and non-tool extensions. No interaction with this extension.

---

## Removing This Extension

1. Delete `~/.pi/agent/extensions/claude-code-use.ts`
2. If you installed the upstream `pi-claude-code-use` package via `pi install`, run `pi remove npm:@benvargas/pi-claude-code-use`
3. Restart pi

All MCP aliases disappear. Tool filtering disappears. All extensions revert to flat names. No changes needed to any other extension.

---

## Maintenance: Syncing With Upstream

When pulling updates from https://github.com/ben-vargas/pi-packages:

1. Diff the helper functions in the "Payload Transform" section:
   - `rewritePromptText()` / `rewriteSystemField()`
   - `filterAndRemapTools()`
   - `remapToolChoice()`
   - `remapMessageToolNames()`
   - `transformPayload()`

2. Replace those blocks in this file with the upstream versions.

3. Re-apply our customizations:
   - Add `rewriteAvailableToolsSection()` and call it from `transformPayload()`
   - Replace `COMPANIONS` hardcoded list with our dynamic discovery in `registerAliasesForAllTools`
   - Replace `isOAuth` check with `model.api === "anthropic-messages"` for both `before_agent_start` and `before_provider_request`
   - Keep `KNOWN_TOOLS` fallback and `FLAT_TOOL_DEFS` population
   - Keep the execute delegation shim with the reverse lookup via `FLAT_TO_MCP`

4. Verify the `session_start` handler fires before the agent loop in Pi's event order (it does — `session_start` fires after extensions load but before the agent loop starts, giving aliases a chance to be registered before the first `before_agent_start`).

---

## Current Known Issues

### Execute delegation partially broken
The MCP alias shim uses `TOOL_EXECUTES.get(flatKey)` but `captureExecuteFromRunner()` cannot reach `ExtensionRunner.getToolDefinition` (not exposed on `ExtensionAPI`). The `registerTool` monkey-patch catches MCP alias registrations, but flat tools registered in `session_start` handlers may not be caught depending on handler execution order.

**Workaround:** `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` lets flat tool names through — works for pool proxy (MiniMax) but not for Anthropic OAuth.

### Available tools section rewrite untested
`rewriteAvailableToolsSection()` has not been confirmed to fire correctly in the actual API payload. The system prompt for the `claude` provider may use an array format with multiple blocks rather than a single string, and the rewrite logic only handles string prompts. This may need adjustment.

### `find` and `ls` skipped by deriveMcpAlias
These tools don't appear in `KNOWN_TOOLS` and don't have `sourceInfo` (registered by the SSH extension as wrappers around core tools, but the flat names `find` and `ls` aren't on `CORE_TOOL_NAMES`). They get skipped by `deriveMcpAlias`. They are currently filtered out in the after payload. This hasn't caused a visible problem but is worth noting.

### FLAT_TO_MCP is now append-only
Fixed: `FLAT_TO_MCP` is no longer cleared between turns. Previously, clearing it on turn 2 caused the shim's reverse lookup to fail. Now it accumulates flat→mcp mappings across the session, which is safe since it's keyed by flat name.