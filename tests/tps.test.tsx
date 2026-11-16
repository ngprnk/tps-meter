import { expect, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

const USAGE = {
  input_tokens: 10,
  output_tokens: 200,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-fable-5-2',
}

const pane = (placement: 'dock' | 'widget') =>
  ({
    plugin: 'tps-meter',
    component: 'Pane',
    requestId: 'tps-meter',
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

// Hooks that stand for the engine beneath the mod. Each model response takes
// 500ms to its first chunk and 2s from there to the stop: 200 tokens, 100 tok/s.
function fakeEngine(on: On) {
  let now = 1_000
  on('clock.now', () => ({ value: now }))
  // The engine's footer: its mode labels joined as it draws them.
  on('ui.render', { component: 'SessionMode' }, ($, e) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.modes.join(' & ')}</Text>
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    now += 500
    yield { kind: 'thinking', index: 0, text: 'hm' }
    for (let i = 0; i < 12; i++) {
      now += 100
      yield { kind: 'text', index: 0, text: 'x'.repeat(36) }
    }
    now += 800
    yield { kind: 'stop', stopReason: 'end_turn', usage: USAGE }

    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'x',
      toolUses: [],
      stopReason: 'end_turn',
      usage: USAGE,
    }
  })
}

async function respond($: Engine, turnId: string): Promise<number> {
  let chunks = 0
  const stream = $.turn.step({ turnId, index: 0, model: 'claude-fable-5-2', messageCount: 1 })
  for await (const _ of stream) chunks += 1

  return chunks
}

const complete = ($: Engine, turnId: string) =>
  $.turn.complete({ answer: 'x', durationMs: 2_500, isAborted: false, turnId, reason: 'answer' })

test('a streamed response is timed from first chunk to stop', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await respond($, 't1')).toBe(14)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...pane('dock'), surface })
    expect((await ui.find({ type: 'Text', text: /^100$/ }))?.text).toBe('100')
    const detail = await ui.find({ type: 'Text', text: /tokens ·/ })
    expect(detail?.text).toBe('200 tokens · 2.0s · first token 0.5s')
    await ui.unmount()
  }

  const widget = await $.ui.mount({ ...pane('widget'), surface: 'desktop' })
  expect((await widget.find({ type: 'Text', text: /^100$/ }))?.text).toBe('100')
  await widget.unmount()
})

test('the footer shows the rate while a turn runs and the average while idle', async ($, on) => {
  fakeEngine(on)

  // Idle before any turn: the engine's own footer, nothing added.
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount(footer(surface, ['focus']))
    expect((await idle.find({ type: 'Text' }))?.text).toBe('focus')
    await idle.unmount()
  }

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')

  // Terminal: after the mode labels at the right of its footer.
  const modes = await $.ui.mount(footer('terminal', ['focus']))
  expect((await modes.find({ type: 'Text' }))?.text).toBe('focus & 100 tok/s')
  await modes.unmount()

  // Desktop: a tree of the mod's own (the chip beside the model selector shows
  // only that), never the engine's node.
  for (const list of [[], ['focus']]) {
    const chip = await $.ui.mount(footer('desktop', list))
    expect((await chip.find({ type: 'Text' }))?.text).toBe(
      list.length === 0 ? '100 tok/s' : 'focus & 100 tok/s',
    )
    await chip.unmount()
  }

  // The turn ends: the session's average stays.
  await complete($, 't1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const idle = await $.ui.mount(footer(surface, ['focus']))
    expect((await idle.find({ type: 'Text' }))?.text).toBe('focus & avg 100 tok/s')
    await idle.unmount()
  }
})

test('a new turn shows no rate from the last one before its first token', async ($, on) => {
  fakeEngine(on)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await respond($, 't1')
  await complete($, 't1')

  await $.turn.start({ text: 'again', turnId: 't2' })
  const chip = await $.ui.mount(footer('desktop', []))
  expect((await chip.find({ type: 'Text' }))?.text).toBe('… tok/s')
  await chip.unmount()
})

test('an empty session says it is waiting', async $ => {
  const ui = await $.ui.mount({ ...pane('dock'), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /waiting/ }))?.text).toBe(
    'waiting for the first response',
  )
  await ui.unmount()
})
