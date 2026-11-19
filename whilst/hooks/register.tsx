// whilst: connects Claude Code to whilst (github.com/PeterSR/systemd-whilst).
//
// Busy signal: a session is busy while a turn runs on its main loop or in any
// subagent (background ones included). A turn held on a permission prompt or a
// question still counts: there is no reliable signal for when it is answered,
// and over-reporting is the safe direction. While busy,
// $XDG_RUNTIME_DIR/claude-busy/<session id> holds "busy" and is touched every
// minute; idle, it is empty. Each busy/idle flip also emits a session-bus
// signal so whilst re-reads at once:
//   io.github.PeterSR.ClaudeBusy.Changed on /io/github/PeterSR/ClaudeBusy
//
// Band: the line above the prompt shows the whilst fact `claude_band` (a
// string; "" or absent hides the line), so the config decides what is shown.
//
// Performance: hooks only touch in-memory state and never wait on I/O. The
// busy file is written on flips and by a 60 s heartbeat, with one busctl
// process per flip. The band stats whilst's state file every 15 s and reads it
// only when its mtime moved; it redraws only when the text changes.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { WhilstBand } from '../types'

type $ = EngineInterface

const band = atom({ plugin: 'whilst', key: 'band' } as const, null as WhilstBand)

const HEARTBEAT_MS = 60_000
const POLL_MS = 15_000
const MAX_BEATS = 12 * 60 // a turn whose end we never saw: drop after 12 h
const FRESH_MS = 3 * 60_000 // how long whilst trusts a busy file (its -mmin -3)
const BAND_FACT = 'claude_band'
const MAIN_ADOPTED = 'main:adopted'
// Agents in these states have finished; any other listed agent may still work.
const DONE = new Set(['completed', 'failed', 'killed', 'idle'])

type Fact = { value?: unknown }
type WhilstState = { facts?: Record<string, Fact> }
type Turn = { agentId?: string; beats: number }

// Module state. A reload starts it over: running subagents are found again
// through $.agent.list(), and a main-loop turn already running is assumed from
// this session's busy file (non-empty and fresh) until the main loop's next
// turn end.
const open = new Map<string, Turn>() // turnId, "agent:<id>" or "main:adopted"
const S = {
  busyDir: undefined as string | undefined,
  stateFile: undefined as string | undefined,
  written: undefined as boolean | undefined, // what this session's busy file says; undefined: not written by this copy
  chain: Promise.resolve() as Promise<void>,
  heartbeat: undefined as { cancel: () => void } | undefined,
  poll: undefined as { cancel: () => void } | undefined,
  stateMtime: -1,
  facts: {} as Record<string, Fact>,
  lastBeat: 0,
}

function isBusy(): boolean {
  return open.size > 0
}

function dropMainTurns(): void {
  for (const [id, t] of open) if (t.agentId === undefined) open.delete(id)
}

// Serialized so writes never land out of order.
function sync($: $, opts: { force?: boolean; signal?: boolean; sessionId?: string } = {}): Promise<void> {
  S.chain = S.chain.then(() => writeBusy($, opts)).catch(() => {})
  return S.chain
}

async function writeBusy($: $, opts: { force?: boolean; signal?: boolean; sessionId?: string }): Promise<void> {
  if (S.busyDir === undefined) return
  const busy = isBusy()
  if (!opts.force && busy === S.written) return
  // Not written yet by this copy and idle: leave a file a previous copy wrote
  // to go stale rather than calling a turn we cannot see idle.
  if (!opts.force && S.written === undefined && !busy) return
  const id = opts.sessionId ?? (await $.session.id())
  await $.fs.write(`${S.busyDir}/${id}`, busy ? 'busy' : '')
  const flipped = busy !== S.written
  S.written = busy
  if (flipped || opts.signal) emitChanged($)
}

function emitChanged($: $): void {
  void $.process
    .run(['busctl', '--user', 'emit', '/io/github/PeterSR/ClaudeBusy', 'io.github.PeterSR.ClaudeBusy', 'Changed'], { timeoutMs: 5000 })
    .catch(() => {})
}

// After a (re)load: subagents still working, one entry each until their own
// turns are seen; and a main-loop turn, if this session's file says busy.
async function adopt($: $): Promise<void> {
  try {
    for (const a of await $.agent.list()) {
      if (!DONE.has(a.status)) open.set(`agent:${a.id}`, { agentId: a.id, beats: 0 })
    }
  } catch {
    // no agent list: count only turns seen from here on
  }
  if (S.busyDir === undefined) return
  try {
    const file = `${S.busyDir}/${await $.session.id()}`
    const { size, mtimeMs } = await $.fs.stat(file)
    if (size > 0 && (await $.clock.now()) - mtimeMs < FRESH_MS && ![...open.values()].some(t => t.agentId === undefined)) {
      open.set(MAIN_ADOPTED, { beats: 0 })
    }
  } catch {
    // no file: nothing was running
  }
}

