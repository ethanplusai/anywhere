-- The early-access list. While ANYWHERE_SIGNUPS is "approved", only these emails can create an
-- account. Emails are stored trimmed and lower-cased. Sign-in is not affected.
CREATE TABLE early_access (
  email       text PRIMARY KEY,
  approved_at timestamptz NOT NULL DEFAULT now(),
  approved_by text NOT NULL DEFAULT ''
);
