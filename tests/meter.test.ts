import { expect, test } from 'claude-code/testing'

import {
  PRIOR_CHARS_PER_TOKEN,
  calibrate,
  charsPerToken,
  finish,
  fmtRate,
  liveRate,
  onChunk,
  startTimer,
  wantsClock,
} from '../hooks/meter'
import type { Piece, Timer } from '../hooks/meter'

const engine: Piece = { kind: 'engine' }
const text = (n: number): Piece => ({ kind: 'text', text: 'x'.repeat(n) })
const stop: Piece = { kind: 'stop' }

// Feeds chunks at the given times, reading the clock only where the meter asks.
function feed(beats: Array<[number, Piece]>, sentAt = 0): Timer {
  let t = startTimer(sentAt)
  for (const [at, p] of beats) t = onChunk(t, p, wantsClock(t, p) ? at : undefined).timer

  return t
}

test('a lone chunk and a pause before any content is a retry: timing restarts', () => {
  const t = feed([
    [300, engine], // the retry marker
    [3_300, engine], // the next attempt's envelope, after the backoff
    [3_310, engine],
    [3_400, text(40)],
    [5_800, stop],
  ])

  expect(t.firstAt).toBe(3_300)
  expect(finish(t, 100, 2.4)).toEqual({ tokens: 100, decodeMs: 2_500, ttftMs: 3_300, calibrates: true })
})

test('hidden thinking after the envelope counts as generation, not as a retry', () => {
  const t = feed([
    [500, engine], // envelope
    [505, engine], // the thinking block starts; its text never streams
    [4_500, engine], // its signature, four seconds on
    [4_505, engine],
    [4_510, text(40)],
    [6_500, stop],
  ])

  expect(t.firstAt).toBe(500)
  expect(t.visibleAt).toBe(4_510)
  // 6s of generation, 2s of it visible: its characters say nothing of a token.
  expect(finish(t, 300, 2.4)).toEqual({ tokens: 300, decodeMs: 6_000, ttftMs: 500, calibrates: false })
})

test('the live rate counts what streamed after the first visible chunk', () => {
  const beats: Array<[number, Piece]> = [[500, engine], [500, text(24)]]
  for (let i = 1; i <= 6; i++) beats.push([500 + 100 * i, text(24)])
  const t = feed(beats)

  // 6 chunks of 24 characters in 0.6s, at 2.4 characters a token: 100 tok/s.
  expect(liveRate(t, 2.4)).toBe(100)
  expect(liveRate(feed([[500, text(24)], [600, text(24)]]), 2.4)).toBe(null)
})

test('mid-stream text reads the clock only when the readout redraws', () => {
  let t = feed([[0, engine], [10, text(5)]])
  const asked: boolean[] = []
  for (let i = 0; i < 6; i++) {
    asked.push(wantsClock(t, text(5)))
    t = onChunk(t, text(5), asked.at(-1) ? 20 + i : undefined).timer
  }

  expect(asked).toEqual([false, false, false, false, false, true])
  expect(wantsClock(t, stop)).toBe(true)
  expect(wantsClock(t, engine)).toBe(false)
})

test('tiny or untimed responses give no numbers', () => {
  expect(finish(feed([[100, text(4)], [150, stop]]), 2, 2.4)).toBe(null)
  expect(finish(feed([[100, text(4)]]), 50, 2.4)).toBe(null)
})

test('characters per token start from the prior and follow what is measured', () => {
  expect(charsPerToken({ chars: 0, tokens: 0 })).toBe(PRIOR_CHARS_PER_TOKEN)
  const learned = calibrate({ chars: 0, tokens: 0 }, 30_000, 10_000)
  expect(charsPerToken(learned)).toBe((2_400 + 30_000) / 11_000)
  expect(calibrate({ chars: 100_000, tokens: 49_999 }, 10, 10)).toEqual({ chars: 50_005, tokens: 25_004.5 })
})

test('rates round to one decimal under 100 and to whole numbers from there', () => {
  expect(fmtRate(5)).toBe('5.0')
  expect(fmtRate(99.94)).toBe('99.9')
  expect(fmtRate(99.96)).toBe('100')
  expect(fmtRate(123.4)).toBe('123')
})
