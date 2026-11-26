/**
 * Noticing new arrivals in the inbox (docs/proposals/inbox-and-renaming.md, W7, D60). Change events from
 * `Deno.watchFs` where the file system sends them, and a poll every few minutes where it does not (SMB/NFS
 * mounts, WSL's /mnt/c). Either only starts a look: the inbox is scanned once nothing in it changed for the
 * quiet period and every file's size and time are the same on two looks, so a copy in progress is never read.
 * The whole inbox must be still, not one folder, because the scan reads the whole inbox.
 */
import { join } from "node:path";
import type { Logger } from "../log.ts";

/** Every file under `dir` with its size and modification time, in a stable order. Symlinks are not followed. */
export async function inboxSnapshot(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (abs: string, rel: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(abs));
    } catch {
      return; // a folder removed while looking, or unreadable: the scan reports those
    }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) await walk(join(abs, e.name), r);
      else if (e.isFile) {
        const st = await Deno.stat(join(abs, e.name)).catch(() => null);
        if (st) out.push(`${r}\0${st.size}\0${st.mtime?.getTime() ?? 0}`);
      }
    }
  };
  await walk(dir, "");
  return out.sort().join("\n");
}

export interface InboxWatcherDeps {
  inboxDir: string;
  /** Called when the inbox settled in a state not scanned yet: queue an inbox scan. */
  onSettled: () => void;
  /** Read before every poll, so a settings change applies; 0 = change events only. */
  pollMs: () => number;
  logger: Logger;
  /** How long nothing may change before a scan (30 s). */
  quietMs?: number;
  /** Change events (on unless a test turns them off). */
  watch?: boolean;
}

export class InboxWatcher {
  #deps: Required<InboxWatcherDeps>;
  #stopped = false;
  #settling: Promise<void> | null = null;
  /** Something changed since the current look began. */
  #dirty = false;
  /** The inbox as last handed to a scan; null until the first, so startup picks up what arrived meanwhile. */
  #scanned: string | null = null;
  #watcher: Deno.FsWatcher | null = null;
  #poll: ReturnType<typeof setTimeout> | undefined;
  #sleep: { timer: ReturnType<typeof setTimeout>; resolve: () => void } | null = null;

  constructor(deps: InboxWatcherDeps) {
    this.#deps = { quietMs: 30_000, watch: true, ...deps };
  }

  start(): void {
    if (this.#deps.watch) this.#watch();
    this.nudge();
    this.#schedulePoll();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#poll);
    this.#watcher?.close();
    if (this.#sleep) {
      clearTimeout(this.#sleep.timer);
      this.#sleep.resolve();
    }
    await this.#settling;
  }

  /** Something may have changed: look, unless a look is already under way (then it looks again). */
  nudge(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#settling ??= this.#settle().catch((e) =>
      this.#deps.logger.warn("cannot look at the inbox", { error: (e as Error).message })
    ).finally(() => (this.#settling = null));
  }

  /** Resolves once the current look, if any, is over; for tests. */
  async idle(): Promise<void> {
    while (this.#settling) await this.#settling;
  }

  async #settle(): Promise<void> {
    while (!this.#stopped) {
      this.#dirty = false;
      const before = await inboxSnapshot(this.#deps.inboxDir);
      await this.#wait(this.#deps.quietMs);
      if (this.#stopped) return;
      const after = await inboxSnapshot(this.#deps.inboxDir);
      if (this.#dirty || before !== after) continue; // still changing: wait for quiet again
      if (after !== this.#scanned) {
        this.#scanned = after;
        this.#deps.onSettled();
      }
      return;
    }
  }

  #wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#sleep = {
        timer: setTimeout(() => {
          this.#sleep = null;
          resolve();
        }, ms),
        resolve,
      };
    });
  }

  #schedulePoll(): void {
    if (this.#stopped) return;
    const ms = this.#deps.pollMs();
    // With polling off, check again later whether it was turned on.
    this.#poll = setTimeout(() => {
      if (ms > 0) this.nudge();
      this.#schedulePoll();
    }, ms > 0 ? ms : 60_000);
  }

  async #watch(): Promise<void> {
    try {
      this.#watcher = Deno.watchFs(this.#deps.inboxDir, { recursive: true });
      // Reads (the scan's own, a player's) change nothing.
      for await (const e of this.#watcher) if (e.kind !== "access") this.nudge();
    } catch (e) {
      // Too many watches, or a file system without events: polling still finds new albums.
      if (!this.#stopped) {
        this.#deps.logger.warn("inbox change events unavailable; polling only", { error: (e as Error).message });
      }
    }
  }
}
