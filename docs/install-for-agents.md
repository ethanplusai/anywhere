# Installing Anywhere, for agents

This page is written for a coding agent (Claude Code, Codex or similar) that has been asked to
install Anywhere, or to "set up Anywhere", and does not have it yet. Do the steps yourself; ask the
person once before you change their settings, and do not hand them commands to run.

Anywhere gives every agent a person uses the same project pages (overview, plan, decisions, open
questions, ideas, log), so what one agent learns the next one already knows.

## 1. Is one already running?

```sh
curl -s http://127.0.0.1:3341/healthz
```

`{"ok":true}` means a local Anywhere is running on this computer. Go to step 3.

## 2. Start one

Ask which the person wants.

**On this computer.** One person, no account, nothing leaves the machine. Needs Node.js 22 and pnpm.

```sh
git clone https://github.com/ethanplusai/anywhere.git ~/anywhere
cd ~/anywhere && pnpm install && pnpm local
```

`pnpm local` keeps running: start it in the background and leave it. It listens on
`127.0.0.1:3341` only and keeps its pages and two tokens in `~/.anywhere`.

**The hosted service.** Works from chat apps as well, and needs an account at
[anywr.ai](https://anywr.ai).

```sh
claude mcp add --scope user --transport http anywhere https://mcp.anywr.ai/mcp
```

In Claude Code the person then types `/mcp`, picks `anywhere` and chooses **Authenticate**. For
Codex: `codex mcp add anywhere --url https://mcp.anywr.ai/mcp`, then `codex mcp login anywhere`.
Skip to step 4.

## 3. Connect to the local one

The agent token is in a file only the person can read. Never read it into the conversation or
print it: pass it straight from the file, as below.

Claude Code:

```sh
claude mcp add --scope user --transport http anywhere-local http://127.0.0.1:3341/mcp --header "Authorization: Bearer $(cat ~/.anywhere/agent-token)"
node ~/anywhere/skill/install.mjs --claude
```

Codex, or if the command above fails: open the app and ask the person to press **Connect** beside
their agent's name. The button connects the agent and installs the skill.

```sh
open "http://127.0.0.1:3341/local/unlock#token=$(cat ~/.anywhere/browser-token)"
```

## 4. Hand over

A connection only loads in a new session, so you cannot use Anywhere in the session that installed
it. Tell the person exactly this:

> Anywhere is connected. Open a new session and say: Set up Anywhere.

In that new session the skill takes over: it asks first, lists the projects on the computer from
folder names and dates only, and brings in the ones the person chooses.
