/**
 * share.ts — shareable worlds (Phase 5A.4): URL-hash seed/config encoding + gzipped
 * file export/import. Main-thread UI utilities (they touch `location`, the DOM download
 * path, and `CompressionStream`). All world (de)serialization goes through the pure
 * `sim/` `serialize`/`deserialize` via the worker; this module only encodes the *initial*
 * config in the URL and gzips/gunzips a `SaveBlob` for file transfer.
 *
 * The URL hash encodes the INITIAL config only (a fresh, reproducible world), never a
 * mid-run snapshot — god-power/live edits detach the world from its URL (the `detached`
 * flag). A full evolved world travels by file export, not by URL.
 */

import type { SaveBlob } from "@sim/serialize";

/** The subset of world creation encoded in the URL hash — a reproducible cold start. */
export interface ShareParams {
  seed: number;
  /** Optional tunable overrides (e.g. mutation rate) applied to the default config. */
  tunables?: Record<string, number>;
}

/** Parse `#seed=..&mut=..` (and generic `t.KEY=..` tunable overrides) from a hash. */
export function parseHash(hash: string): ShareParams | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  const params = new URLSearchParams(raw);
  const seedStr = params.get("seed");
  // Reject a missing OR blank/whitespace `seed=` (a truncated/broken link): `Number("")`
  // and `Number("  ")` are 0 (finite), so without the blank check an empty `seed=` would
  // silently boot the wrong world (seed 0) instead of falling through to the normal flow.
  if (seedStr === null || seedStr.trim() === "") return null;
  // Truncate to an integer, mirroring the store's `setSeed` invariant — a fractional
  // seed is meaningless for the RNG, and the shared-hash path bypasses `setSeed`, so a
  // hand-edited `#seed=1.9` link would otherwise leak a fractional value into the state.
  const seed = Math.trunc(Number(seedStr));
  if (!Number.isFinite(seed)) return null;

  const tunables: Record<string, number> = {};
  // `mut` is a friendly alias for the mutation-rate multiplier.
  const mut = params.get("mut");
  if (mut !== null && Number.isFinite(Number(mut))) tunables.MUT_GLOBAL = Number(mut);
  // Generic `t.KEY=value` tunable overrides.
  for (const [k, v] of params) {
    if (k.startsWith("t.") && Number.isFinite(Number(v))) {
      tunables[k.slice(2)] = Number(v);
    }
  }
  return Object.keys(tunables).length > 0 ? { seed, tunables } : { seed };
}

/** Encode `ShareParams` into a `#seed=..` hash string (leading `#` included). */
export function encodeHash(params: ShareParams): string {
  const sp = new URLSearchParams();
  sp.set("seed", String(params.seed));
  if (params.tunables) {
    for (const [k, v] of Object.entries(params.tunables)) {
      if (k === "MUT_GLOBAL") sp.set("mut", String(v));
      else sp.set(`t.${k}`, String(v));
    }
  }
  return `#${sp.toString()}`;
}

/** Build the full shareable URL for the current origin+path plus these params. */
export function shareUrl(params: ShareParams): string {
  const base = `${location.origin}${location.pathname}`;
  return `${base}${encodeHash(params)}`;
}

// ── Gzipped file export / import ──────────────────────────────────────────────

/** Gzip a UTF-8 string via `CompressionStream` → bytes. */
async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Largest decompressed save we will hold in memory. A real world save is far under this
 * (a few MB at the default 400×400 world), so the cap only ever trips on something that
 * is not a save.
 */
const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/**
 * Thrown when a gzip stream expands past `MAX_DECOMPRESSED_BYTES`. Distinct from a plain
 * gunzip failure because the callers retry those as raw JSON — retrying a bomb would
 * report it as a merely-malformed file and hide why it was actually rejected.
 */
class DecompressionLimitError extends Error {}

/**
 * Gunzip bytes via `DecompressionStream` → UTF-8 string, bounded.
 *
 * A `.viv.gz` is the documented way to hand someone else an evolved world, so its content
 * is untrusted. Buffering the whole stream (`new Response(stream).text()`) would let a
 * ~1 MB decompression bomb expand to several GB and OOM-crash the tab before any
 * validation could run, losing everything since the last autosave. Read incrementally and
 * abort once the decoded output exceeds the cap.
 */
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_DECOMPRESSED_BYTES) {
        throw new DecompressionLimitError("save file is too large to read");
      }
      out += decoder.decode(value, { stream: true });
    }
  } finally {
    // Releases the underlying source whether we finished or bailed out early.
    void reader.cancel().catch(() => undefined);
  }
  return out + decoder.decode();
}

/**
 * Validate a parsed value as a `SaveBlob` (a non-null object carrying a numeric `version`
 * and a `config`). Guards the `JSON.parse` result BEFORE any property access — `JSON.parse`
 * legitimately yields `null`/number/string/array for well-formed-but-wrong input, and
 * dereferencing `.version` on `null` throws a raw `TypeError` instead of our clean error.
 */
function isSaveBlob(value: unknown): value is SaveBlob {
  if (typeof value !== "object" || value === null) return false;
  const b = value as Partial<SaveBlob>;
  return typeof b.version === "number" && b.config !== undefined;
}

/** Trigger a browser download of a gzipped `SaveBlob` as `vivarium-<tick>.viv.gz`. */
export async function exportWorld(blob: SaveBlob): Promise<void> {
  const bytes = await gzip(JSON.stringify(blob));
  const file = new Blob([bytes], { type: "application/gzip" });
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vivarium-${blob.tick ?? 0}.viv.gz`;
  document.body.appendChild(a);
  a.click();
  // Defer cleanup past the current tick: a synthetic anchor click starts the download
  // asynchronously, and revoking the object URL synchronously in the same tick can
  // abort it in some browsers before the download commits.
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

/**
 * Read + parse a save file into a `SaveBlob`. Accepts BOTH gzipped `.viv.gz` and raw
 * uncompressed `.viv` JSON (the file picker advertises both): gunzip first, and on
 * failure fall back to decoding the bytes as UTF-8 JSON directly — mirroring the
 * cold-open fetch's try-gunzip-then-raw strategy. Throws a clean error on malformed
 * input (validated as a `SaveBlob` before returning).
 */
export async function importWorld(file: File): Promise<SaveBlob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  try {
    text = await gunzip(bytes);
  } catch (e) {
    // The raw fallback is for "this file was never gzipped". A size-cap abort is a
    // different answer — retrying it as raw JSON would report a decompression bomb as a
    // merely malformed save and lose the real reason.
    if (e instanceof DecompressionLimitError) throw e;
    text = new TextDecoder().decode(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("not a valid vivarium save");
  }
  if (!isSaveBlob(parsed)) {
    throw new Error("not a valid vivarium save");
  }
  return parsed;
}

/**
 * Fetch + gunzip the pre-evolved cold-open snapshot asset (Phase 5B.2), or null if it
 * is missing/unreadable (the app then falls back to a fresh founder start). Best-effort:
 * a failed fetch must never block boot.
 */
export async function fetchColdOpen(url = "cold-open.viv.gz"): Promise<SaveBlob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    // Some servers (Vite dev, and any with gzip content-encoding on `.gz`) transparently
    // DECOMPRESS the asset, so the bytes may already be raw JSON. Try gunzip first; on
    // failure, fall back to treating the bytes as UTF-8 JSON directly.
    let text: string;
    try {
      text = await gunzip(bytes);
    } catch {
      text = new TextDecoder().decode(bytes);
    }
    const parsed: unknown = JSON.parse(text);
    return isSaveBlob(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
