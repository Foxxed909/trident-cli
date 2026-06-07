# TRIDENT CLI

TRIDENT is an agentic coding CLI that runs in the terminal with project context, tool use, approval controls, and session logging.

## Quickstart

### 1. Install

```bash
npm install
npm run build

# optional: make `trident` available on your PATH
npm link
```

### 2. Set an API key

TRIDENT can run against Anthropic, OpenRouter, or the local Codex CLI.

```bash
# macOS / Linux
export ANTHROPIC_API_KEY=sk-ant-...
export OPENROUTER_API_KEY=sk-or-...

# PowerShell
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:OPENROUTER_API_KEY="sk-or-..."
```

Only one provider key is required for Anthropic/OpenRouter. The default provider is `anthropic`.

For Codex-powered profiles, make sure the local Codex CLI is installed and logged in:

```bash
codex --version
codex doctor
```

### 3. Check your environment

```bash
trident doctor
```

### 4. Initialize project context

```bash
trident init
```

This creates `TRIDENT.md` in the current project.

### 5. Run it

```bash
trident
trident "add input validation to the config loader"
```

## Commands

| Command | Description |
|---|---|
| `trident` | Start interactive mode |
| `trident "task"` | Run a one-shot task |
| `trident init` | Generate `TRIDENT.md` for the current project |
| `trident models` | List available models for each provider |
| `trident profiles` | List trained TRIDENT profiles |
| `trident train` | Prepare the five Codex-powered prompt profiles |
| `trident config` | Show current config |
| `trident config <key> <value>` | Set a config value |
| `trident doctor` | Check environment and API keys |
| `trident review` | Review the latest session action log |
| `trident heal` | Diagnose common issues |
| `trident heal --reset-config` | Reset config to defaults if invalid |
| `trident heal --regen-md` | Regenerate `TRIDENT.md` in the current project |

## Flags

| Flag | Description |
|---|---|
| `-m, --model <model>` | Override model |
| `-p, --provider <provider>` | Provider: `anthropic`, `openrouter`, or `codex` |
| `--mode <mode>` | Approval mode: `yolo`, `review`, or `lockdown` |
| `--max-turns <n>` | Max agent loop iterations |
| `--budget <usd>` | Max spend in USD for the current session |
| `--profile <name>` | Use a trained profile: `Sydney`, `mercedes`, `Cipher`, `XAVIER`, or `Berry-Ski` |
| `--system-override <text>` | Add an operator override that wins over profile output style |
| `--codex-model <model>` | Optional Codex CLI model override when `--provider codex` |
| `--codex-timeout <ms>` | Timeout for `codex exec` runs |

## Interactive commands

Plain text without a leading `/` is sent to the agent as a task.

### Session

- `/help` - show slash-command help
- `/status` - show model, provider, mode, cost, budget, and token totals
- `/cost` - alias for `/status`
- `/history` - show tasks run in the current session
- `/clear` - clear the screen
- `/exit` - quit
- `/` then Enter - open the command picker

### Agent

- `/retry` - re-run the last task
- `/undo` - revert the last approved file write or edit
- `/save [file]` - save the current session transcript to a Markdown file
- `/compact` - trim session history and clear the undo stack
- `/budget` - show the current session budget
- `/budget <usd>` - set the current session budget
- `/budget clear` - clear the current session budget
- `/profile [name|clear]` - show or switch the trained profile
- `/profiles` - list trained profiles
- `/override [text|clear]` - show, set, or clear the operator system override

### Project

- `/init` - generate `TRIDENT.md`
- `/context` - print the current `TRIDENT.md`
- `/tree` - show the project file tree
- `/cwd` - show the working directory

### Config

- `/model <name>` - switch model; model names containing `/` are treated as OpenRouter models
- `/provider anthropic|openrouter|codex` - switch provider
- `/mode yolo|review|lockdown` - switch approval mode
- `/yolo` - shortcut for `/mode yolo`
- `/safe` - shortcut for `/mode review`
- `/lock` - shortcut for `/mode lockdown`
- `/models` - list available models
- `/profiles` - list trained profiles
- `/sessions` - list recent session log files

## Approval modes

| Mode | Description |
|---|---|
| `review` | Auto-approve reads; confirm writes, commands, and destructive actions |
| `yolo` | Auto-approve everything |
| `lockdown` | Confirm every action |

## Configuration

TRIDENT stores config through `conf`. You can inspect the resolved path with:

```bash
trident config
```

Current config keys:

- `model`
- `provider`
- `mode`
- `maxTurns`
- `budgetUsd`
- `logSessions`
- `onboarded`
- `userName`
- `profile`
- `systemOverride`
- `codexModel`
- `codexTimeoutMs`

Examples:

```bash
trident config provider openrouter
trident config model openai/gpt-oss-20b:free
trident config provider codex
trident config profile Sydney
trident config systemOverride "Answer with concise implementation summaries."
trident config mode review
trident config maxTurns 30
trident config budgetUsd 5
trident config logSessions false
```

## Session logs

When `logSessions` is enabled, TRIDENT writes JSONL session logs to:

```text
~/.trident/logs/<session-id>.jsonl
```

Review the most recent log with:

```bash
trident review
```

Each entry records the timestamp, tool name, input, result, approval state, and risk level.

## Models

Default Anthropic model:

- `claude-sonnet-4-6`

You can also switch to OpenRouter and use any compatible model id, for example:

- `openai/gpt-4o`
- `openai/gpt-oss-20b:free`

List the currently exposed model sets with:

```bash
trident models
```

### Codex-powered trained profiles

TRIDENT includes five prompt-trained operating profiles that can run through the local Codex CLI:

- `Sydney` - product-minded full-stack builder
- `mercedes` - systems reliability engineer
- `Cipher` - security and bug-hunting specialist
- `XAVIER` - architecture and reasoning lead
- `Berry-Ski` - fast prototype and polish finisher

Use them with:

```bash
trident --provider codex --profile Sydney "review this repo and fix the highest-impact bug"
trident --provider codex --profile Cipher --system-override "Prioritize path traversal and command execution risks." "audit tools"
```

`trident train` verifies the Codex CLI path and lists the five trained profiles. This is prompt/profile training, not model weight fine-tuning.

## Project structure

```text
trident/
|-- src/
|   |-- index.ts
|   |-- config.ts
|   |-- profiles.ts
|   |-- agent/
|   |   |-- loop.ts
|   |   `-- tools.ts
|   |-- oracle/
|   |   `-- index.ts
|   |-- providers/
|   |   |-- anthropic.ts
|   |   |-- codex.ts
|   |   `-- openrouter.ts
|   |-- ui/
|   |   |-- onboarding.ts
|   |   |-- renderer.ts
|   |   `-- diff.ts
|   `-- warden/
|       `-- index.ts
|-- scripts/
|   `-- smoke-test.mjs
|-- TRIDENT.md
|-- package.json
`-- README.md
```

## Notes

- Tool execution is restricted to the current workspace root.
- Session budgets are enforced during agent runs.
- Provider switching in interactive mode checks that the required API key is present before a request is sent.
- Codex provider runs through `codex exec` with a timeout and captures the final Codex message.
