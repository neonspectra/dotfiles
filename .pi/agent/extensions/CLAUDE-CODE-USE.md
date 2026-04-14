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
const TOOL_EXECUTES = Map<string, ToolExecuteFn>;  // flat_name → execute function, captured via Map.prototype.set patch
const registeredMcpAliases = Set<string>;      // MCP aliases registered in this session
const autoActivatedAliases = Set<string>;        // MCP aliases auto-activated (not user-selected)
const FLAT_TO_MCP = Map<string, string>;         // flat_name → mcp_alias, rebuilt every turn
const FLAT_TOOL_DEFS = Map<string, ToolInfo>;    // flat_name → original tool def, for execute delegation
const KNOWN_TOOLS = Map<string, string>;          // fallback: flat_name → namespace for tools without sourceInfo
```

`registeredMcpAliases` persists across turns to avoid re-registering aliases. `FLAT_TO_MCP` and `FLAT_TOOL_DEFS` are cleared and rebuilt each turn.

---

## Internal Architecture: The Execute Capture Problem

The hardest part of this extension is capturing the `execute` function from other extensions' tools. The problem is deceptively simple — "forward the MCP alias call to the original tool" — but Pi's extension API is deliberately designed to prevent cross-extension access to execute functions. This section documents the full flow, the approaches that failed, and why the final approach works.

### The constraint

Pi's Anthropic OAuth proxy rejects API requests containing unknown flat tool names (anything not in Claude Code's built-in tool set). Extension tools like `remember`, `delegate`, `browser` all get rejected. The extension works around this by:

1. Registering MCP-style aliases (`mcp__stateful-memory__remember`) for each flat tool
2. Filtering flat names out of the API payload so only MCP aliases survive
3. Delegating MCP alias execution back to the original flat tool's `execute` function

Steps 1–2 are straightforward. Step 3 requires access to the original tool's `execute` function — which Pi's API deliberately withholds.

### How Pi stores tool definitions internally

```
┌─────────────────────────────────────────────────────────────────┐
│ ExtensionRunner                                                 │
│                                                                 │
│  extensions: [                                                  │
│    {                                                            │
│      path: "~/.pi/agent/extensions/stateful-memory/",          │
│      tools: Map {                         ◄── has execute      │
│        "remember" → { definition: { name, execute, ... },      │
│                         sourceInfo }                            │
│      },                                                         │
│      handlers: Map { ... }                                      │
│    },                                                           │
│    {                                                            │
│      path: "~/.pi/agent/extensions/claude-code-use.ts",        │
│      tools: Map {                                               │
│        "mcp__stateful-memory__remember" → {                     │
│          definition: { name, execute: shimFn, ... },            │
│          sourceInfo                                             │
│        }                                                        │
│      }                                                          │
│    }                                                            │
│  ]                                                              │
│                                                                 │
│  getToolDefinition(name) → definition  ◄── NOT on ExtensionAPI  │
│  getAllRegisteredTools()  → RegisteredTool[] ◄── NOT on API     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ Each extension gets its own ExtensionAPI object                 │
│ (created by createExtensionAPI in loader.js)                    │
│                                                                 │
│  api.registerTool(tool) {                                       │
│    extension.tools.set(tool.name, {definition: tool, ...});     │
│    runtime.refreshTools();                                      │
│  }                                                              │
│                                                                 │
│  api.getAllTools() {                                            │
│    return runtime.getAllTools();  ◄── strips execute            │
│  }                                                              │
│                                                                 │
│  api.on(event, handler) { ... }                                 │
│  api.exec(cmd, args, opts) { ... }                              │
│  ...                                                            │
└─────────────────────────────────────────────────────────────────┘
```

The type that `getAllTools()` returns:

```typescript
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
    sourceInfo: SourceInfo;
};
```

`execute` is intentionally excluded. The `ExtensionRunner` holds the full definitions (including `execute`) in each extension's `tools` Map, but neither `getToolDefinition()` nor `getAllRegisteredTools()` is exposed on the `ExtensionAPI` interface.

### Full lifecycle sequence

```
Extension Loading (sorted alphabetically by path)
═══════════════════════════════════════════════════

