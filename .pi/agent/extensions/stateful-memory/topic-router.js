import { promises as fs } from "node:fs";
import path from "node:path";
import { tokenize } from "./memory-retriever.js";

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\n?/;

function parseFrontmatter(raw) {
  if (!raw?.startsWith("---")) {
    return { frontmatter: null, body: raw };
  }
  const match = raw.match(FRONTMATTER_REGEX);
  if (!match) {
    return { frontmatter: null, body: raw };
  }
  const frontmatter = match[1];
  const body = raw.slice(match[0].length);
  return { frontmatter, body };
}

function parseFrontmatterJson(frontmatter) {
  if (!frontmatter) {
    return {};
  }
  try {
    return JSON.parse(frontmatter.trim());
  } catch (_error) {
    return {};
  }
}

function normalizeScope(scope) {
  if (!scope) {
    return [];
  }
  if (Array.isArray(scope)) {
    return scope.map((value) => String(value).toLowerCase());
  }
  return [String(scope).toLowerCase()];
}

function normalizeTriggers(triggers) {
  if (!triggers) {
    return [];
  }
  return Array.isArray(triggers) ? triggers.map((item) => String(item)) : [String(triggers)];
}

export async function loadTopicIndex({ cwd, topicsFile }) {
  const resolvedPath = path.isAbsolute(topicsFile)
    ? topicsFile
    : path.resolve(cwd, topicsFile);
  const baseDir = path.dirname(resolvedPath);

  const raw = await fs.readFile(resolvedPath, "utf8");
  const { frontmatter } = parseFrontmatter(raw);
  const data = parseFrontmatterJson(frontmatter);
  const topics = Array.isArray(data.topics) ? data.topics : [];

  return topics
    .map((topic) => ({
      id: String(topic.id ?? "").trim(),
      file: String(topic.file ?? "").trim(),
      summary: topic.summary ? String(topic.summary).trim() : "",
      triggers: normalizeTriggers(topic.triggers),
      scope: normalizeScope(topic.scope),
      priority: Number.isFinite(Number(topic.priority)) ? Number(topic.priority) : 0,
    }))
    .filter((topic) => topic.id && topic.file)
    .map((topic) => ({
      ...topic,
      filePath: path.isAbsolute(topic.file)
        ? topic.file
        : path.resolve(baseDir, topic.file),
    }));
}

function scoreTopic(topic, queryTokens) {
  if (!topic.triggers?.length || queryTokens.size === 0) {
    return 0;
  }

  const triggerTokens = new Set();
  for (const trigger of topic.triggers) {
    for (const token of tokenize(trigger)) {
      triggerTokens.add(token);
    }
  }

  let overlap = 0;
  for (const token of queryTokens) {
    if (triggerTokens.has(token)) {
      overlap += 1;
    }
  }

  if (overlap === 0) {
    return 0;
  }

  return overlap + (topic.priority ?? 0) * 0.5;
}

export function selectTopics({ query, topics, scope, maxResults = 3, minScore = 1 }) {
  const queryTokens = new Set(tokenize(query ?? ""));
  if (queryTokens.size === 0) {
    return [];
  }

  const scopeKey = scope ? String(scope).toLowerCase() : null;
  const scored = topics
    .filter((topic) => !scopeKey || topic.scope.includes(scopeKey))
    .map((topic) => ({
      topic,
      score: scoreTopic(topic, queryTokens),
    }))
    .filter((item) => item.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((item) => item.topic);

  return scored;
}

function extractTitleAndBody(raw) {
  const { body } = parseFrontmatter(raw);
  const lines = body.split("\n");
  const firstLine = lines.find((line) => line.trim());
  if (firstLine?.startsWith("#")) {
    const title = firstLine.replace(/^#+\s*/, "").trim();
    const rest = lines.slice(lines.indexOf(firstLine) + 1).join("\n").trim();
    return { title, body: rest };
  }
  return { title: "", body: body.trim() };
}

export async function readTopicContent(topic) {
  const raw = await fs.readFile(topic.filePath, "utf8");
  return extractTitleAndBody(raw);
}

export async function buildTopicAddendum({ topics }) {
  if (!topics?.length) {
    return "";
  }

  const sections = [];
  for (const topic of topics) {
    const { title, body } = await readTopicContent(topic);
    const heading = title || topic.id;
    const content = body || "";
    sections.push(`### ${heading}\n${content}`.trim());
  }

  return `## Topic Addenda\n\n${sections.join("\n\n")}`.trim();
}

export function listTopicMetadata(topics) {
  return topics.map((topic) => ({
    id: topic.id,
    summary: topic.summary,
    triggers: topic.triggers,
    scope: topic.scope,
    priority: topic.priority,
  }));
}
