-- Rate limit counters shared by every server instance (audit A2). One row per key per window;
-- window_start is epoch milliseconds. Keys are hashed.
CREATE TABLE rate_limits (
  key          text NOT NULL,
  window_start bigint NOT NULL,
  count        integer NOT NULL,
  PRIMARY KEY (key, window_start)
);
CREATE INDEX rate_limits_window ON rate_limits (window_start);

-- Bearer lookups select first and touch last_used_at at most once a minute (audit A14).
-- Personal access tokens may now expire (audit A3).
ALTER TABLE personal_access_tokens ADD COLUMN expires_at timestamptz;