1. claude-code-use.ts loads
   ├── factory function runs
   ├── Map.prototype.set patched  ◄── captures ALL subsequent tool registrations
   ├── session_start handler registered
   ├── before_agent_start handler registered
   └── before_provider_request handler registered

2. delegate/index.ts loads
   ├── factory function runs
   ├── pi.registerTool({ name: "delegate", execute: fn, ... })
   │   └── extension.tools.set("delegate", { definition, sourceInfo })
   │       └── Map.prototype.set fires → TOOL_EXECUTES.set("delegate", fn) ✓
   └── (other registrations)

3. pi-self.ts loads → pi_run captured ✓

4. ssh.ts loads → ssh tools captured ✓

5. stateful-memory/extension.js loads
   ├── factory function runs
   ├── pi.registerTool({ name: "remember", execute: fn, ... })
   │   └── Map.prototype.set fires → TOOL_EXECUTES.set("remember", fn) ✓
   ├── pi.registerTool({ name: "recall", execute: fn, ... }) → captured ✓
   ├── pi.registerTool({ name: "list_topics", ... }) → captured ✓
   ├── pi.registerTool({ name: "load_topic", ... }) → captured ✓
   └── pi.registerTool({ name: "remember_session", ... }) → captured ✓

6. web-search.ts loads → web_search captured ✓

Session Initialization
═══════════════════════

7. bindCore() runs
   └── _refreshToolRegistry() builds _toolDefinitions and _toolRegistry
       from all extensions' tools Maps

8. session_start event fires
   ├── claude-code-use's handler runs:
   │   ├── restoreMapSet() — removes Map.prototype.set patch
   │   └── registerAliasesForAllTools():
   │       ├── scans getAllTools() for flat-named tools
   │       ├── for each: deriveMcpAlias() → "mcp__stateful-memory__remember"
   │       └── pi.registerTool({ name: "mcp__...", execute: shim })
   │           shim looks up TOOL_EXECUTES.get("remember") → original fn ✓
   └── stateful-memory's handler runs (summarization setup, etc.)

Agent Turn
══════════

9. before_agent_start fires
   └── registerAliasesForAllTools() — ensures aliases exist
   └── syncAliasActivation() — activates MCP aliases when model.api === "anthropic-messages"

10. before_provider_request fires
    └── transformPayload():
        ├── rewriteSystemField() — "pi itself" → "the cli itself"
        ├── rewriteAvailableToolsSection() — flat names → MCP aliases in tool list
        ├── filterAndRemapTools() — removes flat tools, keeps MCP aliases
        ├── remapToolChoice() — updates tool_choice if it references a flat name
        └── remapMessageToolNames() — rewrites historical tool_use blocks

11. Model receives payload with only MCP-style tool names
    └── Model responds with tool_use: { name: "mcp__stateful-memory__remember", ... }

12. Pi looks up "mcp__stateful-memory__remember" in _toolRegistry
    └── Finds our shim tool
    └── Shim's execute runs:
        ├── TOOL_EXECUTES.get("remember") → original execute function
        └── Calls original execute(toolCallId, params, signal, onUpdate, ctx)
            └── stateful-memory's remember logic runs ✓
