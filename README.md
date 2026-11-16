# tps-meter

A Claude Code mod that shows how fast Claude writes, in tokens per second.

- **While Claude works**, a small readout in the footer under the prompt shows the rate:
  - `… tok/s` until text starts to stream, which includes any thinking you don't see.
  - `~84 tok/s` while text streams: a live estimate.
  - The exact rate of the last response while a tool runs.
- **When Claude is idle**, the readout keeps the session's average, for example `avg 79.0 tok/s`.
- **The pane** shows:
  - the last response's numbers: tokens, generation time and time to first token
  - a chart of recent responses
  - session totals
  - a list of recent responses, subagents included

In the Claude desktop app the readout sits in the row with the model selector. Click it to open the pane. In the terminal the readout joins the mode labels at the right of the footer, and `/tps` opens the pane.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tps-meter --marketplace ngprnk/tps-meter
```

Answer `y` to add the marketplace, then pick a scope. User scope loads it in every project.

From a shell:

```bash
claude plugin install tps-meter --marketplace ngprnk/tps-meter
```

The desktop app doesn't run `/plugin`. There, click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `ngprnk/tps-meter`, then **Add plugin**.

A plugin installed at user scope from a terminal also loads in the desktop app's local Code sessions.

## How it measures

- Every model response streams through the mod. It notes when the first piece arrives and when the response ends.
- **Exact**: the API's own `output_tokens` for the response, thinking included, divided by the time from the first piece to the end.
  - If a request is retried, the wait before the retry doesn't count.
  - Time to first token is reported separately.
- **Live** (`~`): visible characters streamed so far, divided by characters per token, over the time since the first visible character.
  - It starts at 2.4 characters per token.
  - It then learns from each response that streamed visibly for nearly all of its generation.
  - Hidden thinking streams nothing, so the live estimate waits for text instead of reading low.
- Responses under 5 tokens or 100 ms are skipped. They arrive in one burst and have no meaningful rate.
- **The average** is total output tokens over total generation time, for Claude's own responses in the current session.
  - Subagents get a separate line in the pane and stay out of the footer.
  - **Reset** in the pane clears the numbers.

## Cost

The mod makes no model calls, adds nothing to the system prompt or tools, and passes every response through unchanged. The numbers come from the usage the API already returns, and all drawing happens locally.

The one thing that costs tokens is typing `/tps` in the desktop app. The app runs Claude Code headless, and headless runs save every slash command in the conversation: about 90 tokens, sent again with each later message. Clicking the footer readout opens the same pane for free. In the terminal, `/tps` saves nothing.

## Requirements

Built on Claude Code's function-hooks mod API, which is early access and may change between releases. Tested on Claude Code 2.1.325.

## Developing

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The type check needs `.claude-plugin/types/`. Claude Code writes that folder when it loads the mod from this folder, for example in a session started with `claude --plugin-dir .`. Then, with TypeScript installed:

```bash
npx tsc -p .
```

The timing logic is in `hooks/meter.ts`, and the hooks are in `hooks/register.tsx`.

## Uninstall

```bash
claude plugin uninstall tps-meter@tps-meter
```

## License

[MIT](LICENSE)
