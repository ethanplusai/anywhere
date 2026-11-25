// Seeds a demo account in an embedded database so every view of the web app can be clicked through:
// three projects written by several agents over two weeks, history, a token and connected apps.
//
//   pnpm build && node scripts/demo.mjs [data-dir]
//   ANYWHERE_PGLITE_DIR=<data-dir> ANYWHERE_ALLOW_EMBEDDED_DB=1 PORT=3341 node dist/main.js
//
// The sign-in details are written to <data-dir>/credentials.txt. Never point this at a real database.
/* global URL, process, console */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadLayout, migrate, pgliteDb } from "../dist/index.js";
import { createService } from "../dist/service/projects.js";
import { createUser } from "../dist/auth/users.js";
import { createPat } from "../dist/auth/tokens.js";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const dir = resolve(process.argv[2] ?? join(here, "../.demo"));
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const db = await pgliteDb(dir);
await migrate(db, join(here, "../migrations/"));
const layout = loadLayout();
const service = createService(db, layout);

const email = "demo@anywhere.test";
const password = `demo-${randomBytes(9).toString("base64url")}`;
const user = await createUser(db, email, password);
const id = user.id;

const CLAUDE = "app:Claude";
const CHATGPT = "app:ChatGPT";
const CODE = "app:Claude Code";
const CODEX = "app:Codex";
const CLI = "token:Work laptop";
const WEB = "web";

/** Every write is stamped this many hours ago, oldest first, so the history reads like real use. */
async function at(hoursAgo, fn) {
  await fn();
  await db.query(
    `UPDATE revisions SET created_at = now() - make_interval(hours => $1)
      WHERE created_at > now() - interval '1 minute'`,
    [hoursAgo],
  );
  await db.query(`UPDATE pages SET updated_at = now() - make_interval(hours => $1) WHERE updated_at > now() - interval '1 minute'`, [hoursAgo]);
  await db.query(`UPDATE projects SET updated_at = now() - make_interval(hours => $1) WHERE updated_at > now() - interval '1 minute'`, [hoursAgo]);
}

async function write(slug, path, content, actor) {
  let base;
  try {
    base = (await service.getPage(id, slug, path)).version;
  } catch {
    base = 0;
  }
  await service.putPage(id, slug, path, content, base, actor);
}
async function append(slug, path, content, actor) {
  await service.appendPage(id, slug, path, content, actor);
}

// ---------- Acme rebrand: a client project, mostly chat ----------