```

### Approaches that failed

#### Approach 1: Read `execute` from `getAllTools()`

```typescript
const originalTool = FLAT_TOOL_DEFS.get(flatNameLc);
const execute = originalTool.execute; // always undefined
```

**Failed because:** `ToolInfo` is `Pick<ToolDefinition, "name" | "description" | "parameters">`. The `execute` property is explicitly excluded from the type. This is by design — the extension API is meant to expose tool metadata for display purposes, not for cross-invocation.

#### Approach 2: Monkey-patch `pi.registerTool`

```typescript
const orig = pi.registerTool.bind(pi);
pi.registerTool = function(tool) {
    TOOL_EXECUTES.set(tool.name, tool.execute);
    return orig(tool);
};
```

**Failed because:** Each extension gets its own `ExtensionAPI` object, created by `createExtensionAPI()` in `loader.js`. The `registerTool` method is a closure over that extension's own `extension` object. Patching our API's `registerTool` method only intercepts calls made through our API object — other extensions call their own `registerTool` closures, which are untouched.

This was confirmed by debug logs: the patched `registerTool` caught our own MCP alias registrations but never saw `remember`, `delegate`, etc.

#### Approach 3: Access `ExtensionRunner` via `pi` properties

```typescript
const runner = pi._runner ?? pi._extRunner ?? pi.runner;
const def = runner.getToolDefinition(toolName);
```

**Failed because:** The `ExtensionRunner` instance is not stored on the `ExtensionAPI` object. The API is a plain object literal with methods that close over `runtime` and `extension` — neither of which is accessible as a property. Tried `_runner`, `_extRunner`, `runner`, and general property enumeration. All returned `undefined`.

#### Approach 4: Wrap `getAllTools()` for retroactive capture

```typescript
const origGetAllTools = pi.getAllTools.bind(pi);
pi.getAllTools = function() {
    captureExecuteFromRunner(pi);
    return origGetAllTools();
};
```

**Failed because:** This relies on Approach 3 (reaching the runner). Without runner access, the wrapper fires but can't extract execute functions from the result.

#### Approach 5: Intercept `tool_call` event to redirect execution

```typescript
pi.on("tool_call", (event) => {
    if (event.toolName.startsWith("mcp__")) {
        // Can we redirect to the flat tool?
    }
});
```

**Failed because:** The `tool_call` event (`ToolCallEventResult`) only supports `block?: boolean` and `reason?: string`. There's no mechanism to redirect execution to a different tool name. The event fires before execution and can block it, but can't change which tool runs.

#### Approach 6: Rewrite model responses before tool execution

The idea: don't register MCP aliases as tools at all. Instead, rewrite the model's tool_use response (changing `mcp__stateful-memory__remember` back to `remember`) before Pi looks up the tool.

**Failed because:** There's no event hook between "model response received" and "tool execution begins." The available events (`message_update`, `message_end`, `tool_execution_start`) are informational — they fire as the response streams in but don't allow modifying the tool name. The tool lookup happens in Pi's agent core, which we can't intercept.

#### Approach 7: Access `sessionManager` to reach `AgentSession`

The `ExtensionContext` passed to event handlers has a `sessionManager` property typed as `ReadonlySessionManager`.

**Failed because:** `ReadonlySessionManager` is `Pick<SessionManager, ...>` — it doesn't include `getToolDefinition`. Even at runtime, `SessionManager` and `AgentSession` are separate classes. The tool registry lives on `AgentSession` (as `_toolRegistry` and `_toolDefinitions`), not on `SessionManager`. The session manager manages session persistence, not tool execution.

#### Approach 8: Traverse closure scope or prototype chain

Attempts to reach the shared `runtime` object through the `pi` API's methods:
- `pi.getAllTools` closes over `runtime` — but JavaScript closures aren't accessible as properties
- `pi.events` is the event bus — doesn't reference `runtime` or the runner
- `pi.registerTool` closes over both `extension` and `runtime` — same closure problem

**Failed because:** JavaScript closures are opaque. You can't extract bound variables from a function reference.

### Why `Map.prototype.set` works

All extensions store tools in `Map` instances (`extension.tools = new Map()`). When `registerTool` is called, it does:

```javascript
extension.tools.set(tool.name, {
    definition: tool,  // includes execute
    sourceInfo: extension.sourceInfo
});
```

`Map.prototype.set` is shared across ALL Map instances in the process. By patching it in our factory function (which loads first alphabetically), we intercept every `Map.set` call during subsequent extension loading. The patch:

1. Checks if the value looks like a tool registration (`value.definition.name` is a string, `value.definition.execute` is a function)
2. Stores the execute function in `TOOL_EXECUTES`
3. Excludes MCP aliases (key starts with `mcp__`) to avoid capturing our own shim functions
4. Calls the original `Map.prototype.set` — no behavior change, just observation

The patch is restored during `session_start` (after all extensions have loaded and registered their tools), minimizing its active window.

**Tradeoffs:** This is a global prototype patch, which is inherently invasive. The shape-detection guard (`definition.execute` is a function) prevents false positives from normal Map usage. The patch is active only during extension loading (~100ms), after which it's restored. If Pi's internal tool storage ever moves away from `Map`, this approach breaks — but that's unlikely given how fundamental `Map` is to the extension system.

### If this ever breaks: the clean upstream fix

The ideal solution is a new `ExtensionAPI` method:

```typescript
getToolExecute(toolName: string): ToolExecuteFn | undefined;
```

This would expose execute functions without requiring prototype patching. It would live on `ExtensionAPI`, implemented by reading from the `ExtensionRunner`'s `getToolDefinition(name)`, which already has access to the full definition. If Mario adds this API, the `Map.prototype.set` patch can be removed entirely and replaced with a simple lookup in the MCP alias's execute shim.

---

## The KNOWN_TOOLS Fallback Map

Pi's resource loader (`resource-loader.js`) calls `applyExtensionSourceInfo()` to attach `sourceInfo` to every tool registered by an extension during the initial load phase. The `sourceInfo` contains `baseDir` (the extension's directory) and `path`.

However, **tools from subdirectory extensions (like `stateful-memory/`) and npm packages don't always get usable `sourceInfo`** for alias derivation. The `stateful-memory` extension registers its tools during factory loading, but the `sourceInfo` may not contain a useful `baseDir` depending on how the resource loader processes subdirectories.

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

The `Map.prototype.set` monkey-patch captures execute functions during extension loading. Each extension's `registerTool()` stores tool definitions in a `Map` (`extension.tools.set(name, {definition, sourceInfo})`). Since all Map instances share `Map.prototype.set`, patching it lets us observe every tool registration across all extensions — not just our own.

The patch checks each `Map.set(key, value)` call for the tool registration shape: `key` is a string, `value.definition` has a `name` string and an `execute` function. MCP alias registrations (key starts with `mcp__`) are excluded to avoid capturing our own shim functions.

The patch is installed in our factory function (which loads first alphabetically as `claude-code-use`), so it's active when all subsequent extensions register their tools. It's restored to the original `Map.prototype.set` during `session_start` (after all factories and session_start handlers complete), minimizing the window where the patch is active.

**Why the previous approaches failed:**
- Monkey-patching `pi.registerTool` only affects our extension's API object — each extension gets its own `createExtensionAPI()` closure, so patching ours doesn't intercept other extensions' calls
- `ToolInfo` (from `getAllTools()`) intentionally omits `execute` via `Pick<ToolDefinition, "name" | "description" | "parameters">`
- `ExtensionRunner.getToolDefinition(name)` includes execute but is not exposed on `ExtensionAPI`
- The `ExtensionRunner` instance is not accessible from extensions via any property on `pi`

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

These are registered during extension loading (in the factory function body, not `session_start`). No `sourceInfo` is attached, so `KNOWN_TOOLS` fallback is required for alias derivation. Execute functions are captured by the `Map.prototype.set` monkey-patch.

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

## Testing

### Smoke test: execute delegation

This test verifies that the full pipeline works — MCP alias registration, payload filtering, model tool call, and execute delegation back to the original flat tool.

```bash
# Test: model calls remember through MCP alias
rm -f /tmp/ccu-test.log
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/ccu-test.log pi --print --no-session \
  --model "claude/claude-opus-4-6" \
  'Call the remember tool with items=["execute capture test"] and target="memory".'
