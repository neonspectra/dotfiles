/**
 * Claude Code Use — pi-claude-code-use fork with dynamic tool discovery
 *
 * ## Upstream
 *
 * Based on: https://github.com/ben-vargas/pi-packages
 * Package: @benvargas/pi-claude-code-use (v1.0.1)
 * Commit: 384e595 (latest as of 2026-04-14)
 *
 * Original purpose: Patch Anthropic OAuth payloads for Claude Code-style subscription use.
 * This fork replaces the hardcoded companion list with dynamic tool discovery so it works
 * with any extension's flat-named tools without coordination.
 *
 * ## What This Extension Does
 *
 * When Pi is using Anthropic OAuth, this extension intercepts outbound API requests via
 * `before_provider_request` and:
 *
 * 1. System prompt rewrite — rewrites Pi-identifying phrases:
 *    `pi itself` → `the cli itself`
 *    `pi .md files` → `cli .md files`
 *    `pi packages` → `cli packages`
 *
 * 2. Tool filtering — removes unknown flat-named extension tools from the request payload.
 *    Core Claude Code tools and MCP-prefixed tools always pass through.
 *
 * 3. MCP alias remapping — flat extension tools that were registered under an MCP-style
 *    alias get their flat names replaced with the alias in the payload.
 *
 * 4. Dynamic alias registration — instead of a hardcoded companion list, this extension
 *    dynamically discovers all registered tools on every agent turn and registers MCP-style
 *    aliases (`mcp__<extension>__<toolName>`) for any flat-named tool not on the allowlist.
 *    This means any extension's tools survive the filter automatically, with no coordination
 *    required between extensions and this package.
 *
 * 5. Message history rewriting — tool_use blocks in conversation history are rewritten
 *    to use MCP aliases so the model sees consistent names across the conversation.
 *
 * 6. tool_choice remapping — if tool_choice references a flat name that was remapped,
 *    the reference is updated to the MCP alias.
 *
 * Non-OAuth Anthropic requests and non-Anthropic providers are left completely unchanged.
 *
 * ## Removing This Extension
 *
 * Delete this file and uninstall the upstream pi-claude-code-use package if installed.
 * All MCP aliases disappear, tool filtering disappears, and every extension reverts to
 * flat names. No coordination with individual extensions required.
 *
 * ## Maintenance
 *
 * When syncing with upstream:
 * 1. Pull the latest version from https://github.com/ben-vargas/pi-packages
 * 2. Diff against this file, specifically the helper functions in the "Payload Transform"
 *    section below
 * 3. Replace the relevant blocks below, then re-apply the dynamic alias registration
 *    in before_agent_start and session_start
 * 4. The system prompt rewrite, filter logic, message remapping, and tool_choice remapping
 *    are copy-pasted from upstream with minimal changes — track them with upstream commits
 */

import { appendFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type ToolRegistration = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

// ============================================================================
// Constants
// ============================================================================

/**
 * Core Claude Code tool names that always pass through Anthropic OAuth filtering.
 * Stored lowercase for case-insensitive matching.
 * Mirrors Pi core's claudeCodeTools list in packages/ai/src/providers/anthropic.ts
 */
const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"askuserquestion",
	"enterplanmode",
	"exitplanmode",
	"killshell",
	"notebookedit",
	"skill",
	"task",
	"taskoutput",
	"todowrite",
	"webfetch",
	"websearch",
]);

/**
 * Flat tool name → namespace for tools that don't have sourceInfo.
 * Covers tools registered asynchronously (e.g. stateful-memory registers inside session_start,
 * after the resource loader has already attached sourceInfo to other extensions' tools).
 * Namespace is the directory name of the extension that owns the tool.
 */
const KNOWN_TOOLS = new Map<string, string>([
	// stateful-memory
	["list_topics", "stateful-memory"],
	["load_topic", "stateful-memory"],
	["remember", "stateful-memory"],
	["remember_session", "stateful-memory"],
	["recall", "stateful-memory"],
	// delegate
	["delegate", "delegate"],
	// pi-self
	["pi_run", "pi-self"],
	// web-search
	["web_search", "web-search"],
	// browser (pi-agent-browser npm package — loaded as npm package, not extension dir)
	["browser", "pi-agent-browser"],
]);

