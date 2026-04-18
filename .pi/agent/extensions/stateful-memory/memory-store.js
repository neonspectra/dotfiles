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
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from",
  "has", "have", "i", "if", "in", "is", "it", "me", "my", "of", "on", "or",
  "our", "she", "that", "the", "their", "they", "this", "to", "we", "what",
  "when", "where", "who", "with", "you", "your",
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

export class MemoryStore {
  constructor({ memoryDir, personaFile, auxiliaryPersonaFiles = [], factsFile, wakeFile }) {
    this.memoryDir = memoryDir;
    this.personaFile = personaFile;
    this.auxiliaryPersonaFiles = auxiliaryPersonaFiles;
    this.factsFile = factsFile;
    this.wakeFile = wakeFile;
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

  async ensureFiles({ defaultPersona, defaultUserProfile } = {}) {
    if (this.personaFile) {
      await this.#ensureFile(
        this.personaFile,
        defaultPersona ?? "# Soul\n"
      );
    }

    if (this.factsFile) {
      await this.#ensureFile(
        this.factsFile,
        defaultUserProfile ?? "# Pinned Facts\n"
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

  async readFacts() {
    if (!this.factsFile) {
      return "";
    }
    return this.#readFileSafe(this.factsFile);
  }

  async readWakeContext() {
    if (!this.wakeFile) {
      return "";
    }
    return this.#readFileSafe(this.wakeFile);
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
}
