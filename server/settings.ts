/**
 * UI-managed settings in /config/settings.json (ARCHITECTURE.md §15.2),
 * validated against a schema at startup. Missing keys take defaults; an
 * invalid file stops startup rather than silently resetting the user's choices.
 */
import { join } from "node:path";
import { z } from "zod";

export const settingsSchema = z.object({
  scanner: z.object({
    /** Globs relative to the music root, e.g. "Podcasts/**" or "**\/_Incoming". */
    ignore: z.array(z.string().min(1)).default([]),
  }).prefault({}),
  auth: z.object({
    /** Sessions end after this long without a request. */
    sessionIdleHours: z.number().positive().max(24 * 90).default(24 * 7),
    /** Sessions end this long after login regardless of activity. */
    sessionMaxDays: z.number().positive().max(365).default(30),
  }).prefault({}),
}).strict();

export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export async function loadSettings(configDir: string): Promise<Settings> {
  const path = join(configDir, "settings.json");
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    await Deno.writeTextFile(path, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    return DEFAULT_SETTINGS;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new Error(`${path} is invalid at: ${where}`);
  }
  return parsed.data;
}
