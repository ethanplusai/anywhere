import type { Context, Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { mcpUrl, type Deps } from "../deps.js";
import { listGrants } from "../oauth/grants.js";
import { listPats } from "../auth/tokens.js";
import { AGENT_TOKEN_NAME } from "../local.js";
import { AGENTS, AGENT_NAMES, SERVER_NAME, type AgentId } from "../local-connect.js";
import { DRAWINGS } from "./drawings.generated.js";
import { copyField, flash, icon, type Flash, type Html } from "./render.js";
import { csrfOk, type WebEnv } from "./session.js";

type C = Context<WebEnv>;
type Kind = "app" | "flush" | "auth" | "status";

interface Helpers {
  view: (c: C, title: string, body: Html, status?: 200 | 403, kind?: Kind) => Response | Promise<Response>;
  csrfField: (c: C) => Html;
  requireUser: (c: C) => Response | null;
}

/** One of the onboarding drawings, which are static SVG exported from the website's drawing kit. */
function drawing(name: keyof typeof DRAWINGS): HtmlEscapedString {
  return raw(DRAWINGS[name]) as HtmlEscapedString;
}

type State = "done" | "todo" | "optional";

function badge(state: State, text: string): HtmlEscapedString {
  return html`<span class="ob-badge ob-${state}">${state === "done" ? icon("check") : ""}${text}</span>` as HtmlEscapedString;
}

/**
 * The walkthrough a new account lands on: how Anywhere works, then the four steps to get going with
 * Claude Code, each with its own drawing. Steps tick themselves off as they are done.
 */
export function registerOnboarding(app: Hono<WebEnv>, deps: Deps, h: Helpers): void {
  const { db, config, service } = deps;

  /**
   * The local start page: one screen. A button per agent connects it and installs the skill, and
   * then there is one thing to say. No commands unless the person asks to see them.
   */
  async function localStart(c: C, note?: Flash, status: 200 | 403 = 200) {
    const local = deps.local!;
    const connector = deps.connector!;
    const user = c.get("user")!;
    const [projects, pats] = await Promise.all([service.listProjects(user.id), listPats(db, user.id)]);
    const used = pats.some((p) => p.name === AGENT_TOKEN_NAME && p.lastUsedAt);
    const url = mcpUrl(config);
    const first = projects[0];

    const card = (agent: AgentId) => {
      const name = AGENT_NAMES[agent];
      const s = connector.status(agent);
      const button = (label: string, quiet = false) =>
        html`<form method="post" action="/local/connect/${agent}">${h.csrfField(c)}<button type="submit" class="${quiet ? "btn-sm btn-quiet" : "btn-wide"}">${label}</button></form>`;
      if (!s.installed) {
        return html`<li class="card ob-agent">
          <div class="ob-agent-head"><h2>${name}</h2>${badge("todo", "Not on this computer")}</div>
          <p>Anywhere could not find ${name} here. Install it, then reload this page.</p>
        </li>`;
      }
      if (!s.connected) {
        return html`<li class="card ob-agent">
          <div class="ob-agent-head"><h2>${name}</h2>${badge("todo", "Not connected")}</div>
          <p>Adds this Anywhere to ${name} for every project, and installs the skill that teaches it when to use it.</p>
          ${button(`Connect ${name}`)}
        </li>`;
      }
      return html`<li class="card ob-agent">
        <div class="ob-agent-head"><h2>${name}</h2>${badge("done", "Connected")}</div>
        <p>Open a <strong>new</strong> ${name} session, in any folder, and say:</p>
        ${copyField("Set up Anywhere.", "Copy what to say")}
        ${button("Connect again", true)}
      </li>`;
    };

    return h.view(
      c,
      "Get started",
      html`<div class="ob">
        <section class="ob-intro">
          <div class="ob-intro-copy">
            <p class="ob-kicker">Welcome to Anywhere</p>
            <h1>Connect an agent, then just talk.</h1>
            <p>
              Each project gets a few markdown pages: an overview, a plan, decisions, open questions,
              ideas and a log. Every agent you connect reads and writes the same pages, so what one
              learns, the next one already knows.
            </p>
          </div>
          <div class="ob-art ob-art-wide" aria-hidden="true">${drawing("welcome")}</div>
        </section>

        ${flash(note)}
        <ol class="ob-agents">${AGENTS.map(card)}</ol>

        <section class="card ob-say">
          <div class="ob-agent-head"><h2>Then say what you want</h2>${used ? badge("done", "An agent has used Anywhere") : ""}</div>
          <p>There is nothing else to set up. In a new session of a connected agent:</p>
          <dl class="ob-lines">
            <dt>To bring in your projects</dt>
            <dd>${copyField("Set up Anywhere.", "Copy what to say")}</dd>
            <dt>To save something</dt>
            <dd>${copyField("Add this to Anywhere.", "Copy what to say")}</dd>
            <dt>To carry on, in any agent</dt>
            <dd>${copyField(`Pick up where we left off on ${first ? first.name : "the build"} in Anywhere.`, "Copy what to say")}</dd>
          </dl>
          <p class="ob-more">Setting up asks first, then lists the projects on this computer from folder names and dates, never your conversations or files. You choose which to bring in.</p>
        </section>

        <details class="ob-terminal">
          <summary>Prefer the terminal, or using another agent?</summary>
          <p>The buttons above run this for you. Any agent that can send a fixed header can use the same address and token.</p>
          <p class="ob-label">Claude Code</p>
          ${copyField(`claude mcp add --scope user --transport http ${SERVER_NAME} ${url} --header "Authorization: Bearer $(cat ${local.agentTokenPath})"`, "Copy the command")}
          <p class="ob-more">Claude chat and ChatGPT run in the cloud, so they cannot reach an Anywhere on your computer.</p>
        </details>

        <div class="ob-end">
          <a class="btn" href="/projects">${projects.length ? "Go to your projects" : "Go to projects"}</a>
        </div>
      </div>`,
      status,
    );
  }

  if (deps.local && deps.connector) {
    const connector = deps.connector;
    app.post("/local/connect/:agent", async (c) => {
      const gate = h.requireUser(c);
      if (gate) return gate;
      const form = await c.req.parseBody();
      if (!csrfOk(c, form._csrf)) return localStart(c, { kind: "error", text: "This form expired. Try again." }, 403);
      // The agent is one of two names from a fixed list; nothing else from the request is used.
      const agent = AGENTS.find((a) => a === c.req.param("agent"));
      if (!agent) return c.notFound();
      const result = await connector.connect(agent);
      // Back to the start page by its own address, so reloading it does not connect again.
      if (result.ok) return c.redirect(`/welcome?connected=${agent}`, 303);
      return localStart(c, { kind: "error", text: result.message });
    });
  }

  app.get("/welcome", async (c) => {
    const gate = h.requireUser(c);
    if (gate) return gate;
    if (deps.local && deps.connector) {
      const agent = AGENTS.find((a) => a === c.req.query("connected"));
      const done = agent && deps.connector.status(agent).connected;
      return localStart(
        c,
        done ? { kind: "ok", text: `${AGENT_NAMES[agent]} is connected. Open a new ${AGENT_NAMES[agent]} session and say: Set up Anywhere.` } : undefined,
      );
    }
    const user = c.get("user")!;
    const [grants, projects, pats] = await Promise.all([listGrants(db, user.id), service.listProjects(user.id), listPats(db, user.id)]);
    const url = mcpUrl(config);
    const local = deps.local;
    const claudeCode = grants.find((g) => /claude\s*code/i.test(g.clientName ?? ""));
    // Locally, agents use the owner's agent token, so "connected" means that token has been used.
    const localAgent = local ? pats.find((p) => p.name === AGENT_TOKEN_NAME && p.lastUsedAt) : undefined;
    const connected = local ? (localAgent ? { clientName: "an agent" } : undefined) : (claudeCode ?? grants[0]);
    const skillUrl = `${config.baseUrl}/skill/anywhere.tar.gz`;
    const first = projects[0];

    const step = (n: number, art: keyof typeof DRAWINGS, title: string, status: HtmlEscapedString | "", body: Html) =>
      html`<li class="ob-step">
        <div class="ob-art" aria-hidden="true">${drawing(art)}</div>
        <div class="ob-copy">
          <div class="ob-step-head"><span class="ob-n">${n}</span>${status}</div>
          <h2>${title}</h2>
          ${body}
        </div>
      </li>`;

    return h.view(
      c,
      "Get started",
      html`<div class="ob">
        <section class="ob-intro">
          <div class="ob-intro-copy">
            <p class="ob-kicker">Welcome to Anywhere</p>
            <h1>Every agent you use, one memory.</h1>
            <p>
              Each project gets a few markdown pages: an overview, a plan, decisions, open questions,
              ideas and a log. Claude, ChatGPT, Claude Code and Codex all read and write the same
              pages, so what one agent learns, the next one already knows.
            </p>
            <p class="muted">Four steps to get going with Claude Code. About five minutes.</p>
          </div>
          <div class="ob-art ob-art-wide" aria-hidden="true">${drawing("welcome")}</div>
        </section>

        <ol class="ob-steps">
          ${step(
            1,
            "connect",
            "Connect Claude Code",
            connected ? badge("done", `Connected: ${connected.clientName ?? "an app"}`) : badge("todo", "To do"),
            local
              ? html`<p>Run this in a terminal. It adds this Anywhere to Claude Code for every project, with the agent token from <code>${local.agentTokenPath}</code>. There is nothing to sign in to.</p>
                  ${copyField(`claude mcp add --scope user --transport http anywhere-local ${url} --header "Authorization: Bearer $(cat ${local.agentTokenPath})"`, "Copy the command")}
                  <p>Start a new Claude Code session. This step ticks itself off the first time an agent uses Anywhere.</p>
                  <p class="ob-more">Codex works the same way: <a href="/connect">see the command</a>. Claude chat and ChatGPT run in the cloud, so they cannot reach an Anywhere on your computer.</p>`
              : html`<p>Run this in a terminal. It adds Anywhere to Claude Code for every project.</p>
                  ${copyField(`claude mcp add --scope user --transport http anywhere ${url}`, "Copy the command")}
                  <p>Then, in Claude Code, type <code>/mcp</code>, choose <strong>anywhere</strong> and <strong>Authenticate</strong>. Your browser opens this site: approve, and come back here.</p>
                  <p class="ob-more">Using Claude chat, ChatGPT or Codex too? <a href="/connect">See every app</a>.</p>`,
          )}
          ${step(
            2,
            "skill",
            "Add the skill",
            badge("optional", "Recommended"),
            html`<p>The skill teaches Claude Code and Codex when to use Anywhere, how to set up your projects and how to keep the plan current. It is two small files.</p>
              <p class="ob-label">Claude Code</p>
              ${copyField(`mkdir -p ~/.claude/skills && curl -fsSL ${skillUrl} | tar -xz -C ~/.claude/skills`, "Copy the command")}
              <p class="ob-label">Codex</p>
              ${copyField(`mkdir -p ~/.codex/skills && curl -fsSL ${skillUrl} | tar -xz -C ~/.codex/skills`, "Copy the command")}
              <p class="ob-more">Start a new session afterwards so it loads.</p>`,
          )}
          ${step(
            3,
            "setup",
            "Bring in your projects",
            projects.length ? badge("done", `${projects.length} project${projects.length === 1 ? "" : "s"}`) : badge("todo", "To do"),
            html`<p>Open Claude Code in any folder and say:</p>
              ${copyField("Set up Anywhere.", "Copy what to say")}
              <p>It asks first, then lists the projects on your computer, most recent first, from your Claude Code and Codex sessions and your git folders. It reads folder names and dates, not your conversations. You choose which to bring in, and it drafts each project's pages from its README, CLAUDE.md, AGENTS.md and plans, marked so you know what to check.</p>`,
          )}
          ${step(
            4,
            "resume",
            "Pick up anywhere",
            "",
            html`<p>Agents keep each project's plan current as they work. Out of usage on one account, or want a second opinion from another provider? Open the other agent and say:</p>
              ${copyField(`Pick up where we left off on ${first ? first.name : "the build"} in Anywhere.`, "Copy what to say")}
              <p>It reads the plan's Now and Next, the latest decisions and who changed what, and carries on.</p>`,
          )}
        </ol>

        <div class="ob-end">
          <a class="btn" href="/projects">${projects.length ? "Go to your projects" : "Go to projects"}</a>
          <a class="btn btn-quiet" href="/connect">Connect other apps</a>
        </div>
      </div>`,
    );
  });
}
