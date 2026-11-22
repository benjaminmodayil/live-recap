# second-opinion

A Claude Code plugin that asks a panel of outside models for an isolated second opinion on a plan, spec, research write-up or hard design question. Reviewers are reached through [OpenRouter](https://openrouter.ai) or a [LiteLLM proxy](https://docs.litellm.ai/docs/simple_proxy), and Anthropic models are never used: the session already runs on Claude, so the point is a view from a different model family.

It adds:

- `second_opinion`, a tool Claude can call (listed as `mcp__second-opinion__second_opinion`)
- `/second-opinion`, a slash command

A port of the Pi coding agent's `pi-second-opinion` extension.

```
Second opinion
Artifact: PLAN.md
Panel: 3/3 reviewers (openai, google, zai, strong tier)
GATE: BLOCKED
- Blocking verdict(s): revise.
- 1 blocking finding(s) must be resolved and the gate re-run.
Verdicts: approve x2, revise x1
Blocking findings: No rollback step before switching writers
Panel usage: 9120 tokens, ~$0.0413 as the providers reported it

[google-skeptical] openrouter/google/gemini-3.1-pro-preview → revise (14.2s)
blocking: PLAN.md:2: No rollback step before switching writers
  evidence: 2. Switch writers.
...
```

## Requirements

Function hooks must be on: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` (see the root README).

## Install

```sh
claude plugin marketplace add benjaminmodayil/live-recap
claude plugin install second-opinion@live-recap
```

Then give it a provider (below) and check the setup with `/second-opinion --status`.

## Providers

Set these with `/config` (the second-opinion rows) or `claude plugin configure second-opinion`. API keys are kept in secure storage. Each falls back to an environment variable when left empty.

| Option             | Env fallback         | Meaning                                                      |
| ------------------ | -------------------- | ------------------------------------------------------------ |
| `openrouterApiKey` | `OPENROUTER_API_KEY` | OpenRouter key. Enables `openrouter/...` models              |
| `litellmBaseUrl`   | `LITELLM_BASE_URL`   | LiteLLM proxy URL, such as `http://localhost:4000`. Enables `litellm/...` models |
| `litellmApiKey`    | `LITELLM_API_KEY`    | Virtual or master key, if the proxy needs one               |

A model ref is `provider/model`. Everything after the first slash goes to the provider as is:

- `openrouter/openai/gpt-5.6-sol`: OpenRouter's model id `openai/gpt-5.6-sol`. Variants such as `:nitro` work too.
- `litellm/house-gpt`: the `model_name` your proxy config defines.

## Tiers

Each tier is an ordered pool of models. A panel runs the first models of its tier at once. When one fails, the next untried model takes its slot.

| Option           | Default                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `strongModels`   | `openrouter/openai/gpt-5.6-sol, openrouter/google/gemini-3.1-pro-preview, openrouter/z-ai/glm-5.3, openrouter/x-ai/grok-4.7, openrouter/deepseek/deepseek-v4-pro` |
| `balancedModels` | `openrouter/google/gemini-3.8-flash, openrouter/openai/gpt-5.4-mini, openrouter/moonshotai/kimi-k2.6, openrouter/qwen/qwen3.7-plus` |
| `fastModels`     | `openrouter/z-ai/glm-5.3-flash, openrouter/deepseek/deepseek-v4.1-flash, openrouter/qwen/qwen3.8-flash` |
| `defaultTier`    | `strong`                                                                                     |
| `reviewerCount`  | `3` (1 to 8)                                                                                 |
| `timeoutSeconds` | `150` per reviewer                                                                           |

The defaults were OpenRouter model ids on 2026-11-22. With only a LiteLLM proxy, replace them with `litellm/...` refs. `/second-opinion --status` shows which entries each provider actually lists.

Reasoning effort is `off` for fast, `medium` for balanced and `high` for strong. To set it per model, add `=level` to a ref: `openrouter/openai/gpt-5.5=xhigh`. The levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`.

- OpenRouter gets its unified `reasoning: { effort }`, with `max` sent as `xhigh`. The reasoning text is excluded from the reply.
- LiteLLM gets `reasoning_effort`, with `xhigh` and `max` sent as `high`. The request carries `drop_params: true`, so the proxy drops what a backend does not support.
- `off` sends no reasoning field, which leaves the model at its own default.

## Usage

```text
/second-opinion PLAN.md find requirements the plan forgot
/second-opinion --tier fast --reviewers 2 is the storage choice sound at 10x load?
/second-opinion                       # reviews this session's transcript
/second-opinion --status              # checks keys, endpoints and pools; runs no review
/second-opinion --help
```

Flags: `--tier fast|balanced|strong`, `--validate` (one fast reviewer), `--reviewers N`, `--model provider/model`, `--thinking LEVEL`, `--no-context`, `--focus ASK`.

The command prints the panel's result. Then it starts a turn in which Claude verifies the findings and acts on the gate.

Claude calls the tool on its own after writing a plan, spec or research summary, or for a hard design question. Its inputs mirror the flags: `path` or `content`, `focus`, `modelTier`, `reviewerCount`, `reviewers` (explicit `{ model, label, prompt, thinking }` entries), `model`, `validation`, `thinking` and `includeSessionContext`.

## The gate

Code computes the gate, never a reviewer. It is closed by default and opens only when every reviewer answered, every verdict is `approve` or `n/a`, and no reviewer reported a blocking finding. A timeout, an error, or a reply with no verdict is a missing answer, so it blocks.

After a blocked gate, Claude verifies each finding, revises the artifact for the confirmed ones and re-runs. It gets at most three runs per artifact, and revisions do not reset the count. After three blocked runs it stops and asks you.

## What leaves your machine

Each reviewer receives:

- the artifact
- the ask
- the session transcript: message text plus a one-line note per tool call

Tool results and system reminders are left out of the transcript, and so is this plugin's own output. Pass `--no-context` (or `includeSessionContext: false`) to send a file or text without the transcript. Reviewers get no tools and never see each other's replies.

## Rules that always hold

- Anthropic models never review, under any spelling: `anthropic/claude-*`, `~anthropic/*`, `anthropic.claude-*` on Bedrock, or bare `sonnet`/`opus`/`haiku` ids.
- Routers such as `openrouter/auto` are refused too, since they can pick a Claude model.
- An explicit `model` or `reviewers` entry must also be listed in a tier pool.
- A LiteLLM alias that hides a Claude model behind another name cannot be detected. Keep those out of the pools yourself.
- Panels are capped at 8 reviewers.
- When a pool runs out of distinct models, a model that answered is asked again to fill the panel. The repeat is marked as such and never counts as agreement.
- Cost figures are what the providers reported (OpenRouter's `usage.cost`, LiteLLM's `x-litellm-response-cost`), so treat them as estimates.

## Not ported from Pi

- The Jev screen, which relied on a Pi-native classifier.
- The JSONL run log.
- The interactive first-run model picker. `/second-opinion --status` and the settings rows replace it.

## Develop

`.claude-plugin/types/` is written by Claude Code when it loads the plugin from a folder you own; the repository's `.gitignore` leaves it out.

```sh
tsc -p .                               # typecheck
claude plugin validate --strict .      # manifest + hooks check
claude plugin test .                   # tests/*.test.ts
```

Run it from the working copy with `claude --plugin-dir plugins/second-opinion`.
