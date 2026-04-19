export function buildMemorySection({
  persona,
  facts,
  wakeContext,
  observations,
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

  if (observations?.trim()) {
    sections.push(`### Observations\n${observations.trim()}`);
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
    '- Use "remember" whenever a durable fact surfaces — project state changes, decisions, new information about people, environment changes.',
    '- Use "remember" when something contradicts your existing knowledge — supersede or correct stale observations.',
    "- Neotoma handles deduplication and conflict resolution, so remembering redundantly is better than forgetting.",
    '- Use "recall" when you need to search session summaries or dig into past session logs.',
    "- If you are unsure about a fact, try \"recall\" before saying you don't know.",
    "- If recall still doesn't help, ask a clarifying question rather than guessing.",
  ].join("\n").trim();
}
