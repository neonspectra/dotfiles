import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

function stripAt(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

async function readRequester(cwd: string): Promise<{ topicId: string } | null> {
	try {
		const raw = await readFile(resolve(cwd, ".codex-forum/requester.json"), "utf8");
		const parsed = JSON.parse(raw) as { topicId?: unknown };
		return typeof parsed.topicId === "string" && parsed.topicId ? { topicId: parsed.topicId } : null;
	} catch {
		return null;
	}
}

function guessMimeType(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".png")) return "image/png";
	if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
	if (lower.endsWith(".webp")) return "image/webp";
	if (lower.endsWith(".gif")) return "image/gif";
	if (lower.endsWith(".txt")) return "text/plain";
	if (lower.endsWith(".md")) return "text/markdown";
	if (lower.endsWith(".json")) return "application/json";
	if (lower.endsWith(".pdf")) return "application/pdf";
	if (lower.endsWith(".zip")) return "application/zip";
	return "application/octet-stream";
}

export default function forumAttachmentsExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "forum_upload_attachment",
		label: "Upload Forum Attachment",
		description: "Upload a local file into the current forum topic as a pending attachment and return the reference line to include in the final reply.",
		promptSnippet: "Upload local files to the current forum topic before returning them as attachments.",
		promptGuidelines: [
			"Use forum_upload_attachment when you need to return a generated file to the forum user as an attachment.",
			"After forum_upload_attachment succeeds, include the returned [forum-attachment id=\"...\"] reference as a standalone line in the final answer so the forum can attach it to the post.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Local path to the file to upload. A leading @ is ignored." }),
			filename: Type.Optional(Type.String({ description: "Attachment filename to show in the forum. Defaults to the basename of path." })),
			mimeType: Type.Optional(Type.String({ description: "MIME type. Defaults to a guess from filename." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const requester = await readRequester(ctx.cwd);
			if (!requester) {
				throw new Error("No .codex-forum/requester.json with topicId found in the current workspace");
			}

			const filePath = resolve(ctx.cwd, stripAt(params.path));
			const info = await stat(filePath);
			if (!info.isFile()) throw new Error(`${filePath} is not a file`);
			if (info.size <= 0) throw new Error(`${filePath} is empty`);

			const filename = params.filename?.trim() || basename(filePath);
			const mimeType = params.mimeType?.trim() || guessMimeType(filename);
			const bytes = await readFile(filePath);
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: mimeType }), filename);

			const apiBase = (process.env.MONIKA_FORUM_API_BASE_URL ?? process.env.CODEX_FORUM_API_BASE_URL ?? "http://127.0.0.1:4310/api").replace(/\/$/, "");
			const token = process.env.CODEX_FORUM_INTERNAL_API_TOKEN ?? process.env.MONIKA_FORUM_INTERNAL_API_TOKEN ?? "";
			const headers: Record<string, string> = {};
			if (token) headers["Authorization"] = `Bearer ${token}`;

			const response = await fetch(`${apiBase}/agent/topics/${encodeURIComponent(requester.topicId)}/pending-attachments`, {
				method: "POST",
				headers,
				body: form,
				signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new Error(`Forum attachment upload failed: ${response.status} ${text}`);
			}
			const result = await response.json() as {
				id: string;
				filename: string;
				mimeType: string;
				sizeBytes: number;
				sha256?: string | null;
				reference: string;
				expiresAt: string;
			};

			return {
				content: [{
					type: "text",
					text: [
						`Uploaded ${result.filename} (${result.sizeBytes} bytes) to the current forum topic.`,
						result.sha256 ? `SHA-256: ${result.sha256}` : null,
						"Include this standalone line in your final forum reply to attach it:",
						result.reference,
					].filter(Boolean).join("\n"),
				}],
				details: result,
			};
		},
	});
}
