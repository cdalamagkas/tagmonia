-- Phase 4: credentials managed in the UI, encrypted at rest (ARCHITECTURE.md §14.3, D46),
-- and each provider's last health check.

CREATE TABLE credential (
  provider   TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  value      TEXT    NOT NULL,              -- "v1.<iv>.<ciphertext>" (server/secrets/vault.ts); never plaintext
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (provider, name)
);

CREATE TABLE provider_status (
  provider   TEXT    PRIMARY KEY,
  ok         INTEGER NOT NULL,
  message    TEXT    NOT NULL,              -- never contains a credential
  checked_at INTEGER NOT NULL
);
