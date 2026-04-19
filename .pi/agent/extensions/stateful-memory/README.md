# Stateful Memory — Extension Reference

The `stateful-memory` extension gives Pi persistent identity across sessions. It manages
persona injection, memory retrieval, entity state, topic routing, and the sleep cycle.

## How It Works

### System Prompt Assembly

On every turn (`before_agent_start`), the extension builds the system prompt addon:

1. **Persona** — SOUL.md + STYLE.md + REGISTER.md + SLEEP.md
2. **Current Context** — WAKE.md (orientation from last sleep cycle)
3. **Pinned Facts** — FACTS.md (foundational grounding)
4. **Observations** — OBSERVATIONS.md (Neotoma entity snapshots, rendered on session start)
5. **Memory Context** — enrichment results from memstore (first message only)
6. **Entity Context** — Neotoma entities mentioned in the prompt (first message only)
7. **Topic Addenda** — 0–3 topic files selected by the topic router

### Memory Enrichment (First Message)

When the first user message arrives:

1. Check memstore queue depth — if save jobs are pending, ask whether to wait
2. Search memstore with the user's prompt (natural language → FTS5 query)
3. Fetch top 3 results, truncate bodies to 3000 chars each
4. Search Neotoma for entities whose names appear in the prompt
5. Cache both results — they're included in the system prompt for the rest of the session

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

### Entity State (Neotoma)

The `remember` tool writes observations to Neotoma's append-only store. Each observation
is associated with an entity (person, project, decision, preference, environment, self).
Neotoma's reducer computes current snapshots from the observation history.

OBSERVATIONS.md is rendered from all Neotoma entity snapshots on every session start
(~900ms). It's grouped by entity type, capped at 10 observations per entity, and
gitignored — it's regenerated, never manually edited.

## Configuration

Config is loaded from `~/.pi/agent/stateful-memory.json` with defaults from `config.js`.

### Key config values

| Key | Description |
|---|---|
| `personaFile` | Primary persona file (SOUL.md) |
| `auxiliaryPersonaFiles` | Additional persona files (STYLE.md, REGISTER.md, SLEEP.md) |
| `factsFile` | Pinned facts (FACTS.md) |
| `wakeFile` | Orientation context (WAKE.md) |
| `observationsFile` | Neotoma render (OBSERVATIONS.md) |
| `dreamsDir` | Dream journal directory |
| `topicsFile` | Topic index (PERSONALITY_MATRIX.md) |
| `memstoreSocketPath` | Unix socket for memstore (default: `$XDG_RUNTIME_DIR/memstore.sock`) |
| `neotomaDataDir` | Neotoma data directory (default: `~/.pi/neotoma`) |

### Path resolution

Config keys from the global config file resolve relative to `~/.pi/agent/`. Use absolute
paths to avoid cwd-relative surprises. The `PATH_KEYS` array in `config.js` controls
which keys get path-resolved.

## Tools

### `recall` — Search memory

Searches memstore (FTS5 full-text) and Neotoma (entity search) for content matching a
query. Returns top 3 memory entries with full bodies, plus any matching entity snapshots.
Results include the session date (extracted from the `# Date:` header in the transcript)
so that conflicting information from different time periods can be distinguished.

### `remember` — Store observations

Writes observations to Neotoma's entity store. Each observation is appended to the named
entity's history. Entity type mapping: `person` → `sophont` in Neotoma. Default entity
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

1. **WAKE.md** — reads recent sessions via `recall`, writes an orientation document
2. **FACTS.md** — queries Neotoma for current entity state, curates pinned facts
3. **Dreams** — reflective writing with proposed topic addenda changes

Each fork is a full `createAgentSession()` with the same extensions and persona. Forks
use a retry system with model fallback (default model → Sonnet → others). Fork sessions
are written to `sessions/forks/` and their shutdown triggers a session save to memstore.

Pre-aggregation was removed in Phase 3 — forks use `recall` and the recency index instead
of reading a pre-built archive file.

## File Layout

```
~/.pi/agent/extensions/stateful-memory/
  extension.js          Main extension (event handlers, tools, commands)
  memstore-client.js    MemstoreClient — Unix socket JSON-RPC client
  neotoma-client.js     NeotomaClient — CLI wrapper
  config.js             Config loading and path resolution
  memory-store.js       File operations (persona, facts, observations, recency index)
  memory-prompt.js      System prompt section builders
  memory-sleep.js       Sleep cycle orchestration and fork runner
  session-utils.js      JSONL parsing and transcript normalization
  topic-router.js       Topic scoring, selection, persistence, and addendum loading
  index.js              Package exports
```

## Backend Dependencies

- **memstore**: systemd user service on stanza. Socket at `$XDG_RUNTIME_DIR/memstore.sock`.
  See `/persist/shadowsea/services/stateful-memory/memstore/README.md`.
- **Neotoma**: npm global package. CLI invoked via `child_process.execFile`.
  See `/persist/shadowsea/services/stateful-memory/neotoma/README.md`.
