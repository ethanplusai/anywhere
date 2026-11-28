import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { RUNTIME } from "../src/mcp/panels.js";

/*
 * The panel's side of MCP Apps (2026-01-26), run against a stand-in for the chat app that frames
 * it: what it posts when the person presses a button, and what it does when the app says no.
 */

type Msg = { jsonrpc: "2.0"; id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

/** Loads the runtime with a fake parent window. `answer` replies to each request the panel makes. */
function panel(answer: (m: Msg) => { result?: unknown; error?: unknown }) {
  const sent: Msg[] = [];
  const listeners: ((e: { source: unknown; data: unknown }) => void)[] = [];
  const parent = {
    postMessage(m: Msg) {
      sent.push(m);
      if (m.id === undefined) return;
      const reply = answer(m);
      queueMicrotask(() => listeners.forEach((l) => l({ source: parent, data: { jsonrpc: "2.0", id: m.id, ...reply } })));
    },
  };
  const window = { parent, addEventListener: (_: string, l: (e: { source: unknown; data: unknown }) => void) => listeners.push(l), matchMedia: () => ({ matches: false }) };
  const ctx: Record<string, unknown> = { window, document: { documentElement: { setAttribute() {}, getBoundingClientRect: () => ({ width: 0, height: 0 }) } }, Promise, Error };
  runInNewContext(`${RUNTIME}; this.say = say; this.remember = remember; this.start = start;`, ctx);
  return {
    sent,
    listeners,
    say: ctx.say as (t: string) => Promise<unknown>,
    remember: ctx.remember as (t: string) => Promise<boolean>,
    start: ctx.start as (r: () => void) => void,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("the panel talking to the chat app", () => {
  it("posts the person's message as a list of content blocks, the shape the spec requires", async () => {
    const p = panel(() => ({ result: {} }));
    await p.say("Set up Anywhere with this map of my work.");
    const msg = p.sent.find((m) => m.method === "ui/message")!;
    expect(msg.params).toEqual({ role: "user", content: [{ type: "text", text: "Set up Anywhere with this map of my work." }] });
  });

  it("treats an isError answer as not delivered", async () => {
    const p = panel(() => ({ result: { isError: true } }));
    await expect(p.say("hello")).rejects.toThrow();
  });

  it("hands the words to the agent as context when the app supports that, and only then", async () => {
    const withContext = panel((m) => (m.method === "ui/initialize" ? { result: { hostCapabilities: { updateModelContext: { text: {} } } } } : { result: {} }));
    withContext.start(() => {});
    await tick();
    await tick();
    expect(await withContext.remember("Bring in fully: Acme")).toBe(true);
    expect(withContext.sent.find((m) => m.method === "ui/update-model-context")!.params).toEqual({ content: [{ type: "text", text: "Bring in fully: Acme" }] });

    const without = panel((m) => (m.method === "ui/initialize" ? { result: { hostCapabilities: {} } } : { result: {} }));
    without.start(() => {});
    await tick();
    await tick();
    expect(await without.remember("Bring in fully: Acme")).toBe(false);
    expect(without.sent.some((m) => m.method === "ui/update-model-context")).toBe(false);
  });

  it("ignores messages that do not come from the app framing it", async () => {
    let seen = 0;
    const p = panel(() => ({ result: {} }));
    p.start(() => { seen++; });
    p.listeners.forEach((l) => l({ source: {}, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: { kind: "board" } } } }));
    expect(seen).toBe(0);
  });
});
