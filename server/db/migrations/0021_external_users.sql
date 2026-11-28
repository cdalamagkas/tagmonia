-- Users who sign in through an identity provider (D69): matched by issuer and subject, never by name, so an
-- IdP account called "admin" cannot become the local admin. They have no password ("!" verifies nothing).
ALTER TABLE app_user ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX app_user_external ON app_user(external_id) WHERE external_id IS NOT NULL;
