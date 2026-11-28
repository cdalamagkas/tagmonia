/**
 * The running version (D74): a release image has it in /app/VERSION, written from the release tag at build time;
 * anywhere else (development, tests, CI builds) it is the development version.
 */
const DEV_VERSION = "0.1.0-dev";

/** A version as tags write it ("1.2.0", "1.2.0-rc.1"); anything else is ignored. */
export function parseVersion(text: string | null | undefined): string | null {
  const v = text?.trim().replace(/^v/, "");
  return v && /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v) ? v : null;
}

function releaseVersion(): string | null {
  try {
    return parseVersion(Deno.readTextFileSync(new URL("../VERSION", import.meta.url)));
  } catch {
    return null; // no file: not a release build
  }
}

export const VERSION = releaseVersion() ?? DEV_VERSION;
export const PROJECT_URL = "https://github.com/cdalamagkas/tagmonia";
/**
 * MusicBrainz requires `AppName/version ( contact )` on every request, where the
 * contact is a URL or email (§9.3, CLAUDE.md safety rule 4). The project URL is the contact.
 */
export const USER_AGENT = `Tagmonia/${VERSION} ( ${PROJECT_URL} )`;
