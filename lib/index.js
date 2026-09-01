// taskboard-flow — multi-project kanban flow + Telegram callback bridge.
//
// Watches the dsh-taskboard JSON ledger and spawns agent sessions when tasks
// transition into an enabled column.  Optionally polls a brain MCP endpoint
// for pending Telegram button-press callbacks and auto-creates kanban tasks
// with embedded market data.
//
// All configuration lives in the cordis composition (cordis.patch.yml config
// block) — there is no web UI settings panel.  Edit the profile's
// cordis.patch.yml to change behaviour and restart `dsh web`.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { setInterval, clearInterval } from 'node:timers'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { request as httpRequest } from 'node:http'

export const name = 'taskboard-flow'
export const inject = ['webServer']

// ── Defaults ───────────────────────────────────────────────────────────

const DEFAULT_PROMPT =
  'You are a triage agent. Read the task, decide what to do, and act.'

// Telegram callback action → skill/urgency mapping is CONFIG-DRIVEN:
//   projectCfg.telegramBridge.actionSkills.{action} → skill name
//   projectCfg.telegramBridge.actionUrgency.{action} → urgency
// Unknown actions default to no skill + 'normal' urgency. No domain-specific
// defaults are hardcoded in the published plugin.

// ── Config resolution ──────────────────────────────────────────────────

function resolveLive(config) {
  const cfg = config ?? {}
  return {
    enabled: cfg.enabled !== false,
    ledgerPath:
      typeof cfg.ledgerPath === 'string' && cfg.ledgerPath.length > 0
        ? cfg.ledgerPath
        : join(homedir(), '.dsh', 'dsh-taskboard.json'),
    pollMs: Number.isFinite(cfg.pollMs) ? Number(cfg.pollMs) : 5000,
    skipFirstPoll: cfg.skipFirstPoll !== false,
    maxConcurrent: Number.isFinite(cfg.maxConcurrent) ? Number(cfg.maxConcurrent) : 3,
    projects: cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {},
    defaultEnabled: cfg.defaultEnabled ?? false,
    defaultPrompt: cfg.defaultPrompt ?? DEFAULT_PROMPT,
    executeUrl:
      typeof cfg.executeUrl === 'string' && cfg.executeUrl.length > 0
        ? cfg.executeUrl
        : 'http://127.0.0.1:9001/dsh-taskboard',
    // v0.6.0: session_message tool kill-switch (default ON).
    sessionMessage: cfg.sessionMessage?.enabled !== false,
    // v0.7.0: contacts directory tool (default ON). Store defaults to
    // ~/.dsh/taskboard-flow-contacts.json; '~/' in a custom path expands.
    contactsEnabled: cfg.contacts?.enabled !== false,
    contactsFile:
      typeof cfg.contacts?.file === 'string' && cfg.contacts.file.length > 0
        ? (cfg.contacts.file.startsWith('~/') ? join(homedir(), cfg.contacts.file.slice(2)) : cfg.contacts.file)
        : join(homedir(), '.dsh', 'taskboard-flow-contacts.json'),
  }
}

function getProjectConfig(live, workspaceId) {
  const pc = live.projects[workspaceId]
  if (pc) return { ...pc, isKnown: true }
  return {
    enabled: live.defaultEnabled,
    cwd: '',
    presetId: '',
    model: {},
    renameSession: true,
    attachWorkspace: true,
    telegramBridge: { enabled: false, brainMcpUrl: '', pollMs: 10000 },
    columns: {
      backlog: { enabled: live.defaultEnabled, prompt: live.defaultPrompt, presetId: '', model: {} },
    },
    isKnown: false,
  }
}

function getColumnConfig(pcfg, status) {
  const col = pcfg.columns?.[status]
  if (col) return col
  if (status === 'backlog') {
    return {
      enabled: pcfg.enabled,
      prompt: pcfg.columns?.backlog?.prompt || DEFAULT_PROMPT,
      presetId: pcfg.presetId,
      model: pcfg.model,
    }
  }
  return { enabled: false, prompt: '', presetId: '', model: {} }
}

function readLedgerTasks(ledgerPath) {
  try {
    const text = readFileSync(ledgerPath, 'utf-8')
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object') return []
    // Soft-deleted (trashedAt) tasks are gone for the GUI and the run API
    // ("no task") — exclude them here too, or every trashed-but-todo card is
    // re-dispatched each poll and fails forever.
    const live = (rows) => rows.filter((t) => t && t.trashedAt === undefined)
    for (const key of ['tasks', 'cards', 'items']) {
      if (Array.isArray(data[key])) return live(data[key])
    }
    if (Array.isArray(data)) return live(data)
    return []
  } catch {
    return []
  }
}

// ── Contacts directory store (v0.7.0) ─────────────────────────────────
// Named aliases for session ids so agents resolve "who do I contact" in
// ONE call (name → session id + label + live status) instead of
// list-then-guess. Personal local state, atomic tmp+rename writes,
// never shipped with the package.

const CONTACT_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/

function normalizeContactName(raw) {
  const name = String(raw ?? '').trim().toLowerCase()
  return CONTACT_NAME_RE.test(name) ? name : null
}

function loadContacts(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf-8'))
    return data && typeof data === 'object' && data.contacts && typeof data.contacts === 'object'
      ? data.contacts
      : {}
  } catch {
    return {}
  }
}

