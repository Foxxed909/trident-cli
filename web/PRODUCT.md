# TRIDENT Web — Product Context

register: product

## What it is
The browser face of the TRIDENT CLI: a local-first agentic coding console. It connects
over WebSocket to `trident serve` running on the developer's own machine, in their own
repo. Everything the CLI does — stream a task, run tools, ask for approval, track cost —
happens here with a real UI instead of a terminal.

## Who uses it
Developers who already live in TRIDENT's CLI but want a richer surface for longer
sessions: readable streaming output, visible tool timelines, click-to-approve instead of
y/n prompts, and a persistent list of conversations. Power users, not newcomers.

## Core jobs
1. Start and watch an agent task stream in real time.
2. Approve or deny tool actions (writes, commands, MCP calls) inline, by risk.
3. See the tool timeline: what ran, succeeded, failed, how long it took.
4. Switch approval mode (review / yolo / lockdown) without leaving the screen.
5. Keep multiple conversations ("Chats") and see connected services ("Connections": MCP servers).

## Register & tone
Terminal-native, not consumer-cheerful. The CLI's identity (deep ocean dark, teal +
amber, monospace accents) grown into a real app shell. It should feel like an instrument
a professional trusts, not a marketing page. Density is welcome; the tool disappears into
the task.

## Non-goals
Not a hosted SaaS, not a landing page, not a mobile-first app. No sign-up, no billing UI,
no fake dashboard metrics. One workspace = one running `trident serve`.