```

**Expected stdout:** The tool runs successfully (e.g., `Done — stored "execute capture test" to memory.`)

**Expected debug log:**
```
[map-set] captured execute for remember       ← execute function captured during extension loading
[map-set] restored Map.prototype.set          ← patch removed after session_start
[session_start] done, registered: ...mcp__stateful-memory__remember...
[execute] mcp__stateful-memory__remember called — flatKey=remember hasExecute=true
```

Key things to check:
- `hasExecute=true` in the `[execute]` line — if `false`, the capture failed
- `captured execute for remember` appears in `[map-set]` lines — if missing, the Map patch didn't fire
- `restored Map.prototype.set` appears before `[execute]` — confirms patch cleanup

### Smoke test: recall (read-path verification)

Tests the read direction — model calls `recall` through its MCP alias.

```bash
rm -f /tmp/ccu-test.log
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/ccu-test.log pi --print --no-session \
  --model "claude/claude-opus-4-6" \
  'Call the recall tool with query="anything".'

grep "\[execute\]" /tmp/ccu-test.log
# Expected: [execute] mcp__stateful-memory__recall called — flatKey=recall hasExecute=true
```

### Checking the full debug log

```bash
# All execute delegation events
grep -E "\[execute\]|\[map-set\] captured|\[map-set\] restored|\[session_start\]" /tmp/ccu-test.log

