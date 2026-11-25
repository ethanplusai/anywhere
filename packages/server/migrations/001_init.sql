-- Anywhere v1 schema.

CREATE TABLE users (
  id            text PRIMARY KEY,
  email         text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE web_sessions (
  id_hash    text PRIMARY KEY,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE personal_access_tokens (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

CREATE TABLE projects (
  id          text PRIMARY KEY,
  user_id     text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug        text NOT NULL,
  name        text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

-- One row per path, ever. A deleted page keeps its row as a tombstone
-- (deleted_at set, content empty) so versions never restart.
CREATE TABLE pages (
  id          text PRIMARY KEY,
  project_id  text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path        text NOT NULL,
  content     bytea NOT NULL,
  search_text text NOT NULL,
  search      tsvector NOT NULL,
  version     integer NOT NULL,
  sha256      text NOT NULL,
  size        integer NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz,
  UNIQUE (project_id, path)
);
CREATE INDEX pages_search ON pages USING gin (search);

-- Every version of every page, including deletes (deleted = true, content null).
CREATE TABLE revisions (
  page_id    text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  version    integer NOT NULL,
  content    bytea,
  sha256     text,
  size       integer,
  deleted    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, version)
);

CREATE TABLE oauth_clients (
  client_id                  text PRIMARY KEY,
  kind                       text NOT NULL, -- 'dcr' or 'cimd'
  client_name                text,
  client_uri                 text,
  redirect_uris              jsonb NOT NULL,
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  client_secret_hash         text,
  metadata                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  fetched_at                 timestamptz
);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL,
  user_id        text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri   text NOT NULL,
  redirect_uri_supplied boolean NOT NULL DEFAULT true,
  code_challenge text NOT NULL,
  family_id      text NOT NULL,
  resource       text,
  scope          text,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

CREATE TABLE oauth_access_tokens (
  token_hash text PRIMARY KEY,
  client_id  text NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  text NOT NULL,
  resource   text,
  scope      text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX oauth_access_tokens_family ON oauth_access_tokens (family_id);

CREATE TABLE oauth_refresh_tokens (
  token_hash text PRIMARY KEY,
  client_id  text NOT NULL,
  user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id  text NOT NULL,
  resource   text,
  scope      text,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  revoked_at timestamptz
);
CREATE INDEX oauth_refresh_tokens_family ON oauth_refresh_tokens (family_id);
