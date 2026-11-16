import { atom, read, update } from 'claude-code'
import type { Register, TurnUsage } from 'claude-code'

import type { Live, Step, Totals } from '../types'

const PANE = 'tps-meter'
const TITLE = 'Tokens/sec'
// Claude's tokenizer averages roughly this many characters per token on
// English and code. Only the live estimate uses it; the final number is the
// API's own output_tokens.
const CHARS_PER_TOKEN = 3.6
// Content chunks between live redraws while a response streams.
const PUSH_EVERY = 6
const KEEP = 40
// Responses shorter than this are noise (one burst, no measurable rate).
const MIN_TOKENS = 5
const MIN_DECODE_MS = 100

const EMPTY: Totals = { tokens: 0, decodeMs: 0, count: 0, peak: 0 }

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const live = atom({ plugin: 'tps-meter', key: 'live' } as const, null, {
  shape: 'live-1',
})
const working = atom({ plugin: 'tps-meter', key: 'working' } as const, null, {
  shape: 'working-1',
})
const steps = atom({ plugin: 'tps-meter', key: 'steps' } as const, [], {
  shape: 'steps-1',
})
const totals = atom({ plugin: 'tps-meter', key: 'totals' } as const, EMPTY, {
  shape: 'totals-1',
})

const rate = (tokens: number, ms: number) => (ms > 0 ? tokens / (ms / 1000) : 0)
const fmtRate = (n: number) => (n >= 100 ? String(Math.round(n)) : n.toFixed(1))
const fmtInt = (n: number) =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const fmtSecs = (ms: number) =>
  ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`
const shortModel = (m: string) => m.replace(/^claude-/, '').replace(/-\d{8}$/, '')
const padStart = (s: string, n: number) => (s.length >= n ? s : ' '.repeat(n - s.length) + s)

const BARS = '▁▂▃▄▅▆▇█'
function sparkText(values: number[], width: number): string {
  const shown = values.slice(-Math.max(1, width))
  const max = Math.max(...shown, 1)
  return shown
    .map(v => BARS.charAt(Math.min(7, Math.floor((v / max) * 7.999))))
    .join('')
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
      const h = Math.max(2, (v / max) * H)
      const x = i * (bw + gap)
      const opacity = i === n - 1 ? 1 : 0.5
      return `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="#D97757" fill-opacity="${opacity}"/>`
    })
    .join('')
  const avgLine =
    avg === null
      ? ''
      : `<line x1="0" x2="${W}" y1="${(H - (avg / max) * H).toFixed(1)}" y2="${(H - (avg / max) * H).toFixed(1)}" stroke="#8A8A8A" stroke-width="1" stroke-dasharray="3 3"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${bars}${avgLine}</svg>`
}

// The footer's words while a turn runs: the live estimate while text streams,
// else this turn's last response (a tool is running), else nothing measured yet.
function footerLabel(
  turnId: string,
  cur: Live | null,
  list: readonly Step[],
  tot: Totals,
): string {
  const avg = tot.count > 1 ? ` · avg ${fmtRate(rate(tot.tokens, tot.decodeMs))}` : ''

  if (cur !== null && cur.firstAt !== null && cur.at - cur.firstAt >= 250) {
    return `~${fmtRate(rate(cur.estTokens, cur.at - cur.firstAt))} tok/s${avg}`
  }

  const last = list.filter(s => !s.isSubagent && s.id.startsWith(`${turnId}:`)).at(-1)

  return last ? `${fmtRate(last.tps)} tok/s${avg}` : `… tok/s${avg}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'tps',
      description: 'Show the tokens-per-second pane',
    })
    // A reload runs this again; a stream or turn the old code was timing is gone.
    await update($, live, () => null)
    await update($, working, () => null)

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) await update($, working, () => e.turnId)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, cur => (cur === e.turnId ? null : cur))
    }

    return next(e)
  })

  // The readout in the footer under the input: the current rate while a turn
  // runs, the session's average while idle, nothing before the first timed
  // response. The terminal joins it to its own mode labels. The desktop draws
  // this site as a chip in the row with the model selector, but only from a
  // tree a mod drew itself (the engine's own node counts as empty there, so
  // the chip hides), which is how it is hidden when there is nothing to show.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const [turnId, cur, list, tot] = await Promise.all([
      read($, working),
      read($, live),
      read($, steps),
      read($, totals),
    ])

    const label =
      turnId !== null
        ? footerLabel(turnId, cur, list, tot)
        : tot.count > 0
          ? `avg ${fmtRate(rate(tot.tokens, tot.decodeMs))} tok/s`
          : null

    if (label === null) return next(e)

    const modes = [...e.props.modes, label]

    if (e.surface === 'terminal') {
      return next({ ...e, props: { ...e.props, modes } })
    }

    const { Text } = $.ui.resolve(e)

    return <Text tabular>{modes.join(' & ')}</Text>
  })

  // No `text`: a mod's output line stays in every later request the model
  // reads, and the pane opening says enough.
  on('command.run', { command: 'tps' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return {}
  })

  // Every model request streams through here. Time it from the first chunk
  // to the stop chunk, and take the exact token count from the stop chunk.
  on('turn.step', async function* ($, e, next) {
    const id = `${e.turnId}:${e.index}`
    const isSubagent = e.agentId !== undefined
    const sentAt = await $.clock.now()
    let firstAt: number | null = null
    let stopAt: number | null = null
    let usage: TurnUsage | null = null
    let chars = 0
    let sincePush = 0

    if (!isSubagent) {
      await update($, live, () => ({
        id,
        model: e.model,
        sentAt,
        firstAt: null,
        at: sentAt,
        estTokens: 0,
      }))
    }

    try {
      for await (const chunk of next(e)) {
        if (firstAt === null) {
          const at = await $.clock.now()
          firstAt = at
          if (!isSubagent) {
            await update($, live, cur => (cur?.id === id ? { ...cur, firstAt: at, at } : cur))
          }
        }

        if (chunk.kind === 'text' || chunk.kind === 'thinking') {
          chars += chunk.text.length
          sincePush += 1
        } else if (chunk.kind === 'input') {
          chars += chunk.json.length
          sincePush += 1
        } else if (chunk.kind === 'stop') {
          stopAt = await $.clock.now()
          usage = chunk.usage
        }

        if (!isSubagent && sincePush >= PUSH_EVERY) {
          sincePush = 0
          const at = await $.clock.now()
          const estTokens = chars / CHARS_PER_TOKEN
          await update($, live, cur => (cur?.id === id ? { ...cur, at, estTokens } : cur))
        }

        yield chunk
      }

      if (firstAt !== null && stopAt !== null) {
        const decodeMs = stopAt - firstAt
        const tokens = usage?.output_tokens ?? Math.round(chars / CHARS_PER_TOKEN)

        if (tokens >= MIN_TOKENS && decodeMs >= MIN_DECODE_MS) {
          const step: Step = {
            id,
            model: usage?.model ?? e.model,
            tokens,
            decodeMs,
            ttftMs: firstAt - sentAt,
            tps: rate(tokens, decodeMs),
            isSubagent,
          }
          await update($, steps, list => [...list, step].slice(-KEEP))
          await update($, totals, t => ({
            tokens: t.tokens + tokens,
            decodeMs: t.decodeMs + decodeMs,
            count: t.count + 1,
            peak: tokens >= 20 ? Math.max(t.peak, step.tps) : t.peak,
          }))
        }
      }
    } finally {
      if (!isSubagent) {
        await update($, live, cur => (cur?.id === id ? null : cur))
      }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const [cur, list, tot] = await Promise.all([read($, live), read($, steps), read($, totals)])
    const { Box, Text, Button } = $.ui.resolve(e)

    const last = list.filter(s => !s.isSubagent).at(-1) ?? list.at(-1)
    const liveMs = cur !== null && cur.firstAt !== null ? cur.at - cur.firstAt : 0
    const liveRate = cur !== null && liveMs >= 250 ? rate(cur.estTokens, liveMs) : null
    const hero = liveRate ?? last?.tps ?? null
    const heroText = hero === null ? '—' : (liveRate !== null ? '~' : '') + fmtRate(hero)
    const heroColor = cur !== null ? 'claude' : undefined
    const avg = tot.count > 0 ? rate(tot.tokens, tot.decodeMs) : null

    const status =
      cur === null
        ? last
          ? `last response · ${shortModel(last.model)}`
          : 'waiting for the first response'
        : cur.firstAt === null
          ? `waiting for first token · ${shortModel(cur.model)}`
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
        ? `~${fmtInt(cur.estTokens)} tokens so far · ${fmtSecs(liveMs)} · first token ${fmtSecs(cur.firstAt - cur.sentAt)}`
        : last
          ? `${fmtInt(last.tokens)} tokens · ${fmtSecs(last.decodeMs)} · first token ${fmtSecs(last.ttftMs)}`
          : null

    const rates = list.map(s => s.tps)
    const chartWidth = Math.max(8, e.props.bodyColumns - 2)
    const chart =
      rates.length < 2 ? null : e.surface === 'terminal' ? (
        <Text color="claude">{sparkText(rates, chartWidth)}</Text>
      ) : (
        (() => {
          const { Svg } = $.ui.resolve(e)
          const shown = rates.slice(-KEEP)
          return (
            <Svg
              source={sparkSvg(shown, avg)}
              alt={`Tokens per second over the last ${shown.length} responses, from ${fmtRate(Math.min(...shown))} to ${fmtRate(Math.max(...shown))}`}
            />
          )
        })()
      )

    const room = Math.max(2, Math.min(8, e.props.scroll.bodyRows - 14))
    const recent = list.slice(-room).reverse()

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
          {tot.count === 0 ? (
            <Text size="footnote" dimColor>
              No responses timed yet.
            </Text>
          ) : (
            <Text size="footnote" tabular>
              avg {fmtRate(avg ?? 0)} tok/s · peak {fmtRate(tot.peak)} · {tot.count}{' '}
              {tot.count === 1 ? 'response' : 'responses'} · {fmtInt(tot.tokens)} tokens out
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
                {padStart(fmtRate(s.tps), 6)} tok/s {padStart(fmtInt(s.tokens), 6)} tok{' '}
                {padStart(fmtSecs(s.decodeMs), 5)}
                {s.isSubagent ? '  agent' : ''}
              </Text>
            ))}
          </Box>
        )}

        {tot.count > 0 && (
          <Box>
            <Button
              key="reset"
              label="Reset"
              onPress={async () => {
                await update($, steps, () => [])
                await update($, totals, () => EMPTY)
              }}
            />
          </Box>
        )}
      </Box>
    )
  })
}