# Verify flat tools were filtered from the API payload (after stage)
grep -A2 '"name": "remember"' /tmp/ccu-test.log | grep after
# Should find nothing — flat names are removed in the after stage

# Verify MCP aliases ARE in the API payload (after stage)
grep '"name": "mcp__stateful-memory__remember"' /tmp/ccu-test.log
# Should find the MCP alias in the after stage
```

### Testing the escape hatch

If execute delegation breaks, `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` disables all filtering so flat names pass through unchanged. This works for pool proxy but NOT for direct Anthropic OAuth (which rejects flat names).

```bash
PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1 pi --print --no-session \
  --model "claude/claude-opus-4-6" \
  'Call the remember tool with items=["fallback test"] and target="memory".'
```

### Debugging checklist

| Symptom | Check | Likely cause |
|---|---|---|
| `hasExecute=false` in log | `[map-set] captured` lines | Map.prototype.set patch didn't fire or was installed too late |
| Tool not found error | `[register] knownNames` line in log | MCP alias not registered — check `deriveMcpAlias` returned null |
| Tool filtered out unexpectedly | `[skip]` lines in log | `deriveMcpAlias` returned null — add tool to `KNOWN_TOOLS` |
| `restoreMapSet` missing from log | `[session_start]` lines | session_start handler didn't fire — Pi lifecycle changed? |
| Model uses flat name instead of MCP alias | `[register]` + after-stage payload | MCP alias not in active tools — check `syncAliasActivation` |

---

## Pi Upgrade Watchlist

These are the internal Pi details that this extension depends on. If Pi changes any of them, the extension may break silently or loudly.

### Breaking: extension tool storage moves away from `Map`

**Current:** Extension tools are stored in `extension.tools = new Map()`, set via `extension.tools.set(tool.name, {definition, sourceInfo})`.

**If Pi switches to a plain object, `Set`, `Array`, or any other data structure**, the `Map.prototype.set` monkey-patch stops capturing execute functions. The MCP aliases would register correctly but their execute shims would return `hasExecute=false`.

**Detection:** Run the smoke test after any Pi upgrade. If `hasExecute=false`, check whether `extension.tools` is still a `Map` by adding a debug log:
```typescript
console.log('tools constructor:', extension.tools.constructor.name);
```

### Breaking: `ToolInfo` type definition changes

**Current:** `ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & { sourceInfo }`.

If Pi adds `execute` to `ToolInfo` (which would be the ideal upstream fix), the `Map.prototype.set` patch becomes unnecessary. But if Pi changes the `ToolInfo` shape in some other way (e.g., renaming `parameters` to `inputSchema`), `FLAT_TOOL_DEFS` and the MCP alias registration would break.

**Detection:** Check `dist/core/extensions/types.d.ts` for the `ToolInfo` type definition after upgrades.

### Breaking: extension loading order changes

**Current:** Extensions load alphabetically by path. `claude-code-use.ts` loads before `delegate/`, `pi-self.ts`, `ssh.ts`, `stateful-memory/`, and `web-search.ts`.

If Pi changes the loading order (e.g., deterministic but not alphabetical, or parallel loading), the `Map.prototype.set` patch might not be installed when other extensions register their tools.

**Detection:** Check `[map-set] captured` lines in the debug log. If they're missing or only show our own tools, the loading order changed.

### Breaking: `createExtensionAPI` signature changes

**Current:** `createExtensionAPI(extension, runtime, cwd, eventBus)` creates a plain object literal with methods that close over `extension` and `runtime`. Neither is accessible as a property.

If Pi changes to a class-based API or adds a reference to `runtime`/`extension` as a property, some of the failed approaches might start working (which would be good — we could simplify). But if Pi adds `Object.freeze()` or `Object.seal()` to the API object, our code would still work (we don't modify the API object itself anymore).

### Non-breaking but noteworthy: new tools or extensions

When adding a new extension that registers flat-named tools:

1. If the tool has `sourceInfo` with a usable `baseDir`, `deriveMcpAlias` will derive the alias automatically — no changes needed.
2. If the tool has no `sourceInfo` or an unusable one, add it to `KNOWN_TOOLS` in the constants section.
3. Run the smoke test to verify `hasExecute=true` for the new tool.

### Non-breaking but noteworthy: `CORE_TOOL_NAMES` changes

Pi's built-in tool set may grow over time. The `CORE_TOOL_NAMES` set in this extension mirrors the list in `packages/ai/src/providers/anthropic.ts` in Pi's source. If Pi adds new built-in tools, they need to be added to `CORE_TOOL_NAMES` here, otherwise they'll get MCP aliases (harmless but unnecessary) or get filtered out (breaking).

**Detection:** After a Pi upgrade, check if new tool names appear in `[skip]` debug log lines or if previously-working tools stop appearing in the API payload.

### The clean upstream fix

If Mario adds `ExtensionAPI.getToolExecute(toolName): ToolExecuteFn | undefined` (or similar), the entire `Map.prototype.set` patch can be replaced with a simple lookup in the execute shim. This would eliminate all loading-order sensitivity and prototype-patch fragility. The architecture section has full details on what this would look like.

---

## Resolved Issues

### ~~Execute delegation broken~~ (Resolved 2026-04-14)
Execute delegation now works via `Map.prototype.set` monkey-patch. All flat tool execute functions are captured during extension loading and the patch is restored after `session_start`. Verified with `remember` and `recall` tools returning `hasExecute=true`.

## Current Known Issues

### Available tools section rewrite untested
`rewriteAvailableToolsSection()` has not been confirmed to fire correctly in the actual API payload. The system prompt for the `claude` provider may use an array format with multiple blocks rather than a single string, and the rewrite logic only handles string prompts. This may need adjustment.

### `find` and `ls` skipped by deriveMcpAlias
These tools don't appear in `KNOWN_TOOLS` and don't have `sourceInfo` (registered by the SSH extension as wrappers around core tools, but the flat names `find` and `ls` aren't on `CORE_TOOL_NAMES`). They get skipped by `deriveMcpAlias`. They are currently filtered out in the after payload. This hasn't caused a visible problem but is worth noting.

### FLAT_TO_MCP is now append-only
Fixed: `FLAT_TO_MCP` is no longer cleared between turns. Previously, clearing it on turn 2 caused the shim's reverse lookup to fail. Now it accumulates flat→mcp mappings across the session, which is safe since it's keyed by flat name.