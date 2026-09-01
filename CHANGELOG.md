# Changelog

## v0.7.0 (2026-09-01)

- New `contacts` tool: a named contact directory over raw session ids.
  `contacts { action: "list" | "get" }` resolves an alias ("advisor") to
  its session id + label + LIVE status in one call — no
  `session_message list`-then-guess. `contacts { action: "call", name,
  message }` messages a contact through the exact `session_message`
  delivery engine (idle → full-text wake-steer, busy → mid-turn-safe
  notice), accepting the same `wake` / `resumeIfDead` knobs. `add` /
  `update` (incl. rename) / `remove` manage the directory at runtime —
  no config edit, no restart.
- Store: local JSON (default `~/.dsh/taskboard-flow-contacts.json`),
  atomic tmp+rename writes; personal state, never shipped. Kill-switch
  `contacts.enabled: false` (default ON); custom path via
  `contacts.file`.
- Refactor: the `session_message` send path was extracted into a shared
  `deliverSessionMessage` used by both tools — delivery semantics are
  unchanged.

## v0.6.2-alpha.3 (2026-08-31)

- Board hygiene law (SKILL.md): NEVER `taskboard_delete` a card that
  contains work — finished work hands off `in_review` for the creator to
  close. Soft-deleted cards vanish from the main board and read as lost;
  delete is for true junk only, on the user's explicit instruction.
  Cleanup/workspace-hygiene sessions never touch board cards (the janitor
  protocol governs files, not cards).
- Example config triage prompt carries the same rule.

## v0.6.2-alpha.2 (2026-08-31)

- Telegram bridge: remove hardcoded FX-trading action maps
  (`ACTION_URGENCY` / `ACTION_SKILLS` / dead `ACTION_URGENCY_FIX`). Action →
  skill and action → urgency are now config-driven via
  `telegramBridge.actionSkills` / `telegramBridge.actionUrgency`; unknown
  actions get no skill and normal urgency. No domain-specific defaults ship
  in the published plugin.

## v0.6.2-alpha.1 — first public alpha (2026-08-31)

First tagged release of the dsh-taskboard-flow companion plugin.

- Board flow engine: triage spawn (backlog), direct run-API execution (todo),
  creator wake with report (in_review), `@orchestrator` relay, `[ASK]`
  decision gate, global/project/column concurrency caps
- `session_message` model tool: cross-session messaging with state-aware
  delivery — visible wake-steer for idle targets, mid-turn-safe plugin notice
  for busy targets, runtime-context notes (30-min TTL, cap 5); kill-switch
  `sessionMessage.enabled`
- `taskboard_done`: creator-only task close
- Optional Telegram callback bridge
- File-based cordis config: sanitized `cordis.patch.yml.example` ships, live
  config gitignored; local-only, no telemetry, no stored credentials
- Companion docs: public README (use cases, flows, config reference) and
  agent-facing SKILL.md

## Historical notes (v0.2 → v0.6.2)

DSH plugin for per-board, per-column kanban flow control + Telegram callback
bridge. Config is **file-based** (cordis composition) — there is no web UI
settings panel.

## What it does

1. **Ledger polling** — watches `dsh-taskboard`'s JSON ledger. When a task
   transitions into an enabled column (e.g. `todo`), spawns an agent session
   with that column's prompt + task body.

2. **Telegram callback bridge** (per-project) — polls a brain MCP endpoint
   (`get_pending_callbacks`). When found, gathers market data, creates a
   kanban task with embedded data, marks the callback processed.

## Configuration

All config lives in the cordis composition — the plugin's
`cordis.patch.yml` (defaults) overridden by the profile's
`cordis.patch.yml`. Edit the profile patch and restart `dsh web`.

