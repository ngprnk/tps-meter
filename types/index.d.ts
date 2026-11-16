/** The response streaming right now on the main thread. */
export type Live = {
  /** `${turnId}:${index}`, so only the stream that set it clears it. */
  id: string
  model: string
  sentAt: number
  /** When the first chunk arrived; null while still waiting on it. */
  firstAt: number | null
  /** When `estTokens` was last counted. */
  at: number
  /** Streamed characters over ~3.6 per token: a live estimate. */
  estTokens: number
}

/** One finished model response. */
export type Step = {
  id: string
  model: string
  /** Exact output tokens as the API reported them (thinking included). */
  tokens: number
  /** First chunk to last chunk: the time spent generating. */
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

declare module 'claude-code' {
  interface PluginState {
    'tps-meter': {
      live: Shaped<Live | null>
      /** The main loop's running turn, null while idle. */
      working: Shaped<string | null>
      steps: Shaped<Step[]>
      totals: Shaped<Totals>
    }
  }
}