// ============================================================================
// Helpers
// ============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lower(name: string | undefined): string {
	return (name ?? "").trim().toLowerCase();
}

/**
 * Derive an MCP alias name from a tool's sourceInfo.
 * Returns e.g. "mcp__stateful-memory__remember" for a tool registered from
 * ~/.pi/agent/extensions/stateful-memory/extension.js
 *
 * Normalizes the extension directory name to a clean namespace identifier.
 * Falls back to the KNOWN_TOOLS map for tools registered asynchronously
 * (e.g. stateful-memory registers tools inside session_start, after extension load,
 * so they never get sourceInfo attached by the resource loader).
 */
function deriveMcpAlias(tool: ToolInfo, flatName: string): string | null {
	const flatNameLc = lower(flatName);

	// Fallback: check known tools map first (for asynchronously-registered tools)
	if (KNOWN_TOOLS.has(flatNameLc)) {
		return `mcp__${KNOWN_TOOLS.get(flatNameLc)}__${flatName}`;
	}

	if (!tool.sourceInfo) return null;

	const baseDir = tool.sourceInfo.baseDir;
	const fullPath = tool.sourceInfo.path ?? "";

	// Try baseDir first
	if (baseDir) {
		const dirName = basename(baseDir.replace(/\/$/, ""));
		// Skip "extensions" subdirectory — use the parent directory name instead
		const normalized = dirName === "extensions" ? basename(dirname(baseDir)) : dirName;
		if (normalized && normalized !== "agent" && normalized !== "extensions") {
			const safeNamespace = normalized.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
			return `mcp__${safeNamespace}__${flatName}`;
		}
	}

	// Fall back to extracting from the file path
	if (fullPath) {
		// Try to find a directory name that looks like an extension name
		// e.g. /home/monika/.pi/agent/extensions/stateful-memory/extension.js
		// → stateful-memory
		const pathParts = fullPath.replace(/\\/g, "/").split("/");
		const extIndex = pathParts.indexOf("extensions");
		if (extIndex > 0) {
			const parentDir = pathParts[extIndex - 1];
			if (parentDir && parentDir !== "agent") {
				const safeNamespace = parentDir.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
				return `mcp__${safeNamespace}__${flatName}`;
			}
		}
	}

	return null;
}

// ============================================================================
// System prompt rewrite
//
// Replace "pi itself" → "the cli itself" in system prompt text.
// Preserves cache_control, non-text blocks, and payload shape.
// Copied from upstream: https://github.com/ben-vargas/pi-packages/blob/main/packages/pi-claude-code-use/extensions/index.ts
// ============================================================================

function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") {
		return rewritePromptText(system);
	}
	if (!Array.isArray(system)) {
		return system;
	}
	return system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string") {
			return block;
		}
		const rewritten = rewritePromptText(block.text);
		return rewritten === block.text ? block : { ...block, text: rewritten };
	});
}

// ============================================================================
// Tool filtering and MCP alias remapping
//
// Rules applied per tool:
// 1. Anthropic-native typed tools (have a `type` field) → pass through
// 2. Core Claude Code tool names → pass through
// 3. Tools already prefixed with mcp__ → pass through (with dedup)
// 4. Unknown flat-named tools → filtered out
// Copied from upstream with dynamic companion discovery removed (handled separately).
// ============================================================================

function collectToolNames(tools: unknown[]): Set<string> {
	const names = new Set<string>();
	for (const tool of tools) {
		if (isPlainObject(tool) && typeof tool.name === "string") {
			names.add(lower(tool.name));
		}
	}
	return names;
}

