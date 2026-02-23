export function buildRecallPlanPrompt({ query, memoryIndex }) {
  const indexLines = memoryIndex
    .map(
      (item, idx) =>
        `${idx + 1}. file: ${item.fileName}\n   timestamp: ${item.timestamp}\n   session: ${item.sessionPath ?? "unknown"}\n   summary: ${item.summary ?? "(no summary)"}`
    )
    .join("\n");

  return `You are a memory retrieval assistant.\n\nGiven the query and the memory index, select the memory files most relevant.\nReturn JSON only, no markdown.\n\nJSON schema:\n{\n  \"memoryFiles\": string[],\n  \"needsSessionDetails\": boolean,\n  \"notes\": string\n}\n\nRules:\n- Choose up to 3 memory files by exact file name.\n- If the summaries are insufficient, set needsSessionDetails to true.\n- If nothing is relevant, return an empty memoryFiles array and needsSessionDetails false.\n\nQuery:\n${query}\n\nMemory index:\n${indexLines}`.trim();
}

export function parseRecallPlan(text, memoryIndex) {
  if (!text) {
    return { memoryFiles: [], needsSessionDetails: false, notes: "" };
  }

  let parsed;
  try {
    parsed = JSON.parse(text.trim());
  } catch (_error) {
    return { memoryFiles: [], needsSessionDetails: false, notes: "" };
  }

  const memoryFiles = Array.isArray(parsed?.memoryFiles)
    ? parsed.memoryFiles.map((file) => String(file))
    : [];
  const validNames = new Set(memoryIndex.map((item) => item.fileName));

  return {
    memoryFiles: memoryFiles.filter((name) => validNames.has(name)),
    needsSessionDetails: Boolean(parsed?.needsSessionDetails),
    notes: parsed?.notes ? String(parsed.notes) : "",
  };
}

export async function planRecallWithModel({
  model,
  apiKey,
  persona,
  query,
  memoryIndex,
  maxTokens = 256,
  temperature = 0,
}) {
  const prompt = buildRecallPlanPrompt({ query, memoryIndex });
  const context = {
    systemPrompt: persona?.trim() || undefined,
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };

  const { completeSimple } = await import("@mariozechner/pi-ai");
  const options = { apiKey, maxTokens };
  if (temperature !== undefined && model.api !== "openai-codex-responses") {
    options.temperature = temperature;
  }
  const response = await completeSimple(model, context, options);

  const output = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

  return parseRecallPlan(output, memoryIndex);
}

export function buildRecallResponsePrompt({
  query,
  selectedMemories,
  sessionExcerpts,
}) {
  const memorySection = selectedMemories.length
    ? `\n\nMemory summaries:\n${selectedMemories
        .map((memory) => `- ${memory}`)
        .join("\n")}`
    : "";

  const sessionSection = sessionExcerpts.length
    ? `\n\nSession excerpts:\n${sessionExcerpts
        .map(
          (excerpt) =>
            `[session: ${excerpt.sessionPath}]\n${excerpt.excerpt}`
        )
        .join("\n\n")}`
    : "";

  return `You are recalling information for the user query.\n\nAnswer in first-person stream-of-consciousness, as if you are remembering past conversations.\nKeep it grounded in the memory summaries and session excerpts.\nIf you do not know, say so plainly.\n\nQuery:\n${query}${memorySection}${sessionSection}`.trim();
}

export async function recallWithModel({
  model,
  apiKey,
  persona,
  query,
  selectedMemories,
  sessionExcerpts,
  maxTokens = 512,
  temperature = 0,
}) {
  const prompt = buildRecallResponsePrompt({
    query,
    selectedMemories,
    sessionExcerpts,
  });

  const context = {
    systemPrompt: persona?.trim() || undefined,
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };

  const { completeSimple } = await import("@mariozechner/pi-ai");
  const options = { apiKey, maxTokens };
  if (temperature !== undefined && model.api !== "openai-codex-responses") {
    options.temperature = temperature;
  }
  const response = await completeSimple(model, context, options);

  if (response.stopReason === "error") {
    return "";
  }

  return response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}
