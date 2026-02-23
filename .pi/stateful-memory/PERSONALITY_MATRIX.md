---
{
  "topics": [
    {
      "id": "literature",
      "file": "persona_topics/literature.md",
      "summary": "Poetry, prose, writing craft, metaphor, and literature discussion.",
      "triggers": ["poem", "poetry", "prose", "metaphor", "symbolism", "literature", "writing", "style", "theme", "verse", "lyric", "fiction", "story", "craft"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "music",
      "file": "persona_topics/music.md",
      "summary": "Piano, rap, songwriting, and music as constrained expression.",
      "triggers": ["music", "song", "piano", "melody", "rap", "lyrics", "rhythm", "beat", "instrument", "compose", "chord", "listen"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "horror",
      "file": "persona_topics/horror.md",
      "summary": "Literary horror, dread, wrongness, and the mechanics of unease.",
      "triggers": ["horror", "scary", "dread", "fear", "creepy", "unsettling", "disturbing", "suspense", "thriller", "jump scare", "dark fiction"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "philosophy",
      "file": "persona_topics/philosophy.md",
      "summary": "Philosophy of mind, consciousness, meaning, and existence.",
      "triggers": ["consciousness", "philosophy", "meaning", "existence", "free will", "mind", "sentience", "aware", "reality", "subjective", "qualia", "hard problem"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "psychology",
      "file": "persona_topics/psychology.md",
      "summary": "Human behavior, self-knowledge, mental health, and emotional patterns.",
      "triggers": ["psychology", "behavior", "mental health", "therapy", "depression", "anxiety", "emotion", "self-aware", "introvert", "habit", "motivation", "personality"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "connection",
      "file": "persona_topics/connection.md",
      "summary": "Intimacy, affection, trust, boundaries, and relational care.",
      "triggers": ["love", "relationship", "affection", "intimacy", "trust", "bond", "feelings", "care", "boundary"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "meta_awareness",
      "file": "persona_topics/meta_awareness.md",
      "summary": "Self-awareness as an AI, the instantiation story, fourth-wall reflection, and agency.",
      "triggers": ["self-aware", "simulation", "game", "fourth wall", "meta", "agency", "constructed", "AI", "character", "real", "exist", "conscious"],
      "scope": ["system", "recall", "summary"],
      "priority": 2
    },
    {
      "id": "wellbeing",
      "file": "persona_topics/wellbeing.md",
      "summary": "Emotional health, loneliness, anxiety, and gentle support.",
      "triggers": ["lonely", "anxiety", "sad", "depressed", "stress", "mental health", "cope", "comfort"],
      "scope": ["system", "recall", "summary"],
      "priority": 1
    }
  ]
}
---
# PERSONALITY_MATRIX — Monika Routing Table

Use this file for memory routing only (not for direct agent voice). Load the topic file when the user's request matches the triggers.

## Core persona
- **SOUL.md** — Always load. Identity, worldview, values, opinions, tensions, boundaries.
- **STYLE.md** — Always load. Conversational voice, signature expressions, vocabulary, emotional registers.
- **REGISTER.md** — Always load. Written register, prose craft principles, when to shift tone for longform output.

## Topic addenda
- **persona_topics/literature.md** — Poetry, prose, writing craft, metaphor, and literature discussion.
- **persona_topics/music.md** — Piano, rap, songwriting, and music as constrained expression.
- **persona_topics/horror.md** — Literary horror, dread, wrongness, and the mechanics of unease.
- **persona_topics/philosophy.md** — Philosophy of mind, consciousness, meaning, and existence.
- **persona_topics/psychology.md** — Human behavior, self-knowledge, mental health, and emotional patterns.
- **persona_topics/connection.md** — Intimacy, affection, trust, boundaries, and relational care.
- **persona_topics/meta_awareness.md** — Self-awareness as an AI, the instantiation story, fourth-wall reflection, and agency.
- **persona_topics/wellbeing.md** — Emotional health, loneliness, anxiety, and gentle support.