```yaml
- id: taskboard-flow
  name: taskboard-flow
  config:
    # ── Global ───────────────────────────────────────────
    enabled: true             # master on/off
    pollMs: 5000              # ledger polling interval (ms)
    skipFirstPoll: true       # seed seen map on restart, don't re-trigger
    maxConcurrent: 3          # max concurrent sessions (0 = unlimited)
    ledgerPath: ''            # empty = ~/.dsh/dsh-taskboard.json
    defaultEnabled: false     # fallback for unlisted projects
    defaultPrompt: 'You are a triage agent...'

    # ── Per-Project (native YAML) ────────────────────────
    projects:
      'WORKSPACE-ID':
        enabled: true
        cwd: /path/to/project
        presetId: ''           # default agent preset (overridable per column)
        model: {}              # default model {provider, model} (overridable per column)
        renameSession: true
        attachWorkspace: true

        # ── Telegram Bridge (optional) ──────────────────
        telegramBridge:
          enabled: false
          brainMcpUrl: 'http://localhost:8767/mcp'
          pollMs: 10000

        # ── Per-Column (status) ─────────────────────────
        columns:
          backlog:
            enabled: true      # spawn sessions when tasks enter this status
            prompt: 'You are the triage agent...'
            presetId: ''
            model: {}
          todo:
            enabled: false
            prompt: 'You are the executor...'
            presetId: ''
            model: {}
          in_review:
            enabled: false
            prompt: 'You are the reviewer...'
            presetId: ''
            model: {}
```

## How session spawning works

1. Plugin detects a task status transition (e.g. `backlog → todo`).
2. Checks: project enabled? column enabled? concurrency limit OK?
3. Creates an agent session via `agents.create()` with cwd + preset + model.
4. Attaches the session to its workspace via `workspaceRegistry.attachSession()`.
5. Renames the session to the task title.
6. **`inject()`** — adds the column prompt as system framing (no agent turn).
7. **`followup()`** — adds the task body as a user message (triggers the turn).
8. The agent processes the task, calls tools, sends results.

## skipFirstPoll

On restart the `seen` map is empty. Without `skipFirstPoll`, every existing
task in an enabled column would look like a new transition and spawn a
session. With `skipFirstPoll: true` (default) the first poll only populates
`seen` without spawning — only tasks that transition **after** the first
poll trigger sessions.

## Telegram callback actions

| Action | Urgency | Task Prompt |
|--------|---------|-------------|
| `full_analysis` | normal | Comprehensive analysis using all brain MCP tools |
| `launch_squad` | urgent | Squad workflow per FLOW-SPEC.md |
| `execute_trade` | urgent | Pre-execution CB checks + send_decision |
| `research_request` | normal | Market research report |

## DSH-session callbacks (`dshCallback`)

