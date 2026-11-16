import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import type { History, Now, Step } from '../types'
import {
  EMPTY_CALIB,
  EMPTY_TOTALS,
  addStep,
  average,
  calibrate,
  charsPerToken,
  finish,
  fmtRate,
  liveRate,
  onChunk,
  rate,
  startTimer,
  wantsClock,
} from './meter'

const PANE = 'tps-meter'
const TITLE = 'Tokens/sec'
const KEEP = 40

const IDLE: Now = { turnId: null, live: null }
const EMPTY: History = {
  steps: [],
  lastMain: null,
  main: EMPTY_TOTALS,
  all: EMPTY_TOTALS,
  calib: EMPTY_CALIB,
}

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const now = atom({ plugin: 'tps-meter', key: 'now' } as const, IDLE, { shape: 'now-1' })
const history = atom({ plugin: 'tps-meter', key: 'history' } as const, EMPTY, {
  shape: 'history-1',
})

const fmtInt = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmtSecs = (ms: number) =>
  ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')

const BARS = '▁▂▃▄▅▆▇█'
function sparkText(values: number[], width: number): string {
  const shown = values.slice(-Math.max(1, width))
  const max = Math.max(...shown, 1)

  return shown.map(v => BARS.charAt(Math.min(7, Math.floor((v / max) * 7.999)))).join('')
}

function sparkSvg(values: number[], avg: number | null): string {
  const W = 300
  const H = 56
  const gap = 2
  const n = values.length
  const bw = Math.max(2, (W - gap * (n - 1)) / Math.max(n, 1))
  const max = Math.max(...values, avg ?? 0, 1) * 1.08
  const bars = values
    .map((v, i) => {
      const barH = Math.max(2, (v / max) * H)
      const x = i * (bw + gap)
      const opacity = i === n - 1 ? 1 : 0.5
      return `<rect x="${x.toFixed(1)}" y="${(H - barH).toFixed(1)}" width="${bw.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="#D97757" fill-opacity="${opacity}"/>`
    })
    .join('')
  const y = avg === null ? 0 : (H - (avg / max) * H).toFixed(1)
  const avgLine =
    avg === null
      ? ''
      : `<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="#8A8A8A" stroke-width="1" stroke-dasharray="3 3"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}${avgLine}</svg>`
}

