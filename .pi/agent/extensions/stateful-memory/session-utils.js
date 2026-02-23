import { promises as fs } from "node:fs";

export function extractText(content) {
  if (!content) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export function normalizeText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

export function buildTranscriptFromEntries(entries, { maxChars = 12000 } = {}) {
  const summaryLines = [];
  const messageLines = [];

  for (const entry of entries) {
    if (entry.type === "compaction") {
      if (entry.summary) {
        summaryLines.push(`Compaction summary: ${normalizeText(entry.summary)}`);
      }
      continue;
    }
    if (entry.type === "branch_summary") {
      if (entry.summary) {
        summaryLines.push(`Branch summary: ${normalizeText(entry.summary)}`);
      }
      continue;
    }
    if (entry.type !== "message") {
      continue;
    }
    const { message } = entry;
    if (!message || (message.role !== "user" && message.role !== "assistant")) {
      continue;
    }
    const text = normalizeText(extractText(message.content ?? ""));
    if (!text) {
      continue;
    }
    const label = message.role === "user" ? "User" : "Assistant";
    messageLines.push(`${label}: ${text}`);
  }

  const summaryBlock = summaryLines.join("\n");
  const remainingBudget = Math.max(
    0,
    maxChars - summaryBlock.length - (summaryBlock ? 2 : 0)
  );

  const selectedMessages = [];
  let currentLength = 0;
  for (let i = messageLines.length - 1; i >= 0; i -= 1) {
    const line = messageLines[i];
    const nextLength = currentLength + line.length + 1;
    if (nextLength > remainingBudget && selectedMessages.length > 0) {
      break;
    }
    if (nextLength > remainingBudget) {
      break;
    }
    selectedMessages.unshift(line);
    currentLength = nextLength;
  }

  const blocks = [];
  if (summaryBlock) {
    blocks.push(summaryBlock);
  }
  if (selectedMessages.length > 0) {
    blocks.push(selectedMessages.join("\n"));
  }

  return blocks.join("\n\n").trim();
}

export async function readSessionJsonl(filePath, { maxChars = 12000 } = {}) {
  if (!filePath) {
    return "";
  }
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }

  const entries = [];
  const lines = raw.split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      entries.push(entry);
    } catch (_error) {
      // skip invalid
    }
  }

  return buildTranscriptFromEntries(entries, { maxChars });
}
