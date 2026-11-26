import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeSecrets, findSecrets } from "../src/service/secrets.js";
import { BASE, makeTestApp, type TestApp } from "./helpers.js";

/*
 * Anywhere refuses to store keys, tokens and passwords. The values below are made up and only have
 * the shape of a real credential; they are built from parts so no scanner mistakes this file for
 * one that leaks.
 */
const r = (n: number, c = "a1B2") => c.repeat(Math.ceil(n / c.length)).slice(0, n);
const SAMPLES: [string, string][] = [
  ["Anthropic API key", `sk-ant-api03-${r(40)}`],
  ["OpenAI API key", `sk-proj-${r(48)}`],
  ["Stripe secret key", `sk_live_${r(24)}`],
  ["GitHub token", `ghp_${r(36)}`],
  ["GitHub token", `github_pat_${r(60)}`],
  ["AWS access key", `AKIA${"ABCDEFGHIJKLMNOP"}`],
  ["Google API key", `AIza${r(35)}`],
  ["Slack token", `xoxb-${r(30)}`],
  ["npm token", `npm_${r(36)}`],
  ["Supabase secret key", `sb_secret_${r(32)}`],
  ["Resend API key", `re_${r(10)}_${r(24)}`],
  ["private key", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"],
  ["JSON web token", `eyJ${r(20)}.eyJ${r(30)}.${r(30)}`],
  ["bearer token", `Authorization: Bearer ${r(40)}`],
  ["password in a URL", "postgres://admin:hunter2pass@db.example.com:5432/app"],
  ["secret assignment", `STRIPE_SECRET_KEY=${r(30, "x9Z")}`],
  ["secret assignment", `- DATABASE_PASSWORD: "${r(20, "p4$s")}"`],
];

describe("findSecrets", () => {
  it("finds each kind of credential and the line it is on", () => {
    for (const [kind, value] of SAMPLES) {
      const found = findSecrets(`# Where it lives\n\nSome notes.\n${value}\n`);
      expect(found[0], kind).toEqual({ kind, line: 4 });
    }
  });

  it("leaves ordinary project writing alone, including words about secrets", () => {
    const page = [
      "# Where it lives",
      "- The Stripe key is in Vercel environment variables as STRIPE_SECRET_KEY.",
      "- STRIPE_SECRET_KEY=<from the Stripe dashboard>",
      "- API_KEY=${API_KEY}",
      "- OPENAI_API_KEY=your-key-here",
      "- RESEND_API_KEY: set in Vercel",
      "- TOKEN_TTL=3600",
      "- PASSWORD_RESET_URL=https://example.com/reset",
      "- Commit 3f9a2c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39 fixed sign-in.",
      "- Project id prj_abc123, deployed from github.com/acme/rocket.",
      "- Visit https://app.example.com/login and use the magic link.",
      "- sk-ant- keys are rotated every 90 days.",
    ].join("\n");
    expect(findSecrets(page)).toEqual([]);
  });

  it("describes what it found without the value", () => {
    const value = SAMPLES[0]![1];
    const text = describeSecrets(findSecrets(`a\n${value}\n${SAMPLES[6]![1]}`));
    expect(text).toBe("an Anthropic API key on line 2, a Google API key on line 3");
    expect(text).not.toContain(value);
  });
});

describe("saving a secret is refused", () => {
  let t: TestApp;
  let client: Client;
  const KEY = SAMPLES[0]![1];

  beforeEach(async () => {
    t = await makeTestApp();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
        fetch: (url, init) => t.fetch(String(url), init),
        requestInit: { headers: { authorization: `Bearer ${t.token}` } },
      }),
    );
    await t.api("POST", "/projects", { name: "Rocket" });
  });
  afterEach(async () => {
    await client.close();
    await t.close();
  });

  it("over the API, for pages, appends and project details, and stores nothing", async () => {
    const put = await t.api("PUT", "/projects/rocket/pages/topics/keys.md", { content: `# Keys\n\n${KEY}\n`, baseVersion: 0 });
    expect(put.status).toBe(422);
    const body = (await put.json()) as { error: { code: string; message: string; secrets: unknown } };
    expect(body.error.code).toBe("contains_secret");
    expect(body.error.message).toContain("an Anthropic API key on line 3");
    expect(body.error.message).not.toContain(KEY);
    expect((await t.api("GET", "/projects/rocket/pages/topics/keys.md")).status).toBe(404);

    expect((await t.api("POST", "/projects/rocket/pages/log.md/append", { content: `- 2026-11-26 used ${KEY}\n` })).status).toBe(422);
    expect((await t.api("PATCH", "/projects/rocket", { description: `Uses ${KEY}` })).status).toBe(422);
    expect((await t.api("POST", "/projects", { name: "Other", description: `Key ${KEY}` })).status).toBe(422);
  });

  it("over MCP, with a message that says what to do instead", async () => {
    const res = (await client.callTool({
      name: "write_page",
      arguments: { project: "rocket", path: "where.md", content: `# Where it lives\n\nSTRIPE_SECRET_KEY=${r(30, "x9Z")}\n` },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(res.isError).toBe(true);
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).toContain("contains_secret");
    expect(text).toContain("say where it is kept instead");
    expect(text).not.toContain(r(30, "x9Z"));
  });
});
