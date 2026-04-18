import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_BASE_DIR = path.join(os.homedir(), ".pi");

const DEFAULT_CONFIG = {
  baseDir: DEFAULT_BASE_DIR,
  memoryDir: "stateful-memory/memory/sessions",
  personaFile: "stateful-memory/SOUL.md",
  auxiliaryPersonaFiles: [
    "stateful-memory/STYLE.md",
    "stateful-memory/REGISTER.md",
    "stateful-memory/SLEEP.md",
  ],
  factsFile: "stateful-memory/FACTS.md",
  wakeFile: "stateful-memory/WAKE.md",
  dreamsDir: "stateful-memory/dreams",
  memoryModel: "codex:gpt-5.1-codex-mini",
  memoryModelMaxTokens: 512,
  recallModelMaxTokens: 1024,
  memoryModelTemperature: 0,
  sessionSummaryMaxChars: 12000,
  recallMaxSessionChars: 12000,
  topicsFile: "stateful-memory/PERSONALITY_MATRIX.md",
  topicPersistenceCount: 3,
  topicPreviousMessageMaxChars: 500,
  neotomaDataDir: "/home/monika/.pi/neotoma",
  tagmemSocketPath: null,
};

const CONFIG_FILENAME = ".pi/stateful-memory.json";
const GLOBAL_CONFIG_PATH = path.join(
  os.homedir(),
  ".pi",
  "agent",
  "stateful-memory.json"
);

async function readConfigFile(configPath) {
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return {};
  }
}

const PATH_KEYS = ["memoryDir", "personaFile", "factsFile", "wakeFile", "dreamsDir", "topicsFile"];
const PATH_ARRAY_KEYS = ["auxiliaryPersonaFiles"];

function resolveRelative(value, baseDir) {
  if (!value || typeof value !== "string") {
    return value;
  }
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function resolveConfigPaths({ config }) {
  // Resolve baseDir first — everything else is relative to it.
  const baseDir = config.baseDir
    ? (path.isAbsolute(config.baseDir) ? config.baseDir : path.resolve(config.baseDir))
    : DEFAULT_BASE_DIR;

  const resolved = { ...config, baseDir };

  for (const key of PATH_KEYS) {
    resolved[key] = resolveRelative(resolved[key], baseDir);
  }

  for (const key of PATH_ARRAY_KEYS) {
    const entries = Array.isArray(resolved[key]) ? resolved[key] : [];
    resolved[key] = entries.map((entry) => resolveRelative(entry, baseDir));
  }

  return resolved;
}

export async function loadConfig(cwd) {
  const configPath = path.resolve(cwd, CONFIG_FILENAME);
  const [globalConfig, fileConfig] = await Promise.all([
    readConfigFile(GLOBAL_CONFIG_PATH),
    readConfigFile(configPath),
  ]);

  const auxiliaryPersonaFiles = process.env.PI_STATEFUL_MEMORY_AUX_PERSONA_FILES
    ? process.env.PI_STATEFUL_MEMORY_AUX_PERSONA_FILES.split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined;

  const envConfig = {
    memoryDir: process.env.PI_STATEFUL_MEMORY_DIR,
    personaFile: process.env.PI_STATEFUL_MEMORY_PERSONA_FILE,
    auxiliaryPersonaFiles,
    factsFile: process.env.PI_STATEFUL_MEMORY_FACTS_FILE,
    wakeFile: process.env.PI_STATEFUL_MEMORY_WAKE_FILE,
    dreamsDir: process.env.PI_STATEFUL_MEMORY_DREAMS_DIR,
    memoryModel: process.env.PI_STATEFUL_MEMORY_MODEL,
    memoryModelMaxTokens: process.env.PI_STATEFUL_MEMORY_MODEL_MAX_TOKENS
      ? Number(process.env.PI_STATEFUL_MEMORY_MODEL_MAX_TOKENS)
      : undefined,
    recallModelMaxTokens: process.env.PI_STATEFUL_MEMORY_RECALL_MAX_TOKENS
      ? Number(process.env.PI_STATEFUL_MEMORY_RECALL_MAX_TOKENS)
      : undefined,
    memoryModelTemperature: process.env.PI_STATEFUL_MEMORY_MODEL_TEMPERATURE
      ? Number(process.env.PI_STATEFUL_MEMORY_MODEL_TEMPERATURE)
      : undefined,
    sessionSummaryMaxChars: process.env.PI_STATEFUL_MEMORY_SUMMARY_MAX_CHARS
      ? Number(process.env.PI_STATEFUL_MEMORY_SUMMARY_MAX_CHARS)
      : undefined,
    recallMaxSessionChars: process.env.PI_STATEFUL_MEMORY_RECALL_MAX_CHARS
      ? Number(process.env.PI_STATEFUL_MEMORY_RECALL_MAX_CHARS)
      : undefined,
    topicsFile: process.env.PI_STATEFUL_MEMORY_TOPICS_FILE,
  };

  const merged = {
    ...DEFAULT_CONFIG,
    ...globalConfig,
    ...fileConfig,
    ...Object.fromEntries(
      Object.entries(envConfig).filter(([, value]) => value !== undefined)
    ),
  };

  return resolveConfigPaths({ config: merged });
}

export function resolvePath(cwd, targetPath) {
  if (!targetPath) {
    return undefined;
  }
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.resolve(cwd, targetPath);
}

export { DEFAULT_CONFIG, CONFIG_FILENAME, GLOBAL_CONFIG_PATH };