function saveContacts(file, contacts) {
  const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), contacts }, null, 2) + '\n'
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${Date.now()}`
  writeFileSync(tmp, payload, 'utf-8')
  renameSync(tmp, file)
}

// ── Plugin ─────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  const live = resolveLive(config)
  // v0.4.2: action logs go to console.log — ctx.logger output never reaches
  // ~/.dsh/dsh-web.log (verified 2026-08-28 audit), which left execute/callback
  // actions without an audit trail. apply() already used console.log.
  const log = (...args) => console.log(...args)

  // DEBUG: log what we received
  console.log('[taskboard-flow] apply() called with config keys:', Object.keys(config ?? {}))
  console.log('[taskboard-flow] config.projects keys:', Object.keys(config?.projects ?? {}))
  console.log('[taskboard-flow] live.projects keys:', Object.keys(live.projects))
  console.log('[taskboard-flow] live.enabled:', live.enabled)
  for (const [wid, pcfg] of Object.entries(live.projects)) {
    console.log(`[taskboard-flow] project ${wid}: enabled=${pcfg.enabled}, telegramBridge=${JSON.stringify(pcfg.telegramBridge)}`)
  }

  // All mutable state lives in this closure — disposed with the fiber.
  let ledgerInterval = null
  let isFirstPoll = true
  const seen = new Map()
  // `${taskId}:${status}` keys — one column-action fire per status ENTRY
  // (key is deleted when the task leaves the status, so review loops
  // in_review → in_progress → in_review and re-plans todo → backlog → todo
  // fire again).
  const spawnedTasks = new Set()
  // Failed-dispatch retry (v0.4.6): taskId -> earliest-retry epoch ms. A
  // failed run-API POST re-arms the card (spawnedTasks key removed) and this
  // cooldown keeps the retry no sooner than 15s later, not every poll.
  const executeRetryAfter = new Map()
  const callbackFired = new Set() // `${taskId}:${status}` keys — one dshCallback fire per status entry
  // v0.4.7 runtime-context delivery channel: per-session note buffers that
  // are rendered into the target agent's system prompt via
  // systemPrompt.context() (dsh-system-prompt layer.contexts — the
  // "Current runtime context" snapshot block).
  const contextNotes = new Map() // sessionId -> [{key, text, addedAt}]
  const contextFibers = new Map() // agent -> fiber (per-agent systemPrompt context registration)
  const failedInstalls = new Set() // agent ids whose installContextNotes already logged an error (log-once)
  const NOTE_TTL_MS = 30 * 60 * 1000 // notes expire after 30 minutes
  const NOTE_CAP = 5 // max notes retained per session
  const throttledTasks = new Set() // taskIds held in todo by the execute concurrency gate (log-once marker)
  const seenCommentCounts = new Map() // taskId → last-seen comment count (@executor relay diffing)
  const activeSessions = new Set()
  const processedCallbacks = new Set()
  const callbackTimers = new Map()
  let mcpSession = null

  // ── Brain MCP JSON-RPC client (for Telegram callback bridge) ────────

  function mcpInit(brainUrl) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'taskboard-flow', version: '2.1' },
        },
      })
      const url = new URL(brainUrl)
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        },
        (res) => {
          if (res.headers['mcp-session-id']) mcpSession = res.headers['mcp-session-id']
          res.resume() // drain init response
          // Send notifications/initialized (MCP protocol requires it after init)
          if (mcpSession) {
            const notifBody = JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
              params: {},
            })
            const nReq = httpRequest(
              {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                  'MCP-Session-Id': mcpSession,
                  'Content-Length': Buffer.byteLength(notifBody),
                },
                timeout: 5000,
              },
              (nRes) => {
                nRes.resume()
                resolve(mcpSession)
              },
            )
            nReq.on('error', () => resolve(mcpSession))
            nReq.on('timeout', () => {
              nReq.destroy()
              resolve(mcpSession)
            })
            nReq.write(notifBody)
            nReq.end()
          } else {
            resolve(mcpSession)
          }
        },
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('init timeout'))
      })
      req.write(body)
      req.end()
    })
  }

  function mcpToolCall(brainUrl, toolName, args = {}) {
    return new Promise(async (resolve, reject) => {
      // Build and send the tools/call request.  On 404 (expired/invalid session),
      // reset mcpSession and retry once with a fresh init.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!mcpSession) {
          try {
            await mcpInit(brainUrl)
          } catch (e) {
            log(`[taskboard-flow] MCP init failed: ${e?.message}, trying without session`)
          }
        }
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'tools/call',
          params: { name: toolName, arguments: args },
        })
        const url = new URL(brainUrl)
        const headers = {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(body),
        }
        if (mcpSession) headers['MCP-Session-Id'] = mcpSession
        try {
          const result = await new Promise((res2, rej2) => {
            const req = httpRequest(
              {
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers,
                timeout: 15000,
              },
              (res) => {
                if (res.headers['mcp-session-id']) mcpSession = res.headers['mcp-session-id']
                // 404 = session expired/invalid — caller will retry
                if (res.statusCode === 404) {
                  mcpSession = null
                  res.resume()
                  return rej2(new Error('session_expired_404'))
                }
                let d = ''
                res.on('data', (c) => {
                  d += c
                })
                res.on('end', () => {
                  try {
                    for (const line of d.split('\n')) {
                      if (line.startsWith('data: ')) {
                        const json = JSON.parse(line.slice(6))
                        if (json.error)
                          return rej2(
                            new Error(`MCP error: ${json.error.message || JSON.stringify(json.error)}`),
                          )
                        if (json.result?.structuredContent) return res2(json.result.structuredContent)
                        if (json.result?.content?.[0]?.text) {
                          try {
                            return res2(JSON.parse(json.result.content[0].text))
                          } catch {
                            return res2(json.result.content[0].text)
                          }
                        }
                        return res2(json.result)
                      }
                    }
                    try {
                      const json = JSON.parse(d)
                      res2(json.result ?? json)
                    } catch {
                      res2(null)
                    }
                  } catch (err) {
                    rej2(new Error(`MCP parse: ${err.message}`))
                  }
                })
              },
            )
            req.on('error', rej2)
            req.on('timeout', () => {
              req.destroy()
              rej2(new Error('timeout'))
            })
            req.write(body)
            req.end()
          })
          return resolve(result)
        } catch (err) {
          if (err?.message === 'session_expired_404' && attempt === 0) {
            log(`[taskboard-flow] MCP session expired, re-initializing for ${toolName}`)
            continue // retry with fresh session
          }
          return reject(err)
        }
      }
    })
  }

  // ── Telegram callback → task creation ───────────────────────────────

  async function processPendingCallbacks(projectCfg, workspaceId) {
    if (!projectCfg.telegramBridge?.enabled) return
    const brainUrl = projectCfg.telegramBridge.brainMcpUrl
    if (!brainUrl) return
    try {
      const result = await mcpToolCall(brainUrl, 'get_pending_callbacks', {})
      const callbacks = result?.callbacks || []
      for (const cb of callbacks) {
        const cbId = cb.callback_id
        if (processedCallbacks.has(cbId)) continue
        processedCallbacks.add(cbId)
        try {
          log(`[taskboard-flow] processing callback ${cbId}: ${cb.action}`)
          // Mark first to prevent duplicates
          try {
            await mcpToolCall(brainUrl, 'mark_callback_processed', {
              callback_id: cbId,
              response_text: 'Task creation in progress...',
            })
          } catch (e) {
            log(`[taskboard-flow] mark failed: ${e?.message}`)
          }
          // Gather market data
          const tools = [
            ['get_market_data', { symbol: 'XAUUSD' }],
            ['get_indicators', { symbol: 'XAUUSD' }],
            ['get_regime', { symbol: 'XAUUSD' }],
            ['get_price_action', { symbol: 'XAUUSD' }],
            ['get_risk_status', {}],
            ['get_positions', { symbol: 'XAUUSD' }],
            ['get_basket_analysis', { symbol: 'XAUUSD' }],
          ]
          const md = {}
          for (const [t, a] of tools) {
            try {
              md[t] = await mcpToolCall(brainUrl, t, a)
            } catch (e) {
              md[t] = { error: e.message }
            }
          }
          const action = cb.action || 'unknown'
          const symbol = (cb.button_data || '').split(':')[1] || 'XAUUSD'
          const urgency = projectCfg.telegramBridge?.actionUrgency?.[action] || 'normal'
          const skillName = projectCfg.telegramBridge?.actionSkills?.[action] || null
          const title = `[Telegram] ${action.replace(/_/g, ' ')} — ${symbol}`
          // Task description includes market snapshot + skill reference.
          // The agent loads the skill (via `skill` tool) for the full methodology.
          const desc = [
            `Telegram callback: ${action} | ${symbol} | ID: ${cbId} | ${cb.timestamp}`,
            '',
            `Price: ${md.get_market_data?.current_price ?? '?'} | RSI: ${md.get_indicators?.rsi?.toFixed(1) ?? '?'} | Regime: ${md.get_regime?.regime ?? '?'}`,
            `CBs: ${md.get_risk_status?.active_breakers?.length ? md.get_risk_status.active_breakers.join(',') : 'OK'} | Positions: ${Array.isArray(md.get_positions) ? md.get_positions.length : 0}`,
            '',
            '---',
            '',
            skillName
              ? `Load and follow skill: ${skillName}\nUse the \`skill\` tool with name "${skillName}" to get the full analysis/execution methodology.\nSymbol: ${symbol}\nIf this task came from a Telegram callback, use brain-mark_callback_processed (callback_id: ${cbId}) to send your final report back to the user.`
              : `Process action: ${action}\nSymbol: ${symbol}\nIf this task came from a Telegram callback, use brain-mark_callback_processed (callback_id: ${cbId}) to send your final report back to the user.`,
          ].join('\n')
          // Create task via dsh-taskboard API (POST /dsh-taskboard/tasks)
          // NOT direct JSON write — the dsh-taskboard plugin has its own
          // in-memory cache that doesn't detect external file writes.
          const taskBody = JSON.stringify({
            title,
            description: desc,
            prompt: skillName ? `Load skill: ${skillName}` : `Process: ${action}`,
            workspaceId,
            urgency,
            status: 'todo',
            execution: { mode: 'claim' },
          })
          const taskRes = await new Promise((resolve, reject) => {
            const tReq = httpRequest({
              hostname: '127.0.0.1', port: 9001,
              path: '/dsh-taskboard/tasks', method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(taskBody) },
              timeout: 10000,
            }, (res) => {
              let d = ''; res.on('data', (c) => { d += c })
              res.on('end', () => {
                try { resolve(JSON.parse(d)) } catch { resolve(null) }
              })
            })
            tReq.on('error', reject)
            tReq.on('timeout', () => { tReq.destroy(); reject(new Error('taskboard API timeout')) })
            tReq.write(taskBody); tReq.end()
          })
          const taskId = taskRes?.value?.id ?? 'unknown'
          console.log(`[taskboard-flow] created task ${taskId} for callback ${cbId} via API`)
        } catch (err) {
          log(`[taskboard-flow] callback ${cbId} failed: ${err?.message}`)
        }
      }
    } catch (err) {
      log(`[taskboard-flow] callback poll failed: ${err?.message}`)
    }
  }

  // ── Session spawning ────────────────────────────────────────────────

  function resolveCwd(task, pcfg) {
    if (pcfg.cwd) return pcfg.cwd
    if (typeof task.cwd === 'string') return task.cwd
    return undefined
  }

  async function spawnSession(agentCtx, task, pcfg, colCfg, wsCtx) {
    const cwd = resolveCwd(task, pcfg)
    if (!cwd) {
      log(`[taskboard-flow] no cwd for task ${task.id}`)
      return
    }

    const sessionId = `session-taskboard-flow-${randomUUID()}`
    activeSessions.add(sessionId)

    try {
      const createOpts = {
        sessionId,
        meta: {
          cwd,
          ...(colCfg.presetId || pcfg.presetId
            ? { agentPreset: colCfg.presetId || pcfg.presetId }
            : {}),
        },
      }
      // Model override: column > project > task > default
      const model =
        colCfg.model && Object.keys(colCfg.model).length > 0
          ? colCfg.model
          : pcfg.model && Object.keys(pcfg.model).length > 0
            ? pcfg.model
            : task.model
      if (model && typeof model === 'object' && model.provider) {
        createOpts.agentOptions = { provider: model.provider, model: model.model }
      } else {
        // Fallback: use the default model from config or hardcoded default
        createOpts.agentOptions = { provider: pcfg.defaultProvider || 'minimax', model: pcfg.defaultModel || 'MiniMax-M3' }
      }
      const handle = await agentCtx.agents.create(createOpts)

      // Attach to workspace
      if (pcfg.attachWorkspace !== false && wsCtx?.workspaceRegistry && task.workspaceId) {
        try {
          const ws = wsCtx.workspaceRegistry.get(task.workspaceId)
          if (ws) await ws.attachSession(sessionId)
        } catch (e) {
          log(`[taskboard-flow] ws attach failed: ${e?.message}`)
        }
      }

      // Rename session
      if (pcfg.renameSession !== false) {
        try {
          if (agentCtx.renameSession) agentCtx.renameSession(sessionId, task.title ?? 'untitled')
        } catch {}
      }

      // 1. inject prompt as system framing (no turn)
      const prompt = colCfg.prompt || DEFAULT_PROMPT
      handle.agent.inject({
        id: `msg-tf-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin', plugin: 'taskboard-flow' },
      })

      // 2. followup with task body (triggers agent turn)
      const taskBody = `Task: ${task.title ?? '(untitled)'}\n\n${task.description ?? '(no description)'}`
      handle.agent.followup({
        id: `msg-tf-${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text: taskBody }],
        source: { kind: 'user' },
      })

      // Track session completion
      handle.agent.whenIdle?.()?.then?.(
        () => {
          activeSessions.delete(sessionId)
        },
        () => {
          activeSessions.delete(sessionId)
        },
      )

      log(
        `[taskboard-flow] spawned ${sessionId} for task ${task.id} (col=${task.status})`,
      )
    } catch (err) {
      activeSessions.delete(sessionId)
      log(`[taskboard-flow] spawn failed ${task.id}: ${err?.message}`)
    }
  }


  // ── Runtime-context delivery channel (v0.4.7) ──────────────────────
  //
  // Callbacks/relays are delivered as runtime-context contributions: a
  // persistent per-agent systemPrompt.context() registration (pattern from
  // dsh-file-reference-local/lib/index.js:265-297) renders the target
  // session's live note buffer into the "Current runtime context" snapshot
  // the model reads at its next tool run. Busy targets get context alone
  // (steering an in-flight turn is lossy); idle targets additionally get a
  // ONE-LINE wake nudge so the session actually starts a turn.

  function renderContextNotes(sid) {
    const notes = contextNotes.get(sid)
    if (!notes || notes.length === 0) return ''
    const now = Date.now()
    const fresh = notes.filter((n) => now - n.addedAt < NOTE_TTL_MS)
    if (fresh.length !== notes.length) contextNotes.set(sid, fresh)
    if (fresh.length === 0) {
      contextNotes.delete(sid)
      return ''
    }
    return fresh.slice(-NOTE_CAP).map((n) => n.text).filter((t) => t && t.trim()).join('\n\n')
  }

  function installContextNotes(agent) {
    const sid = agent?.id
    if (!sid || contextFibers.has(agent)) return
    try {
      const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
        scope.systemPrompt.context({
          name: 'taskboard-flow',
          order: 200,
          text: () => renderContextNotes(sid),
        })
      })
      contextFibers.set(agent, fiber)
    } catch (e) {
      if (!failedInstalls.has(sid)) {
        failedInstalls.add(sid)
        log(`[taskboard-flow] context install failed for ${sid}: ${e?.message}`)
      }
    }
  }

  function pushContextNote(sid, key, text) {
    if (!sid || !text) return
    let notes = contextNotes.get(sid)
    if (!notes) {
      notes = []
      contextNotes.set(sid, notes)
    }
    if (notes.some((n) => n.key === key)) return // same key delivered once
    notes.push({ key, text, addedAt: Date.now() })
    if (notes.length > NOTE_CAP) notes.splice(0, notes.length - NOTE_CAP)
  }

  // One-line wake nudge for an idle target (steer preferred, followup
  // fallback). The payload itself lives in the runtime context — the nudge
  // only points at it.
  function sendContextNudge(agent, nudgeText, msgPrefix) {
    const base = {
      id: `msg-${msgPrefix}-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: nudgeText }],
      source: { kind: 'user' },
    }
    if (typeof agent.steer === 'function') agent.steer(base)
    else if (typeof agent.followup === 'function') agent.followup(base)
    else return false
    return true
  }

  // ── DSH-session callbacks (dshCallback) ────────────────────────────
  //
  // Delivers a transition notice INTO an existing DSH session (default:
  // the session that created the task, resolved from ledger
  // createdBy.sessionId).  Orthogonal to column spawning: a column may
  // spawn nothing and still fire a dshCallback.
  //   mode 'notify' → agent.inject() a plugin-source notice (no turn;
  //                   same delivery path tguard notices use)
  //   mode 'wake'   → agent.followup() (triggers an agent turn, same as
  //                   the spawn path)
  // Falls back to agents.resume({sessionId}) when the target session is
  // not live, but only if resumeIfDead: true (experimental, opt-in).

  function buildCallbackText(task, cb, prevStatus) {
    const lines = []
    const arrow = prevStatus ? `${prevStatus} → ${task.status}` : `→ ${task.status}`
    lines.push(`[taskboard-flow] Task ${task.id} "${task.title ?? '(untitled)'}" moved ${arrow}.`)
    const by = task.updatedBy
    if (by?.kind === 'agent' && by?.sessionId) lines.push(`By: agent session ${by.sessionId}`)
    else if (by?.kind) lines.push(`By: ${by.kind}`)
    lines.push(`Workspace: ${task.workspaceId} | urgency: ${task.urgency ?? 'normal'}`)
    if (cb.includeReport !== false) {
      const execs = Array.isArray(task.executions) ? task.executions : []
      const report = execs.length ? execs[execs.length - 1].report : null
      if (report?.summary) {
        const s = String(report.summary)
        lines.push(`Executor report: ${s.length > 600 ? s.slice(0, 600) + '…' : s}`)
      }
    }
    const allExecs = Array.isArray(task.executions) ? task.executions : []
    const lastExec = allExecs.length ? allExecs[allExecs.length - 1] : null
    if (lastExec?.sessionId) {
      lines.push(`Executor session: ${lastExec.sessionId} (${lastExec.outcome ?? 'running'})`)
    }
    lines.push(`Details: taskboard_get("${task.id}")`)
    lines.push(`This is information — do NOT drop your current work. Continue your current task first.`)
    lines.push(`Track this on the board itself: mint a follow-up item NOW via taskboard_checklist action=add on card "${task.id}" with item text 'Creator follow-up: process "${task.title ?? '(untitled)'}" (${arrow})' — the add response prints its id; CHECK IT OFF (action=check, that id) once you have processed this notice. Non-board sessions: record in your own tracking instead.`)
    return lines.join('\n')
  }

  async function deliverSessionCallback(agentCtx, task, cb, prevStatus, projectCfg) {
    // Target: explicit sessionId, or the task's creator (default).
    let targetId = null
    if (typeof cb.target === 'string' && cb.target && cb.target !== 'creator') {
      targetId = cb.target
    } else {
      const sid = task.createdBy?.sessionId
      if (sid) targetId = sid
    }
    if (!targetId) {
      log(
        `[taskboard-flow] dshCallback: no target sessionId for ${task.id} (createdBy.kind=${task.createdBy?.kind ?? 'unknown'}), skipped`,
      )
      return
    }
    // Live-agent lookup (AgentRegistry.get: id = shared agent/session id).
    let agent = agentCtx.agents.get(targetId)
    if (!agent && cb.resumeIfDead === true) {
      try {
        const handle = await agentCtx.agents.resume({ sessionId: targetId })
        agent = handle?.agent ?? handle
        log(`[taskboard-flow] dshCallback: resumed session ${targetId}`)
      } catch (e) {
        log(`[taskboard-flow] dshCallback: resume ${targetId} failed: ${e?.message}`)
      }
    }
    if (!agent || typeof agent.inject !== 'function') {
      // Telegram fallback: deliver via brain MCP send_telegram when the
      // project has a telegram bridge configured and the option is on.
      const brainUrl = projectCfg?.telegramBridge?.brainMcpUrl
      if (cb.telegramFallback === true && typeof brainUrl === 'string' && brainUrl) {
        try {
          await mcpToolCall(brainUrl, 'send_telegram', {
            event: 'custom',
            text: `[taskboard-flow] creator session not live — callback for ${task.id}:
${buildCallbackText(task, cb, prevStatus)}`,
          })
          log(
            `[taskboard-flow] dshCallback → Telegram fallback for ${task.id}:${task.status} (${targetId} not live)`,
          )
          return
        } catch (e) {
          log(`[taskboard-flow] dshCallback Telegram fallback failed: ${e?.message}`)
        }
      }
      log(
        `[taskboard-flow] dshCallback: session ${targetId} not live for ${task.id}:${task.status}, dropped`,
      )
      return
    }
    const text = buildCallbackText(task, cb, prevStatus)
    const delivery = cb.delivery ?? 'context'
    if (delivery === 'context') {
      // v0.4.7: deliver as a runtime-context contribution. The full notice
      // text is pushed into the target session's note buffer and rendered
      // by its systemPrompt.context() registration at the next tool run.
      // Busy target = context alone (steering an in-flight turn is lossy);
      // idle target additionally gets a one-line wake nudge.
      pushContextNote(targetId, `${task.id}:${task.status}`, text)
      installContextNotes(agent)
      if (agent.status === 'idle') {
        sendContextNudge(
          agent,
          `[taskboard-flow] context updated: ${task.title ?? '(untitled)'} -> ${task.status} — full notice in your runtime context.`,
          'tfcbn',
        )
      }
      log(
        `[taskboard-flow] dshCallback context-delivered → ${targetId} (${agent.status === 'idle' ? 'context+nudge' : 'context-only'}) for ${task.id}:${task.status}`,
      )
      return
    }
    const base = {
      id: `msg-tfcb-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text }],
    }
    if (
      cb.mode === 'wake' &&
      delivery === 'steer' &&
      typeof agent.steer === 'function'
    ) {
      agent.steer({ ...base, source: { kind: 'user' } })
    } else if (cb.mode === 'wake' && typeof agent.followup === 'function') {
      agent.followup({ ...base, source: { kind: 'user' } })
    } else {
      agent.inject({
        ...base,
        source: { kind: 'plugin', plugin: 'taskboard-flow', form: 'notice' },
      })
    }
    log(
      `[taskboard-flow] dshCallback delivered → ${targetId} (${cb.mode === 'wake' ? 'wake' : 'notify'}) for ${task.id}:${task.status}`,
    )
  }

  // ── Taskboard execution API (spawnMode: 'execute') ─────────────────
  //
  // Instead of spawning a bare session, call the REAL taskboard execution
  // service: POST <executeUrl>/tasks/<id>/run — it mints the session,
  // claims the task, prepares isolation, attaches the workspace, records
  // the execution (sessionId, outcome, report), and settles (auto
  // comment + move to in_review when the session ends). The executor is a
  // first-class taskboard execution session that can interact with the
  // task directly (claim/checklist/execution_report/handoff).

  async function executeTask(task, pcfg) {
    const base = (pcfg.executeUrl || live.executeUrl).replace(/\/+$/, '')
    const url = `${base}/tasks/${encodeURIComponent(task.id)}/run`
    const body = JSON.stringify({})
    await new Promise((resolve, reject) => {
      const u = new URL(url)
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: u.port,
          path: u.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 15000,
        },
        (res) => {
          let data = ''
          res.on('data', (chunk) => {
            data += chunk
          })
          res.on('end', () => {
            let parsed = null
            try {
              parsed = JSON.parse(data)
            } catch {}
            if (res.statusCode === 202 && parsed?.ok) {
              const sid = parsed?.value?.sessionId ?? '(unknown)'
              log(
                `[taskboard-flow] execute → ${task.id}:${task.status} via taskboard run API (executor ${sid})`,
              )
              resolve()
            } else {
              const msg = parsed?.error?.message ?? String(data).slice(0, 200)
              reject(new Error(`run API HTTP ${res.statusCode}: ${msg}`))
            }
          })
        },
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error('run API timeout'))
      })
      req.write(body)
      req.end()
    })
  }

  // ── @executor relay (same-session review loop) ─────────────────────
  //
  // A NEW comment on a task whose body starts with "@executor" is review
  // feedback: forward it to the task's LAST executor session (live
  // lookup + followup → the SAME agent session continues and modifies;
  // no new spawn). Triage/reviewers address executors this way; the
  // executor re-hands-off to in_review when done, which fires the
  // dshCallback again (per-entry dedupe key was reset on departure).

  async function deliverExecutorRelay(agentCtx, task, comment, projectCfg) {
    const execs = Array.isArray(task.executions) ? task.executions : []
    let executorId = null
    for (let i = execs.length - 1; i >= 0; i--) {
      if (execs[i]?.sessionId) {
        executorId = execs[i].sessionId
        break
      }
    }
    const from = comment?.threadId ?? comment?.createdBy?.sessionId ?? 'unknown'
    if (!executorId) {
      log(
        `[taskboard-flow] @executor relay: no execution session on ${task.id} — comment by ${from} dropped`,
      )
      return
    }
    const agent = agentCtx.agents.get(executorId)
    if (!agent || (typeof agent.steer !== 'function' && typeof agent.followup !== 'function')) {
      const brainUrl = projectCfg?.telegramBridge?.brainMcpUrl
      if (typeof brainUrl === 'string' && brainUrl.length > 0) {
        try {
          await mcpToolCall(brainUrl, 'send_telegram', {
            event: 'custom',
            text: `[taskboard-flow] @executor relay: executor ${executorId} not live for ${task.id} — feedback undelivered:\n${String(comment?.body ?? '').slice(0, 500)}`,
          })
        } catch {}
      }
      log(
        `[taskboard-flow] @executor relay: session ${executorId} not live for ${task.id}, dropped`,
      )
      return
    }
    const text = [
      `[taskboard-flow] Review feedback on task ${task.id} "${task.title ?? '(untitled)'}":`,
      String(comment?.body ?? ''),
      '',
      'Address the feedback: move the task to in_progress, apply the changes, update the execution report, then hand off to in_review again.',
    ].join('\n')
    // v0.4.7: context-channel delivery — full fix list lands in the
    // executor's runtime context; busy executor = context only, idle
    // executor additionally gets a one-line wake nudge.
    pushContextNote(executorId, `${task.id}:relay:${comment?.id ?? comment?.createdAt ?? Date.now()}`, text)
    installContextNotes(agent)
    if (agent.status === 'idle') {
      sendContextNudge(
        agent,
        `[taskboard-flow] @executor fix list for "${task.title ?? '(untitled)'}" (${task.id}) is in your runtime context.`,
        'tfexn',
      )
    }
    log(
      `[taskboard-flow] @executor relay context-delivered → ${executorId} for ${task.id} (${agent.status === 'idle' ? 'context+nudge' : 'context-only'})`,
    )
  }

  // ── @orchestrator relay (order-level escalation, v0.4.3) ────────────
  //
  // A NEW comment starting with "@orchestrator" on ANY task in a project
  // that has `orchestratorSession` configured escalates an order-level
  // question mid-loop: triage/executors that hit a decision they cannot
  // make (scope, user intent, conflicting requirements) ask the board's
  // orchestrator instead of guessing. Delivery: live lookup → resume
  // (orchestrators are long-lived by design) → Telegram fallback.

  async function deliverOrchestratorRelay(agentCtx, task, comment, projectCfg) {
    const targetId = typeof projectCfg?.orchestratorSession === 'string' ? projectCfg.orchestratorSession : ''
    const from = comment?.threadId ?? comment?.createdBy?.sessionId ?? 'unknown'
    if (!targetId) {
      log(
        `[taskboard-flow] @orchestrator relay: no orchestratorSession configured for project of ${task.id} — comment by ${from} dropped`,
      )
      return
    }
    let agent = agentCtx.agents.get(targetId)
    if (!agent) {
      try {
        const handle = await agentCtx.agents.resume({ sessionId: targetId })
        agent = handle?.agent ?? handle
      } catch {}
    }
    if (!agent || (typeof agent.steer !== 'function' && typeof agent.followup !== 'function')) {
      const brainUrl = projectCfg?.telegramBridge?.brainMcpUrl
      if (typeof brainUrl === 'string' && brainUrl.length > 0) {
        try {
          await mcpToolCall(brainUrl, 'send_telegram', {
            event: 'custom',
            text: `[taskboard-flow] @orchestrator relay: orchestrator ${targetId} not reachable for ${task.id} — escalation undelivered:\n${String(comment?.body ?? '').slice(0, 500)}`,
          })
        } catch {}
      }
      log(
        `[taskboard-flow] @orchestrator relay: ${targetId} not reachable for ${task.id}, dropped`,
      )
      return
    }
    const text = [
      `[taskboard-flow] Escalation on task ${task.id} "${task.title ?? '(untitled)'}" (status ${task.status}):`,
      String(comment?.body ?? ''),
      '',
      'You are the orchestrator: answer the escalated question as a comment on the task, then act per the routing standard (answer → in_review hand-off, or direct the worker via @executor). Do NOT decompose [ASK] cards.',
    ].join('\n')
    // v0.4.7: context-channel delivery — full escalation lands in the
    // orchestrator's runtime context; busy = context only, idle gets a
    // one-line wake nudge.
    pushContextNote(targetId, `${task.id}:esc:${comment?.id ?? comment?.createdAt ?? Date.now()}`, text)
    installContextNotes(agent)
    if (agent.status === 'idle') {
      sendContextNudge(
        agent,
        `[taskboard-flow] @orchestrator escalation on "${task.title ?? '(untitled)'}" (${task.id}) is in your runtime context.`,
        'tforcn',
      )
    }
    log(
      `[taskboard-flow] @orchestrator relay context-delivered → ${targetId} for ${task.id} (${agent.status === 'idle' ? 'context+nudge' : 'context-only'})`,
    )
  }

  // ── Ledger polling ──────────────────────────────────────────────────

  // ── creator-close (v0.4.9) ────────────────────────────────────────────
  // A comment starting with "#done" on an in_review task, authored by the
  // task's CREATOR session, closes the task: the plugin performs the
  // in_review → done move via the board HTTP move API. The agent-facing
  // taskboard_move tool forbids done moves (harness gate, dsh-taskboard
  // tools.ts) — the creator-closes law (user 2026-08-30) routes through
  // here instead.
  async function creatorClose(task, pcfg) {
    const baseUrl = (pcfg.executeUrl || live.executeUrl).replace(/\/+$/, '')
    const res = await fetch(`${baseUrl}/tasks/${task.id}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ifVersion: task.version, status: 'done' }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || data?.ok !== true) {
      throw new Error(`move API HTTP ${res.status}: ${String(JSON.stringify(data)).slice(0, 300)}`)
    }
    return data.value
  }

  async function pollLedger(agentCtx, wsCtx) {
    if (!live.enabled) return
    const tasks = readLedgerTasks(live.ledgerPath)

    // First poll: just populate seen + spawnedTasks, don't spawn (prevents restart re-trigger)
    if (isFirstPoll && live.skipFirstPoll) {
      for (const task of tasks) {
        if (task?.id && task?.status) {
          seen.set(task.id, task.status)
          seenCommentCounts.set(
            task.id,
            Array.isArray(task.comments) ? task.comments.length : 0,
          )
          // Mark existing task/status pairs as already fired — only NEW
          // entries (new tasks or transitions) should trigger.
          // v0.4.2 EXCEPTION: execute-mode columns do NOT seed their spawn
          // keys. Combined with the dispatch-side rule (execute columns
          // fire whenever the key is absent), a todo child queued across a
          // restart drains at boot instead of being silently silenced —
          // and a task still in todo can never have a live executor (the
          // run API claims → in_progress), so boot dispatch is safe.
          // Classic spawn columns keep the seeding (restart-safe triage
          // behavior).
          const pcfg = getProjectConfig(live, task.workspaceId)
          if (pcfg.enabled !== false) {
            const colCfg = getColumnConfig(pcfg, task.status)
            if (colCfg.enabled && colCfg.spawnMode !== 'execute') {
              spawnedTasks.add(`${task.id}:${task.status}`)
            }
          }
        }
      }
      isFirstPoll = false
      log(
        `[taskboard-flow] first poll: seeded ${seen.size} tasks (skipFirstPoll=true)`,
      )
      return
    }
    isFirstPoll = false

    // Dispatches fired during THIS poll pass — the snapshot's in_progress
    // count lags until the run API's claim lands, so the gate adds these.
    let dispatchedNow = 0

    for (const task of tasks) {
      if (!task?.id || !task?.status) continue
      const prev = seen.get(task.id)
      const pcfg = getProjectConfig(live, task.workspaceId)

      // Skip if project disabled
      if (pcfg.enabled === false) {
        seen.set(task.id, task.status)
        continue
      }

      const colCfg = getColumnConfig(pcfg, task.status)

      // Status transition detected: reset the departed status's dedupe keys
      // so a later re-entry fires again (review loop in_review → in_progress
      // → in_review; re-plan todo → backlog → todo).
      if (task.status !== prev && prev) {
        spawnedTasks.delete(`${task.id}:${prev}`)
        callbackFired.delete(`${task.id}:${prev}`)
      }

      // Fire the column action if the column is enabled AND this (task,
      // status) entry never fired. For CLASSIC spawn columns "entry" means a
      // transition (status !== prev — restart-safe: boot states never fire).
      // For EXECUTE columns the dedupe key alone gates dispatch: fire
      // whenever the key is absent (boot queue-drain + re-entry), because
      // the run API claims atomically (a claimed task is in_progress, never
      // todo) — a todo task can never have a live executor, so re-POST is
      // always correct intent, never a duplicate.
      const spawnKey = `${task.id}:${task.status}`
      if (
        colCfg.enabled &&
        !spawnedTasks.has(spawnKey) &&
        (task.status !== prev || colCfg.spawnMode === 'execute')
      ) {
        // skipSpawnPrefixes (v0.4.3, optional colCfg array): titles starting
        // with any listed prefix NEVER take this column's action — the entry
        // is marked resolved (spawnedTasks) so it stays silent without
        // re-logging every poll. Routing use: "[ASK]" cards in backlog skip
        // the triage spawn and are answered by the orchestrator directly.
        const skipPfxs = Array.isArray(colCfg.skipSpawnPrefixes)
          ? colCfg.skipSpawnPrefixes.filter((p) => typeof p === 'string' && p)
          : []
        if (skipPfxs.length > 0 && skipPfxs.some((p) => (task.title ?? '').startsWith(p))) {
          spawnedTasks.add(spawnKey)
          log(
            `[taskboard-flow] column action skipped (skipSpawnPrefixes) ${task.id} "${task.title ?? ''}"`,
          )
        } else if (colCfg.spawnMode === 'execute') {
          // Real taskboard execution via the run API — the execution service
          // owns the session lifecycle.
          //
          // Concurrency gate (v0.4.2): execute POSTs used to bypass
          // maxConcurrent entirely (a 15-child order minted 15 simultaneous
          // executor sessions). In-flight = tasks currently in_progress in
          // the same project (the run API claims → in_progress; settle →
          // in_review) + dispatches fired in this poll pass. Over-cap tasks
          // stay in todo and retry next poll — spawnedTasks is NOT marked
          // and seen is NOT updated (continue before the tail), so the spawn
          // condition stays armed. Knob: executeMaxConcurrent
          // (column > project > maxConcurrent fallback).
          //
          // executeOnlyPrefix (legacy v0.4.1 knob) + executeSkipTitleContains
          // (v0.4.4 routing standard, user directive 2026-08-30: "if it lands
          // on to be done should not be triaged and should have its info
          // directly"): todo ("to be done") executes cards DIRECTLY by
          // default — any self-contained card landing there mints an executor
          // session. Skip only titles containing a skip keyword (brain:
          // "Triage" — triage's Phase A retitles the umbrella MAIN card with
          // it, so the umbrella stays a planned marker and never
          // double-executes; `[<main-id>]` children carry no skip word and
          // execute). Legacy executeOnlyPrefix still honored if configured.
          const pfx = typeof colCfg.executeOnlyPrefix === 'string' ? colCfg.executeOnlyPrefix : ''
          const skipWords = Array.isArray(colCfg.executeSkipTitleContains)
            ? colCfg.executeSkipTitleContains.map((k) => String(k).toLowerCase())
            : []
          const titleLower = (task.title ?? '').toLowerCase()
          const executable =
            (!pfx || (task.title ?? '').startsWith(pfx)) &&
            !skipWords.some((k) => k && titleLower.includes(k))
          const cap = Number.isFinite(colCfg.executeMaxConcurrent)
            ? colCfg.executeMaxConcurrent
            : Number.isFinite(pcfg.executeMaxConcurrent)
              ? pcfg.executeMaxConcurrent
              : live.maxConcurrent
          const inFlight =
            tasks.filter(
              (t) => t?.workspaceId === task.workspaceId && t?.status === 'in_progress',
            ).length + dispatchedNow
          if (executable && cap > 0 && inFlight >= cap) {
            if (!throttledTasks.has(task.id)) {
              throttledTasks.add(task.id)
              log(
                `[taskboard-flow] execute deferred ${task.id}: ${inFlight}/${cap} executors in flight — held in todo, retried next poll`,
              )
            }
            continue // NOT seen.set → spawn condition stays armed for next poll
          }
          throttledTasks.delete(task.id)
          // v0.4.6 cooldown guard: a recently-failed dispatch waits silently
          // for its retry window — no spawnedTasks mark, no seen update, no
          // POST — so the card retries later instead of every poll.
          {
            const retryAt = executeRetryAfter.get(task.id)
            if (retryAt !== undefined && Date.now() < retryAt) continue
          }
          spawnedTasks.add(spawnKey)
          if (executable) {
            dispatchedNow++
            executeTask(task, pcfg).catch((err) => {
              // v0.4.6: re-arm the card on failure — remove the spawn key so
              // the next eligible poll re-POSTs, with a 15s cooldown to avoid
              // hammering the run API on persistent errors (e.g. HTTP 400).
              spawnedTasks.delete(spawnKey)
              executeRetryAfter.set(task.id, Date.now() + 15000)
              log(`[taskboard-flow] execute failed ${task.id}: ${err?.message}`)
            })
          } else {
            log(
              `[taskboard-flow] execute skipped (executeOnlyPrefix/executeSkipTitleContains filter) ${task.id} "${task.title ?? ''}"`,
            )
          }
        } else if (live.maxConcurrent > 0 && activeSessions.size >= live.maxConcurrent) {
          log(
            `[taskboard-flow] concurrency limit (${activeSessions.size}/${live.maxConcurrent}), skipping ${task.id}`,
          )
          seen.set(task.id, task.status)
          continue
        } else {
          spawnedTasks.add(spawnKey)
          spawnSession(agentCtx, task, pcfg, colCfg, wsCtx).catch(() => {})
        }
      }

      // DSH-session callback: fires once per (task, status) entry,
      // independent of the spawn flag above. onlyPrefix (v0.4.3, optional
      // cbCfg string): the callback fires ONLY for titles starting with it —
      // non-matching tasks are skipped WITHOUT setting callbackFired, so
      // they never consume the entry (routing use: backlog [ASK] cards wake
      // the orchestrator; work orders stay silent here).
      const cbCfg = colCfg.dshCallback
      const cbKey = `${task.id}:${task.status}`
      const cbOnly = typeof cbCfg?.onlyPrefix === 'string' ? cbCfg.onlyPrefix : ''
      if (
        cbCfg &&
        cbCfg.enabled === true &&
        task.status !== prev &&
        !callbackFired.has(cbKey) &&
        (!cbOnly || (task.title ?? '').startsWith(cbOnly))
      ) {
        callbackFired.add(cbKey)
        deliverSessionCallback(agentCtx, task, cbCfg, prev, pcfg).catch(() => {})
      }

      // @executor relay: new comments starting with "@executor" forward to
      // the task's last executor session (same-session review loop).
      const comments = Array.isArray(task.comments) ? task.comments : []
      const prevCommentCount = seenCommentCounts.get(task.id)
      if (prevCommentCount === undefined) {
        seenCommentCounts.set(task.id, comments.length)
      } else if (comments.length !== prevCommentCount) {
        if (comments.length > prevCommentCount) {
          for (const c of comments.slice(prevCommentCount)) {
            const body = typeof c?.body === 'string' ? c.body.trim() : ''
            if (/^@executor\b/i.test(body)) {
              deliverExecutorRelay(agentCtx, task, c, pcfg).catch(() => {})
            } else if (/^@orchestrator\b/i.test(body)) {
              deliverOrchestratorRelay(agentCtx, task, c, pcfg).catch(() => {})
            } else if (/^#done\b/i.test(body)) {
              const author = c?.createdBy?.sessionId
              const creator = task.createdBy?.sessionId
              if (task.status === 'in_review' && author && creator && author === creator) {
                creatorClose(task, pcfg)
                  .then(() => console.log(`[taskboard-flow] creator-close → ${task.id}: done (via move API; #done by creator ${author})`))
                  .catch((err) => console.log(`[taskboard-flow] creator-close FAILED on ${task.id}: ${err?.message ?? err}`))
              } else {
                console.log(`[taskboard-flow] creator-close skipped on ${task.id}: #done by ${author ?? 'unknown'} (creator ${creator ?? 'none'}), status ${task.status}`)
              }
            }
          }
        }
        seenCommentCounts.set(task.id, comments.length)
      }

      seen.set(task.id, task.status)
    }
  }

  // ── Telegram bridge timers ──────────────────────────────────────────

  for (const [wid, pcfg] of Object.entries(live.projects)) {
    if (pcfg.telegramBridge?.enabled) {
      const cbMs = pcfg.telegramBridge.pollMs || 10000
      callbackTimers.set(
        wid,
        setInterval(() => {
          processPendingCallbacks(pcfg, wid).catch(() => {})
        }, cbMs),
      )
      log(`[taskboard-flow] Telegram bridge for ${wid} every ${cbMs}ms`)
    }
  }

  // ── Start: wait for workspaceRegistry + agents ──────────────────────

  ctx.inject(['workspaceRegistry'], (wsCtx) => {
    wsCtx.inject(['agents'], (agentCtx) => {
      // v0.4.7: seed the runtime-context registration for every existing
      // agent and keep it installed for agents created later (pattern from
      // dsh-file-reference-local/lib/index.js:265-297). agent.id is the
      // session id used by agents.get(sessionId).
      try {
        for (const a of agentCtx.agents.list()) installContextNotes(a)
      } catch (e) {
        log(`[taskboard-flow] agent seeding failed: ${e?.message}`)
      }
      const offCreated = ctx.on('agent/created', ({ agent }) => installContextNotes(agent))
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        contextFibers.delete(agent)
        if (agent?.id) contextNotes.delete(agent.id)
      })

      // ── taskboard_done tool (v0.5.0, creator-closes law) ─────────────
      // Creator-close as a first-class model tool (user GO 2026-08-30).
      // CREATOR-ONLY (caller session === task createdBy.sessionId, fail
      // closed) and in_review-ONLY. Posts the closing comment, re-reads
      // the task (the comment bumps version), then performs the done move
      // via creatorClose. The #done comment branch stays as fallback.
      let disposeDoneTool = null
      let disposeSessionMsgTool = null

      // ── shared cross-session delivery (v0.7.0) ────────────────────────
      // Extracted from session_message v0.6.2 so the contacts tool's
      // "call" action reuses the exact same delivery semantics. History
      // of the rules (keep them): an IDLE target's wake carries the FULL
      // payload — steer renders it visibly in the target conversation; a
      // pointer-only nudge once left humans staring at "full text in
      // your runtime context" with nothing visible. Status is read ONCE
      // (live-observed race: target flipped idle→running mid-send, which
      // double-reading turned into a contradictory result). A BUSY target
      // + wake gets the FULL text injected as a plugin-source notice —
      // same path as context/compression nudges: visible immediately,
      // mid-turn safe, starts no turn. Both paths also push a runtime-
      // context note (30-min TTL, cap 5). resumeIfDead resurrects a dead
      // target via AgentRegistry.resume (opt-in).
      async function deliverSessionMessage({ sid, target, message, wake = true, resumeIfDead = false }) {
        if (!target) return { ok: false, error: 'target session id required (use session_message or contacts action "list" to discover targets)' }
        if (!message) return { ok: false, error: 'message text required' }
        if (target === sid) return { ok: false, error: 'self-send refused — target must be another session' }
        let agent = agentCtx.agents.get(target)
        let resumed = false
        if (!agent && resumeIfDead === true) {
          try {
            const handle = await agentCtx.agents.resume({ sessionId: target })
            agent = handle?.agent ?? handle
            resumed = true
          } catch (e) {
            return { ok: false, error: `resume ${target} failed: ${e?.message}` }
          }
        }
        if (!agent || typeof agent.inject !== 'function') {
          return { ok: false, error: `session ${target} not live${resumeIfDead === true ? '' : ' (retry with resumeIfDead: true to resurrect it)'}` }
        }
        const text = `[session-message] From session ${sid}:\n\n${message}`
        pushContextNote(target, `sm-${randomUUID()}`, text)
        installContextNotes(agent)
        const idleAtSend = agent.status === 'idle'
        let nudgeVia = 'none'
        if (wake !== false && idleAtSend) {
          const wakeMsg = {
            id: `msg-smn-${randomUUID()}`,
            role: 'user',
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
          }
          if (typeof agent.steer === 'function') {
            agent.steer(wakeMsg)
            nudgeVia = 'steer'
          } else if (typeof agent.followup === 'function') {
            agent.followup(wakeMsg)
            nudgeVia = 'followup'
          }
        }
        let noticeInjected = false
        if (!idleAtSend && wake !== false && typeof agent.inject === 'function') {
          try {
            agent.inject({
              id: `msg-smn-${randomUUID()}`,
              role: 'user',
              content: [{ type: 'text', text }],
              source: { kind: 'plugin', plugin: 'taskboard-flow', form: 'notice' },
            })
            noticeInjected = true
          } catch (e) {
            log(`[taskboard-flow] session_message notice inject failed → ${target}: ${e?.message}`)
          }
        }
        const delivery = idleAtSend
          ? `context+wake-${nudgeVia}`
          : (noticeInjected ? 'context+notice' : 'context-only')
        const note = idleAtSend
          ? 'idle main session: full text now visible in its conversation + runtime context; a turn starts at the user\'s next input'
          : (noticeInjected
              ? 'busy target: full text injected as a visible conversation notice (same path as context-compression nudges) + runtime context note; the running turn is untouched'
              : 'busy target: context note only (wake disabled)')
        return { ok: true, from: sid, to: target, targetStatus: agent.status ?? 'unknown', delivery, nudgeVia, noticeInjected, note, resumed }
      }

      try {
        const toolsSvc = ctx.get('tools')
        if (toolsSvc && typeof toolsSvc.register === 'function') {
          disposeDoneTool = toolsSvc.register({
            name: 'taskboard_done',
            description:
              'Close (→ done) a kanban task YOU created, after processing its in_review callback. CREATOR-ONLY (calling session must be the task creator; fail-closed) and in_review-ONLY. Posts your closing comment, then performs the done move (the taskboard_move tool hard-forbids agent done-moves — this is the sanctioned creator close). Params: id (task id), comment (closing summary: outcome + how verified).',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'comment'],
              properties: {
                id: { type: 'string', description: 'Task id, e.g. t-mtdxxxxx-xxxxxxx' },
                comment: { type: 'string', description: 'Closing comment: outcome + how verified (creator-closes law).' },
              },
            },
            output: {
              schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
              render: (_args, value) => [{ type: 'text', text: value.text }],
            },
            async execute(args, exec) {
              try {
                const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — close refused' }) }
                const tasks = readLedgerTasks(live.ledgerPath)
                const task = (Array.isArray(tasks) ? tasks : []).find((t) => t?.id === args?.id)
                if (!task) return { text: JSON.stringify({ ok: false, error: `task ${args?.id} not found` }) }
                if (task.status !== 'in_review') {
                  return { text: JSON.stringify({ ok: false, error: `task status is ${task.status} — only in_review tasks can be closed` }) }
                }
                const creator = task.createdBy?.sessionId
                if (creator && creator !== sid) {
                  return { text: JSON.stringify({ ok: false, error: `forbidden: caller ${sid} is not the creator (${creator})` }) }
                }
                const pcfg = getProjectConfig(live, task.workspaceId)
                const baseUrl = (pcfg.executeUrl || live.executeUrl).replace(/\/+$/, '')
                const cRes = await fetch(`${baseUrl}/tasks/${task.id}/comment`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ body: `${String(args.comment ?? '').trim()}\n\n(closed via taskboard_done by creator)` }),
                  signal: AbortSignal.timeout(15000),
                })
                const cData = await cRes.json().catch(() => null)
                if (!cRes.ok || cData?.ok !== true) {
                  return { text: JSON.stringify({ ok: false, error: `comment API HTTP ${cRes.status}` }) }
                }
                // The comment bumped task.version — re-read before the move.
                const fresh = (readLedgerTasks(live.ledgerPath) || []).find((t) => t?.id === task.id) || task
                await creatorClose(fresh, pcfg)
                log(`[taskboard-flow] taskboard_done → ${task.id}: done (creator ${sid})`)
                return { text: JSON.stringify({ ok: true, id: task.id, from: 'in_review', to: 'done', commentPosted: true }) }
              } catch (err) {
                return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
              }
            },
          })
          log('[taskboard-flow] tool registered: taskboard_done (v0.5.0 creator-closes)')
        } else {
          log('[taskboard-flow] tools service unavailable — taskboard_done NOT registered')
        }
      } catch (err) {
        log(`[taskboard-flow] taskboard_done registration failed: ${err?.message}`)
      }

      // ── session_message tool (v0.6.0, full-text wake v0.6.1) ──────────
      // Cross-session messaging as a first-class model tool: ANY session
      // agent can send a message to ANY other session. Reuses the v0.4.7
      // runtime-context delivery stack (pushContextNote +
      // installContextNotes + sendContextNudge): the message lands in the
      // target's "Current runtime context" snapshot (30-min TTL, cap 5
      // notes). v0.6.1: an IDLE target's wake now carries the FULL payload
      // (steer renders it visibly in the target conversation — a
      // pointer-only nudge left humans staring at "full text in your
      // runtime context" with nothing visible). Harness physics: main GUI
      // sessions start turns on user input, so the wake renders the text
      // but does not force a turn. A BUSY target gets the context note
      // only (steering an in-flight turn is lossy). resumeIfDead
      // resurrects a dead target via AgentRegistry.resume (opt-in, same
      // gate as dshCallback).
      if (live.sessionMessage) {
        try {
          const toolsSvcMsg = ctx.get('tools')
          if (toolsSvcMsg && typeof toolsSvcMsg.register === 'function') {
            disposeSessionMsgTool = toolsSvcMsg.register({
              name: 'session_message',
              description:
                'Send a message to another DSH session agent, or list live sessions. Delivery: on an IDLE target the FULL message text is rendered into the target conversation (steer, followup fallback) AND pushed into its runtime context (~30-min TTL); main GUI sessions start a turn only on user input, so the text is visible the moment anyone opens the target session and the agent reads it at its next turn. A BUSY target receives the runtime-context note only. Actions: "list" → live sessions [{id,status}]; "send" (target + message required) → deliver. Optional: wake (default true), resumeIfDead (default false — resume a dead target session first). Self-send refused.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['list', 'send'], description: 'list = enumerate live sessions; send = deliver a message.' },
                  target: { type: 'string', description: 'Target session id (required for send; use action "list" to discover).' },
                  message: { type: 'string', description: 'Message text (required for send).' },
                  wake: { type: 'boolean', description: 'Nudge an idle target to start a turn (default true).' },
                  resumeIfDead: { type: 'boolean', description: 'Resume the target session if not live (default false).' },
                },
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
              async execute(args, exec) {
                try {
                  const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — send refused' }) }
                  const action = args?.action === 'send' ? 'send' : 'list'
                  if (action === 'list') {
                    const rows = []
                    for (const a of agentCtx.agents.list()) {
                      if (!a?.id) continue
                      rows.push({ id: a.id, status: a.status ?? 'unknown' })
                    }
                    return { text: JSON.stringify({ ok: true, count: rows.length, sessions: rows }) }
                  }
                  const target = typeof args?.target === 'string' ? args.target.trim() : ''
                  const message = typeof args?.message === 'string' ? args.message.trim() : ''
                  const result = await deliverSessionMessage({
                    sid,
                    target,
                    message,
                    wake: args?.wake !== false,
                    resumeIfDead: args?.resumeIfDead === true,
                  })
                  if (result.ok) {
                    log(`[taskboard-flow] session_message ${sid} → ${target} (${result.delivery})${result.resumed ? ' [resumed]' : ''}`)
                  }
                  return { text: JSON.stringify(result) }
                } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
            })
            log('[taskboard-flow] tool registered: session_message (v0.6.0 cross-session messaging)')
          } else {
            log('[taskboard-flow] tools service unavailable — session_message NOT registered')
          }
        } catch (err) {
          log(`[taskboard-flow] session_message registration failed: ${err?.message}`)
        }
      }

      // ── contacts tool (v0.7.0) ─────────────────────────────────────────
      // Named contact directory over raw session ids: agents resolve an
      // alias ("advisor") to session id + label + LIVE status in ONE call
      // (no list-then-guess), message a contact in one call via the
      // shared delivery engine, and manage entries (add/update/remove) at
      // runtime — no config edits, no restart. Local JSON store (default
      // ~/.dsh/taskboard-flow-contacts.json), atomic tmp+rename writes;
      // the store is personal state, never shipped.
      let disposeContactsTool = null
      if (live.contactsEnabled) {
        try {
          const toolsSvcCc = ctx.get('tools')
          if (toolsSvcCc && typeof toolsSvcCc.register === 'function') {
            const nowIso = () => new Date().toISOString()
            disposeContactsTool = toolsSvcCc.register({
              name: 'contacts',
              description:
                'Named contacts directory for cross-session messaging: resolve a human alias ("advisor", "brain-orchestrator") to its session id + LIVE status in ONE call instead of list-then-guess. Actions: "list" → every contact with live status; "get" (name) → one contact + status; "call" (name + message) → message that contact through the same engine as session_message (idle: visible full-text wake; busy: mid-turn-safe notice); "add" (name + sessionId, optional label/tags/note) → create; "update" (name, optional sessionId/label/tags/note/rename) → edit; "remove" (name) → delete. Names: lowercase [a-z0-9._-], ≤64 chars.',
              parameters: {
                type: 'object',
                additionalProperties: false,
                required: ['action'],
                properties: {
                  action: { type: 'string', enum: ['list', 'get', 'call', 'add', 'update', 'remove'], description: 'list | get | call | add | update | remove.' },
                  name: { type: 'string', description: 'Contact name (required for get/call/add/update/remove).' },
                  sessionId: { type: 'string', description: 'Target session id (required for add; optional for update).' },
                  message: { type: 'string', description: 'Message text (required for call).' },
                  label: { type: 'string', description: 'Human-readable label (optional; add/update).' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags (add/update).' },
                  note: { type: 'string', description: 'Free-text note (optional; add/update).' },
                  rename: { type: 'string', description: 'Rename the contact (optional; update only).' },
                  wake: { type: 'boolean', description: 'Nudge an idle contact (default true; call only).' },
                  resumeIfDead: { type: 'boolean', description: 'Resume a dead contact session first (default false; call only).' },
                },
              },
              output: {
                schema: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } } },
                render: (_args, value) => [{ type: 'text', text: value.text }],
              },
              async execute(args, exec) {
                try {
                  const sid = exec?.agent?.id ?? exec?.agent?.session?.id ?? null
                  if (!sid) return { text: JSON.stringify({ ok: false, error: 'caller identity unavailable — refused' }) }
                  const action = ['list', 'get', 'call', 'add', 'update', 'remove'].includes(args?.action) ? args.action : null
                  if (!action) return { text: JSON.stringify({ ok: false, error: 'action must be one of: list, get, call, add, update, remove' }) }
                  const contacts = loadContacts(live.contactsFile)
                  const liveStatus = (sessionId) => {
                    const a = agentCtx.agents.get(sessionId)
                    return a ? (a.status ?? 'unknown') : 'dead'
                  }
                  const withStatus = (name, c) => ({
                    name,
                    sessionId: c.sessionId,
                    label: c.label ?? '',
                    tags: c.tags ?? [],
                    note: c.note ?? '',
                    updatedAt: c.updatedAt ?? null,
                    status: liveStatus(c.sessionId),
                  })
                  if (action === 'list') {
                    const rows = Object.keys(contacts).sort().map((n) => withStatus(n, contacts[n]))
                    return { text: JSON.stringify({ ok: true, count: rows.length, contacts: rows, file: live.contactsFile }) }
                  }
                  const rawName = typeof args?.name === 'string' ? args.name.trim() : ''
                  const name = normalizeContactName(rawName)
                  if (!name) {
                    return { text: JSON.stringify({ ok: false, error: `invalid contact name "${rawName}" — use lowercase letters/digits/._- (≤64 chars)` }) }
                  }
                  if (action === 'get') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    return { text: JSON.stringify({ ok: true, contact: withStatus(name, c) }) }
                  }
                  if (action === 'call') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    const message = typeof args?.message === 'string' ? args.message.trim() : ''
                    const result = await deliverSessionMessage({
                      sid,
                      target: c.sessionId,
                      message,
                      wake: args?.wake !== false,
                      resumeIfDead: args?.resumeIfDead === true,
                    })
                    if (result.ok) {
                      log(`[taskboard-flow] contacts call "${name}" ${sid} → ${c.sessionId} (${result.delivery})${result.resumed ? ' [resumed]' : ''}`)
                      result.contact = name
                      result.label = c.label ?? ''
                    }
                    return { text: JSON.stringify(result) }
                  }
                  if (action === 'add') {
                    const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : ''
                    if (!/^session-[0-9a-fA-F-]{10,}$/.test(sessionId)) {
                      return { text: JSON.stringify({ ok: false, error: 'sessionId required and must look like "session-…"' }) }
                    }
                    if (contacts[name]) {
                      return { text: JSON.stringify({ ok: false, error: `contact "${name}" already exists — use action "update"` }) }
                    }
                    const record = {
                      sessionId,
                      label: typeof args?.label === 'string' ? args.label.trim() : '',
                      tags: Array.isArray(args?.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : [],
                      note: typeof args?.note === 'string' ? args.note.trim() : '',
                      createdAt: nowIso(),
                      updatedAt: nowIso(),
                    }
                    const next = { ...contacts, [name]: record }
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[taskboard-flow] contacts add "${name}" → ${sessionId}`)
                    const out = { ok: true, added: name, contact: withStatus(name, record) }
                    if (!agentCtx.agents.get(sessionId)) {
                      out.warn = 'session not currently live — contact saved anyway (resumeIfDead can reach it later)'
                    }
                    return { text: JSON.stringify(out) }
                  }
                  if (action === 'update') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list" or "add")` }) }
                    if (args?.sessionId !== undefined) {
                      const sessionId = String(args.sessionId).trim()
                      if (!/^session-[0-9a-fA-F-]{10,}$/.test(sessionId)) {
                        return { text: JSON.stringify({ ok: false, error: 'sessionId must look like "session-…"' }) }
                      }
                      c.sessionId = sessionId
                    }
                    if (args?.label !== undefined) c.label = String(args.label).trim()
                    if (args?.tags !== undefined) c.tags = Array.isArray(args.tags) ? args.tags.map((t) => String(t).trim()).filter(Boolean) : []
                    if (args?.note !== undefined) c.note = String(args.note).trim()
                    let finalName = name
                    if (args?.rename !== undefined) {
                      const renamed = normalizeContactName(args.rename)
                      if (!renamed) return { text: JSON.stringify({ ok: false, error: `invalid new name "${args.rename}"` }) }
                      if (renamed !== name && contacts[renamed]) {
                        return { text: JSON.stringify({ ok: false, error: `contact "${renamed}" already exists` }) }
                      }
                      finalName = renamed
                    }
                    c.updatedAt = nowIso()
                    const next = { ...contacts }
                    delete next[name]
                    next[finalName] = c
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[taskboard-flow] contacts update "${name}"${finalName !== name ? ` → "${finalName}"` : ''}`)
                    return { text: JSON.stringify({ ok: true, updated: finalName, renamed: finalName !== name, contact: withStatus(finalName, c) }) }
                  }
                  if (action === 'remove') {
                    const c = contacts[name]
                    if (!c) return { text: JSON.stringify({ ok: false, error: `contact "${name}" not found (use action "list")` }) }
                    const next = { ...contacts }
                    delete next[name]
                    try { saveContacts(live.contactsFile, next) } catch (e) {
                      return { text: JSON.stringify({ ok: false, error: `persist failed: ${e?.message}` }) }
                    }
                    log(`[taskboard-flow] contacts remove "${name}"`)
                    return { text: JSON.stringify({ ok: true, removed: name, sessionId: c.sessionId }) }
                  }
                  return { text: JSON.stringify({ ok: false, error: 'unhandled action' }) }
                } catch (err) {
                  return { text: JSON.stringify({ ok: false, error: err?.message ?? String(err) }) }
                }
              },
            })
            log('[taskboard-flow] tool registered: contacts (v0.7.0 named contact directory)')
          } else {
            log('[taskboard-flow] tools service unavailable — contacts NOT registered')
          }
        } catch (err) {
          log(`[taskboard-flow] contacts registration failed: ${err?.message}`)
        }
      }

      // Initial poll + interval
      pollLedger(agentCtx, wsCtx).catch(() => {})
      ledgerInterval = setInterval(() => pollLedger(agentCtx, wsCtx), live.pollMs)

      log(
        `[taskboard-flow] ready — poll=${live.pollMs}ms skipFirst=${live.skipFirstPoll} maxConcurrent=${live.maxConcurrent} projects=${Object.keys(live.projects).length}`,
      )

      return () => {
        if (ledgerInterval) clearInterval(ledgerInterval)
        try {
          offCreated?.()
          offDisposed?.()
        } catch {}
        try {
          disposeDoneTool?.()
        } catch {}
        try {
          disposeSessionMsgTool?.()
        } catch {}
        try {
          disposeContactsTool?.()
        } catch {}
        for (const t of callbackTimers.values()) clearInterval(t)
        callbackTimers.clear()
        // Dispose every per-agent systemPrompt context fiber with the plugin.
        for (const [agent, fiber] of contextFibers) {
          try {
            fiber?.dispose?.()
          } catch {}
          contextFibers.delete(agent)
        }
        contextNotes.clear()
      }
    })
  })
}