export const VERSION = "0.1.0-dev";
export const PROJECT_URL = "https://github.com/cdalamagkas/tagmonia";
/**
 * MusicBrainz requires `AppName/version ( contact )` on every request, where the
 * contact is a URL or email (§9.3, CLAUDE.md safety rule 4). The project URL is the contact.
 */
export const USER_AGENT = `Tagmonia/${VERSION} ( ${PROJECT_URL} )`;