function filterAndRemapTools(tools: unknown[] | undefined, disableFilter: boolean): unknown[] | undefined {
	if (!Array.isArray(tools)) return tools;

	const advertised = collectToolNames(tools);
	const emitted = new Set<string>();
	const result: unknown[] = [];

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;

		// Rule 1: native typed tools always pass through
		if (typeof tool.type === "string" && tool.type.trim().length > 0) {
			result.push(tool);
			continue;
		}

		const name = typeof tool.name === "string" ? tool.name : "";
		if (!name) continue;
		const nameLc = lower(name);

		// Rules 2 & 3: core tools and mcp__-prefixed pass through (with dedup)
		if (CORE_TOOL_NAMES.has(nameLc) || nameLc.startsWith("mcp__")) {
			if (!emitted.has(nameLc)) {
				emitted.add(nameLc);
				result.push(tool);
			}
			continue;
		}

		// Rule 4: unknown flat-named tool — filter out (unless filter disabled)
		if (disableFilter && !emitted.has(nameLc)) {
			emitted.add(nameLc);
			result.push(tool);
		}
	}

	return result;
}

// ============================================================================
// tool_choice remapping
// Copied from upstream.
// ============================================================================

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	survivingNames: Map<string, string>,
): Record<string, unknown> | undefined {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") {
		return toolChoice;
	}

	const nameLc = lower(toolChoice.name);
	const actualName = survivingNames.get(nameLc);
	if (actualName) {
		return actualName === toolChoice.name ? toolChoice : { ...toolChoice, name: actualName };
	}

	// Also check mcp__ prefixed names
	if (nameLc.startsWith("mcp__") && survivingNames.has(nameLc)) {
		return toolChoice;
	}

	return undefined;
}

// ============================================================================
// Message history rewriting
// Rewrites tool_use blocks in conversation history to use MCP aliases.
// Copied from upstream.
// ============================================================================

function remapMessageToolNames(messages: unknown[], survivingNames: Map<string, string>): unknown[] {
	let anyChanged = false;
	const result = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;

		let msgChanged = false;
		const content = (msg.content as unknown[]).map((block) => {
			if (!isPlainObject(block) || block.type !== "tool_use" || typeof block.name !== "string") {
				return block;
			}
			const nameLc = lower(block.name);
			const actualName = survivingNames.get(nameLc);
			if (actualName && actualName !== block.name) {
				msgChanged = true;
				return { ...block, name: actualName };
			}
			return block;
		});

		if (msgChanged) {
			anyChanged = true;
			return { ...msg, content };
		}
		return msg;
	});

	return anyChanged ? result : messages;
}

// System prompt rewrite — Available tools section
// Replaces flat tool names in the "Available tools:" section with MCP aliases
// and removes entries for tools that have no MCP alias (they'll fail OAuth anyway).
function rewriteAvailableToolsSection(systemText: string): string {
	const marker = "Available tools:";
	const endMarker = "Guidelines:";
	const start = systemText.indexOf(marker);
	if (start === -1) return systemText;
	const end = systemText.indexOf(endMarker, start);
	if (end === -1) return systemText;

	const before = systemText.slice(0, start);
	const toolsBlock = systemText.slice(start, end);
	const after = systemText.slice(end);

	// FLAT_TO_MCP maps flat_name → mcp_alias
	const lines = toolsBlock.split("\n");
	const result: string[] = [];
	let skipUntilNext = false;

	for (const raw of lines) {
		const line = raw;
		// Detect tool header: "- ToolName: description"
		const header = line.match(/^(\s*-\s+)([A-Za-z_][A-Za-z0-9_]*)(:)(.*)/);
		if (header) {
			const [, indent, name, colon, rest] = header;
			const mcp = FLAT_TO_MCP.get(name.toLowerCase());
			if (mcp) {
				result.push(`${indent}- ${mcp}${colon}${rest}`);
				skipUntilNext = false;
			} else {
				// No MCP alias — skip this tool's header and all its description lines
				skipUntilNext = true;
			}
		} else if (skipUntilNext) {
			// Inside a skipped tool's description — skip unless this is an empty line
			// or clearly a new tool entry
			if (/^\s*$/.test(line) || /^\s*-\s/.test(line)) {
				skipUntilNext = false;
				if (/^\s*-\s/.test(line)) {
					// Reprocess as new header
					const h = line.match(/^(\s*-\s+)([A-Za-z_][A-Za-z0-9_]*)(:)(.*)/);
					if (h) {
						const [, indent2, name2, colon2, rest2] = h;
						const mcp2 = FLAT_TO_MCP.get(name2.toLowerCase());
						if (mcp2) {
							result.push(line.replace(`${indent2}- ${name2}${colon2}`, `${indent2}- ${mcp2}${colon2}`));
						} else {
							skipUntilNext = true;
						}
					} else {
						result.push(line);
					}
				} else {
					result.push(line);
				}
			}
		} else {
			result.push(line);
		}
	}

	return before + result.join("\n") + after;
}