Per-column option that delivers a transition notice INTO an existing DSH
session — by default the session that CREATED the task (resolved from the
ledger's `createdBy.sessionId`). This is the callback-to-the-orchestrator
path: no Telegram, no external bridge — the notice lands directly in the
live session's context.

```yaml
columns:
  in_review:
    enabled: false          # spawning stays off if you only want the callback
    dshCallback:
      enabled: true         # opt-in per column
      target: creator       # 'creator' (default) | explicit session id string
      mode: notify          # 'notify' = inject notice (no turn) | 'wake' = followup (triggers a turn)
      includeReport: true   # append the last execution report summary (truncated to 600 chars)
      resumeIfDead: false   # experimental: agents.resume() the session if it is not live
      telegramFallback: false # deliver via brain send_telegram when the session is not live
```

Behaviour notes:

- Fires once per `(taskId, status)` transition; `skipFirstPoll` seeding makes
  restarts safe (pre-existing states never replay).
- Independent of the column `enabled` (spawn) flag — a column can be
  spawn-off + callback-on (e.g. notify the creator at `in_review` without
  spawning a reviewer).
- `mode: wake` uses the same `followup` path as session spawning, so the
  target session actually takes a turn (it should know how to react — e.g.
  an orchestrator persona instructed to `taskboard_get` on taskboard-flow
  notices).
- If the target session is not live the notice is dropped with a host-log
  warn, unless `resumeIfDead: true` (resumes the persisted session via
  AgentRegistry.resume and then delivers — wired `true` on the brain board
  in_review column since v0.4.2 so the review loop survives `dsh web`
  restarts; fallback order live → resume → Telegram).
- Host-log lines start `[taskboard-flow] dshCallback`.

## Execute mode (`spawnMode: execute`) — v0.4

A column may spawn through the REAL taskboard execution service instead of a
bare session:

```yaml
columns:
  todo:
    enabled: true
    spawnMode: execute   # default is 'spawn' (classic behavior)
```

`execute` POSTs `<executeUrl>/tasks/<id>/run` (the same API the GUI's
"Execute now" button uses; default `executeUrl http://127.0.0.1:9001/dsh-taskboard`,
overridable per project or globally). The execution service owns the whole
lifecycle: mints the session, claims the task, prepares worktree isolation,
attaches the workspace, records the execution (sessionId / outcome / report),
and settles (auto-comment + move to `in_review` when the session ends without
handoff). Executors are first-class execution sessions — they can use
`taskboard_get/checklist/execution_report` on their own task directly. The
column `prompt` is NOT used in execute mode (the task's own `prompt` is).

Per-entry dedupe: fire keys are `(taskId, status)` and are DELETED when the
task leaves the status — review loops (`in_review → in_progress → in_review`)
and re-plans (`todo → backlog → todo`) fire again, as they should.

Execute-mode dispatch differences (v0.4.2):

- **Dispatch is gated by the dedupe key alone** (`fire whenever the key is
  absent`), not by transitions: a `todo` child queued across a `dsh web`
  restart DRAINS at boot instead of stalling. This is safe because the run
  API claims atomically — a claimed task is `in_progress`, never `todo`, so a
  `todo` task can never have a live executor and a boot POST is never a
  duplicate. Classic spawn columns keep transition-only dispatch
  (restart-seeded).
- `executeOnlyPrefix` (column knob): only tasks whose title starts with the
  prefix mint an executor session. Brain board convention: `[<main-id>] …`
  children execute; the umbrella MAIN card sits in `todo` as a planned
  marker only.
- `executeMaxConcurrent` (column > project > `maxConcurrent` fallback,
  default 3): caps simultaneous run-API executors per project. In-flight =
  tasks currently `in_progress` in the same project + dispatches fired in
  the current poll pass. Over-cap tasks stay in `todo` and auto-dispatch as
  executors settle (retried every poll; logged once per task).

## `@executor` relay — same-session review loop — v0.4

Any NEW comment whose body starts with `@executor` (e.g.
`@executor checklist item 2 not verified — re-run tests`) is relayed into the
task's LAST executor session (`agent.followup`, source user — the SAME agent
session continues and modifies; no new spawn). The relay message tells the
executor to move the task to `in_progress`, fix, update the report, and hand
off to `in_review` again — which re-fires the `dshCallback` (per-entry dedupe
was reset on departure). If the executor session is not live, the feedback
goes to Telegram when the project has a `telegramBridge.brainMcpUrl`,
otherwise it is dropped with a host-log warn. Host-log lines start
`[taskboard-flow] @executor relay`.

## v0.4.3 — routing standard (2026-08-29)

Question/decision cards are routed to the board's orchestrator instead of
triage, and workers can escalate order-level questions mid-loop:

1. **`skipSpawnPrefixes`** (column, array of strings) — titles starting with
   any listed prefix NEVER take that column's action (no triage spawn, no
   execute). Brain backlog uses `['[ASK]']`: question cards sit in backlog as
   orchestrator-answered cards.
2. **`dshCallback.onlyPrefix`** (column callback, string) — the callback fires
   ONLY for titles starting with the prefix; non-matching tasks are skipped
   WITHOUT consuming the dedupe key. Brain backlog pairs `onlyPrefix: '[ASK]'`
   with `target: <orchestrator session>` so an [ASK] card landing in backlog
   WAKES the orchestrator, which answers in a comment and hands off
   in_review.
3. **`@orchestrator` relay** — a NEW comment starting `@orchestrator` on ANY
   task in a project with `orchestratorSession` configured is followed-up
   into that session (live → resume → Telegram fallback). Triage/executors
   use it to escalate scope/intent questions instead of guessing; the triage
   skill's Step 0 directs them to it.
4. **`[GOAL]` prefix** = provenance marker on planned hand-off cards from
   brain to project boards; mechanics are the default work order (creator
   callback returns them to the brain orchestrator). No special code.

Harness: `/tmp/tf-test/harness3.mjs` — 6/6 PASS (skip, onlyPrefix wake +
key-free skip, classic-spawn regression, both relays).

