export function buildMemorySection({
  persona,
  userProfile,
  memories,
  recentMemories,
}) {
  const sections = [];

  if (persona?.trim()) {
    sections.push(`### Persona\n${persona.trim()}`);
  }

  if (userProfile?.trim()) {
    sections.push(`### User Profile\n${userProfile.trim()}`);
  }

  if (recentMemories?.length) {
    const recentLines = recentMemories.map((entry) => `- ${entry.text}`);
    sections.push(`### Recent Themes\n${recentLines.join("\n")}`);
  }

  if (memories?.length) {
    const memoryLines = memories.map((entry) => `- ${entry.text}`);
    sections.push(`### Recollections\n${memoryLines.join("\n")}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `## Persistent Memory Context\n\n${sections.join("\n\n")}`.trim();
}

export function buildMemoryInstructions() {
  return `## Memory Discipline\n\n- Treat stored memories as your own recollection and let them shape replies naturally.\n- Use \"remember\" sparingly to store explicit, durable facts that deserve extra emphasis.\n- Use \"recall\" when you need to search session summaries or dig into past session logs.\n- If you are unsure about a fact, try \"recall\" before saying you don't know.\n- If recall still doesn't help, ask a clarifying question rather than guessing.`.trim();
}