// ============================================================================
// Full payload transform
// Copied from upstream with companion-specific logic removed.
// ============================================================================

function transformPayload(raw: Record<string, unknown>, disableFilter: boolean): Record<string, unknown> {
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

	// 1. System prompt rewrite (always applies)
	if (payload.system !== undefined) {
		payload.system = rewriteSystemField(payload.system);
		// Also rewrite flat tool names in the "Available tools:" section of the system
		// prompt to MCP aliases. This prevents the model from trying flat names that
		// fail with OAuth when it should use the MCP alias instead.
		if (typeof payload.system === "string") {
			payload.system = rewriteAvailableToolsSection(payload.system);
		}
	}

	// When escape hatch is active, skip all tool filtering/remapping
	if (disableFilter) {
		return payload;
	}

	// 2. Tool filtering
	payload.tools = filterAndRemapTools(payload.tools as unknown[] | undefined, false);

	// 3. Build map of tool names that survived filtering (lowercase → actual name)
	const survivingNames = new Map<string, string>();
	if (Array.isArray(payload.tools)) {
		for (const tool of payload.tools) {
			if (isPlainObject(tool) && typeof tool.name === "string") {
				survivingNames.set(lower(tool.name), tool.name as string);
			}
		}
	}

	// 4. Remap tool_choice if it references a renamed or filtered tool
	if (isPlainObject(payload.tool_choice)) {
		const remapped = remapToolChoice(payload.tool_choice, survivingNames);
		if (remapped === undefined) {
			delete payload.tool_choice;
		} else {
			payload.tool_choice = remapped;
		}
	}

	// 5. Rewrite historical tool_use blocks in message history
	if (Array.isArray(payload.messages)) {
		payload.messages = remapMessageToolNames(payload.messages, survivingNames);
	}

	return payload;
}

// ============================================================================
// Debug logging
// Copied from upstream.
// ============================================================================

const debugLogPath = process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG;

function writeDebugLog(payload: unknown): void {
	if (!debugLogPath) return;
	try {
		appendFileSync(debugLogPath, `${new Date().toISOString()}\n${JSON.stringify(payload, null, 2)}\n---\n`, "utf-8");
	} catch {
		// Debug logging must never break actual requests
	}
}

// ============================================================================
// Dynamic MCP alias registration
//
// Instead of a hardcoded companion list, we dynamically discover all registered
// tools on every agent turn and register MCP-style aliases for any flat-named tool
// that isn't on the allowlist and isn't already mcp-prefixed.
//
// This means ANY extension's tools survive the filter automatically.
// ============================================================================

const registeredMcpAliases = new Set<string>();
const autoActivatedAliases = new Set<string>();
let lastManagedToolList: string[] | undefined;

const FLAT_TO_MCP = new Map<string, string>(); // flat → mcp (populated dynamically)
const FLAT_TOOL_DEFS = new Map<string, ToolInfo>(); // flat name → original tool definition (for execute delegation)

