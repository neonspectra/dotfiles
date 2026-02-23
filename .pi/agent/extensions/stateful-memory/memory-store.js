import { promises as fs } from "node:fs";
import path from "node:path";

function pad(value) {
  return String(value).padStart(2, "0");
}

export function formatTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds()
  )}`;
}

export function formatSessionStamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(
    date.getSeconds()
  )}`;
}

export function slugifyTopic(text, maxWords = 6) {
  if (!text) {
    return "untitled";
  }

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords);

  return words.length > 0 ? words.join("-") : "untitled";
}

const SLUG_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "she",
  "that",
  "the",
  "their",
  "they",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "who",
  "with",
  "you",
  "your",
]);

export function slugifyKeywords(text, maxWords = 6) {
  if (!text) {
    return "untitled";
  }

  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !SLUG_STOP_WORDS.has(token));

  const seen = new Set();
  const keywords = [];
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= maxWords) {
      break;
    }
  }

  return keywords.length > 0 ? keywords.join("-") : "untitled";
}

export function formatMemoryLine({
  text,
  tags = [],
  timestamp = new Date(),
  sessionPath = "unknown",
}) {
  const sessionSection = sessionPath
    ? ` [session: ${sessionPath}]`
    : "";
  const tagSection = tags.length > 0 ? ` [tags: ${tags.join(", ")}]` : "";
  return `- [${formatTimestamp(timestamp)}]${sessionSection}${tagSection} ${text}`.trim();
}

export function parseMemoryLine(line) {
  const match = line.match(
    /^-\s+\[(?<timestamp>[^\]]+)\](?:\s+\[session:\s*(?<session>[^\]]+)\])?(?:\s+\[tags:\s*(?<tags>[^\]]+)\])?\s+(?<text>.+)$/
  );
  if (!match?.groups) {
    return null;
  }
  const tags = match.groups.tags
    ? match.groups.tags.split(",").map((tag) => tag.trim()).filter(Boolean)
    : [];
  return {
    timestamp: match.groups.timestamp,
    sessionPath: match.groups.session,
    tags,
    text: match.groups.text,
    raw: line,
  };
}

export class MemoryStore {
  constructor({ memoryDir, personaFile, auxiliaryPersonaFiles = [], userFile, memoryFile }) {
    this.memoryDir = memoryDir;
    this.personaFile = personaFile;
    this.auxiliaryPersonaFiles = auxiliaryPersonaFiles;
    this.userFile = userFile;
    this.memoryFile = memoryFile;
    this.sessionPath = "unknown";
    this.sessionStartedAt = new Date();
  }

  setSessionInfo({ sessionPath, sessionStartedAt }) {
    if (sessionPath) {
      this.sessionPath = sessionPath;
    }
    if (sessionStartedAt) {
      this.sessionStartedAt = sessionStartedAt;
    }
  }

  setMemoryFile(fileName) {
    this.memoryFile = fileName;
  }

  get memoryFilePath() {
    return path.join(this.memoryDir, this.memoryFile);
  }

  get sessionStamp() {
    return formatSessionStamp(this.sessionStartedAt);
  }

  getSessionFileName(topicSlug = "untitled") {
    return `session-${this.sessionStamp}__${topicSlug}.md`;
  }

  async ensureFiles({ defaultPersona, defaultUserProfile } = {}) {
    if (!this.memoryFile) {
      throw new Error("Memory file name is not set.");
    }

    await fs.mkdir(this.memoryDir, { recursive: true });

    const header = `# Session Memory\n\nSession: ${this.sessionPath}\nStarted: ${formatTimestamp(
      this.sessionStartedAt
    )}\n`;

    await this.#ensureFile(this.memoryFilePath, `${header}\n`);

    if (this.personaFile) {
      await this.#ensureFile(
        this.personaFile,
        defaultPersona ?? "# Soul\n"
      );
    }

