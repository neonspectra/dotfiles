# Stateful Memory — Implementation Notes

*Last updated: March 2026. Written for cold re-entry — assumes no prior context.*

---

## What This Is

The stateful-memory extension gives pi persistent identity across sessions: persona files injected into every system prompt, session summaries written to disk and retrievable via `recall()`, pinned facts (FACTS.md), orientation context (WAKE.md), and a sleep cycle that synthesizes and updates all of the above between sessions.

Everything lives in two places:

- **`~/.pi/stateful-memory/`** — runtime files: FACTS.md, WAKE.md, dreams/, session memory logs, persona source files
- **`~/.pi/agent/extensions/stateful-memory/`** — the extension source code

Both are tracked in the **dotfiles repo** (`~/`, GitHub `neonspectra/dotfiles`), which is the single source of truth for Pi extensions and persona files. Volatile runtime data (session logs, dreams, FACTS.md, WAKE.md) is gitignored.

---

## File Layout

```
~/.pi/
  agent/
    stateful-memory.json       ← global config (absolute paths)
    extensions/
      stateful-memory/         ← extension source (tracked in dotfiles)
  stateful-memory/
    SOUL.md                    ← persona file (tracked in dotfiles)
    STYLE.md                   ← persona file (tracked in dotfiles)
    REGISTER.md                ← persona file (tracked in dotfiles)
    SLEEP.md                   ← persona file (tracked in dotfiles)
    PERSONALITY_MATRIX.md      ← topic index (tracked in dotfiles)
    persona_topics/            ← topic addenda (tracked in dotfiles)
    FACTS.md                   ← runtime, written by sleep / remember tool (gitignored)
    WAKE.md                    ← runtime, written by sleep cycle (gitignored)
    dreams/                    ← runtime, written by sleep cycle (gitignored)
    memory/
      sessions/                ← session memory log files, one .md per session (gitignored)
```

---

## Configuration

### Global config: `~/.pi/agent/stateful-memory.json`

This is what's currently deployed:

```json
{
  "memoryDir": "/home/parallels/.pi/stateful-memory/memory/sessions",
  "personaFile": "/home/parallels/.pi/stateful-memory/SOUL.md",
  "auxiliaryPersonaFiles": [
    "/home/parallels/.pi/stateful-memory/STYLE.md",
    "/home/parallels/.pi/stateful-memory/REGISTER.md",
    "/home/parallels/.pi/stateful-memory/SLEEP.md"
  ],
  "factsFile": "/home/parallels/.pi/stateful-memory/FACTS.md",
  "wakeFile": "/home/parallels/.pi/stateful-memory/WAKE.md",
  "dreamsDir": "/home/parallels/.pi/stateful-memory/dreams",
  "topicsFile": "/home/parallels/.pi/stateful-memory/PERSONALITY_MATRIX.md",
  "memoryModel": "codex:gpt-5.1-codex-mini",
  "memoryModelMaxTokens": 512,
  "recallModelMaxTokens": 1024,
  "memoryModelTemperature": 0,
  "sessionSummaryMaxChars": 12000,
  "recallMaxSessionChars": 12000
}
```

### All config keys

| Key | Default | Description |
|---|---|---|
| `memoryDir` | `stateful-memory/memory/sessions` | Where per-session memory log .md files live |
| `personaFile` | `stateful-memory/SOUL.md` | Primary persona file (SOUL.md) |
| `auxiliaryPersonaFiles` | STYLE.md, REGISTER.md | Additional persona files concatenated after SOUL.md |
| `factsFile` | `stateful-memory/FACTS.md` | Pinned facts — always in system prompt, rewritten by sleep |
| `wakeFile` | `stateful-memory/WAKE.md` | Orientation context — always in system prompt, rewritten by sleep |
| `dreamsDir` | `stateful-memory/dreams` | Where dream journal files are written |
| `topicsFile` | `stateful-memory/PERSONALITY_MATRIX.md` | Topic index JSON (frontmatter) + description |
| `memoryModel` | `codex:gpt-5.1-codex-mini` | Model used for summarization, recall planning, recall synthesis |
| `memoryModelMaxTokens` | `512` | Max tokens for summarization and recall planning calls |
| `recallModelMaxTokens` | `1024` | Max tokens for the final recall synthesis call (needs more room) |
| `memoryModelTemperature` | `0` | Temperature for all memory model calls |
| `sessionSummaryMaxChars` | `12000` | Max transcript chars fed to the summarizer |
| `recallMaxSessionChars` | `12000` | Max chars from a raw session JSONL read during recall |
| `topicPersistenceCount` | `3` | How many quiet turns a topic persists after last being freshly selected |
| `topicPreviousMessageMaxChars` | `500` | Max chars from previous assistant message included in topic query |