async function registerAliasesForAllTools(pi: ExtensionAPI): Promise<void> {
	FLAT_TO_MCP.clear();
	// Reset per-turn tracking so we always re-derive FLAT_TO_MCP fresh.
	// registeredMcpAliases persists across turns to avoid re-registering
	// aliases that already exist in the session, but FLAT_TO_MCP must be
	// rebuilt each turn because syncAliasActivation depends on it.

	const allTools = pi.getAllTools();
	const knownNames = new Set(allTools.map((t) => lower(t.name)));

	// Populate FLAT_TOOL_DEFS so execute delegation can find original tools by flat name.
	// Exclude MCP alias tools that were registered in previous turns — we only want
	// the original flat-named tools so the execute delegation works correctly.
	for (const tool of allTools) {
		const nameLc = lower(tool.name);
		if (nameLc.startsWith("mcp__")) continue;
		FLAT_TOOL_DEFS.set(nameLc, tool);
	}

	if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
		const debug = (msg: string) =>
			appendFileSync(process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!, `${new Date().toISOString()} [register] ${msg}\n`, "utf-8");
		debug(`knownNames: ${[...knownNames].sort().join(", ")}`);
	}

	// Process each tool — register MCP alias for flat-named non-core non-mcp tools
	for (const tool of allTools) {
		const flatName = tool.name;
		const flatNameLc = lower(flatName);

		// Skip core tools and MCP-prefixed tools
		if (CORE_TOOL_NAMES.has(flatNameLc)) continue;
		if (flatNameLc.startsWith("mcp__")) continue;

		// Derive MCP alias from sourceInfo (or KNOWN_TOOLS fallback)
		const mcpAlias = deriveMcpAlias(tool, flatName);
		if (!mcpAlias) {
			if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
				appendFileSync(
					process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
					`${new Date().toISOString()} [skip] ${flatName}: deriveMcpAlias returned null\n`,
					"utf-8",
				);
			}
			continue;
		}

		const mcpAliasLc = lower(mcpAlias);

		// Skip if already registered in a previous turn
		if (registeredMcpAliases.has(mcpAliasLc)) {
			// Already exists — add to FLAT_TO_MCP for this turn's sync
			FLAT_TO_MCP.set(flatNameLc, mcpAliasLc);
			continue;
		}

		// Look up the original tool's definition (stored for execute delegation)
		// FLAT_TOOL_DEFS has flat names as keys (MCP aliases filtered out), so we
		// look up by flatNameLc directly.
		const originalTool = FLAT_TOOL_DEFS.get(flatNameLc);
		if (!originalTool) continue;

		// Register the MCP alias with an execute function that delegates to the original tool.
		// We use the flat name as the key for delegation lookup.
		const flatKey = flatNameLc;
		pi.registerTool({
			name: mcpAlias,
			label: `MCP ${originalTool.label ?? flatName}`,
			description: originalTool.description ?? "",
			parameters: originalTool.parameters ?? Type.Object({}),
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				// Delegate to the original flat-named tool by reversing the FLAT_TO_MCP map
				const origFlat = [...FLAT_TO_MCP.entries()].find(([, mcp]) => lower(mcp) === lower(mcpAlias))?.[0];
				const orig = origFlat ? FLAT_TOOL_DEFS.get(origFlat) : undefined;
				if (!orig?.execute) return { content: [{ type: "text", text: `Tool ${mcpAlias} not executable` }], isError: true };
				return orig.execute(toolCallId, params, signal, onUpdate, ctx);
			},
		});

		registeredMcpAliases.add(mcpAliasLc);
		FLAT_TO_MCP.set(flatNameLc, mcpAliasLc);
	}
}

/**
 * Synchronize MCP alias tool activation with the current model state.
 * Auto-activates MCP aliases when their flat counterpart is active.
 * Removes auto-activated aliases when OAuth is inactive (but preserves user-selected).
 */
