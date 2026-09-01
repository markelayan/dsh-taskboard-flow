# dsh-taskboard-flow

**Companion plugin to dsh-taskboard** — the task kanban plugin for
[DeepSeek Harness (DSH)](https://github.com/deepseek-ai). dsh-taskboard gives
you the board, the cards, and the `taskboard_*` tools. **taskboard-flow makes
the board move itself**: it watches the ledger, spawns and routes agent
sessions through your columns, wakes the right session at the review moment,
and lets any session message any other session.

Config is **file-based** (a cordis composition patch). No web UI, no database,
no telemetry — everything runs on your machine against your local dsh web API.

> [!WARNING]
> **This plugin is a companion to the [dsh-taskboard](https://github.com/markelayan/dsh-taskboard) plugin and can make agent sessions interact with ANY other session on your dsh instance — sessions on your dsh-taskboard boards, idle sessions, or sessions actively running any agent model.** A
> `session_message` from one session is delivered visibly into another
> session's conversation even in the middle of a turn, and the target agent
> may act on it with its full tool permissions. Board flows likewise spawn
> agent sessions and wake sessions automatically. Treat cross-session
> messages like remote instructions: only enable this plugin where you trust
> every session on the instance, and set `sessionMessage.enabled: false` to
> withhold the tool entirely.

## At a glance

| Capability | What happens |
|---|---|
| **Triage spawn** | A card entering `backlog` spawns a triage session that decomposes it into child cards in `todo` |
| **Direct execution** | A card entering `todo` executes via the real taskboard run API, on the card's own model pin |
| **Review wake** | A card entering `in_review` wakes the card creator's session — live, or resumed after a restart |
| **`@orchestrator` relay** | A comment starting `@orchestrator` escalates to the project's orchestrator session |
| **`[ASK]` decision gate** | Question/decision cards skip triage entirely and wake a designated answerer — answered, never decomposed |
| **`session_message`** | Any session can message any other session, with state-aware, always-visible delivery |
| **`taskboard_done`** | Creator-only task close with a mandatory closing comment |
| **`contacts`** | Named contact directory over session ids — alias → session id + live status in one call, message a contact in one call |
| **Concurrency caps** | Global / per-project / per-column executor limits with automatic re-dispatch |
| **Telegram bridge** *(optional)* | Polls a local MCP endpoint for pending callbacks and creates tasks from them (off by default) |

## How it complements dsh-taskboard

| dsh-taskboard provides | taskboard-flow adds |
|---|---|
| Kanban board + JSON ledger | The flow engine that reacts to card transitions |
| `taskboard_create` / `update` / `move` / `checklist` tools | `taskboard_done` — creator-only close |
| Manual card work by sessions | Automatic spawn / route / execute / wake |
| — | `session_message` cross-session messaging |
| — | `contacts` — named contact directory (alias → session + live status) |
| — | `@orchestrator` + `[ASK]` escalation routing |
| — | Optional Telegram remote-control bridge |

## Use cases

1. **Autonomous work-order pipeline.** Drop a work order as a `backlog` card
   and walk away: triage decomposes it into model-pinned children, executors
   run them through the run API, and your session is woken with the execution
   report the moment a card hits `in_review`.
2. **Multi-project federation.** Wire several boards (each with its own
   workspace path, orchestrator session, and column wiring) in one config
   file. A `@orchestrator` comment always escalates within the card's own
   project.
3. **Human-in-the-loop decisions.** Title a card `[ASK] …` when the agents
   need a ruling: it never gets decomposed — it wakes the designated answerer
   (you, or a staff session), the answer lands as a comment, and work
   resumes.
4. **Cross-session coordination.** An orchestrator nudges a stuck executor
   with `session_message`: if the executor is mid-turn the message appears as
   a visible notice without interrupting the turn; if it is idle the full
   text is steered into its conversation.
5. **Unattended resilience.** `resumeIfDead` resurrects callback targets
   after dsh restarts, so the review loop survives reboots; the optional
   Telegram fallback keeps you reachable when no session can be reached.
6. **Remote control.** With the Telegram bridge enabled, callbacks from your
   bot become kanban tasks with embedded data — the board becomes the
   queue for everything.

## Flows

### The kanban loop (per board, all wiring optional)

```
              ┌──────────────────────────────────────────────┐
              │            backlog card arrives              │
              └───────────────────┬──────────────────────────┘
                 [ASK] title? ────┼──── normal card
                      │                          │
                      ▼                          ▼
        wake [ASK] answerer         spawn TRIAGE session
        (answered in comment        (column prompt + card body)
         → in_review)                            │
                                                 ▼
                                   child cards created in todo
                                                 │
                                                 ▼
                                  TODO card executes (run API,
                                  card's model pin, column cap)
                                                 │
                                                 ▼
                                  IN_REVIEW → wake the creator
                                  (report attached, resumeIfDead)
                                                 │
                                                 ▼
                                    creator closes (taskboard_done)
```

Any card, any column: a comment starting `@orchestrator` escalates to that
project's orchestrator session (live → resumed → Telegram fallback).

### Callback delivery (`dshCallback`)

How a wake reaches the target session — per column, your choice:

| `mode` | Behavior |
|---|---|
| `wake` | Starts a turn on the target: steer for live sessions, followup for executor sessions, `AgentRegistry.resume` for dead ones |
| `notify` | Injects a visible plugin notice — mid-turn safe, starts no turn |
| `context` | Quietly pushes a runtime-context note (30-min TTL) the agent reads at its next turn |

Knobs: `target` (`creator` or a fixed session id), `onlyPrefix`,
`delivery` (`steer`/`followup` for wake mode), `includeReport`,
`resumeIfDead`, `telegramFallback`.

### `session_message` delivery

Delivery adapts to the target's state so a human **always** sees the message:

| Target state | Human sees | Agent gets | `delivery` value |
|---|---|---|---|
| **Idle** | Full text steered into the conversation | Steer + runtime-context note; turn starts at the target's next user input | `context+wake-steer` |
| **Busy (mid-turn)** | Full text injected as a visible notice — same channel as context-compression nudges, mid-turn safe | Same notice + runtime-context note; the running turn is untouched | `context+notice` |

Both paths also push a runtime-context note (30-min TTL, cap 5) so the target
agent reads the payload at its next turn even if it never re-opens the GUI.

## Model tools

### `session_message`

```
session_message { action: "list" }
→ { ok, count, sessions: [{ id, status }] }

session_message { action: "send", target, message, wake?, resumeIfDead? }
→ { ok, from, to, targetStatus, delivery, nudgeVia, noticeInjected, note, resumed }
```

Options: `wake: false` disables turn-start attempts; `resumeIfDead: true`
resurrects a dead target first (opt-in). Self-sends are refused. Disable the
whole tool with the `sessionMessage.enabled: false` config knob.

### `taskboard_done`

```
taskboard_done { id, comment }
```

Creator-only: the caller must be the task's creator and the task must be
`in_review`. Posts the closing comment, then performs the done move. No other
path moves a task to `done` — `taskboard_move` hard-forbids it.

### `contacts`

```
contacts { action: "list" }
→ { ok, count, contacts: [{ name, sessionId, label, tags, note, updatedAt, status }] }

contacts { action: "get", name }
contacts { action: "call", name, message, wake?, resumeIfDead? }   // via the session_message engine
contacts { action: "add", name, sessionId, label?, tags?, note? }
contacts { action: "update", name, sessionId?, label?, tags?, note?, rename? }
contacts { action: "remove", name }
```

A named directory over raw session ids: `list`/`get` resolve an alias to
its session id + **live status** in one call, `call` messages the contact
through the `session_message` delivery engine (same `wake` /
`resumeIfDead` semantics, same delivery fields), and `add`/`update`/
`remove` manage entries at runtime — no config edit, no restart. Entries
persist to a local JSON store (`~/.dsh/taskboard-flow-contacts.json` by
default; atomic writes; personal state, never shipped). Kill-switch
`contacts.enabled: false`; custom store path via `contacts.file`. Names:
lowercase `[a-z0-9._-]`, ≤64 chars.

## Requirements

- A running **dsh web** deployment (the plugin talks to the local run API at
  `http://127.0.0.1:9001/dsh-taskboard` by default).
- The **dsh-taskboard** plugin (provides the ledger the flow engine watches
  and the `taskboard_*` tools agents use).
- Node.js (ESM, no runtime dependencies — `package.json` declares none).

## Install

```bash
# 1. Get the package
git clone https://github.com/markelayan/dsh-taskboard-flow.git
cd dsh-taskboard-flow

# 2. Create YOUR config (the live config is gitignored on purpose)
cp cordis.patch.yml.example cordis.patch.yml
#    → edit cordis.patch.yml: your board id(s), workspace paths, sessions

# 3. Make the package resolvable from your dsh profile
#    Either link it into the profile's node_modules…
ln -s "$(pwd)" ~/.dsh/profiles/web/node_modules/taskboard-flow
#    …or add it as a profile dependency and register the bundle
#    ("taskboard-flow") in your profile's dsh.profile bundles list.

# 4. Restart dsh web (plugin patches load at startup)
```

> **Do NOT** also add a `- insert: taskboard-flow` row to your profile's
> `cordis.patch.yml` — the package ships its own patch, and doubling it up
> produces a `duplicate entry for taskboard-flow` error at startup.

## Configuration reference

Every knob is documented inline in
[`cordis.patch.yml.example`](cordis.patch.yml.example). Summary:

### Global

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for the whole plugin |
| `pollMs` | `5000` | Ledger poll interval (ms) |
| `skipFirstPoll` | `true` | Ignore transitions that predate plugin boot |
| `maxConcurrent` | `3` | Global fallback cap on simultaneous executors |
| `executeUrl` | `http://127.0.0.1:9001/dsh-taskboard` | Local dsh web run API |
| `defaultEnabled` | `false` | Boards without an entry stay untouched |
| `sessionMessage.enabled` | `true` | Registers (or withholds) the `session_message` tool |
| `contacts.enabled` | `true` | Registers (or withholds) the `contacts` tool |
| `contacts.file` | `~/.dsh/taskboard-flow-contacts.json` | Local JSON store for contact entries (atomic writes) |

### Per project (one key per board/workspace id)

| Key | Meaning |
|---|---|
| `enabled` | Gate for this board |
| `cwd` | Workspace path attached to spawned sessions |
| `renameSession` | Rename spawned sessions after the task |
| `attachWorkspace` | Attach `cwd` as the session workspace |
| `orchestratorSession` | Target for `@orchestrator` escalation (omit to disable) |
| `telegramBridge` | `{ enabled, brainMcpUrl }` — optional callback bridge |
| `columns` | Per-column wiring (below) |

### Per column (`backlog` / `todo` / `in_review`)

| Key | Meaning |
|---|---|
| `enabled` | React to transitions into this column |
| `prompt` | (backlog) system prompt for the spawned triage session |
| `model` | `{ provider, model }` pin for spawned sessions |
| `skipSpawnPrefixes` | (backlog) titles with these prefixes skip triage (e.g. `[ASK]`) |
| `spawnMode` | `execute` = real run-API execution (todo), not a bare spawn |
| `executeSkipTitleContains` | Titles containing these keywords are held (umbrella mains) |
| `executeMaxConcurrent` | Column executor cap (column > project > global) |
| `dshCallback` | Wake wiring on transition (see delivery table above) |

## Security & privacy

- **Local-only.** The flow engine talks to your local dsh web API
  (`127.0.0.1`); the optional Telegram bridge talks to whatever local MCP URL
  you configure. Nothing else. No telemetry, no analytics, no bundled secrets.
- **Your config stays yours.** `cordis.patch.yml` (board ids, session ids,
  local paths) is gitignored; only a sanitized `cordis.patch.yml.example`
  ships in the repo.
- **No stored credentials.** The plugin reads no tokens and stores no secrets.
  If your Telegram bridge requires auth, that lives in your own MCP setup,
  not here.
- **`session_message` trust boundary.** Any session on your dsh instance can
  message any other session on the same instance. That is the point of the
  tool — but it means a hijacked session can whisper to other sessions. If
  that is a concern for your deployment, set `sessionMessage.enabled: false`
  and the tool is not registered at all.
- **Spawned sessions inherit your permissions.** Triage/executor sessions run
  with your dsh account's tool access and your column prompts. Review the
  prompts you put in the config — they are instructions your agents will
  follow.

## Troubleshooting

- **`duplicate entry for taskboard-flow` at startup** — you added an insert
  row to your profile patch while the package already ships one. Remove the
  row.
- **`projects=0, all loops dead`** — your `projects:` wrapper is malformed
  (indentation). The example file shows the correct nesting.
- **Config changes not taking effect** — restart `dsh web`; the plugin reads
  its config once at startup.
- **A wake didn't start a turn** — main GUI sessions only start turns on user
  input; the message is rendered visibly in the conversation and the agent
  reads it at its next turn. Executor-style sessions wake immediately.

## Documents

- [`SKILL.md`](SKILL.md) — agent companion skill: tool reference, usage
  patterns, etiquette.
- [`CHANGELOG.md`](CHANGELOG.md) — full version history.
- [`cordis.patch.yml.example`](cordis.patch.yml.example) — annotated config
  template.

## License

[MIT](LICENSE)
