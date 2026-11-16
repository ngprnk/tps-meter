import type { TurnStepChunk, TurnStepInput, TurnUsage } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]
/** Wait this many milliseconds, then stream the chunk. */
type Beat = [number, TurnStepChunk]

const MODEL = 'claude-fable-5-2'

const usage = (output_tokens: number): TurnUsage => ({
  input_tokens: 10,
  output_tokens,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: MODEL,
})

const stop = (tokens: number): TurnStepChunk => ({
  kind: 'stop',
  stopReason: 'end_turn',
  usage: usage(tokens),
})

// 500ms to the first chunk, then 2s of generation to the stop: `tokens / 2`
// tokens a second. 12 visible chunks of 36 characters come 100ms apart.
function script(tokens: number): Beat[] {
  const beats: Beat[] = [[500, { kind: 'thinking', index: 0, text: 'hm' }]]
  for (let i = 0; i < 12; i++) beats.push([100, { kind: 'text', index: 1, text: 'x'.repeat(36) }])
  beats.push([800, stop(tokens)])

  return beats
}

// Hooks that stand for the engine beneath the mod. Returns the panes opened.
function fakeEngine(on: On, plan: (e: TurnStepInput) => Beat[] = () => script(200)) {
  let now = 1_000
  const opened: string[] = []

  on('clock.now', () => ({ value: now }))
  on('ui.open', (_, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  // The engine's own footer, marked so a test can tell it from the mod's tree.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{`engine: ${e.props.modes.join(' & ')}`}</Text>
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    let last: TurnUsage | null = null
    for (const [ms, chunk] of plan(e)) {
      now += ms
      if (chunk.kind === 'stop') last = chunk.usage
      yield chunk
    }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: last,
    }
  })

  return opened
}

const stream = ($: Engine, turnId: string, agentId?: string) =>
  $.turn.step({
    turnId,
    index: 0,
    model: MODEL,
    messageCount: 1,
    ...(agentId !== undefined && { agentId }),
  })

async function respond($: Engine, turnId: string, agentId?: string): Promise<number> {
  let chunks = 0
  for await (const _ of stream($, turnId, agentId)) chunks += 1

  return chunks
}

const complete = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: 'x', durationMs: 2_500, isAborted: false, turnId, reason: 'answer' })

const pane = (placement: 'dock' | 'widget', surface: 'terminal' | 'desktop' | 'vscode' | 'mobile') =>
  ({
    plugin: 'tps-meter',
    component: 'Pane',
    requestId: 'tps-meter',
    surface,
    props: {
      title: 'Tokens/sec',
      isFocused: false,
      bodyColumns: 40,
      placement,
      scroll: { offset: 0, bodyRows: 30 },
      view: {},
    },
  }) as const

const footer = (surface: 'terminal' | 'desktop', modes: string[]) =>
  ({
    plugin: 'tps-meter',
    component: 'SessionMode',
    requestId: 'session-mode',
    surface,
    props: { modes },
  }) as const

/** The terminal footer's one line, as the engine beneath drew it. */
async function terminalLine($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount(footer('terminal', ['focus']))
  const text = (await ui.find({ type: 'Text' }))?.text
  await ui.unmount()

  return text
}

/**
 * The desktop chip: the readout button's label, or the engine's own line
 * when the mod handed the site back (which the desktop treats as empty).
 */
async function chip($: Engine, modes: string[] = []): Promise<string | undefined> {
  const ui = await $.ui.mount(footer('desktop', modes))
  const button = await ui.find({ type: 'Button', key: 'open' })
  const engine = await ui.find({ type: 'Text', text: /^engine:/ })
  await ui.unmount()
  if (button !== undefined && engine !== undefined) throw new Error('both trees drawn')

  return button?.text ?? engine?.text
}

async function paneText($: Engine, pattern: RegExp, surface: 'terminal' | 'desktop' = 'desktop') {
  const ui = await $.ui.mount(pane('dock', surface))
  const text = (await ui.find({ type: 'Text', text: pattern }))?.text
  await ui.unmount()

  return text
}

test('a streamed response is timed from first chunk to stop', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await respond($, 't1')).toBe(14)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount(pane('dock', surface))
    expect((await ui.find({ type: 'Text', text: /^100$/ }))?.text).toBe('100')
    const detail = await ui.find({ type: 'Text', text: /tokens ·/ })
    expect(detail?.text).toBe('200 tokens · 2.0s · first token 0.5s')
    await ui.unmount()
  }

  const widget = await $.ui.mount(pane('widget', 'desktop'))
  expect((await widget.find({ type: 'Text', text: /^100$/ }))?.text).toBe('100')
  await widget.unmount()
})

test('the footer shows the rate while a turn runs and the average while idle', async ($, on) => {
  fakeEngine(on)

  // Nothing measured yet: the engine's own footer, untouched.
  expect(await terminalLine($)).toBe('engine: focus')
  expect(await chip($)).toBe('engine: ')

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')

  // Terminal: after the mode labels, still drawn by the engine.
  expect(await terminalLine($)).toBe('engine: focus & 100 tok/s')
  // Desktop: a tree of the mod's own, the readout a button.
  expect(await chip($)).toBe('100 tok/s')
  const withModes = await $.ui.mount(footer('desktop', ['focus']))
  expect((await withModes.find({ type: 'Text' }))?.text).toBe('focus')
  expect((await withModes.find({ type: 'Button', key: 'open' }))?.text).toBe('100 tok/s')
  await withModes.unmount()

  // The turn ends: the session's average stays.
  await complete($, 't1')
  expect(await terminalLine($)).toBe('engine: focus & avg 100 tok/s')
  expect(await chip($)).toBe('avg 100 tok/s')
})