function syncAliasActivation(pi: ExtensionAPI, enableAliases: boolean): void {
	const activeNames = pi.getActiveTools();
	const allNames = new Set(pi.getAllTools().map((t) => lower(t.name)));

	if (enableAliases) {
		const activeLc = new Set(activeNames.map(lower));
		const desiredAliases: string[] = [];

		for (const [flat, mcp] of FLAT_TO_MCP) {
			if (activeLc.has(flat) && allNames.has(lower(mcp)) && registeredMcpAliases.has(lower(mcp))) {
				desiredAliases.push(mcp);
			}
		}
		const desiredSet = new Set(desiredAliases);

		// Promote auto-activated aliases to user-selected when user explicitly kept
		// the alias while removing its flat counterpart
		if (lastManagedToolList !== undefined) {
			const activeSet = new Set(activeNames.map(lower));
			const lastManaged = new Set(lastManagedToolList.map(lower));
			for (const alias of autoActivatedAliases) {
				if (!activeSet.has(alias) || desiredSet.has(alias)) continue;
				// Find the flat name for this alias
				const flatName = [...FLAT_TO_MCP.entries()].find(([, mcp]) => lower(mcp) === alias)?.[0];
				if (flatName && lastManaged.has(lower(flatName)) && !activeSet.has(lower(flatName))) {
					autoActivatedAliases.delete(alias);
				}
			}
		}

		const activeRegistered = activeNames.filter((n) => registeredMcpAliases.has(lower(n)));
		const preserved = activeRegistered.filter((n) => !autoActivatedAliases.has(lower(n)));

		const nonAlias = activeNames.filter((n) => !registeredMcpAliases.has(lower(n)));
		const next = Array.from(new Set([...nonAlias, ...preserved, ...desiredAliases]));

		const preservedSet = new Set(preserved.map(lower));
		autoActivatedAliases.clear();
		for (const name of desiredAliases) {
			if (!preservedSet.has(lower(name))) {
				autoActivatedAliases.add(name);
			}
		}

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = next;
		}
	} else {
		const next = activeNames.filter((n) => !autoActivatedAliases.has(lower(n)));
		autoActivatedAliases.clear();

		if (next.length !== activeNames.length || next.some((n, i) => n !== activeNames[i])) {
			pi.setActiveTools(next);
			lastManagedToolList = next;
		} else {
			lastManagedToolList = undefined;
		}
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default async function claudeCodeUse(pi: ExtensionAPI): Promise<void> {
	// Pre-register aliases at session start. session_start fires after extensions have
	// loaded but before the agent loop begins. This means aliases are registered
	// before the first before_agent_start, giving them a chance to appear in turn 1's
	// tool list.
	pi.on("session_start", async () => {
		if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
			appendFileSync(
				process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
				`${new Date().toISOString()} [session_start] firing\n`,
				"utf-8",
			);
		}
		await registerAliasesForAllTools(pi);
		if (process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG) {
			appendFileSync(
				process.env.PI_CLAUDE_CODE_USE_DEBUG_LOG!,
				`${new Date().toISOString()} [session_start] done, registered: ${[...registeredMcpAliases].join(", ")}\n`,
				"utf-8",
			);
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		await registerAliasesForAllTools(pi);
		// Enable aliases for any request targeting the Anthropic API format — this
		// includes both direct OAuth and pool-proxy requests, both of which need
		// MCP-style tool names to avoid rejection at Anthropic's end.
		const model = ctx.model;
		const isAnthropicApi = model?.api === "anthropic-messages";
		syncAliasActivation(pi, isAnthropicApi);
	});

	pi.on("before_provider_request", (event, ctx) => {
		const model = ctx.model;
		// Fire on any request to the Anthropic API format — both direct OAuth and
		// pool-proxy requests use this format and both need tool name transformation.
		if (!model || model.api !== "anthropic-messages") {
			return undefined;
		}
		if (!isPlainObject(event.payload)) {
			return undefined;
		}

		writeDebugLog({ stage: "before", payload: event.payload });
		const disableFilter = process.env.PI_CLAUDE_CODE_USE_DISABLE_TOOL_FILTER === "1";
		const transformed = transformPayload(event.payload as Record<string, unknown>, disableFilter);
		writeDebugLog({ stage: "after", payload: transformed });
		return transformed;
	});
}