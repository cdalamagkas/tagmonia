/**
 * TagIO backed by a long-lived Python/mutagen sidecar (§11.4 option B, D7).
 * Requests are serialised over newline-delimited JSON on stdin/stdout.
 */
import { fileURLToPath } from "node:url";
import { atomicModify } from "../atomic.ts";
import { FIELD_MAPPINGS } from "../mapping.ts";
import { readResultWireSchema } from "../schema.ts";
import { type ReadResult, type TagChange, type TagIO, TagIOError } from "../types.ts";

const SIDECAR = fileURLToPath(new URL("./mutagen_sidecar.py", import.meta.url));

export interface MutagenTagIOOptions {
  python?: string;
  /** Test hook passed to the sidecar as TAGMONY_TAGIO_FAULT. */
  fault?: "crash-mid-write";
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

interface SidecarResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function toBase64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

export class MutagenTagIO implements TagIO {
  #opts: MutagenTagIOOptions;
  #proc?: Deno.ChildProcess;
  #writer?: WritableStreamDefaultWriter<Uint8Array>;
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ready?: Promise<void>;
  // Serialises requests: mutagen is synchronous and one in-flight op keeps failures attributable.
  #chain: Promise<unknown> = Promise.resolve();

  constructor(opts: MutagenTagIOOptions = {}) {
    this.#opts = opts;
  }

  read(path: string): Promise<ReadResult> {
    return this.#enqueue(async () => {
      const raw = await this.#call({ op: "read", path });
      const parsed = readResultWireSchema.safeParse(raw);
      if (!parsed.success) throw new TagIOError(`invalid sidecar response: ${parsed.error.message}`, path);
      return parsed.data as ReadResult;
    });
  }

  write(path: string, change: TagChange): Promise<void> {
    const wire = {
      set: change.set,
      remove: change.remove,
      ...(change.pictures ? { pictures: change.pictures.map((p) => ({ ...p, data: toBase64(p.data) })) } : {}),
    };
    return this.#enqueue(() =>
      atomicModify(path, async (tmp) => {
        await this.#call({ op: "write", path: tmp, change: wire });
      })
    );
  }

  async close(): Promise<void> {
    const proc = this.#proc;
    if (!proc) return;
    this.#proc = undefined;
    this.#ready = undefined;
    await this.#writer?.close().catch(() => {});
    await proc.status;
  }

  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  #start(): Promise<void> {
    if (this.#ready) return this.#ready;
    const env: Record<string, string> = { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" };
    if (this.#opts.fault) env.TAGMONY_TAGIO_FAULT = this.#opts.fault;
    const proc = new Deno.Command(this.#opts.python ?? "python3", {
      // -I: isolated mode, so nothing next to the music files can shadow stdlib modules.
      args: ["-I", SIDECAR],
      stdin: "piped",
      stdout: "piped",
      stderr: "inherit",
      env,
    }).spawn();
    this.#proc = proc;
    this.#writer = proc.stdin.getWriter();
    this.#pump(proc);
    this.#ready = this.#send({ op: "init", mapping: FIELD_MAPPINGS }).then(() => {});
    return this.#ready;
  }

  async #pump(proc: Deno.ChildProcess): Promise<void> {
    let buf = "";
    const dec = new TextDecoder();
    try {
      for await (const chunk of proc.stdout) {
        buf += dec.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.trim()) this.#dispatch(JSON.parse(line) as SidecarResponse);
        }
      }
    } finally {
      // Sidecar exited: fail everything in flight and restart lazily on next use.
      if (this.#proc === proc) {
        this.#proc = undefined;
        this.#ready = undefined;
      }
      const err = new TagIOError("tagio sidecar exited unexpectedly");
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    }
  }

  #dispatch(msg: SidecarResponse): void {
    const p = this.#pending.get(msg.id);
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new TagIOError(msg.error ?? "sidecar error"));
  }

  #send(payload: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;
    const line = JSON.stringify({ id, ...payload }) + "\n";
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#writer!.write(new TextEncoder().encode(line)).catch((e) => {
        this.#pending.delete(id);
        reject(new TagIOError("cannot write to tagio sidecar", undefined, { cause: e }));
      });
    });
  }

  async #call(payload: Record<string, unknown>): Promise<unknown> {
    await this.#start();
    try {
      return await this.#send(payload);
    } catch (e) {
      if (e instanceof TagIOError && typeof payload.path === "string" && !e.path) {
        throw new TagIOError(e.message, payload.path, { cause: e });
      }
      throw e;
    }
  }
}