// The footer's words. While a turn runs: the live estimate while text
// streams, else this turn's last response (a tool is running, or the model is
// thinking out of sight), else nothing measured yet. While idle: the main
// thread's average for the session, or nothing before its first response.
function footerLabel({ turnId, live }: Now, hist: History): string | null {
  const avg = average(hist.main)
  if (turnId === null) return avg === null ? null : `avg ${fmtRate(avg)} tok/s`

  const suffix = avg !== null && hist.main.count > 1 ? ` · avg ${fmtRate(avg)}` : ''
  const ofTurn = (id: string | undefined) => id?.startsWith(`${turnId}:`) === true

  if (ofTurn(live?.id) && live?.rate != null) return `~${fmtRate(live.rate)} tok/s${suffix}`
  const last = ofTurn(hist.lastMain?.id) ? hist.lastMain : null

  return `${last ? fmtRate(last.tps) : '…'} tok/s${suffix}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tps',
      description: 'Show the tokens-per-second pane',
      immediate: true,
    })
    // A reload runs this again; a stream or turn the old code was timing is gone.
    await update($, now, () => IDLE)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, now, () => ({ turnId: e.turnId, live: null }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, now, s => (s.turnId === e.turnId ? IDLE : s))
    }

    return next(e)
  })

  // The readout in the footer under the input. The terminal joins it to its
  // own mode labels. The desktop draws this site as a chip in the row with the
  // model selector, from a tree a mod drew itself only (the engine's own node
  // counts as empty there, so the chip hides, which is how it is hidden when
  // there is nothing to show). There the readout is a button that opens the
  // pane, which costs nothing, where a typed `/tps` leaves rows in the
  // conversation.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [state, hist] = await Promise.all([read($, now), read($, history)])
    const label = footerLabel(state, hist)

    if (label === null) return next(e)

    if (e.surface === 'terminal') {
      return next({ ...e, props: { ...e.props, modes: [...e.props.modes, label] } })
    }

    const { Box, Text, Button } = $.ui.resolve(e)
    const open = (
      <Button
        key="open"
        label={label}
        onPress={async () => {
          await $.ui.open({ id: PANE, title: TITLE })
        }}
      />
    )

    return e.props.modes.length === 0 ? (
      open
    ) : (
      <Box flexDirection="row" gap={1}>
        <Text>{e.props.modes.join(' & ')}</Text>
        {open}
      </Box>
    )
  })

  // No `text`: a mod's output line stays in every later request the model
  // reads, and the pane opening says enough. In the terminal the run then
  // leaves no row. The desktop app runs the engine headless, which records the
  // command itself (about 90 tokens in later requests), so the readout there
  // is a button instead.
  on('command.run', { command: 'tps' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return {}
  })

  // Every model request streams through here. Time it from the first chunk of
  // the attempt that answered to the stop chunk, and take the exact token
  // count from the stop chunk. The live estimate counts visible characters
  // only, from the first one, so hidden thinking does not drag it down.
  on('turn.step', async function* ($, e, next) {
    const id = `${e.turnId}:${e.index}`
    const isMain = e.agentId === undefined
    const [sentAt, before] = await Promise.all([$.clock.now(), read($, history)])
    const ratio = charsPerToken(before.calib)
    let timer = startTimer(sentAt)
    let usage: TurnUsage | null = null

    if (isMain) {
      const live = { id, model: e.model, sentAt, firstAt: null, visibleAt: null, at: sentAt, rate: null }
      await update($, now, s => ({ ...s, live }))
    }

    try {
      for await (const chunk of next(e)) {
        const at = wantsClock(timer, chunk) ? await $.clock.now() : undefined
        const tick = onChunk(timer, chunk, at)
        timer = tick.timer
        if (chunk.kind === 'stop') usage = chunk.usage

        if (isMain && tick.push) {
          const { firstAt, visibleAt, at: time } = timer
          const r = liveRate(timer, ratio)
          await update($, now, s =>
            s.live?.id === id ? { ...s, live: { ...s.live, firstAt, visibleAt, at: time, rate: r } } : s,
          )
        }

        yield chunk
      }

      const m = finish(timer, usage?.output_tokens, ratio)
      if (m !== null) {
        const step: Step = {
          id,
          model: usage?.model ?? e.model,
          tokens: m.tokens,
          decodeMs: m.decodeMs,
          ttftMs: m.ttftMs,
          tps: rate(m.tokens, m.decodeMs),
          isSubagent: !isMain,
        }
        const { chars } = timer
        await update($, history, prev => ({
          steps: [...prev.steps, step].slice(-KEEP),
          lastMain: isMain ? step : prev.lastMain,
          main: isMain ? addStep(prev.main, step) : prev.main,
          all: addStep(prev.all, step),
          calib: m.calibrates ? calibrate(prev.calib, chars, m.tokens) : prev.calib,
        }))
      }
    } finally {
      if (isMain) await update($, now, s => (s.live?.id === id ? { ...s, live: null } : s))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [{ live: cur }, hist] = await Promise.all([read($, now), read($, history)])
    const { Box, Text, Button } = $.ui.resolve(e)

    const last = hist.lastMain ?? hist.steps.at(-1) ?? null
    const liveRate = cur?.rate ?? null
    const hero = liveRate ?? last?.tps ?? null
    const heroText = hero === null ? '—' : (liveRate !== null ? '~' : '') + fmtRate(hero)
    const heroColor = cur !== null ? 'claude' : undefined
    const avg = average(hist.main)

    const status =
      cur === null
        ? last
          ? `last response · ${shortModel(last.model)}`
          : 'waiting for the first response'
        : cur.firstAt === null
          ? `waiting for first token · ${shortModel(cur.model)}`
          : cur.visibleAt === null
            ? `thinking · ${shortModel(cur.model)}`
            : `streaming · ${shortModel(cur.model)}`

    if (e.props.placement === 'widget') {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="flex-end">
            <Text size="title" weight="bold" tabular color={heroColor}>
              {heroText}
            </Text>
            <Text size="caption" dimColor>
              tok/s
            </Text>
          </Box>
          <Text size="caption" dimColor wrap="truncate">
            {avg === null ? status : `avg ${fmtRate(avg)} · ${status}`}
          </Text>
        </Box>
      )
    }

    const detail =
      cur !== null && cur.firstAt !== null
        ? `first token ${fmtSecs(cur.firstAt - cur.sentAt)}`
        : last
          ? `${fmtInt(last.tokens)} tokens · ${fmtSecs(last.decodeMs)} · first token ${fmtSecs(last.ttftMs)}`
          : null

    const rates = hist.steps.filter(s => !s.isSubagent).map(s => s.tps)
    const chart =
      rates.length < 2 ? null : e.surface === 'terminal' ? (
        <Text color="claude">{sparkText(rates, Math.max(8, e.props.bodyColumns - 2))}</Text>
      ) : (
        (() => {
          const { Svg } = $.ui.resolve(e)
          return (
            <Svg
              source={sparkSvg(rates, avg)}
              alt={`Tokens per second over the last ${rates.length} responses, from ${fmtRate(Math.min(...rates))} to ${fmtRate(Math.max(...rates))}`}
            />
          )
        })()
      )

    const room = Math.max(2, Math.min(8, e.props.scroll.bodyRows - 14))
    const recent = hist.steps.slice(-room).reverse()
    const subagents = hist.all.count - hist.main.count

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="flex-end">
            <Text size="title" weight="bold" tabular color={heroColor}>
              {heroText}
            </Text>
            <Text dimColor>tok/s</Text>
          </Box>
          <Text size="footnote" dimColor>
            {status}
          </Text>
          {detail !== null && (
            <Text size="footnote" tabular>
              {detail}
            </Text>
          )}
        </Box>

        {chart}

        <Box flexDirection="column">
          <Text size="footnote" weight="semibold">
            This session
          </Text>
          {avg === null ? (
            <Text size="footnote" dimColor>
              No responses timed yet.
            </Text>
          ) : (
            <Text size="footnote" tabular>
              avg {fmtRate(avg)} tok/s · peak {fmtRate(hist.main.peak)} · {hist.main.count}{' '}
              {hist.main.count === 1 ? 'response' : 'responses'} · {fmtInt(hist.main.tokens)} tokens out
            </Text>
          )}
          {subagents > 0 && (
            <Text size="footnote" dimColor tabular>
              with subagents: avg {fmtRate(average(hist.all) ?? 0)} tok/s · {hist.all.count} responses
            </Text>
          )}
        </Box>

        {recent.length > 0 && (
          <Box flexDirection="column">
            <Text size="footnote" weight="semibold">
              Recent
            </Text>
            {recent.map(s => (
              <Text size="footnote" mono tabular dimColor={s.isSubagent}>
                {fmtRate(s.tps).padStart(6)} tok/s {fmtInt(s.tokens).padStart(6)} tok{' '}
                {fmtSecs(s.decodeMs).padStart(5)}
                {s.isSubagent ? '  agent' : ''}
              </Text>
            ))}
          </Box>
        )}

        {hist.all.count > 0 && (
          <Box>
            <Button
              key="reset"
              label="Reset"
              onPress={async () => {
                // Keeps what it learned of characters per token.
                await update($, history, prev => ({ ...EMPTY, calib: prev.calib }))
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
