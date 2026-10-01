# message-timestamps

A Claude Code plugin that prefixes each Claude reply block in the transcript with the local time it arrived. No model calls, no tokens: the time is read from the clock when the block is appended and formatted with `Intl` in your locale and time zone.

```
⏺ `11:04 AM` I'll add the band hook to register.tsx.

  ⏺ Update(hooks/register.tsx)
    ...

⏺ `11:06 AM` Done. Tests pass.
```

A block that opens with block markdown (heading, list, code fence, quote, table) gets the time on its own line above it, so the markdown still renders.

## Requirements

Function hooks must be on: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (see the root README).

## Install

```sh
claude plugin marketplace add benjaminmodayil/live-recap
claude plugin install message-timestamps@live-recap
```

## Behavior

- Display only: the stored message and what the model reads are unchanged (ctrl+o shows the original).
- Deterministic: a block's time is fixed when it is appended; redraws, scrolls and resizes never change it.
- Every text block of a reply is stamped, so long turns show progression.
- Blocks loaded by `--resume` / `--continue` were not appended in this session and draw without a time.

## Develop

`.claude-plugin/types/` is written by Claude Code when it loads the plugin from a folder you own; it is gitignored.

```sh
tsc -p .                               # typecheck
claude plugin validate --strict .      # manifest + hooks check
claude plugin test .                   # tests/*.test.ts
```

The test kit in Claude Code 2.1.285 has no stand-in for `session.append` or plugin state, so tests cover the formatting (`hooks/stamp.ts`) and the unstamped render path; the append-to-render wiring was verified by loading the plugin in a live session (2.1.285).
