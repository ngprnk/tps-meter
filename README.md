# tps-meter

A Claude Code mod that shows how fast Claude writes, in tokens per second.

- **While Claude works**, a small readout in the footer under the prompt shows the live rate: `… tok/s` until the first token, `~84 tok/s` while text streams, then the exact rate of the last response while a tool runs.
- **When Claude is idle**, the readout keeps the session's average, for example `avg 79.0 tok/s`.
- **`/tps`** opens a pane with the last response's numbers (tokens, generation time, time to first token), a chart of recent responses, session totals and a list of recent responses, subagents included.

In the Claude desktop app the readout sits in the row with the model selector. In the terminal it joins the mode labels at the right of the footer.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install tps-meter --marketplace ngprnk/tps-meter
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every project).

From a shell:

```bash
claude plugin install tps-meter --marketplace ngprnk/tps-meter
```

In the Claude desktop app, where `/plugin` does not run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `ngprnk/tps-meter`, then **Add plugin**.

A plugin installed at user scope from a terminal also loads in the desktop app's local Code sessions.

## How it measures

- Every model response streams through the mod. It notes when the first piece arrives and when the response ends.
- **Live** (`~`): characters received so far divided by about 3.6 characters per token. It reads low when thinking is hidden or summarized.
- **Exact**: the API's own `output_tokens` for the response (thinking included) divided by the time from first chunk to last. Time to first token is reported separately.
- Responses under 5 tokens or 100 ms are skipped: they arrive in one burst and have no meaningful rate.
- The average is total output tokens over total generation time for the session. **Reset** in the `/tps` pane clears it.

## Cost

None in tokens. The mod makes no model calls, adds nothing to the system prompt or tools, and passes every response through unchanged. The numbers come from the usage the API already returns, and all drawing happens locally.

## Uninstall

```bash
claude plugin uninstall tps-meter@tps-meter
```

## Notes

Built on Claude Code's function-hooks mod API (tested on Claude Code 2.1.325). That API is early access and may change between releases.

## License

[MIT](LICENSE)
