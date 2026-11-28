import { isIP } from "node:net";
import type { Db } from "../db/db.js";
import { newId } from "./crypto.js";

/**
 * What happened to an account, kept for its owner: the security page lists it, and the ones that
 * matter are also emailed. Each row records a coarse place (browser and network, never a full
 * address) so the owner can tell their own actions from someone else's.
 */
export type EventKind =
  | "signin"
  | "account_created"
  | "app_connected"
  | "app_disconnected"
  | "token_created"
  | "token_revoked"
  | "passkey_added"
  | "passkey_removed"
  | "github_linked"
  | "github_unlinked"
  | "email_changed"
  | "signed_out_everywhere"
  | "session_ended"
  | "export";

export interface RequestPlace {
  device: string;
  ip: string;
}

export interface SecurityEvent {
  id: string;
  kind: EventKind;
  detail: string;
  device: string;
  ip: string;
  createdAt: Date;
}

/** "Chrome on macOS" from a User-Agent header: enough to recognise a browser, not to track one. */
export function describeAgent(ua: string | undefined): string {
  if (!ua) return "";
  const os = /iPhone|iPad/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\/|CriOS\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "";
  if (!browser && !os) return "Unknown browser";
  return browser && os ? `${browser} on ${os}` : browser || os;
}

/** An address with its last part hidden: 203.0.113.x, or the first three groups of an IPv6 address. */
export function coarseIp(address: string): string {
  const a = address.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.)/, "");
  if (isIP(a) === 4) return a.replace(/\.\d+$/, ".x");
  if (isIP(a) === 6) return `${a.split(":").slice(0, 3).join(":")}::`;
  return "";
}

export async function recordEvent(db: Db, userId: string, kind: EventKind, detail: string, place: RequestPlace): Promise<void> {
  await db.query("INSERT INTO security_events (id, user_id, kind, detail, device, ip) VALUES ($1, $2, $3, $4, $5, $6)", [
    newId(),
    userId,
    kind,
    detail.slice(0, 200),
    place.device.slice(0, 120),
    place.ip.slice(0, 64),
  ]);
}

export async function listEvents(db: Db, userId: string, limit = 50): Promise<SecurityEvent[]> {
  const rows = await db.query<{ id: string; kind: EventKind; detail: string; device: string; ip: string; created_at: Date }>(
    "SELECT id, kind, detail, device, ip, created_at FROM security_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
    [userId, limit],
  );
  return rows.map((r) => ({ id: r.id, kind: r.kind, detail: r.detail, device: r.device, ip: r.ip, createdAt: r.created_at }));
}

/** How each event reads on the security page. */
export function eventLabel(e: Pick<SecurityEvent, "kind" | "detail">): string {
  const d = e.detail;
  switch (e.kind) {
    case "signin":
      return `Signed in${d ? ` with ${d}` : ""}`;
    case "account_created":
      return "Account created";
    case "app_connected":
      return `Connected ${d || "an app"}`;
    case "app_disconnected":
      return `Disconnected ${d || "an app"}`;
    case "token_created":
      return `Created token “${d}”`;
    case "token_revoked":
      return `Revoked token${d ? ` “${d}”` : ""}`;
    case "passkey_added":
      return `Added passkey “${d}”`;
    case "passkey_removed":
      return `Removed passkey${d ? ` “${d}”` : ""}`;
    case "github_linked":
      return `Linked GitHub${d ? ` (${d})` : ""}`;
    case "github_unlinked":
      return "Unlinked GitHub";
    case "email_changed":
      return `Changed email${d ? ` to ${d}` : ""}`;
    case "signed_out_everywhere":
      return "Signed out everywhere";
    case "session_ended":
      return `Signed out a browser${d ? ` (${d})` : ""}`;
    case "export":
      return "Downloaded all projects";
  }
}