    if (this.userFile) {
      await this.#ensureFile(
        this.userFile,
        defaultUserProfile ?? "# User Profile\n"
      );
    }
  }

  async #ensureFile(filePath, content) {
    try {
      await fs.access(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    }
  }

  async readPersona() {
    if (!this.personaFile) {
      return "";
    }
    const parts = await Promise.all([
      this.#readFileSafe(this.personaFile),
      ...this.auxiliaryPersonaFiles.map((f) => this.#readFileSafe(f)),
    ]);
    return parts.filter(Boolean).join("\n\n---\n\n");
  }

  async readUserProfile() {
    if (!this.userFile) {
      return "";
    }
    return this.#readFileSafe(this.userFile);
  }

  async #readFileSafe(filePath) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async readMemoryEntries() {
    return this.#readMemoryFileEntries(this.memoryFilePath);
  }

  async readAllMemoryEntries() {
    const files = await this.#listMemoryFiles();
    const entries = [];

    for (const file of files) {
      const fileEntries = await this.#readMemoryFileEntries(
        path.join(this.memoryDir, file)
      );
      entries.push(...fileEntries);
    }

    return entries;
  }

  async listMemoryFiles() {
    return this.#listMemoryFiles();
  }

  async readMemoryFile(fileName) {
    return this.#readFileSafe(path.join(this.memoryDir, fileName));
  }

  async readMemoryFileEntries(fileName) {
    return this.#readMemoryFileEntries(path.join(this.memoryDir, fileName));
  }

  async upsertSessionSummary(text, { tags = [] } = {}) {
    const summaryTags = ["session-summary", ...tags]
      .map((tag) => tag?.trim())
      .filter(Boolean);
    const line = formatMemoryLine({
      text,
      tags: [...new Set(summaryTags)],
      sessionPath: this.sessionPath,
    });

    const raw = await this.#readFileSafe(this.memoryFilePath);
    const lines = raw.split("\n");

    const filtered = lines.filter((entry) => {
      const parsed = parseMemoryLine(entry.trim());
      if (!parsed) {
        return true;
      }
      return !parsed.tags.includes("session-summary");
    });

    let insertIndex = filtered.findIndex((entry) => entry.trim().startsWith("- ["));
    if (insertIndex === -1) {
      insertIndex = filtered.length;
    }

    filtered.splice(insertIndex, 0, line);

    let output = filtered.join("\n");
    if (!output.endsWith("\n")) {
      output += "\n";
    }

    await fs.writeFile(this.memoryFilePath, output, "utf8");
    return line;
  }

  async #readMemoryFileEntries(filePath) {
    const raw = await this.#readFileSafe(filePath);
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseMemoryLine)
      .filter(Boolean);
  }

  async #listMemoryFiles() {
    try {
      const entries = await fs.readdir(this.memoryDir, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  async appendMemories(items, { tags = [] } = {}) {
    const lines = items
      .map((text) => text?.trim())
      .filter(Boolean)
      .map((text) =>
        formatMemoryLine({
          text,
          tags,
          sessionPath: this.sessionPath,
        })
      );

    if (lines.length === 0) {
      return [];
    }

    const payload = `\n${lines.join("\n")}\n`;
    await fs.appendFile(this.memoryFilePath, payload, "utf8");
    return lines;
  }

  async appendUserProfile(items, { heading = "Learned Facts" } = {}) {
    if (!this.userFile) {
      return [];
    }

    const additions = items
      .map((text) => text?.trim())
      .filter(Boolean)
      .map((text) => `- ${text}`);

    if (additions.length === 0) {
      return [];
    }

    let current = await this.#readFileSafe(this.userFile);
    const header = `## ${heading}`;

    if (!current.includes(header)) {
      current = `${current.trimEnd()}\n\n${header}\n`;
    } else if (!current.endsWith("\n")) {
      current += "\n";
    }

    current += `${additions.join("\n")}\n`;
    await fs.writeFile(this.userFile, current, "utf8");
    return additions;
  }
}
