-- One row per OAuth grant (a token family: one connected app), so it can be listed, revoked, and
-- given an absolute lifetime however often it refreshes (audit A3).
CREATE TABLE oauth_grants (
  family_id    text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id    text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at   timestamptz
);
CREATE INDEX oauth_grants_user ON oauth_grants (user_id);

INSERT INTO oauth_grants (family_id, user_id, client_id, expires_at, last_used_at)
SELECT family_id, min(user_id), min(client_id), now() + interval '90 days', now()
  FROM oauth_refresh_tokens WHERE revoked_at IS NULL GROUP BY family_id;

-- Sliding idle timeout for web sessions (audit A12).
ALTER TABLE web_sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX web_sessions_user ON web_sessions (user_id);
