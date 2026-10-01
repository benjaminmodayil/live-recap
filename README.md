# live-recap

A Claude Code plugin that draws a card above the prompt saying what Claude is working on, refreshed every few minutes while a turn runs. After the run ends, the last recap stays up (muted) until the next prompt.

```
╭─ tracking  running 6m · 2 in background · haiku · ~1m ago ──────────╮
│ Editing hooks/register.tsx to draw the live card. It shows the user
│ what Claude is doing while they look away.
╰──────────────────────────────────────────────────────────────────────
```

## Also in this repo

- [`message-timestamps`](plugins/message-timestamps): prefixes each Claude reply with the local time it arrived, no model calls. Install with `claude plugin install message-timestamps@live-recap`.

## Requirements

Function hooks are early access and off by default. Enable them before installing, or the plugin loads but never draws:

```json
// ~/.claude/settings.json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Or export `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` in your shell profile. Restart Claude Code after setting it.

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

## Troubleshooting

- **No card at all**: check `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` is set (see Requirements), then `claude plugin list` shows `live-recap` loaded.
- **Card missing on short turns**: expected. The first card appears only after a turn runs `intervalMinutes` (default 2).
- **Card hidden while a question dialog is open**: the dialog takes over the area above the prompt; the card returns once the dialog closes.

## Develop

`.claude-plugin/types/` is written by Claude Code when it loads the plugin from a folder you own; it is gitignored. Load the plugin once to generate it.

```sh
tsc -p .                                  # typecheck
claude plugin validate --strict .         # manifest + hooks check
claude plugin test .                      # tests/*.test.ts (when available in your CLI build)
```