### Path resolution — the critical gotcha

`config.js` merges three sources: `DEFAULT_CONFIG` → `globalConfig` (the `~/.pi/agent/` file) → `fileConfig` (a `.pi/stateful-memory.json` in the cwd, if present). Path keys are resolved relative to the *source that supplied them*:

- Keys from `globalConfig` resolve relative to `~/.pi/agent/` (the directory containing the global config file)
- Keys from `fileConfig` resolve relative to `cwd`
- Keys from `DEFAULT_CONFIG` (i.e., not overridden by either) also resolve relative to `cwd`

**This is where things went wrong initially.** `factsFile`, `wakeFile`, and `dreamsDir` were added to `DEFAULT_CONFIG` but not to `~/.pi/agent/stateful-memory.json`. Since nothing in globalConfig overrode them, they resolved against `cwd` — which was `/media/psf/Repos/monika-mono`. Sleep wrote WAKE.md and FACTS.md into the git repo instead of `~/.pi`.

**Fix applied:** all three keys are now in `~/.pi/agent/stateful-memory.json` with absolute paths. Any path-keyed config value should be set with an absolute path in the global config to prevent cwd-relative surprises.

The `PATH_KEYS` array in `config.js` controls which keys get path-resolved. If you add a new path-type config key, add it there too.

---

## System Prompt Assembly

On every `before_agent_start` event, the extension builds the system prompt addon in this order:

1. **Persona** — SOUL.md + auxiliary files (STYLE.md, REGISTER.md, SLEEP.md) concatenated
2. **Current Context** — WAKE.md (the orientation doc written by the last sleep cycle)
3. **Pinned Facts** — FACTS.md
4. **Recent Themes** — 5 most recent memory entries by timestamp, shown as a flat list
5. **Recollections** — up to 4 session summaries + 4 explicit-tagged entries (combined, deduped)
6. **Topic Addenda** — 0–3 topic files selected by the topic router based on the current query

The Memory Discipline block (instructions for how to use `remember` and `recall`) is prepended before all of the above.

The topic addenda are determined separately and appended after the memory section. Their selection uses the hybrid query described below.

---

## Topic Router

### What topics are

Topics are domain-specific addenda — extended worldview, craft knowledge, or context that would be too large to include in every prompt but should be present when relevant. Each is a markdown file with a YAML frontmatter block in `PERSONALITY_MATRIX.md` that defines:

- `id` — identifier string
- `file` — path to the addendum markdown file
- `summary` — one-line description (shown by `list_topics`)
- `triggers` — array of keyword strings; token overlap with the query determines the score
- `scope` — array of contexts where this topic can be selected: `"system"` (live prompt), `"summary"` (session summarization), `"recall"` (recall tool)
- `priority` — numeric bonus added to the raw overlap score (scaled by 0.5)

### Scoring

The raw score for a topic against a query is: *number of overlapping tokens between the query tokens and all tokens across the topic's triggers*, plus `priority × 0.5`. The `tokenize()` function lowercases and strips punctuation, so matching is case-insensitive and punctuation-insensitive.

### Hybrid query (the fix)

Before the fix, topic scoring only used the user's current message. This caused topics to drop out immediately after any short reply that didn't restate the topic keywords — even mid-conversation.

The fix: on `before_agent_start`, the query passed to `selectTopics` is:

```js
const lastAssistantMsg = getLastAssistantMessage(ctx); // capped at topicPreviousMessageMaxChars
const combinedQuery = [event.prompt, lastAssistantMsg].filter(Boolean).join("\n");
```

The previous assistant message is scanned from the session branch (most recent `role: "assistant"` entry). It's capped at 500 characters by default to prevent a long response from dominating the score. The combined query means a topic remains scoreable as long as *either* the user's message or the assistant's most recent reply contains relevant tokens.

### Persistence

Beyond the hybrid query, topics also persist through a counter system tracked in `activeTopics` (a `Map<topicId, { counter, maxCounter }>` held in extension closure state).

When a topic is freshly selected (score ≥ minScore), its counter resets to `topicPersistenceCount` (default 3). Each turn where the topic is *not* freshly selected, its counter decrements by 1. When the counter hits 0, the topic is removed from `activeTopics`.

Persisted topics get a **persistence score** computed as:

```
persistenceScore = minScore × (counter / maxCounter)²
```

This is quadratic decay — a topic at full counter gets a synthetic score of `minScore × 1 = minScore`, just at threshold. As the counter decrements the score falls off toward zero. The `effectiveScore` used for sorting and slicing is `max(freshScore, persistenceScore)`, so a genuinely fresh signal always wins, while a persisted topic can survive quiet turns without blocking new topics from appearing.

`activeTopics` is reset to an empty Map on `session_switch`, so persistence doesn't bleed across sessions.

The `updateActiveTopics: true` flag must be passed to `selectTopicsForPrompt` to activate counter tracking. It's only set `true` in the `before_agent_start` handler — not in summarization, recall, or tool calls — so counters only advance during live conversation turns.

---

## Sleep Cycle

### Overview

`/sleep` runs three sequential fork sessions, each a full agent instance with access to all tools and the complete memory store. After all three complete, a new main session is opened.

```
/sleep
  → Phase 0: pre-sleep summary of current session (synchronous, same process)
  → Phase 1: WAKE.md fork  (reads all session summaries; writes WAKE.md)
  → Phase 2: FACTS.md fork (reads all session summaries + current FACTS.md; rewrites FACTS.md)
  → Phase 3: Dreams fork   (reads recent summaries + topic addenda; writes dream journal entry)
  → ctx.newSession()
```

### Pre-aggregation

Before any forks run, all session summary `.md` files are concatenated into a single `_sleep-session-archive.md` temp file. This avoids forks needing to read 300+ individual files (which previously caused cascading delegate chains and 25+ minute runtimes). The archive is cleaned up after all phases complete.

Note: `memoryDir` in config already points to `.../memory/sessions` — the aggregator uses it directly without appending another `sessions/` segment.

### Shared infrastructure

Auth, model registry, and settings are loaded once via `loadSharedInfra()` at the start of the sleep cycle and reused across all fork attempts. Settings are read from the real `settings.json` (so forks inherit `defaultProvider`/`defaultModel`) with compaction force-disabled.

### The fork runner

Each fork attempt is a full `createAgentSession()` call — same agentDir, same persona, same memory store, same extensions. Key settings:

- **Real settings inherited** — the fork reads `settings.json` and merges it with `{ compaction: { enabled: false } }`, so it uses the correct default model/provider from the user's config
- **Sessions written to `sessions/forks/`** rather than the main `sessions/` directory, so they're findable but distinct
- **20-minute timeout** per attempt
- After the agent finishes, `session_shutdown` is fired manually on the fork so its session summary gets written to the memory store — making the fork's work recallable like any other session
- On timeout, `waitForIdle()` is skipped (only called when the agent resolved normally) to prevent deadlock from a fork stuck mid-request

### Retry and model fallback

Each sleep phase gets up to 3 attempts before giving up:

| Attempt | Model | Cooldown before attempt |
|---|---|---|
| 1 | Default (from settings, typically Opus) | None |
| 2 | Same default model | 20s (escalating) |
| 3 | Fallback: Sonnet → Sonnet [1m] → MiniMax M2.7 → Haiku | 30s (escalating) |

The fallback model candidates are defined in `FALLBACK_MODEL_CANDIDATES` and resolved by walking the list against the model registry. If no fallback is found, the retry uses the default model.

