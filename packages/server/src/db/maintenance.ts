import type { Db } from "./db.js";

/**
 * Deletes what has expired: sessions, authorization codes, tokens, grants, rate-limit windows,
 * metadata-fetch failures, and dynamically registered clients that never got a code or token within
 * a day (audit A6, A12). Safe to run at any time and from several instances. A hosted deployment
 * should call it on a schedule (for example a daily cron); requests also run it now and then.
 */
export async function purgeExpired(db: Db): Promise<Record<string, number>> {
  const steps: [string, string, unknown[]][] = [
    ["web_sessions", "DELETE FROM web_sessions WHERE expires_at < now() OR last_seen_at < now() - interval '30 days'", []],
    ["oauth_codes", "DELETE FROM oauth_codes WHERE expires_at < now() - interval '1 day'", []],
    ["oauth_access_tokens", "DELETE FROM oauth_access_tokens WHERE expires_at < now() - interval '1 day'", []],
    // Spent refresh tokens are kept while their grant lives, for reuse detection.
    [
      "oauth_refresh_tokens",
      `DELETE FROM oauth_refresh_tokens r WHERE r.expires_at < now() - interval '1 day'
          OR NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.family_id = r.family_id AND g.revoked_at IS NULL AND g.expires_at > now() - interval '1 day')`,
      [],
    ],
    ["oauth_grants", "DELETE FROM oauth_grants WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'", []],
    ["personal_access_tokens", "DELETE FROM personal_access_tokens WHERE revoked_at < now() - interval '30 days' OR expires_at < now() - interval '30 days'", []],
    ["rate_limits", "DELETE FROM rate_limits WHERE window_start < $1", [Date.now() - 2 * 24 * 3600 * 1000]],
    ["email_challenges", "DELETE FROM email_challenges WHERE expires_at < now() - interval '1 day'", []],
    ["webauthn_challenges", "DELETE FROM webauthn_challenges WHERE expires_at < now()", []],
    // A year of account activity is enough to spot anything odd.
    ["security_events", "DELETE FROM security_events WHERE created_at < now() - interval '365 days'", []],
    ["cimd_failures", "DELETE FROM cimd_failures WHERE until < now()", []],
    [
      "oauth_clients",
      `DELETE FROM oauth_clients c WHERE c.kind = 'dcr' AND c.created_at < now() - interval '1 day'
          AND NOT EXISTS (SELECT 1 FROM oauth_codes x WHERE x.client_id = c.client_id)
          AND NOT EXISTS (SELECT 1 FROM oauth_grants x WHERE x.client_id = c.client_id)
          AND NOT EXISTS (SELECT 1 FROM oauth_refresh_tokens x WHERE x.client_id = c.client_id)`,
      [],
    ],
  ];
  const counts: Record<string, number> = {};
  for (const [name, sql, params] of steps) {
    const rows = await db.query(`WITH d AS (${sql} RETURNING 1) SELECT count(*)::int AS n FROM d`, params);
    counts[name] = Number((rows[0] as { n: number } | undefined)?.n ?? 0);
  }
  return counts;
}
