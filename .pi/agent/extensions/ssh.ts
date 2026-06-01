/**
 * SSH Remote Execution Example
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 *
 * Docs: ~/.pi/agent/extensions/SSH.md
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_LS_MAX_BYTES = 50 * 1024;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

function getCliFlagValue(name: string): string | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) {
			const next = process.argv[i + 1];
			if (next && !next.startsWith("-")) {
				return next;
			}
		}
		if (arg.startsWith(prefix)) {
			return arg.slice(prefix.length);
		}
	}
	return undefined;
}

function getCliFlagBoolean(name: string): boolean | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) return true;
		if (arg.startsWith(prefix)) {
			const value = arg.slice(prefix.length).toLowerCase();
			if (value === "true") return true;
			if (value === "false") return false;
		}
	}
	return undefined;
}

function truncateToBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(input, "utf-8");
	if (buf.length <= maxBytes) {
		return { text: input, truncated: false };
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end -= 1;
	}
	return { text: buf.slice(0, end).toString("utf-8"), truncated: true };
}

function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

function sshExec(remote: string, command: string, options?: string[]): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const sshOpts = options ?? SSH_OPTIONS;
		const child = spawn("ssh", [...sshOpts, remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

/** SSH options for relocate validation — accepts new host keys automatically. */
const RELOCATE_SSH_OPTIONS = [
	"-o", "BatchMode=yes",
	"-o", "ConnectTimeout=10",
	"-o", "StrictHostKeyChecking=accept-new",
];

/**
 * Validate an SSH connection before switching. Returns a structured result
 * so the caller can report specific failure reasons.
 */
async function validateSshTarget(remote: string, remoteCwd?: string): Promise<{
	success: boolean;
	remoteCwd: string;
	hostname?: string;
	error?: string;
	errorKind?: "host_key" | "auth" | "refused" | "timeout" | "path" | "unknown";
}> {
	try {
		// Test basic connectivity
		const echoResult = await sshExec(remote, "echo __relocate_ok__", RELOCATE_SSH_OPTIONS);
		if (!echoResult.toString().includes("__relocate_ok__")) {
			return { success: false, remoteCwd: "", error: "Unexpected response from host", errorKind: "unknown" };
		}

		// Get remote cwd
		const cwd = remoteCwd ?? (await sshExec(remote, "pwd", RELOCATE_SSH_OPTIONS)).toString().trim();

		// Verify cwd exists
		try {
			await sshExec(remote, `test -d ${JSON.stringify(cwd)}`, RELOCATE_SSH_OPTIONS);
		} catch {
			return { success: false, remoteCwd: cwd, error: `Remote path does not exist: ${cwd}`, errorKind: "path" };
		}

		// Get hostname for display
		let hostname: string | undefined;
		try {
			hostname = (await sshExec(remote, "hostname", RELOCATE_SSH_OPTIONS)).toString().trim();
		} catch { /* non-fatal */ }

		return { success: true, remoteCwd: cwd, hostname };
	} catch (error: any) {
		const msg: string = error?.message ?? String(error);
		if (msg.includes("Host key verification failed")) {
			return { success: false, remoteCwd: "", error: "Host key verification failed — the host's SSH key has CHANGED (possible security issue). Manually verify and update known_hosts.", errorKind: "host_key" };
		}
		if (msg.includes("Permission denied")) {
			return { success: false, remoteCwd: "", error: `Authentication failed for ${remote}. Check SSH keys and authorized_keys on the target.`, errorKind: "auth" };
		}
		if (msg.includes("Connection refused")) {
			return { success: false, remoteCwd: "", error: `Connection refused by ${remote}. Is sshd running on the target?`, errorKind: "refused" };
		}
		if (msg.includes("timed out") || msg.includes("Connection timed out")) {
			return { success: false, remoteCwd: "", error: `Connection timed out for ${remote}. Host may be unreachable.`, errorKind: "timeout" };
		}
		if (msg.includes("Could not resolve hostname")) {
			return { success: false, remoteCwd: "", error: `Could not resolve hostname in ${remote}. Check the address.`, errorKind: "unknown" };
		}
		return { success: false, remoteCwd: "", error: msg, errorKind: "unknown" };
	}
}

