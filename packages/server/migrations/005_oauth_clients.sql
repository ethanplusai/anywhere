-- Failed Client ID Metadata Document fetches, cached per host so the server cannot be used to hammer
-- one (audit A5).
CREATE TABLE cimd_failures (
  host  text PRIMARY KEY,
  until timestamptz NOT NULL
);
CREATE INDEX oauth_clients_dcr_created ON oauth_clients (created_at) WHERE kind = 'dcr';
CREATE INDEX oauth_codes_client ON oauth_codes (client_id);
CREATE INDEX oauth_refresh_tokens_client ON oauth_refresh_tokens (client_id);
