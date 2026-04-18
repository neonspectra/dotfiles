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

// ── OBSERVATIONS.md render ──────────────────────────────────────────────────

const TYPE_ORDER = ["sophont", "project", "decision", "environment", "preference", "self"];
const TYPE_LABELS = {
  sophont: "People",
  project: "Projects",
  decision: "Decisions",
  environment: "Environment",
  preference: "Preferences",
  self: "Self",
};
const MAX_OBS_PER_ENTITY = 10;

/**
 * Render all Neotoma entity snapshots to a markdown file.
 * Deterministic — produces the same output for the same entity state.
 *
 * @param {import('./neotoma-client.js').NeotomaClient} neotomaClient
 * @param {string} outputPath — path to write OBSERVATIONS.md
 * @returns {Promise<string>} the rendered content
 */
export async function renderObservations(neotomaClient, outputPath) {
  const { entities } = await neotomaClient.listEntities();

  // Group by entity type
  const groups = new Map();
  for (const entity of entities) {
    const type = entity.entity_type;
    if (!groups.has(type)) groups.set(type, []);
    groups.get(type).push(entity);
  }

  const sections = [];
  sections.push("# Entity Observations");
  sections.push("");
  sections.push("*Rendered from Neotoma entity store. Regenerated on every session start.*");

  // Render in defined order, then any unknown types
  const orderedTypes = [...TYPE_ORDER];
  for (const type of groups.keys()) {
    if (!orderedTypes.includes(type)) orderedTypes.push(type);
  }

  for (const type of orderedTypes) {
    const entities = groups.get(type);
    if (!entities || entities.length === 0) continue;

    const label = TYPE_LABELS[type] || type.charAt(0).toUpperCase() + type.slice(1);
    sections.push("");
    sections.push(`## ${label}`);

    // Sort entities alphabetically by name
    entities.sort((a, b) => a.canonical_name.localeCompare(b.canonical_name));

    for (const entity of entities) {
      const obs = entity.snapshot?.observations;
      if (!obs || obs.length === 0) {
        sections.push(`\n- **${entity.canonical_name}** *(no observations recorded)*`);
        continue;
      }

      sections.push(`\n### ${entity.canonical_name}`);
      const shown = obs.slice(0, MAX_OBS_PER_ENTITY);
      for (const o of shown) {
        sections.push(`- ${o}`);
      }
      if (obs.length > MAX_OBS_PER_ENTITY) {
        sections.push(`- *(${obs.length - MAX_OBS_PER_ENTITY} more observations...)*`);
      }
    }
  }

  const content = sections.join("\n") + "\n";
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, content, "utf8");
  return content;
}

// ── Recency index ───────────────────────────────────────────────────────────

/**
 * Update the recency index with a new session write-back entry.
 * Most recent first, capped at 50 entries.
 *
 * @param {string} indexPath
 * @param {{ sessionPath: string, tagmemEntryId: number, timestamp: string, tags: string[] }} entry
 */
export async function updateRecencyIndex(indexPath, entry) {
  let entries = await readRecencyIndex(indexPath);

  // Remove any existing entry for this session (dedup on resume)
  entries = entries.filter(e => e.sessionPath !== entry.sessionPath);

  // Prepend new entry
  entries.unshift(entry);

  // Cap at 50
  if (entries.length > 50) entries = entries.slice(0, 50);

  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(entries, null, 2), "utf8");
}

/**
 * Read the recency index. Returns empty array if file doesn't exist.
 * @param {string} indexPath
 * @returns {Promise<Array<{ sessionPath: string, tagmemEntryId: number, timestamp: string, tags: string[] }>>}
 */
export async function readRecencyIndex(indexPath) {
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    console.error("[stateful-memory] Failed to read recency index:", error.message);
    return [];
  }
}

// ── MemoryStore ─────────────────────────────────────────────────────────────

export class MemoryStore {
  constructor({ memoryDir, personaFile, auxiliaryPersonaFiles = [], factsFile, wakeFile, observationsFile }) {
    this.memoryDir = memoryDir;
    this.personaFile = personaFile;
    this.auxiliaryPersonaFiles = auxiliaryPersonaFiles;
    this.factsFile = factsFile;
    this.wakeFile = wakeFile;
    this.observationsFile = observationsFile;
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

  async readObservations() {
    if (!this.observationsFile) {
      return "";
    }
    return this.#readFileSafe(this.observationsFile);
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