await at(330, () => service.createProject(id, { name: "Acme rebrand", description: "New identity and website for Acme Outdoor, launching 3 March." }, CLAUDE));
await at(329, () =>
  write("acme-rebrand", "overview.md", `# Acme rebrand

New visual identity and marketing site for Acme Outdoor, a 40-person maker of camping gear sold direct and through REI.

## Who it is for
Acme's buyers are 28 to 45, plan trips months ahead and care about repairability. The current brand reads as discount.

## Goals
- A mark and wordmark that work stitched on fabric at 2 cm.
- A site that sells the repair programme, not just products.
- Launch on 3 March, before the spring catalogue.

## Current state
Logo direction chosen (the ridge line). Typeface chosen. Site design in progress; copy not started.

## People
- Dana Reyes, marketing lead at Acme, signs off everything.
- Priya, the photographer, shoots in January.
`, CLAUDE));
await at(328, () =>
  write("acme-rebrand", "decisions.md", `# Decisions

- 2026-11-10: Logo direction is the ridge line, not the compass. Dana said the compass looked like every other outdoor brand.
- 2026-11-08: One typeface family only, to keep the embroidery files simple.
`, CLAUDE));
await at(300, () =>
  write("acme-rebrand", "open-questions.md", `# Open questions

- Which typeface? Shortlist: Söhne, Founders Grotesk, Inter Display.
- Does the repair programme get its own page or a section on every product?
- Who writes the product copy, Acme or us?
`, CHATGPT));
await at(290, () =>
  write("acme-rebrand", "ideas.md", `# Ideas

- A "repair counter" on the homepage showing how many items Acme fixed this year.
- Stitch-pattern dividers between sections, taken from their actual tent seams.
- Let customers upload photos of 10-year-old Acme gear.
`, CHATGPT));
await at(200, () =>
  write("acme-rebrand", "decisions.md", `# Decisions

- 2026-11-15: Typeface is Founders Grotesk. It holds up embroidered at small sizes; Söhne's apertures closed up in the stitch test.
- 2026-11-10: Logo direction is the ridge line, not the compass. Dana said the compass looked like every other outdoor brand.
- 2026-11-08: One typeface family only, to keep the embroidery files simple.
`, CLAUDE));
await at(199, () =>
  write("acme-rebrand", "open-questions.md", `# Open questions

- Does the repair programme get its own page or a section on every product?
- Who writes the product copy, Acme or us?
`, CLAUDE));
await at(120, () =>
  write("acme-rebrand", "topics/brand-voice.md", `# Brand voice

Plain, warm, a little dry. Talks like the person at the repair counter, not like an ad.

## Do
- Say what the thing is made of and how long it lasts.
- Use numbers: "fixed 4,212 tents this year".

## Don't
- "Adventure awaits", "epic", "conquer".
- Exclamation marks.
`, CHATGPT));
await at(118, () => append("acme-rebrand", "log.md", "\n- 2026-11-18 (ChatGPT): Drafted the brand voice page from Dana's call notes.\n", CHATGPT));
await at(50, () =>
  write("acme-rebrand", "decisions.md", `# Decisions

- 2026-11-21: The repair programme gets its own page, linked from every product. Dana wants it to be a reason to buy.
- 2026-11-15: Typeface is Founders Grotesk. It holds up embroidered at small sizes; Söhne's apertures closed up in the stitch test.
- 2026-11-10: Logo direction is the ridge line, not the compass. Dana said the compass looked like every other outdoor brand.
- 2026-11-08: One typeface family only, to keep the embroidery files simple.
`, CLAUDE));
await at(49, () =>
  write("acme-rebrand", "open-questions.md", `# Open questions

- Who writes the product copy, Acme or us? Waiting on Dana's budget answer.
`, CLAUDE));
await at(48, () => append("acme-rebrand", "log.md", "\n- 2026-11-21 (Claude): Call with Dana. Repair page settled; product copy still open.\n", CLAUDE));
await at(3, () =>
  write("acme-rebrand", "ideas.md", `# Ideas

- A "repair counter" on the homepage showing how many items Acme fixed this year.
- Stitch-pattern dividers between sections, taken from their actual tent seams.
- Let customers upload photos of 10-year-old Acme gear.
- [ ] Ask Priya to shoot the repair bench as well as the products.
`, WEB));

// ---------- Fieldnotes app: a code project, Claude Code and Codex ----------

