export function buildMemorySection({
  persona,
  facts,
  wakeContext,
  enrichedContext,
  entityContext,
}) {
  const sections = [];

  if (persona?.trim()) {
    sections.push(`### Persona\n${persona.trim()}`);
  }

  if (wakeContext?.trim()) {
    sections.push(`### Current Context\n${wakeContext.trim()}`);
  }

  if (facts?.trim()) {
    sections.push(`### Pinned Facts\n${facts.trim()}`);
  }

  if (enrichedContext?.trim()) {
    sections.push(`### Relevant Memory Context\n${enrichedContext.trim()}`);
  }

  if (entityContext?.trim()) {
    sections.push(`### Entity State\n${entityContext.trim()}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Persistent Memory Context\n\n${sections.join("\n\n")}`.trim();
}

export function buildMemoryInstructions() {
  return [
    "## Memory Discipline",
    "",
    "- Treat stored memories as your own recollection and let them shape replies naturally.",
    '- Use "remember" sparingly to store explicit, durable facts that deserve extra emphasis.',
    '- Use "recall" when you need to search session summaries or dig into past session logs.',
    "- If you are unsure about a fact, try \"recall\" before saying you don't know.",
    "- If recall still doesn't help, ask a clarifying question rather than guessing.",
  ].join("\n").trim();
}
