/**
 * Chromaprint fingerprints via `fpcalc` (ARCHITECTURE.md §4, §8 order 4).
 * Lives in server/tagio/ because only this module may read audio bytes
 * (CLAUDE.md). Read-only: fpcalc never modifies the file.
 */
import { z } from "zod";

export interface Fingerprint {
  fingerprint: string;
  /** Whole seconds, as AcoustID expects. */
  durationSec: number;
}

export interface FpcalcOptions {
  fpcalc?: string;
  /** Seconds of audio to analyse; AcoustID's own clients use 120. */
  lengthSec?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class FingerprintError extends Error {
  override name = "FingerprintError";
}

const outputSchema = z.object({ duration: z.number().nonnegative(), fingerprint: z.string().min(1) });

/** `absPath` must already be resolved inside the music root (§14.4). */
export async function fingerprintFile(absPath: string, opts: FpcalcOptions = {}): Promise<Fingerprint> {
  if (!absPath.startsWith("/")) throw new FingerprintError("fingerprintFile needs an absolute path");
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 60_000);
  const cmd = new Deno.Command(opts.fpcalc ?? "fpcalc", {
    // An absolute path cannot be mistaken for an option.
    args: ["-json", "-length", String(opts.lengthSec ?? 120), absPath],
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
  });
  let out: Deno.CommandOutput;
  try {
    out = await cmd.output();
  } catch (e) {
    opts.signal?.throwIfAborted();
    throw new FingerprintError(`fpcalc could not run: ${e instanceof Error ? e.message : e}`);
  }
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim().split("\n").at(-1) ?? "";
    throw new FingerprintError(`fpcalc failed (exit ${out.code})${err ? `: ${err}` : ""}`);
  }
  let parsed;
  try {
    parsed = outputSchema.safeParse(JSON.parse(new TextDecoder().decode(out.stdout)));
  } catch {
    throw new FingerprintError("fpcalc printed invalid JSON");
  }
  if (!parsed.success) throw new FingerprintError("fpcalc output has no fingerprint");
  return { fingerprint: parsed.data.fingerprint, durationSec: Math.round(parsed.data.duration) };
}
