/**
 * Sets up the throwaway dev Jellyfin (docker/jellyfin-dev.compose.yml, D44):
 * first-run wizard, a "MusicTest" music library over /music, and an API key
 * for Tagmonia. Idempotent. Secrets go to dev/secrets/ (gitignored, mode 0600)
 * and are never printed.
 *
 *   DK_NETWORK=tagmonia-dev scripts/dk deno run -A scripts/dev_jellyfin.ts
 *
 * Real-time monitoring is off for the library, so changes appear only when
 * Tagmonia asks for a refresh: exactly what the Phase 3 check must prove.
 */
const BASE = Deno.env.get("JELLYFIN_URL") ?? "http://tagmonia-dev-jellyfin:8096";
const LIBRARY = "MusicTest";
const USER = "tagmonia";
const SECRETS = "dev/secrets";
const CLIENT = 'MediaBrowser Client="Tagmonia dev setup", Device="dev", DeviceId="tagmonia-dev-setup", Version="1"';

async function secret(name: string, make: () => string): Promise<string> {
  const path = `${SECRETS}/${name}`;
  try {
    return (await Deno.readTextFile(path)).trim();
  } catch {
    await Deno.mkdir(SECRETS, { recursive: true });
    const value = make();
    await Deno.writeTextFile(path, value + "\n", { mode: 0o600 });
    return value;
  }
}

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(new URL(path, BASE), {
    method,
    headers: {
      Authorization: token ? `${CLIENT}, Token="${token}"` : CLIENT,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Jellyfin takes a while to start the first time.
let info: { StartupWizardCompleted?: boolean; Version?: string } | null = null;
// While starting, it answers without a version (and 503 to everything else): wait for the version.
for (let i = 0; i < 90 && !info?.Version; i++) {
  try {
    info = await call("GET", "System/Info/Public");
  } catch {
    info = null;
  }
  if (!info?.Version) await new Promise((r) => setTimeout(r, 2000));
}
if (!info?.Version) throw new Error(`Jellyfin at ${BASE} did not answer; is docker/jellyfin-dev.compose.yml up?`);
console.log(`Jellyfin ${info.Version} at ${BASE}`);

const password = await secret("jellyfin_admin", () => crypto.randomUUID());
if (!info.StartupWizardCompleted) {
  await call("POST", "Startup/Configuration", {
    UICulture: "en-US",
    MetadataCountryCode: "US",
    PreferredMetadataLanguage: "en",
  });
  await call("GET", "Startup/User");
  await call("POST", "Startup/User", { Name: USER, Password: password });
  await call("POST", "Startup/RemoteAccess", { EnableRemoteAccess: true, EnableAutomaticPortMapping: false });
  await call("POST", "Startup/Complete");
  console.log(`first-run setup done (user "${USER}", password in ${SECRETS}/jellyfin_admin)`);
}

const auth = await call("POST", "Users/AuthenticateByName", { Username: USER, Pw: password });
const token: string = auth.AccessToken;

const folders: { Name: string }[] = await call("GET", "Library/VirtualFolders", undefined, token);
if (!folders.some((f) => f.Name === LIBRARY)) {
  // Only what is in the files: no online metadata, so the check sees exactly what Tagmonia wrote.
  const none = (Type: string) => ({ Type, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [] });
  const q = new URLSearchParams({ name: LIBRARY, collectionType: "music", paths: "/music", refreshLibrary: "true" });
  await call("POST", `Library/VirtualFolders?${q}`, {
    LibraryOptions: {
      EnableRealtimeMonitor: false,
      EnableInternetProviders: false,
      MetadataSavers: [],
      TypeOptions: [none("MusicAlbum"), none("MusicArtist"), none("Audio")],
    },
  }, token);
  console.log(`library "${LIBRARY}" created over /music`);
}

const APP = "Tagmonia (dev)";
let keys: { Items: { AppName: string; AccessToken: string }[] } = await call("GET", "Auth/Keys", undefined, token);
if (!keys.Items.some((k) => k.AppName === APP)) {
  await call("POST", `Auth/Keys?app=${encodeURIComponent(APP)}`, undefined, token);
  keys = await call("GET", "Auth/Keys", undefined, token);
}
const key = keys.Items.find((k) => k.AppName === APP)!.AccessToken;
await Deno.writeTextFile(`${SECRETS}/jellyfin_key`, key + "\n", { mode: 0o600 });
console.log(`API key in ${SECRETS}/jellyfin_key. Run Tagmonia with:
  TAGMONIA_JELLYFIN_URL=${BASE}
  TAGMONIA_JELLYFIN_KEY_FILE=${SECRETS}/jellyfin_key
  TAGMONIA_JELLYFIN_LIBRARY=${LIBRARY}`);
