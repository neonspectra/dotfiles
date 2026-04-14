# Handoff: claude-code-use.ts execute delegation bug

## What this extension does

Intercepts `before_provider_request` for `anthropic-messages` API format. Scans all registered tools, registers MCP-style aliases (`mcp__<namespace>__<toolName>`) for flat extension tools, and rewrites the API payload to send MCP aliases instead of flat names. This prevents Anthropic's pool proxy from flagging unknown flat extension tool names as extra-usage.

## The bug

**Problem:** The MCP alias shim (the `execute` function registered with the alias) returns `"Tool mcp__stateful-memory__remember not executable"` or `"has no execute function"`. The model calls the MCP alias correctly but execution fails.

**Root cause identified:** `getAllTools()` returns `ToolInfo` which intentionally omits `execute`. The type is:

```typescript
// dist/core/extensions/types.d.ts:956
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
    sourceInfo: SourceInfo;
};
```

`execute` is not in `ToolInfo`. The execute function is stored internally in the `ExtensionRunner`'s `RegisteredTool` objects (which have `{ definition: ToolDefinition, sourceInfo, ... }` — the definition includes execute). `getToolDefinition(name)` on `ExtensionRunner` returns `RegisteredTool["definition"]` which **does** include execute, but this method is NOT exposed on `ExtensionAPI`.

The extension's shim was trying to:
```typescript
const originalTool = FLAT_TOOL_DEFS.get(flatNameLc); // ToolInfo — no execute
const originalExecute = originalTool.execute; // always undefined
```

## What was attempted

### Attempt 1: Closure capture
Capture `originalTool.execute` at shim registration time. **Failed** — `ToolInfo` has no `execute`.

### Attempt 2: TOOL_EXECUTES map + monkey-patch registerTool
Wrap `pi.registerTool` in the factory function to capture execute at registration time. Store in `TOOL_EXECUTES` map. Shims look up from there.

**Problem:** Factory functions run during extension LOADING (sorted by filename). `claude-code-use.ts` loads first (c-first). `stateful-memory/` loads later as a subdirectory. The `session_start` handler in stateful-memory fires AFTER all extensions are loaded — and it calls `pi.registerTool()` to register `remember`, `recall`, etc. By that point, our patch IS in place and SHOULD catch them.

But the debug log shows: `(pi as any).getToolDefinition` is not accessible from `ExtensionAPI`. The monkey-patch on `registerTool` IS being called (we see `[registerTool]` logs for MCP alias registrations), but the flat tools (`remember`, etc.) are NOT showing up in those logs.

This suggests either:
- stateful-memory's `session_start` fires BEFORE `claude-code-use`'s `session_start` (extension loading order matters)
- OR `registerTool` is being called before our factory function wraps it

### Attempt 3: Wrap getAllTools for retroactive capture
Try to reach the `ExtensionRunner`'s internal `getToolDefinition` via `pi._runner`, `pi.runner`, `pi._extRunner`. All return `undefined`. The `ExtensionRunner` is not accessible from the `ExtensionAPI`.

### Attempt 4: Use tool_call event
Try to capture execute at `tool_call` event time. **Not yet implemented.** The `tool_call` event fires BEFORE tool execution and has `toolName` and `input` but NOT `execute`. However, the original tool IS being called by the model (the flat name version). If we intercept the flat tool call and redirect it to use the MCP alias's execute, this could work. But we'd need the execute function for the flat tool, which circles back to the same problem.

## Key architectural facts

- `ExtensionRunner.getAllRegisteredTools()` returns `RegisteredTool[]` (includes execute)
- `ExtensionRunner.getToolDefinition(name)` returns `RegisteredTool["definition"]` (includes execute)
- Neither is exposed on `ExtensionAPI`
- `ExtensionRunner` is NOT accessible from within an extension via the `ExtensionAPI` object
- `pi.registerTool` CAN be monkey-patched at factory function time
- `ToolInfo` (from `getAllTools()`) NEVER has `execute`
- Extension factory functions run during loading, sorted alphabetically by path
- `session_start` fires after all extensions load, in handler registration order

## State of the code

The current code in `claude-code-use.ts` has:
1. `TOOL_EXECUTES` map (defined but not populated correctly)
2. Monkey-patch on `pi.registerTool` (captures MCP alias registrations but NOT flat tools registered before our patch)
3. `captureExecuteFromRunner()` function (runner not accessible — never captures anything)
4. `getAllTools` wrapper that calls `captureExecuteFromRunner()` (doesn't help)
5. `registerAliasesForAllTools` with STILL BROKEN shim: `const originalExecute = originalTool.execute;` (reads undefined from ToolInfo)

**The shim still uses the broken approach.** The `originalExecute` is always `undefined`. The fix (using `TOOL_EXECUTES.get(flatKey)`) was planned but not applied to `registerAliasesForAllTools`.

## Potential next approaches

1. **tool_call event interception**: Listen for `tool_call` on flat tool names, look up the MCP alias, and redirect execution. But we'd still need the execute function.

2. **Register the MCP alias BEFORE session_start**: Register MCP aliases during extension loading (in the factory function), not in `session_start`. At factory time, tools aren't registered yet, so there's nothing to alias. But we could pre-register stub aliases that get wired up when the flat tools register in `session_start`.

3. **Wrap `session_start` handlers**: Intercept all `pi.on("session_start", ...)` calls and add a wrapper that captures `registerTool` calls within the handler.

4. **Fork the stateful-memory extension**: Add MCP alias registration directly to stateful-memory's `session_start` handler. Not ideal — requires coordination.

5. **Ask Mario for a new API**: `ExtensionAPI.getToolExecute(toolName): Promise<ToolExecuteFn | undefined>` that returns the execute function if accessible.

6. **Accept the limitation**: The `PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER=1` workaround lets flat names through without MCP aliasing. This works for pool proxy (MiniMax, o4-mini) but not for Anthropic OAuth which requires MCP-style names.

## What works

- MCP alias registration: aliases ARE being registered and appearing in API payloads correctly
- Tool filtering: flat extension tools ARE being filtered out of Anthropic API payloads correctly
- System prompt rewriting: works
- The extension is architecturally sound except for the execute delegation

## Test commands

```bash
# Test with Claude (pool proxy, anthropic-messages format)
PI_CLAUDE_CODE_USE_DEBUG_LOG=/tmp/ccu.log pi --print --no-session \
  --model "claude/claude-opus-4-6" \
  'Call the remember tool with items=["test"] and target="memory".'

# Check the debug log
grep -E "\[execute\]|\[registerTool\]|\[runner\]" /tmp/ccu.log
```

## Files

- `~/.pi/agent/extensions/claude-code-use.ts` — the extension (current state: broken shim)
- `~/.pi/agent/extensions/CLAUDE-CODE-USE.md` — documentation (needs updating)
- PR: https://github.com/neonspectra/dotfiles/pull/15 (branch: `claude-code-use-extension`)
