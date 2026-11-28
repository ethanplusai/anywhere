import type { Context } from "hono";
import { coarseIp, describeAgent, recordEvent, type EventKind, type RequestPlace } from "../auth/events.js";
import type { User } from "../auth/users.js";
import type { Deps } from "../deps.js";
import { clientIp } from "../http.js";
import type { Mail } from "../mail/mailer.js";
import { securityEmail } from "../mail/templates.js";

/** The browser and network a request came from, coarse enough to show the owner and no more. */
export function placeOf(c: Context, deps: Deps): RequestPlace {
  return { device: describeAgent(c.req.header("user-agent")), ip: coarseIp(clientIp(c, deps.config)) };
}

/** Sends an email without letting a provider failure undo or block what the person just did. */
export async function sendQuietly(deps: Deps, mail: Mail): Promise<boolean> {
  try {
    await deps.mailer.send(mail);
    return true;
  } catch (err) {
    console.error(`mail: could not send "${mail.tag}":`, (err as Error).message);
    return false;
  }
}

/** Which events are also emailed, and what the email says. */
const EMAILED: Partial<Record<EventKind, (detail: string, product: string) => { subject: string; heading: string; lines: string[] }>> = {
  signin: (d, n) => ({ subject: `New sign-in to ${n}`, heading: "New sign-in to your account", lines: [`Your account was signed in to${d ? ` with ${d}` : ""}.`] }),
  app_connected: (d, n) => ({
    subject: `${d || "An app"} was connected to ${n}`,
    heading: `${d || "An app"} can now use your account`,
    lines: [`${d || "An app"} was approved and can read, create, change and delete pages in all your projects.`],
  }),
  token_created: (d, n) => ({ subject: `New ${n} token: ${d}`, heading: "A personal access token was created", lines: [`A token named “${d}” was created. Anything that has it can read and write your projects.`] }),
  passkey_added: (d, n) => ({ subject: `Passkey added to ${n}`, heading: "A passkey was added", lines: [`A passkey (“${d}”) can now sign in to your account.`] }),
  passkey_removed: (d, n) => ({ subject: `Passkey removed from ${n}`, heading: "A passkey was removed", lines: [`The passkey “${d}” can no longer sign in to your account.`] }),
  github_linked: (d, n) => ({ subject: `GitHub linked to ${n}`, heading: "GitHub was linked", lines: [`The GitHub account ${d} can now sign in to your account.`] }),
  github_unlinked: (_d, n) => ({ subject: `GitHub unlinked from ${n}`, heading: "GitHub was unlinked", lines: ["GitHub can no longer sign in to your account."] }),
  email_changed: (d, n) => ({ subject: `Your ${n} email was changed`, heading: "Your email was changed", lines: [`Your account now uses ${d}. Sign-in codes and notices go there from now on.`] }),
};

/**
 * Records what happened on the account and, for the changes that matter, emails the owner with
 * where it came from. `to` overrides the address (an email change notifies the old one).
 */
export async function notify(deps: Deps, c: Context, user: User, kind: EventKind, detail = "", opts: { email?: boolean; to?: string } = {}): Promise<void> {
  const place = placeOf(c, deps);
  await recordEvent(deps.db, user.id, kind, detail, place);
  const template = EMAILED[kind];
  if (!template || opts.email === false || deps.local) return;
  const t = template(detail, deps.brand.productName);
  await sendQuietly(deps, securityEmail(deps.brand, opts.to ?? user.email, t.subject, t.heading, t.lines, { when: new Date(), ...place }, `notice-${kind}`));
}