await at(260, () => service.createProject(id, { name: "Fieldnotes app", description: "iOS app for logging bird sightings offline. SwiftUI, SQLite, sync later." }, CODE));
await at(259, () =>
  write("fieldnotes-app", "overview.md", `# Fieldnotes app

An iOS app for logging bird sightings in places with no signal. Built in SwiftUI with a local SQLite store.

## Goals
- Log a sighting in under five seconds, one-handed.
- Work fully offline; sync is a later release.
- TestFlight build for the Audubon chapter by 15 December.

## Stack
SwiftUI, GRDB for SQLite, no third-party analytics.

## Current state
Logging and the species list work. Photo attachments in progress.
`, CODE));
await at(258, () =>
  write("fieldnotes-app", "decisions.md", `# Decisions

- 2026-11-12: GRDB, not SwiftData. SwiftData migrations were unreliable in the spike and we need to ship schema changes safely.
- 2026-11-12: No accounts in the first version. Everything stays on the device.
`, CODE));
await at(150, () =>
  write("fieldnotes-app", "open-questions.md", `# Open questions

- Store photos in the database or as files with a path? Leaning files.
- Which species list: eBird taxonomy or the chapter's own list?
`, CODEX));
await at(149, () => append("fieldnotes-app", "log.md", "\n- 2026-11-17 (Codex): Added the species search with prefix matching. 9 ms on 11k species.\n", CODEX));
await at(100, () =>
  write("fieldnotes-app", "decisions.md", `# Decisions

- 2026-11-19: Photos are files in Application Support, with a path in the database. Keeps the database small enough to back up.
- 2026-11-12: GRDB, not SwiftData. SwiftData migrations were unreliable in the spike and we need to ship schema changes safely.
- 2026-11-12: No accounts in the first version. Everything stays on the device.
`, CODE));
await at(99, () =>
  write("fieldnotes-app", "open-questions.md", `# Open questions

- Which species list: eBird taxonomy or the chapter's own list?
`, CODE));
await at(98, () => append("fieldnotes-app", "log.md", "- 2026-11-19 (Claude Code): Photo storage done. Migration v3 adds the photos table.\n", CODE));
await at(30, () =>
  write("fieldnotes-app", "topics/sync.md", `# Sync (later)

Not in the first release. Notes so we don't lose them:

- CloudKit private database is the default choice: no server, free for users.
- Conflicts: last writer wins per sighting is fine; sightings are rarely edited.
- Photos would need CKAsset; check the 50 MB limit.
`, CLAUDE));
await at(6, () => append("fieldnotes-app", "log.md", "- 2026-11-23 (Codex): One-handed logging flow done; 3.8 s median in testing.\n", CLI));

// ---------- Kitchen renovation: a personal, non-code project ----------

await at(80, () => service.createProject(id, { name: "Kitchen renovation", description: "Budget, contractors and choices for the kitchen, spring 2027." }, CHATGPT));
await at(79, () =>
  write("kitchen-renovation", "overview.md", `# Kitchen renovation

Redo the kitchen in spring 2027. Keep the layout, replace cabinets, counters and the floor.

## Budget
$38,000 all in, with 10% held back for surprises.

## Current state
Two contractor quotes in, waiting on a third. Cabinets: leaning toward painted shaker.
`, CHATGPT));
await at(78, () =>
  write("kitchen-renovation", "open-questions.md", `# Open questions

- Quartz or butcher block for the island?
- Do we move the dishwasher to the left of the sink? Needs the plumber's view.
- Third quote from Hollis & Sons: due by 30 November.
`, CHATGPT));
await at(20, () =>
  write("kitchen-renovation", "decisions.md", `# Decisions

- 2026-11-22: Floor is oak engineered plank, not tile. Warmer underfoot and the quote was $1,900 less.
`, CLAUDE));

// ---------- a token and two connected apps ----------

await createPat(db, id, "Work laptop", 90);
await db.query("UPDATE personal_access_tokens SET last_used_at = now() - interval '6 hours'");
const apps = [
  ["demo-claude", "Claude", "https://claude.ai/api/mcp/auth_callback", 330, 1],
  ["demo-chatgpt", "ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect", 300, 20],
  ["demo-code", "Claude Code", "http://localhost:51234/callback", 260, 30],
  ["demo-codex", "Codex", "http://127.0.0.1:1455/callback", 150, 6],
];
for (const [clientId, name, redirect, ageH, usedH] of apps) {
  await db.query("INSERT INTO oauth_clients (client_id, kind, client_name, redirect_uris) VALUES ($1, 'dcr', $2, $3)", [clientId, name, JSON.stringify([redirect])]);
  await db.query(
    `INSERT INTO oauth_grants (family_id, user_id, client_id, created_at, expires_at, last_used_at)
     VALUES ($1, $2, $3, now() - make_interval(hours => $4), now() - make_interval(hours => $4) + interval '90 days', now() - make_interval(hours => $5))`,
    [`fam-${clientId}`, id, clientId, ageH, usedH],
  );
}

writeFileSync(join(dir, "credentials.txt"), `Demo account for the local Anywhere server\nemail: ${email}\npassword: ${password}\n`, { mode: 0o600 });
await db.close?.();
console.log(`Seeded ${dir}. Sign-in details are in ${join(dir, "credentials.txt")}.`);