function parseSshArg(arg: string): { remote: string; remoteCwd?: string } {
	const match = arg.match(/^(.+?):(\/.*)$/);
	if (match) {
		return { remote: match[1], remoteCwd: match[2] };
	}
	return { remote: arg };
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [...SSH_OPTIONS, remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

function resolveRemotePath(remoteCwd: string, localCwd: string, path: string | undefined): string {
	const rawPath = path ?? ".";
	if (rawPath.startsWith(localCwd)) {
		return rawPath.replace(localCwd, remoteCwd);
	}
	if (rawPath.startsWith("/")) return rawPath;
	return `${remoteCwd}/${rawPath}`;
}

async function remoteLs(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	path: string | undefined,
	limit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const resolvedPath = resolveRemotePath(remoteCwd, localCwd, path);
	try {
		await sshExec(remote, `test -e ${JSON.stringify(resolvedPath)}`);
	} catch {
		throw new Error(`Path not found: ${resolvedPath}`);
	}
	try {
		await sshExec(remote, `test -d ${JSON.stringify(resolvedPath)}`);
	} catch {
		throw new Error(`Not a directory: ${resolvedPath}`);
	}
	const rawEntries = (await sshExec(remote, `LC_ALL=C ls -A -p ${JSON.stringify(resolvedPath)}`))
		.toString()
		.trim();
	const entries = rawEntries.length ? rawEntries.split("\n") : [];
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;
	let entryLimitReached = false;
	let limitedEntries = entries;
	if (entries.length > effectiveLimit) {
		entryLimitReached = true;
		limitedEntries = entries.slice(0, effectiveLimit);
	}
	let output = limitedEntries.length ? limitedEntries.join("\n") : "(empty directory)";
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (Buffer.byteLength(output, "utf-8") > DEFAULT_LS_MAX_BYTES) {
		output = output.slice(0, DEFAULT_LS_MAX_BYTES);
		notices.push(`${DEFAULT_LS_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

async function ensureRemoteCommand(remote: string, command: string): Promise<void> {
	try {
		await sshExec(remote, `command -v ${command}`);
	} catch {
		throw new Error(`${command} is not available on the remote host`);
	}
}

function joinRemotePath(base: string, childPath: string): string {
	if (childPath.startsWith("/")) return childPath;
	return path.posix.join(base, childPath);
}

async function remoteFind(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	pattern: string,
	searchDir: string | undefined,
	limit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const searchPath = resolveRemotePath(remoteCwd, localCwd, searchDir);
	try {
		await sshExec(remote, `test -e ${JSON.stringify(searchPath)}`);
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	try {
		await sshExec(remote, `test -d ${JSON.stringify(searchPath)}`);
	} catch {
		throw new Error(`Not a directory: ${searchPath}`);
	}
	await ensureRemoteCommand(remote, "rg");
	const rgCmd = `cd ${JSON.stringify(searchPath)} && rg --files --hidden -g ${JSON.stringify(pattern)}`;
	const wrappedCmd = `bash -lc ${JSON.stringify(`${rgCmd}; code=$?; if [ $code -eq 1 ]; then exit 0; else exit $code; fi`)}`;
	const rawOutput = (await sshExec(remote, wrappedCmd)).toString().trim();
	if (!rawOutput) {
		return { content: [{ type: "text", text: "No files found matching pattern" }] };
	}
	const entries = rawOutput.split("\n").filter((line) => line.trim().length > 0);
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;
	const resultLimitReached = entries.length >= effectiveLimit;
	const limitedEntries = entries.slice(0, effectiveLimit);
	let output = limitedEntries.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.resultLimitReached = effectiveLimit;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

async function remoteGrep(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const searchPath = resolveRemotePath(remoteCwd, localCwd, params.path);
	let isDirectory = false;
	try {
		await sshExec(remote, `test -d ${JSON.stringify(searchPath)}`);
		isDirectory = true;
	} catch {
		try {
			await sshExec(remote, `test -e ${JSON.stringify(searchPath)}`);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
	}
	await ensureRemoteCommand(remote, "rg");
	const args: string[] = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) {
		args.push("--glob", params.glob);
	}
	args.push(params.pattern, searchPath);
	const rgCmd = args.map((arg) => JSON.stringify(arg)).join(" ");
	const wrappedCmd = `bash -lc ${JSON.stringify(`${rgCmd}; code=$?; if [ $code -eq 1 ]; then exit 0; else exit $code; fi`)}`;
	const rawOutput = (await sshExec(remote, wrappedCmd)).toString();
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const matches: Array<{ filePath: string; lineNumber: number }> = [];
	let matchLimitReached = false;
	for (const line of rawOutput.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "match") {
			const filePath = event.data?.path?.text;
			const lineNumber = event.data?.line_number;
			if (filePath && typeof lineNumber === "number") {
				if (matches.length < effectiveLimit) {
					matches.push({ filePath, lineNumber });
				} else {
					matchLimitReached = true;
				}
			}
		}
	}
	if (matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }] };
	}
	const formatPath = (filePath: string) => {
		if (isDirectory) {
			const relative = path.posix.relative(searchPath, filePath);
			if (relative && !relative.startsWith("..")) {
				return relative;
			}
		}
		return path.posix.basename(filePath);
	};
	const fileCache = new Map<string, string[]>();
	const getFileLines = async (filePath: string) => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = (await sshExec(remote, `cat ${JSON.stringify(filePath)}`)).toString("utf-8");
				lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};
	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const match of matches) {
		const absolutePath = joinRemotePath(isDirectory ? searchPath : path.posix.dirname(searchPath), match.filePath);
		const relativePath = formatPath(absolutePath);
		const lines = await getFileLines(absolutePath);
		if (!lines.length) {
			outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
		const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
		for (let current = start; current <= end; current += 1) {
			const lineText = lines[current - 1] ?? "";
			const sanitized = lineText.replace(/\r/g, "");
			const { text: truncatedText, wasTruncated } = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
			if (wasTruncated) linesTruncated = true;
			if (current === match.lineNumber) {
				outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
			} else {
				outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
			}
		}
	}
	let output = outputLines.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("ssh-debug", { description: "Enable SSH debug status output", type: "boolean" });
	pi.registerFlag("ssh-verify", {
		description: "Verify a remote path exists and list it on connect",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let sshRequired = false;
	let sshDebug = false;
	let sshError: Error | null = null;
	let remoteHost: string | null = null;
	let remoteAgentsContent: string | null = null;

	const getSsh = () => resolvedSsh;
	const requireSsh = () => {
		if (!resolvedSsh && sshRequired) {
			const details = sshError ? ` (${sshError.message})` : "";
			throw new Error(`SSH mode was requested but is not available${details}.`);
		}
		return resolvedSsh;
	};
	const mapRemotePath = (ssh: { remoteCwd: string }, p: string) => p.replace(localCwd, ssh.remoteCwd);
	const setDebugStatus = (ctx: any, message: string) => {
		if (!sshDebug) return;
		ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("accent", message));
	};

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} read: ${targetPath}`);
			}
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} write: ${targetPath}`);
			}
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} edit: ${targetPath}`);
			}
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { pattern, path: searchPath, limit } = params as {
				pattern: string;
				path?: string;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, searchPath) : searchPath ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} find: ${targetPath} :: ${pattern}`);
			}
			if (ssh) {
				return remoteFind(ssh.remote, ssh.remoteCwd, localCwd, pattern, searchPath, limit);
			}
			return localFind.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const typed = params as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, typed.path) : typed.path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} grep: ${targetPath} :: ${typed.pattern}`);
			}
			if (ssh) {
				return remoteGrep(ssh.remote, ssh.remoteCwd, localCwd, typed);
			}
			return localGrep.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { path, limit } = params as { path?: string; limit?: number };
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, path) : path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} ls: ${targetPath}`);
			}
			if (ssh) {
				return remoteLs(ssh.remote, ssh.remoteCwd, localCwd, path, limit);
			}
			return localLs.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const { command, cwd } = params as { command: string; cwd: string };
				const targetCwd = ssh ? mapRemotePath(ssh, cwd) : cwd;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} bash: ${targetCwd} :: ${command}`);
			}
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	// ── Relocate tool ──────────────────────────────────────────────────────
	// Switches the execution context mid-session. All tools (bash, read, write,
	// edit, grep, find, ls) will route to the new target after a successful
	// relocate. Validates connectivity BEFORE switching — if validation fails,
	// the current context is preserved and a detailed error is returned.
	const relocateSchema = Type.Object({
		target: Type.Optional(Type.String({ description: 'SSH target: "user@host", "user@host:/path", or "local" to return to container-local execution. Omit to check current status.' })),
	});

	pi.registerTool({
		name: "relocate",
		description: "Switch execution context to a different host via SSH. All tools (bash, read, write, edit, grep, find, ls) will route to the new target after a successful relocate. Call with no target to check current context.",
		label: "Relocate",
		parameters: relocateSchema,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const { target } = params as { target?: string };

			// ── Status check (no target) ──
			if (!target) {
				if (resolvedSsh) {
					return {
						content: [{ type: "text" as const, text: `Current context: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}${remoteHost ? ` (hostname: ${remoteHost})` : ""}\nAll tools are routing to this target via SSH.` }],
					};
				}
				return {
					content: [{ type: "text" as const, text: "Current context: local (container-local execution).\nAll tools operate on the container filesystem." }],
				};
			}

			// ── Return to local ──
			if (target === "local") {
				const wasRemote = resolvedSsh;
				resolvedSsh = null;
				sshRequired = false;
				sshError = null;
				remoteHost = null;
				remoteAgentsContent = null;
				if (ctx) {
					ctx.ui.setStatus("ssh", "");
					ctx.ui.notify("Relocated to local execution", "info");
				}
				return {
					content: [{ type: "text" as const, text: `Relocated to local execution (container).${wasRemote ? ` Disconnected from ${wasRemote.remote}.` : ""}` }],
				};
			}

			// ── Parse target ──
			const parsed = parseSshArg(target);

			// ── Validate BEFORE switching ──
			const validation = await validateSshTarget(parsed.remote, parsed.remoteCwd);

			if (!validation.success) {
				// DO NOT change state. Return error with diagnosis.
				const current = resolvedSsh ? `${resolvedSsh.remote}:${resolvedSsh.remoteCwd}` : "local";
				const lines = [
					`RELOCATE FAILED — staying on current context (${current}).`,
					`Target: ${target}`,
					`Error: ${validation.error}`,
				];
				if (validation.errorKind === "auth") {
					lines.push("", "To fix: ensure the SSH public key is in the target's ~/.ssh/authorized_keys or /etc/ssh/authorized_keys.d/.");
				} else if (validation.errorKind === "host_key") {
					lines.push("", "To fix: verify the host's identity, then remove the old key from known_hosts and retry.");
				} else if (validation.errorKind === "refused") {
					lines.push("", "To fix: check that sshd is running on the target (systemctl status sshd).");
				} else if (validation.errorKind === "path") {
					lines.push("", "To fix: use a different path, e.g.: relocate user@host:/home/user");
				}
				if (ctx) {
					ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", `SSH: FAILED ${target}`));
					ctx.ui.notify(`Relocate failed: ${validation.error}`, "error");
				}
				return { content: [{ type: "text" as const, text: lines.join("\n") }] };
			}

			// ── Switch context ──
			const previousContext = resolvedSsh ? `${resolvedSsh.remote}:${resolvedSsh.remoteCwd}` : "local";
			resolvedSsh = { remote: parsed.remote, remoteCwd: validation.remoteCwd };
			sshRequired = true;
			sshError = null;
			remoteHost = validation.hostname ?? null;

			// Read remote AGENTS.md if available
			remoteAgentsContent = null;
			try {
				const agentsPath = `${validation.remoteCwd}/AGENTS.md`;
				await sshExec(parsed.remote, `test -r ${JSON.stringify(agentsPath)}`, RELOCATE_SSH_OPTIONS);
				const content = (await sshExec(parsed.remote, `cat ${JSON.stringify(agentsPath)}`, RELOCATE_SSH_OPTIONS)).toString("utf-8");
				if (content.trim().length > 0) {
					remoteAgentsContent = content;
				}
			} catch { /* no AGENTS.md, that's fine */ }

			// Update UI
			if (ctx) {
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`Relocated to ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			}

			// Build result
			const lines = [
				`Relocated: ${previousContext} → ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`,
				`Hostname: ${validation.hostname ?? "unknown"}`,
				`All tools (bash, read, write, edit, grep, find, ls) now operate on ${resolvedSsh.remote}.`,
			];
			if (remoteAgentsContent) {
				lines.push("", "Remote AGENTS.md found and loaded into context.");
			}
			return { content: [{ type: "text" as const, text: lines.join("\n") }] };
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = (pi.getFlag("ssh") as string | undefined) ?? getCliFlagValue("ssh");
		sshRequired = Boolean(arg);
		const cliDebug = getCliFlagBoolean("ssh-debug");
		sshDebug = Boolean((pi.getFlag("ssh-debug") as boolean | undefined) ?? cliDebug);
		const sshVerify = (pi.getFlag("ssh-verify") as string | undefined) ?? getCliFlagValue("ssh-verify");
		if (arg) {
			try {
				const parsed = parseSshArg(arg);
				const remote = parsed.remote;
				const remoteCwd = parsed.remoteCwd ?? (await sshExec(remote, "pwd")).toString().trim();
				await sshExec(remote, `test -d ${JSON.stringify(remoteCwd)}`);
				if (sshVerify) {
					await sshExec(remote, `test -d ${JSON.stringify(sshVerify)}`);
					const listing = (await sshExec(remote, `ls -a ${JSON.stringify(sshVerify)}`)).toString().trim();
					ctx.ui.notify(
						`SSH verify: ${sshVerify}\n${listing || "(empty directory)"}`,
						"info",
					);
				}
				resolvedSsh = { remote, remoteCwd };
				sshError = null;
				remoteAgentsContent = null;
				try {
					await sshExec(remote, `test -r ${JSON.stringify(`${remoteCwd}/AGENTS.md`)}`);
					remoteAgentsContent = (await sshExec(remote, `cat ${JSON.stringify(`${remoteCwd}/AGENTS.md`)}`)).toString("utf-8");
					if (remoteAgentsContent.trim().length === 0) {
						remoteAgentsContent = null;
					}
				} catch {
					remoteAgentsContent = null;
				}
				if (sshDebug) {
					remoteHost = (await sshExec(remote, "hostname")).toString().trim();
					ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("accent", `SSH debug: ${remoteHost}`));
					ctx.ui.notify(`SSH debug: connected to ${remoteHost} (${resolvedSsh.remote}:${resolvedSsh.remoteCwd})`, "info");
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			} catch (error) {
				sshError = error instanceof Error ? error : new Error(String(error));
				if (sshDebug) {
					ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("error", "SSH debug: failed"));
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH: failed"));
				ctx.ui.notify(`SSH requested but failed: ${sshError.message}`, "error");
			}
		}

		// Auto-relocate from RELOCATE_TARGET env var (production container mode).
		// Only fires if --ssh was not explicitly provided.
		if (!arg && process.env.RELOCATE_TARGET) {
			const autoTarget = process.env.RELOCATE_TARGET;
			const parsed = parseSshArg(autoTarget);
			const validation = await validateSshTarget(parsed.remote, parsed.remoteCwd);
			if (validation.success) {
				resolvedSsh = { remote: parsed.remote, remoteCwd: validation.remoteCwd };
				sshRequired = true;
				remoteHost = validation.hostname ?? null;
				// Read AGENTS.md
				try {
					const agentsPath = `${validation.remoteCwd}/AGENTS.md`;
					await sshExec(parsed.remote, `test -r ${JSON.stringify(agentsPath)}`, RELOCATE_SSH_OPTIONS);
					const content = (await sshExec(parsed.remote, `cat ${JSON.stringify(agentsPath)}`, RELOCATE_SSH_OPTIONS)).toString("utf-8");
					if (content.trim().length > 0) remoteAgentsContent = content;
				} catch { /* no AGENTS.md */ }
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`Auto-relocated to ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			} else {
				ctx.ui.notify(`Auto-relocate to ${autoTarget} failed: ${validation.error}. Starting in container-local mode.`, "error");
			}
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = requireSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	pi.on("context", async (event) => {
		if (!remoteAgentsContent) return;
		const marker = "[Remote AGENTS.md]";
		const alreadyInjected = event.messages.some((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return false;
			return message.content.some((item) => item.type === "text" && item.text?.includes(marker));
		});
		if (alreadyInjected) return;
		const injected = {
			role: "user" as const,
			content: [{ type: "text" as const, text: `${marker}\n${remoteAgentsContent}` }],
			timestamp: Date.now(),
		};
		return { messages: [injected, ...event.messages] };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		let modified = event.systemPrompt;
		if (ssh) {
			modified = modified.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
		}
		if (sshDebug) {
			if (ssh) {
				const hostInfo = remoteHost ?? "unknown";
				modified += `\nSSH debug: remote=${ssh.remote} host=${hostInfo} cwd=${ssh.remoteCwd} localCwd=${localCwd}`;
			} else if (sshRequired) {
				modified += "\nSSH debug: requested but not connected";
			} else {
				modified += "\nSSH debug: not requested";
			}
		}
		if (modified !== event.systemPrompt) {
			return { systemPrompt: modified };
		}
	});
}
