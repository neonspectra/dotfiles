export function buildMemoryExtractionPrompt(conversation) {
  return `You are a memory extraction assistant.\n\nFrom the conversation below, extract a short list of concise memory items that the assistant should remember long-term.\n\nRules:\n- Return JSON only, no markdown.\n- The JSON must be an array of strings.\n- Each item should be a single sentence.\n- If nothing is worth remembering, return an empty array ([]).\n\nConversation:\n${conversation}`.trim();
}

export function parseMemoryExtractionResponse(text) {
  if (!text) {
    return [];
  }

  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => String(item).trim()).filter(Boolean);
    }
    if (parsed && Array.isArray(parsed.items)) {
      return parsed.items.map((item) => String(item).trim()).filter(Boolean);
    }
  } catch (_error) {
    // fall through
  }

  return trimmed
    .split("\n")
    .map((line) => line.replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);
}

export async function extractMemoriesWithModel({
  model,
  persona,
  conversation,
  apiKey,
  maxTokens = 256,
  temperature = 0,
}) {
  const prompt = buildMemoryExtractionPrompt(conversation);
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

  return parseMemoryExtractionResponse(output);
}
