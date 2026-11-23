/** Boot: config -> (Phase 1: migrations, queue) -> HTTP. */
import { loadConfig } from "./config.ts";
import { createApp } from "./http/app.ts";
import { VERSION } from "./version.ts";

if (import.meta.main) {
  const config = loadConfig();
  const app = createApp(config);
  Deno.serve({
    port: config.port,
    onListen: ({ hostname, port }) => console.log(`Tagmony ${VERSION} listening on http://${hostname}:${port}`),
  }, app.fetch);
}
