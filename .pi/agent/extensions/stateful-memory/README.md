# Stateful Memory — Extension Reference

The `stateful-memory` extension gives Pi persistent identity across sessions. It manages
persona injection, memory retrieval, entity observations, topic routing, and the sleep cycle.

## How It Works

### System Prompt Assembly

On every turn (`before_agent_start`), the extension builds the system prompt addon:

1. **Persona** — SOUL.md + STYLE.md + REGISTER.md + SLEEP.md
2. **Current Context** — WAKE.md (orientation from last sleep cycle)
3. **Pinned Facts** — FACTS.md (foundational grounding)
4. **Entity Context** — Recent observations + entity awareness index (rendered on session start)
5. **Memory Context** — enrichment results from memstore (first message only)
6. **Topic Addenda** — 0–3 topic files selected by the topic router

### Memory Enrichment (First Message)

When the first user message arrives:

1. Check memstore queue depth — if save jobs are pending, ask whether to wait
2. Search memstore with the user's prompt (natural language → FTS5 query)
3. Fetch top 3 results, truncate bodies to 3000 chars each
4. Cache results — they're included in the system prompt for the rest of the session

### Session Saves

On session close or switch, the full session transcript is normalized (tool calls
stripped, text extracted) and submitted to memstore via `proxy/submit_save`. This
returns instantly (~1ms) — memstore queues the job and processes it in the background.

The save flow:
1. Read session JSONL → extract user/assistant text blocks
2. Generate a slug title from keywords
3. Detect project tags from content and active topics
4. Submit to memstore proxy (body, title, origin, tags, depth)
5. Update recency index (`recent-sessions.json`)

The memstore save job processor extracts the session date from the `# Date:` header
in the transcript body and uses it as `created_at`. This means re-saving a resumed
session preserves the original date. `updated_at` reflects when the entry was last
written.

### Entity Observations (memstore)

The `remember` tool writes observations to memstore's `observations` table — a separate
FTS5-indexed table distinct from session transcripts. Each observation is associated with
an entity (person, project, decision, preference, environment, self).

On session start, the entity context is rendered from two sources:
- **Recent observations** — the 15 most recent observations from memstore, grouped by
  entity type and name, with bodies truncated to ~150 chars
- **Entity awareness** — a compact listing of all known entities from `entity-index.json`,
  showing name, type, count, and last observation date

The `entity-index.json` file is a local cache maintained by the remember tool. If lost,
it can be rebuilt from memstore. It lives at `~/.pi/stateful-memory/entity-index.json`.

## Configuration

Config is loaded from `~/.pi/agent/stateful-memory.json` with defaults from `config.js`.

### Key config values

| Key | Description |
|---|---|
| `personaFile` | Primary persona file (SOUL.md) |
| `auxiliaryPersonaFiles` | Additional persona files (STYLE.md, REGISTER.md, SLEEP.md) |
| `factsFile` | Pinned facts (FACTS.md) |
| `wakeFile` | Orientation context (WAKE.md) |
| `observationsFile` | Entity context render (OBSERVATIONS.md) |
| `dreamsDir` | Dream journal directory |
| `topicsFile` | Topic index (PERSONALITY_MATRIX.md) |
| `memstoreSocketPath` | Unix socket for memstore (default: `$XDG_RUNTIME_DIR/memstore.sock`) |

### Path resolution

Config keys from the global config file resolve relative to `~/.pi/agent/`. Use absolute
paths to avoid cwd-relative surprises. The `PATH_KEYS` array in `config.js` controls
which keys get path-resolved.

## Tools

### `recall` — Search memory

Searches memstore for both session transcripts (FTS5 full-text, top 3) and entity
observations (FTS5 full-text, top 5). Results are presented in two sections: "Recalled
Sessions" and "Recalled Observations". Session results include the session date extracted
from the `# Date:` header so that conflicting information from different time periods can
be distinguished.

### `remember` — Store observations

Writes observations to memstore's observations table. Each observation is stored as a
separate FTS5-indexed entry with entity_type and entity_name. The local entity-index.json
is updated after each write. Entity type mapping: `person` → `sophont`. Default entity
names: person→Neon, self→Monika, environment→stanza, preference→Neon.

### `remember_session` — Manual session save

Triggers an immediate session save to memstore (same as the automatic save on session close).

### `list_topics` / `load_topic` — Topic management

List available topic addenda or load a specific topic's full content.

## Topic Router

Topics are domain-specific addenda in `persona_topics/`. Each has triggers (keyword arrays)
defined in `PERSONALITY_MATRIX.md`. On each turn, the router scores topics against the
combined query (current user message + previous assistant message), selects the top 3
above a minimum score, and appends their content to the system prompt.

Topics persist across turns via a counter system. A freshly-selected topic gets a counter
of 3; each turn where it's not re-selected, the counter decrements. When it hits 0, the
topic drops. This prevents topics from vanishing after a single short reply that doesn't
restate the keywords.

## Sleep Cycle

`/sleep` runs three sequential fork sessions:

1. **WAKE.md** — reads recent sessions and entity context via `recall`, writes orientation
2. **FACTS.md** — reads entity context and current FACTS.md, curates pinned facts
3. **Dreams** — reflective writing with proposed topic addenda changes

Each fork is a full `createAgentSession()` with the same extensions and persona. Forks
use a retry system with model fallback (default model → Sonnet → others). Fork sessions
are written to `sessions/forks/` and their shutdown triggers a session save to memstore.

## File Layout

```
~/.pi/agent/extensions/stateful-memory/
  extension.js          Main extension (event handlers, tools, commands)
  memstore-client.js    MemstoreClient — Unix socket JSON-RPC client
  config.js             Config loading and path resolution
  memory-store.js       File operations (persona, facts, entity context, recency index)
  memory-prompt.js      System prompt section builders
  memory-sleep.js       Sleep cycle orchestration and fork runner
  session-utils.js      JSONL parsing and transcript normalization
  topic-router.js       Topic scoring, selection, persistence, and addendum loading
  index.js              Package exports
```

## Backend Dependencies

- **memstore**: systemd user service on stanza. Socket at `$XDG_RUNTIME_DIR/memstore.sock`.
  Provides both session transcript storage (entries table) and entity observation storage
  (observations table), each with independent FTS5 indexes.
  See `/persist/shadowsea/services/stateful-memory/memstore/README.md`.
