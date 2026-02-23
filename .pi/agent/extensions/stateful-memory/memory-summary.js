export function buildSessionSummaryPrompt({ transcript, explicitFacts = [] }) {
  const factsSection = explicitFacts.length
    ? `\n\nExplicit facts (use only if central):\n${explicitFacts
        .map((fact) => `- ${fact}`)
        .join("\n")}`
    : "";

  return `You are summarizing a session for long-term memory.\n\nRules:\n- Write 2-5 concise sentences in plain text.\n- Focus on durable facts, decisions, preferences, and outcomes.\n- Do not include tool names, file paths, or timestamps unless crucial.\n- Do not exaggerate.\n- Use the same voice as the persona.\n- If explicit facts are listed, include them only if they matter to the session's core.\n\nSession transcript:\n${transcript}${factsSection}`.trim();
}

export async function summarizeSessionWithModel({
  model,
  apiKey,
  persona,
  transcript,
  explicitFacts = [],
  maxTokens = 256,
  temperature = 0,
}) {
  const prompt = buildSessionSummaryPrompt({ transcript, explicitFacts });
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
    .join("\n")
    .trim();

  if (response.stopReason === "error") {
    return "";
  }

  return output.replace(/\s+/g, " ").trim();
}