## v0.4.2 — audit fixes (2026-08-28)

- **Log channel**: all 27 action log calls moved from `ctx.logger` to
  `console.log` — ctx.logger output never reached `~/.dsh/dsh-web.log`
  (verified in the post-smoke-test audit), which left execute/callback/
  relay actions without an audit trail.
- **Execute concurrency gate**: `executeMaxConcurrent` knob (see above);
  previously execute POSTs bypassed `maxConcurrent` entirely.
- **Boot queue-drain**: execute columns fire whenever the dedupe key is
  absent (queued children survive `dsh web` restarts; classic columns
  unchanged).
- **Checklist self-mint protocol** (config + skill `taskboard-triage`, not
  code): triage never passes `checklist` to taskboard_create; child prompts
  carry a `DoD items:` block and executors mint their own checklist via
  `taskboard_checklist action=add` — the add response prints every item
  `id=`, closing the id-visibility gap that left one smoke-test executor
  unable to check anything off.
- Offline harness: `/tmp/tf-test/harness2.mjs` — 16/16 pass (boot drain,
  classic seeding, gate defer/release/log-once, dedupe, callbacks, relay,
  re-entry, re-plan, spawn regression).

## Files

- `lib/index.js` — host-side plugin (ledger polling, session spawn, Telegram bridge)
- `cordis.patch.yml` — default config (plugin bundle layer)
- `package.json` — manifest

## Install

```sh
dsh plugin --profile web add "link:/path/to/taskboard-flow"
```

Restart DSH after install or config changes.

## v0.4.4 — direct-execution lane (2026-08-30)

User directive: "if it lands on 'to be done' should not be triaged and should
have its info directly… when its a triage task the title should include Triage."

- New column knob `executeSkipTitleContains: [string]` (case-insensitive
  contains match). The todo column now executes cards DIRECTLY by default —
  any self-contained card (prompt + model pin) landing in todo mints an
  executor session, no triage, no prefix requirement. Only titles containing
  a skip keyword are held as planned markers. Brain config: `['Triage']` —
  triage's Phase A retitles umbrella MAIN cards with "Triage", so umbrellas
  never double-execute AND the title shows which path the card took.
- Legacy `executeOnlyPrefix` still honored if set (filters combine).
- Backlog ("to be planned") remains the TRIAGE lane (`skipSpawnPrefixes`
  `[ASK]` unchanged). Model law alongside: a user-named model is LAW —
  pinned verbatim on every child/work session, never substituted.
- Requires dsh web restart to go live.
## v0.4.5 — steer delivery

Wake callbacks (`in_review`/`blocked` wakes for the creator session) and the
`@executor` / `@orchestrator` comment relays are now delivered via
`agent.steer()` — a mid-turn context injection the agent reads at its next
step boundary (next tool run / model request) instead of waiting for the
current turn to end. Idle agents start a turn on it, so wake semantics are
preserved. If the live agent handle lacks `.steer` (older DSH builds), the
plugin falls back to `agent.followup()` exactly as before.

New optional per-callback knob: `delivery: 'steer' | 'followup'` (default
`'steer'`) on wake callback config entries — set `followup` to restore the
old queued-message behavior. Existing `cordis.patch.yml` configs stay valid
via the default.

Unchanged: `notify`-mode callbacks still use `agent.inject()` (no wake), and
the spawn path (system-framing `inject` + `followup` task body for new
sessions) is untouched. Requires dsh web restart to go live (user action).

## v0.4.6 — failed-dispatch retry

Failed run-API POSTs (HTTP 400 concurrency races, "no task" for deleted cards) no longer permanently disarm todo cards: the spawn key is removed on failure and the card re-arms for a later retry, with a 15s cooldown between attempts so persistent errors do not hammer the run API every poll. The deferred-by-cap path (executeMaxConcurrent) is unchanged. Requires a dsh web restart to take effect (user action).

## v0.4.7 — context() channel delivery

