/** Entry point for TagIO. Everything outside server/tagio/ imports from here. */
import { MutagenTagIO } from "./impl/mutagen.ts";
import type { TagIO } from "./types.ts";

export type TagIOImpl = "mutagen" | "taglib-wasm";

/** The production implementation is the mutagen sidecar (Decision log D7). */
export async function createTagIO(impl: TagIOImpl = "mutagen"): Promise<TagIO> {
  if (impl === "taglib-wasm") {
    const { TaglibWasmTagIO } = await import("./impl/taglib_wasm.ts");
    return new TaglibWasmTagIO();
  }
  return new MutagenTagIO();
}

export * from "./types.ts";
export { storableTags, supportsField, verifyChange } from "./verify.ts";
