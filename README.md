# live-recap

A Claude Code plugin that draws a card above the prompt saying what Claude is working on, refreshed every few minutes while a turn runs. After the run ends, the last recap stays up (muted) until the next prompt.

```
╭─ tracking  running 6m · 2 in background · haiku · ~1m ago ──────────╮
│ Editing hooks/register.tsx to draw the live card. It shows the user
│ what Claude is doing while they look away.
╰──────────────────────────────────────────────────────────────────────
```

## Install

```sh
claude plugin marketplace add benjaminmodayil/live-recap
claude plugin install live-recap@live-recap
```

Restart Claude Code (or run `/reload-plugins`).

## Options

Set with `claude plugin configure live-recap`.

| Key               | Default | Meaning                                                                                              |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `intervalMinutes` | `2`     | Card first shows after a turn runs this long, then refreshes at the same interval                    |
| `source`          | `haiku` | `haiku`: small model reads recent activity (cheap). `fork`: session model reads full transcript (costs more) |

## Side effects

- On session start (interactive only), turns off the built-in session recap (`awaySummaryEnabled: false` in user settings) since it draws over this card. This persists if the plugin is removed.
- Headless runs draw nothing and make no model calls.

## Develop

`.claude-plugin/types/` is written by Claude Code when it loads the plugin from a folder you own; it is gitignored. Load the plugin once to generate it.

```sh
tsc -p .                                  # typecheck
claude plugin validate --strict .         # manifest + hooks check
claude plugin test .                      # tests/*.test.ts (when available in your CLI build)
```
