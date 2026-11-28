-- Passwordless accounts: people sign in with a code or link sent to their email, with GitHub, or
-- with a passkey. Passwords are gone; existing accounts sign in by email from now on.

ALTER TABLE users DROP COLUMN password_hash;
-- Set when the person proves they receive mail at this address. Every account created from now on
-- is verified by the code that creates it.
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
ALTER TABLE users ADD COLUMN github_id bigint;
ALTER TABLE users ADD COLUMN github_login text;
CREATE UNIQUE INDEX users_github_id ON users (github_id) WHERE github_id IS NOT NULL;

-- One email sign-in in progress: a six-digit code for the browser that asked, and a link that works
-- on any device. Both are stored hashed. `browser_hash` ties the code to the browser that asked, so a
-- code is useless without that browser; the link is a separate one-time secret.
CREATE TABLE email_challenges (
  id           text PRIMARY KEY,
  purpose      text NOT NULL,             -- 'signin', 'reauth' or 'change_email'
  email        text NOT NULL,             -- lower-cased
  user_id      text REFERENCES users(id) ON DELETE CASCADE,
  browser_hash text NOT NULL,
  code_hash    text NOT NULL,
  link_hash    text NOT NULL UNIQUE,
  next         text NOT NULL DEFAULT '/projects',
  attempts     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz
);
CREATE INDEX email_challenges_browser ON email_challenges (browser_hash);

-- Passkeys (WebAuthn credentials). The public key is what the authenticator gave at registration.
CREATE TABLE passkeys (
  id            text PRIMARY KEY,            -- the credential id, base64url
  user_id       text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key    bytea NOT NULL,
  counter       bigint NOT NULL DEFAULT 0,
  transports    jsonb NOT NULL DEFAULT '[]'::jsonb,
  name          text NOT NULL,
  backed_up     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz
);
CREATE INDEX passkeys_user ON passkeys (user_id);

-- A WebAuthn ceremony in progress, tied to the browser that started it.
CREATE TABLE webauthn_challenges (
  id           text PRIMARY KEY,
  browser_hash text NOT NULL,
  purpose      text NOT NULL,                -- 'register', 'signin' or 'reauth'
  user_id      text REFERENCES users(id) ON DELETE CASCADE,
  challenge    text NOT NULL,
  next         text NOT NULL DEFAULT '/projects',
  expires_at   timestamptz NOT NULL
);

-- What each signed-in browser is, so the security page can list them, and when it last proved who
-- it is (destructive actions need that to be recent).
ALTER TABLE web_sessions ADD COLUMN method text NOT NULL DEFAULT 'email';
ALTER TABLE web_sessions ADD COLUMN device text NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN ip text NOT NULL DEFAULT '';
ALTER TABLE web_sessions ADD COLUMN public_id text;
ALTER TABLE web_sessions ADD COLUMN reauth_at timestamptz NOT NULL DEFAULT now();
UPDATE web_sessions SET public_id = substr(id_hash, 1, 16) WHERE public_id IS NULL;
ALTER TABLE web_sessions ALTER COLUMN public_id SET NOT NULL;
CREATE UNIQUE INDEX web_sessions_public_id ON web_sessions (public_id);

-- What happened to an account, for its owner: sign-ins, new apps, tokens, passkeys, email changes.
CREATE TABLE security_events (
  id         text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  detail     text NOT NULL DEFAULT '',
  device     text NOT NULL DEFAULT '',
  ip         text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user ON security_events (user_id, created_at DESC);