// A drawing mounted while a stream is held waits ~1.5s for it to settle.
test('while text streams the footer shows a live estimate, then the exact rate', { timeoutMs: 20_000 }, async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const it = stream($, 't1')[Symbol.asyncIterator]()
  for (let i = 0; i < 7; i++) await it.next()

  // 6 chunks of 36 characters in 0.6s since the first, at 2.4 a token.
  expect(await chip($)).toBe('~150 tok/s')
  const ui = await $.ui.mount(pane('dock', 'desktop'))
  expect((await ui.find({ type: 'Text', text: /^streaming/ }))?.text).toBe('streaming · fable-5-2')
  expect((await ui.find({ type: 'Text', text: /^~/ }))?.text).toBe('~150')
  await ui.unmount()

  while (!(await it.next()).done) {}
  expect(await chip($)).toBe('100 tok/s')
  await complete($, 't1')

  // From the second response on, the turn's readout carries the average.
  await $.turn.start({ text: 'again', turnId: 't2' })
  await respond($, 't2')
  await complete($, 't2')
  await $.turn.start({ text: 'more', turnId: 't3' })
  const next = stream($, 't3')[Symbol.asyncIterator]()
  for (let i = 0; i < 7; i++) await next.next()
  expect(await chip($)).toMatch(/^~\d+ tok\/s · avg 100$/)
  while (!(await next.next()).done) {}
})

test('a new turn shows no rate from the last one before its first token', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  await complete($, 't1')

  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(await chip($)).toBe('… tok/s')
})

test("a subagent's responses stay out of the footer and its average", async ($, on) => {
  fakeEngine(on, e => script(e.agentId === undefined ? 200 : 100))

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  // More subagent responses than the pane's list keeps.
  for (let i = 0; i < 45; i++) await respond($, `a${i}`, 'agent-1')

  expect(await chip($)).toBe('100 tok/s')
  await complete($, 't1')
  expect(await chip($)).toBe('avg 100 tok/s')

  expect(await paneText($, /^avg/)).toBe('avg 100 tok/s · peak 100 · 1 response · 200 tokens out')
  // 4,700 tokens in 92s, main and subagents together.
  expect(await paneText($, /^with subagents/)).toBe('with subagents: avg 51.1 tok/s · 46 responses')
  expect(await paneText($, /agent$/)).toBe('  50.0 tok/s    100 tok  2.0s  agent')
})

test('an interrupted response leaves no live reading and no numbers', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  const it = stream($, 't1')[Symbol.asyncIterator]()
  for (let i = 0; i < 3; i++) await it.next()
  expect(await paneText($, /^streaming/)).toBe('streaming · fable-5-2')

  await it.return?.(undefined as never)
  expect(await paneText($, /^waiting/)).toBe('waiting for the first response')
  expect(await chip($)).toBe('… tok/s')
})

test('a response too short to time is skipped', async ($, on) => {
  fakeEngine(on, () => [
    [500, { kind: 'text', index: 0, text: 'ok' }],
    [10, stop(2)],
  ])

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  await complete($, 't1')

  expect(await chip($)).toBe('engine: ')
  expect(await paneText($, /^No responses/)).toBe('No responses timed yet.')
})

test('/tps opens the pane and prints nothing', async ($, on) => {
  const opened = fakeEngine(on)

  const result = await $.command.run({
    command: 'tps',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(result.text).toBeUndefined()
  expect(opened).toEqual(['tps-meter'])
})

test('the desktop readout opens the pane when clicked', async ($, on) => {
  const opened = fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  await complete($, 't1')

  const ui = await $.ui.mount(footer('desktop', []))
  await ui.press({ key: 'open' })
  await ui.unmount()

  expect(opened).toEqual(['tps-meter'])
})

test('Reset clears the numbers', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  await complete($, 't1')

  const ui = await $.ui.mount(pane('dock', 'desktop'))
  await ui.press({ key: 'reset' })
  await ui.unmount()

  expect(await paneText($, /^No responses/)).toBe('No responses timed yet.')
  expect(await chip($)).toBe('engine: ')
})

test('the chart shows recent responses', async ($, on) => {
  fakeEngine(on)

  for (const turnId of ['t1', 't2']) {
    await $.turn.start({ text: 'hi', turnId })
    await respond($, turnId)
    await complete($, turnId)
  }

  const desktop = await $.ui.mount(pane('dock', 'desktop'))
  expect((await desktop.find({ type: 'Svg' }))?.type).toBe('Svg')
  await desktop.unmount()

  expect(await paneText($, /^[▁▂▃▄▅▆▇█]+$/, 'terminal')).toBe('██')
})

test('an empty session says it is waiting', async ($, on) => {
  fakeEngine(on)

  expect(await paneText($, /waiting/)).toBe('waiting for the first response')
})
