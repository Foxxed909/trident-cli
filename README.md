# 🔱 TRIDENT CLI

> **Three Prongs. One Power. All Yours.**

TRIDENT is an all-powerful agentic AI coding assistant that runs entirely in your terminal. Inspired by Claude Code, OpenAI Codex CLI, and Qwen Code CLI — built to surpass them all.

---

## Architecture: The Three Prongs

```
🔱 TRIDENT
├── ⚡ FORGE     — Agentic coding engine (tool loop, file ops, shell execution)
├── 🔮 ORACLE    — Project context engine (TRIDENT.md, framework detection, tree scanning)
└── 🛡 WARDEN    — Safety & approval layer (risk classification, diffs, session logging)
```

---

## Quickstart

### 1. Install

```bash
# Clone or copy this project, then:
npm install

# Make globally available
npm link

# Or run directly:
npx tsx src/index.ts
```

### 2. Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Run doctor check

```bash
trident doctor
```

### 4. Initialize your project

```bash
cd /your/project
trident init   # Generates TRIDENT.md — the AI memory file
```

### 5. Start building

```bash
trident                           # Interactive mode
trident "add input validation"    # One-shot task
```

---

## Commands

| Command | Description |
|---------|-------------|
| `trident` | Interactive REPL mode |
| `trident "task"` | One-shot task execution |
| `trident init` | Generate TRIDENT.md for current project |
| `trident config` | Show full configuration |
| `trident config <key> <value>` | Set a config value |
| `trident doctor` | Check environment & API keys |
| `trident review` | Review last session action log |
| `trident --help` | Show all options |

### Flags

| Flag | Description |
|------|-------------|
| `-m, --model <model>` | Override model (e.g. `claude-opus-4-5`) |
| `--mode <mode>` | Approval mode: `yolo`, `review`, `lockdown` |
| `--max-turns <n>` | Max agent loop iterations (default: 50) |
| `--budget <usd>` | Max spend in USD for this session |

### Interactive Commands

While in interactive mode:
- `exit` or `quit` — Exit TRIDENT
- `init` — Generate TRIDENT.md
- `mode yolo|review|lockdown` — Switch approval mode
- `model <name>` — Switch model

---

## Approval Modes

| Mode | Description |
|------|-------------|
| `review` (default) | Auto-approve reads; ask for writes, shell, destructive |
| `yolo` | Auto-approve everything — fastest, zero interruptions |
| `lockdown` | Ask for every single action — maximum safety |

### Risk Classification

Every tool call is classified before execution:

| Risk | Color | Actions |
|------|-------|---------|
| `READ` | 🟢 Green | read_file, list_dir, search, web_fetch |
| `WRITE` | 🟡 Yellow | write_file, edit_file |
| `EXECUTE` | 🟣 Magenta | run_command |
| `DESTRUCTIVE` | 🔴 Red | delete_file |

---

## TRIDENT.md — Project Memory

TRIDENT reads `TRIDENT.md` from your project root and injects it into every agent prompt. This gives the AI persistent knowledge about your project.

```markdown
# TRIDENT Project Context

## Project
- Name, languages, frameworks, package manager

## Commands
- Install, dev, test, build, lint

## Do Not Touch
- Files/dirs TRIDENT should never modify

## Context for AI
- Any conventions, rules, or extra context you want TRIDENT to know
```

Run `trident init` to auto-generate it. Edit it freely.

---

## Agent Tools

TRIDENT's agent has access to 10 tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Write/create a file |
| `edit_file` | Surgical string-replace edits |
| `delete_file` | Delete a file (DESTRUCTIVE) |
| `list_dir` | List directory (with recursive option) |
| `run_command` | Execute shell commands |
| `search_codebase` | Grep across project files |
| `web_fetch` | Fetch URLs (docs, APIs) |
| `ask_user` | Ask you a clarifying question |
| `final_answer` | Signal task completion |

All tools have a 30-second timeout and full session logging.

---

## Configuration

```bash
trident config                        # Show all config
trident config model claude-sonnet-4-5  # Switch model
trident config mode yolo              # Default to YOLO mode
trident config maxTurns 100           # More iterations
```

Config stored at `~/.trident-cli/config.json`.

---

## Session Logs

All actions are logged to `~/.trident/logs/<session-id>.jsonl`.

Review the latest session:
```bash
trident review
```

Each log entry contains: timestamp, tool name, input, result, approved/denied, risk level.

---

## Models

TRIDENT uses Anthropic's models by default:

| Model | Best For |
|-------|----------|
| `claude-opus-4-5` | Complex agentic tasks (default) |
| `claude-sonnet-4-5` | Balanced speed/quality |
| `claude-haiku-4-5-20251001` | Fast, cheap tasks |

---

## Project Structure

```
trident/
├── src/
│   ├── index.ts              ← CLI entry point & interactive REPL
│   ├── config.ts             ← Config management (conf-backed)
│   ├── agent/
│   │   ├── loop.ts           ← Main agent loop (streaming + tool calling)
│   │   └── tools.ts          ← Tool definitions + executors
│   ├── providers/
│   │   └── anthropic.ts      ← Streaming Anthropic provider
│   ├── oracle/
│   │   └── index.ts          ← Project scanner, TRIDENT.md, system prompt
│   ├── ui/
│   │   ├── renderer.ts       ← Terminal UI (chalk-based)
│   │   └── diff.ts           ← Colored diff viewer
│   └── warden/
│       └── index.ts          ← Risk classifier, approval, session logger
├── package.json
├── tsconfig.json
└── README.md
```

---

## Philosophy

1. **Think before acting** — The agent plans before calling tools
2. **Minimal blast radius** — Surgical edits preferred over full rewrites
3. **Verify work** — Tests/linters run after changes when available
4. **Ask when uncertain** — Clarification over wrong assumptions
5. **Full transparency** — Every action logged, every risk shown
6. **Complete tasks** — The agent doesn't stop until it's done

---

*Built with ⚡ TypeScript, Anthropic SDK, Commander, Chalk, Inquirer, Execa*