async function beat($: $): Promise<void> {
  const now = await $.clock.now()
  // A gap of more than two beats means the machine slept: whilst may have
  // read the busy files as stale, so ping it along with the refresh.
  const slept = S.lastBeat > 0 && now - S.lastBeat > 2.5 * HEARTBEAT_MS
  S.lastBeat = now
  const agents: string[] = []
  for (const [id, t] of open) {
    t.beats += 1
    if (t.beats > MAX_BEATS) open.delete(id)
    else if (t.agentId !== undefined) agents.push(id)
  }
  // Drop subagent turns whose agent has finished (killed without a turn end).
  // Only the entries seen before asking: a turn that starts meanwhile stays.
  if (agents.length > 0) {
    try {
      const live = new Set<string>()
      for (const a of await $.agent.list()) if (!DONE.has(a.status)) live.add(a.id)
      for (const id of agents) {
        const t = open.get(id)
        if (t?.agentId !== undefined && !live.has(t.agentId)) open.delete(id)
      }
    } catch {
      // keep them until the next beat, or the 12 h cap
    }
  }
  const busy = isBusy()
  await sync($, { force: busy, signal: busy && slept })
}

async function refreshBand($: $): Promise<void> {
  if (S.stateFile === undefined) return
  try {
    const { mtimeMs } = await $.fs.stat(S.stateFile)
    if (mtimeMs !== S.stateMtime) {
      const parsed = JSON.parse(await $.fs.read(S.stateFile)) as WhilstState
      S.facts = parsed.facts ?? {}
      S.stateMtime = mtimeMs
    }
  } catch {
    S.facts = {}
    S.stateMtime = -1 // try again next poll
  }
  const value = S.facts[BAND_FACT]?.value
  const text = typeof value === 'string' && value !== '' ? value : null
  if (text !== (await read($, band))) await update($, band, () => text)
}

function stopTimers(): void {
  S.heartbeat?.cancel()
  S.poll?.cancel()
  S.heartbeat = undefined
  S.poll = undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const runtime = await $.env.get('XDG_RUNTIME_DIR')
    S.busyDir = runtime?.startsWith('/') ? `${runtime}/claude-busy` : undefined
    const home = await $.env.get('HOME')
    const xdgState = await $.env.get('XDG_STATE_HOME')
    const stateHome = xdgState?.startsWith('/') ? xdgState : home ? `${home}/.local/state` : undefined
    S.stateFile = stateHome ? `${stateHome}/whilst/state.json` : undefined

    stopTimers()
    S.heartbeat = $.clock.every(HEARTBEAT_MS, () => void beat($))
    S.poll = $.clock.every(POLL_MS, () => void refreshBand($))
    void adopt($).then(() => sync($))
    void refreshBand($)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    // Main-loop turns never overlap: one starting ends any we missed.
    if (e.agentId === undefined) dropMainTurns()
    open.set(e.turnId, { agentId: e.agentId, beats: 0 })
    void sync($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) dropMainTurns()
    else {
      open.delete(e.turnId)
      open.delete(`agent:${e.agentId}`)
    }
    void sync($)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // Background subagents may outlive a /clear or a /resume; anything else
    // ends here. Timers keep running: they stop with the process, and an
    // in-process /resume fires no session.start to restart them.
    const continues = e.reason === 'clear' || e.reason === 'resume'
    if (continues) dropMainTurns()
    else open.clear()
    // The ending session's file is emptied under its own id, after any write
    // already queued.
    const dir = S.busyDir
    if (dir !== undefined) {
      S.chain = S.chain
        .then(async () => {
          await $.fs.write(`${dir}/${e.sessionId}`, '')
          if (S.written === true) emitChanged($)
        })
        .catch(() => {})
      await S.chain
    }
    S.written = undefined // the next write goes to the new id
    const result = await next(e)
    // Subagents still running belong to the new id: report them now rather
    // than at the next beat.
    if (continues && isBusy()) $.clock.after(500, () => void sync($, { force: true }))
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const text = await read($, band)
    if (text === null || e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        <Text dimColor>{text}</Text>
      </Box>
    )
  })
}
