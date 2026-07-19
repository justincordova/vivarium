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
  if (seedStr === null) return null;
  const seed = Number(seedStr);
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

/** Gunzip bytes via `DecompressionStream` → UTF-8 string. */
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
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

/** Read + gunzip + parse a `.viv.gz` file into a `SaveBlob`. Throws on malformed input. */
export async function importWorld(file: File): Promise<SaveBlob> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const text = await gunzip(bytes);
  const blob = JSON.parse(text) as SaveBlob;
  if (typeof blob.version !== "number" || blob.config === undefined) {
    throw new Error("not a valid vivarium save");
  }
  return blob;
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
    const blob = JSON.parse(text) as SaveBlob;
    if (typeof blob.version !== "number" || blob.config === undefined) return null;
    return blob;
  } catch {
    return null;
  }
}
