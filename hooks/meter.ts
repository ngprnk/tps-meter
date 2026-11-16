// The arithmetic of timing one model response as its chunks stream through
// `turn.step`, kept apart from the hooks so it can be tested on its own.
// Pure: the hook reads the clock only when `wantsClock` says a chunk needs it.

import type { Calib, Step, Totals } from '../types'

/** Visible chunks between live redraws while a response streams. */
export const PUSH_EVERY = 6
/**
 * A pause this long after a lone first chunk, before any content, means that
 * chunk was a retry marker and the backoff followed: timing restarts at the
 * next attempt's first chunk.
 */
export const RETRY_GAP_MS = 1_000
/** Responses shorter than this are one burst, with no rate worth showing. */
export const MIN_TOKENS = 5
export const MIN_DECODE_MS = 100
/** A live rate needs this much visible streaming before it means anything. */
export const MIN_LIVE_MS = 250
/** The peak ignores responses shorter than this: a short burst reads fast. */
export const PEAK_MIN_TOKENS = 50
/**
 * Characters per token in what Claude streams visibly (text, tool arguments),
 * as measured on recent transcripts. Each finished response refines it.
 */
export const PRIOR_CHARS_PER_TOKEN = 2.4
const PRIOR_WEIGHT = 1_000
const CALIB_CAP = 50_000

export const EMPTY_TOTALS: Totals = { tokens: 0, decodeMs: 0, count: 0, peak: 0 }
export const EMPTY_CALIB: Calib = { chars: 0, tokens: 0 }

/** What the meter reads of a chunk. */
export type Piece = {
  kind: 'text' | 'thinking' | 'tool' | 'input' | 'stop' | 'engine'
  text?: string
  json?: string
}

export type Timer = {
  sentAt: number
  /** The first chunk of the attempt that answered; null before any. */
  firstAt: number | null
  /** Chunks seen before any content, and when the last of them came. */
  before: number
  lastAt: number
  hasContent: boolean
  /** The first visible character; null while thinking is hidden or none came. */
  visibleAt: number | null
  /** Visible characters in all, and those after the first visible chunk. */
  chars: number
  liveChars: number
  sincePush: number
  /** The last time the clock was read. */
  at: number
  stopAt: number | null
}

export const startTimer = (sentAt: number): Timer => ({
  sentAt,
  firstAt: null,
  before: 0,
  lastAt: sentAt,
  hasContent: false,
  visibleAt: null,
  chars: 0,
  liveChars: 0,
  sincePush: 0,
  at: sentAt,
  stopAt: null,
})

const charsOf = (p: Piece) =>
  p.kind === 'text' || p.kind === 'thinking'
    ? (p.text?.length ?? 0)
    : p.kind === 'input'
      ? (p.json?.length ?? 0)
      : 0

/**
 * Whether `onChunk` needs the time for this chunk: every chunk before the
 * content starts (to spot a retry), the first visible one, each redraw, the
 * stop. Mid-stream text needs none.
 */
export function wantsClock(t: Timer, p: Piece): boolean {
  if (p.kind === 'stop' || !t.hasContent) return true
  if (charsOf(p) === 0) return false

  return t.visibleAt === null || t.sincePush + 1 >= PUSH_EVERY
}

/** The timer after a chunk, and whether the live readout should redraw. */
export function onChunk(t: Timer, p: Piece, now?: number): { timer: Timer; push: boolean } {
  const at = now ?? t.at
  const next: Timer = { ...t, at }
  let push = false

  if (!t.hasContent) {
    const isRetry = t.before === 1 && at - t.lastAt >= RETRY_GAP_MS
    if (t.firstAt === null || isRetry) {
      next.firstAt = at
      next.before = 1
      push = true
    } else {
      next.before = t.before + 1
    }
    next.lastAt = at
    next.hasContent = p.kind !== 'engine' && p.kind !== 'stop'
  }

  const n = charsOf(p)
  if (n > 0) {
    next.chars = t.chars + n
    if (t.visibleAt === null) {
      next.visibleAt = at
      next.sincePush = 0
      push = true
    } else {
      next.liveChars = t.liveChars + n
      next.sincePush = t.sincePush + 1
      if (next.sincePush >= PUSH_EVERY) {
        next.sincePush = 0
        push = true
      }
    }
  }

  if (p.kind === 'stop') next.stopAt = at

  return { timer: next, push }
}

export const rate = (tokens: number, ms: number) => (ms > 0 ? tokens / (ms / 1000) : 0)

/** Tokens per second over what has streamed visibly so far, or null too early. */
export function liveRate(t: Timer, charsPerToken: number): number | null {
  if (t.visibleAt === null) return null
  const ms = t.at - t.visibleAt

  return ms >= MIN_LIVE_MS ? rate(t.liveChars / charsPerToken, ms) : null
}

export type Measured = {
  tokens: number
  decodeMs: number
  ttftMs: number
  /** Whether its characters per token are worth learning from. */
  calibrates: boolean
}

/** The finished response's numbers, or null when it has no rate worth keeping. */
export function finish(
  t: Timer,
  outputTokens: number | undefined,
  charsPerToken: number,
): Measured | null {
  if (t.firstAt === null || t.stopAt === null) return null
  const decodeMs = t.stopAt - t.firstAt
  const tokens = outputTokens ?? Math.round(t.chars / charsPerToken)
  if (tokens < MIN_TOKENS || decodeMs < MIN_DECODE_MS) return null

  // Only a response that streamed visibly for nearly all of its generation
  // says what a token is in characters: hidden thinking spends tokens that
  // show nothing.
  const calibrates =
    outputTokens !== undefined &&
    tokens >= PEAK_MIN_TOKENS &&
    t.visibleAt !== null &&
    t.stopAt - t.visibleAt >= 0.9 * decodeMs

  return { tokens, decodeMs, ttftMs: t.firstAt - t.sentAt, calibrates }
}

export const charsPerToken = (c: Calib) =>
  (PRIOR_CHARS_PER_TOKEN * PRIOR_WEIGHT + c.chars) / (PRIOR_WEIGHT + c.tokens)

/** Learns from one response, halving old evidence so it keeps adapting. */
export function calibrate(c: Calib, chars: number, tokens: number): Calib {
  const next = { chars: c.chars + chars, tokens: c.tokens + tokens }

  return next.tokens > CALIB_CAP ? { chars: next.chars / 2, tokens: next.tokens / 2 } : next
}

export const addStep = (t: Totals, s: Step): Totals => ({
  tokens: t.tokens + s.tokens,
  decodeMs: t.decodeMs + s.decodeMs,
  count: t.count + 1,
  peak: s.tokens >= PEAK_MIN_TOKENS ? Math.max(t.peak, s.tps) : t.peak,
})

export const average = (t: Totals) => (t.count > 0 ? rate(t.tokens, t.decodeMs) : null)

/** One decimal under 100, whole numbers from there (99.96 reads "100"). */
export function fmtRate(n: number): string {
  const tenths = Math.round(n * 10) / 10

  return tenths >= 100 ? String(Math.round(n)) : tenths.toFixed(1)
}