Between phases (WAKE → FACTS → DREAM), there's also a 10-second inter-fork cooldown to avoid rate-limit stacking on the proxy.

### The TASK_COMPLETE marker

Each fork's task prompt ends with an instruction to append `TASK_COMPLETE: ` followed by a brief summary sentence. The fork runner scans the full response text for the last occurrence of this marker and uses everything after it as the returned summary string. This is a lightweight alternative to structured output — the fork can write freely and just signal completion at the end.

### Phase 0: Pre-sleep summary

Before any fork starts, `summarizeCurrentSession()` is called on the main session. This ensures the current session's content is in the memory store by the time Phase 1 reads through summaries. If this fails, it logs a warning and continues — it's not fatal.

### Phase 1: WAKE.md

The fork reads all session summary files in `memoryDir`. It's instructed to treat early sessions (February 2026) as test noise and focus on recent meaningful content. It writes a 400–800 word orientation document in first person — not a status report, but a self-addressed letter about where things are, what's in motion, what's been on the mind. WAKE.md lands in the system prompt under "Current Context" every session until the next sleep cycle replaces it.

### Phase 2: FACTS.md

The fork reads all session summaries plus the current FACTS.md, then rewrites FACTS.md from scratch. The goal is curation: things that have become consistently important get added, stale things get removed. FACTS.md is meant to be tight — if something is better served by `recall()`, it doesn't need to be pinned. It lands in the system prompt under "Pinned Facts."

### Phase 3: Dreams

The fork reads recent session summaries and all topic addendum files, then writes a personal journal entry to `dreams/dream-YYYY-MM-DD_HH-MM.md`. It's not a task report — it's reflection. At the end of the entry, a `## What I Want to Add or Change` section proposes specific edits to topic addenda. Those proposals are not auto-applied; they require deliberate review.

### The jiti import note

The fork runner in `memory-sleep.js` does *not* import from the delegate extension, even though both are installed. It inlines a self-contained fork runner that imports only from `@mariozechner/pi-coding-agent` (a published package, resolved normally). This avoids potential jiti real-path resolution issues with cross-extension imports.

---

## Memory Store and Session Files

Each session gets a `.md` file in `memoryDir` named `session-{timestamp}__{slug}.md`. The slug starts as `untitled` and gets renamed after the first session summary is written (slug derived from the summary text). This rename happens in `maybeSetTopicFromSummary()`.

The session file format is simple plaintext:
```
# Session Memory

Session: /path/to/session.jsonl
Started: 2026-03-06 18:00:00

- [2026-03-06 18:30:00] [session: ...] [tags: session-summary] Summary text here
- [2026-03-06 18:31:00] [session: ...] [tags: explicit] An explicit remembered fact
```

The `upsertSessionSummary()` method replaces any existing `session-summary`-tagged entry rather than appending — so each session file has at most one summary at a time, kept current.

`readAllMemoryEntries()` reads every session file and returns a flat array of all entries. The system prompt uses the 5 most recent (by timestamp) as "Recent Themes" and up to 4 summaries + 4 explicit entries as "Recollections."

---

## Tools and Commands

### `remember` tool

Stores facts either to the session memory log (target `"memory"`, tagged `explicit`) or to FACTS.md directly (target `"profile"`). The `profile` target calls `store.appendFacts()` which appends under a `## Learned Facts` heading.

### `recall` tool

Two-phase: first calls the memory model to build a plan (which session files to read), then reads those files and calls the memory model again to synthesize a response. Falls back to a token-overlap heuristic if the planning call returns no files. The recall synthesis call uses `recallModelMaxTokens` (1024) rather than the smaller `memoryModelMaxTokens` (512) to give it room to write a useful response.

### `list_topics` and `load_topic` tools

List the topic index metadata or load a full topic file by id. Useful for debugging which topics exist and what triggers them.

### `/sleep` command

Described above. Requires confirmation before running. Checks that memory is initialized (session file persisted) before proceeding.

---

## Outstanding Work

- **River's character file.** Separate from this extension — Zeta Directive work.