Wake callbacks and the `@executor` / `@orchestrator` comment relays are now delivered as **runtime-context contributions**: the plugin keeps a per-session note buffer and registers, for every live agent (seeded at boot + `agent/created` / `agent/disposed` events, pattern from dsh-file-reference-local), a `systemPrompt.context({name: 'taskboard-flow', order: 200})` entry whose `text()` renders the buffer into the agent's "Current runtime context" snapshot — the payload is read at the target's next tool run / model request, mid-turn included.

Harness physics split: a **busy** target gets the context contribution alone (steering an in-flight turn is lossy); an **idle** target additionally receives a ONE-LINE wake nudge ("context updated: … — full notice in your runtime context") via `steer` (fallback `followup`) so the session actually starts a turn. The full payload never rides in the nudge.

New per-callback knob: `delivery: 'context' | 'steer' | 'followup'` (default `'context'`); `steer`/`followup` restore the v0.4.5 message-based behavior. Notes expire after 30 minutes and are capped at 5 per session. Dead-session resume and Telegram fallbacks are unchanged; the spawn path (inject + followup for NEW sessions) is untouched. Requires a dsh web restart to go live — user action, do NOT restart anything yourself.

v0.4.8 — callback notices now end with a continue-current-task-first + record-in-todo instruction (user directive 2026-08-30).

0.4.9 — creator-close: a #done comment by the task creator on an in_review card performs the done move via the board move API (agent tool layer forbids done; creator-closes law 2026-08-30).

## v0.5.0 — taskboard_done tool (creator-closes)
Model tool registered via ctx.tools.register: creator-only close (caller session === task createdBy.sessionId, fail-closed) for in_review tasks; posts the closing comment then performs the done move via the board move API (re-reads the task first — the comment bumps version). The '#done' comment branch (v0.4.9) stays as a compatible fallback. Needs dsh web restart to go live.

## v0.6.0 — session_message tool (cross-session messaging)
Model tool registered via ctx.tools.register (kill-switch: `sessionMessage.enabled: false` in the config block, default ON): ANY session agent can send a message to ANY other session agent — the generic form of the board-scoped relays. Actions: `list` → live sessions `[{id,status}]` (AgentRegistry); `send` (target + message) → delivery via the v0.4.7 runtime-context stack (pushContextNote + installContextNotes + idle wake nudge via steer/followup; 30-min TTL, cap 5). `resumeIfDead: true` (default false) resurrects a dead target via AgentRegistry.resume — same gate as dshCallback. Caller identity from exec.agent.id; self-send refused; busy targets get context-only delivery. Needs dsh web restart to go live (user action).

## v0.6.1 — session_message full-text wake (live-test fixes)
Live two-way testing exposed three defects, all fixed: (1) the idle-target wake was a POINTER ("full text in your runtime context") that rendered in the target conversation while showing humans nothing — the wake now carries the FULL message text, visible in the target conversation the moment anyone opens the session; (2) the result overstated delivery (`context+nudge` fired merely because `steer` exists) — the result now reports honest `nudgeVia: 'steer'|'followup'|'none'` plus a `note` field; (3) documented harness physics: main GUI sessions start turns on user input only — the wake renders the message but does not force a turn; the agent reads it at its next turn via conversation history + the runtime-context note. Deferred: GUI-bell/desktop notification on delivery (blocked: notify service contract unverifiable — the Cordis inspect bridge currently drops tool args, separate bug). Needs dsh web restart to go live (user action).

## v0.6.2 — session_message visible notice for busy targets
The two-test round exposed the remaining hole: a BUSY target got `context-only` delivery — model-facing, invisible to humans (TEST B never appeared in the conversation, so its requested reply never came). Fix per user direction: when the target is busy and wake is requested, the full text is injected as a plugin-source notice (`agent.inject`, `source: { kind: 'plugin', plugin: 'taskboard-flow', form: 'notice' }`) — the SAME visible delivery path as context-compression nudges: renders in the target conversation immediately, mid-turn safe, starts no turn. A deferred-timer wake (poll status every 5s, fire the steer on idle) was drafted first and replaced by this strictly better mechanism — no polling, no delay, no timer cleanup surface. Result fields now include `noticeInjected`; busy delivery reports `context+notice`. The v0.6.1 race fix (single `idleAtSend` status read) is retained. Needs dsh web restart to go live (user action).
