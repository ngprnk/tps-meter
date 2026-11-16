/** The response streaming right now on the main thread. */
export type Live = {
  /** `${turnId}:${index}`, so only the stream that set it clears it. */
  id: string
  model: string
  sentAt: number
  /** The first chunk of the attempt that answered; null while waiting on it. */
  firstAt: number | null
  /** The first visible character; null while thinking is hidden. */
  visibleAt: number | null
  /** When `rate` was last worked out. */
  at: number
  /** Estimated tokens per second over the visible stream; null too early. */
  rate: number | null
}

/** The main loop: its running turn, and the response streaming in it. */
export type Now = {
  turnId: string | null
  live: Live | null
}

/** One finished model response. */
export type Step = {
  id: string
  model: string
  /** Exact output tokens as the API reported them (thinking included). */
  tokens: number
  /** First chunk to the stop: the time spent generating. */
  decodeMs: number
  /** Request sent to first chunk. */
  ttftMs: number
  tps: number
  isSubagent: boolean
}

export type Totals = {
  tokens: number
  decodeMs: number
  count: number
  peak: number
}

/** Visible characters and the tokens they cost, over calibrating responses. */
export type Calib = {
  chars: number
  tokens: number
}

/** Everything measured this session. */
export type History = {
  /** The last responses, main thread and subagents alike. */
  steps: Step[]
  /** The main thread's last response, however many subagent ones came since. */
  lastMain: Step | null
  /** The main thread alone: what the footer's average is. */
  main: Totals
  /** Main thread and subagents together. */
  all: Totals
  calib: Calib
}

declare module 'claude-code' {
  interface PluginState {
    'tps-meter': {
      now: Shaped<Now>
      history: Shaped<History>
    }
  }
}
