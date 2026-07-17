/**
 * persistence.ts — crash-safe rotating-slot autosave/restore over IndexedDB.
 *
 * The worker owns the World, so it owns persistence (SPEC.md §Persistence & Save Format).
 * This module is the storage plumbing only: it (de)serializes via the pure Phase-0.9
 * `serialize`/`deserialize` and reads/writes a key-value store. It imports NO DOM
 * lifecycle (the worker wires the ~30s timer + `visibilitychange`) and nothing from
 * `sim/` beyond the save format.
 *
 * **Crash safety (write-older-then-flip):** two world slots (`world:a`/`world:b`) and a
 * `meta` pointer. Each save writes the OLDER slot, then flips `meta.newest`. A crash
 * between the slot write and the meta flip leaves the previous newest slot intact and
 * valid — a crash loses at most one autosave, never the world (SPEC.md §Persistence).
 *
 * **Testability:** every function takes a `KeyValStore` (get/set), so tests inject an
 * in-memory store — Vitest runs in Node with no IndexedDB. The default store is backed
 * by `idb-keyval`.
 */

import { deserialize, type SaveBlob, serialize } from "@sim/serialize";
import type { World } from "@sim/types";
import { get as idbGet, set as idbSet } from "idb-keyval";

/** The minimal key-value surface persistence needs — satisfied by `idb-keyval` and by
 * an in-memory `Map` in tests. */
export interface KeyValStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** Storage keys (module-private constants — the two slots + the pointer). */
export const SLOT_A = "world:a";
export const SLOT_B = "world:b";
export const META_KEY = "meta";

/** Which slot is currently newest, plus the wall-clock + tick of that save. */
export interface Meta {
  newest: "a" | "b";
  /** Wall-clock ms at save time — the worker stamps it; `tick()` never reads it. */
  lastSavedRealTime: number;
  /** The world tick at save time (for progress display / diagnostics). */
  savedTick: number;
}

/** The default store, backed by `idb-keyval` (used in the browser worker). */
export const idbStore: KeyValStore = {
  get: <T>(key: string): Promise<T | undefined> => idbGet<T>(key),
  set: (key: string, value: unknown): Promise<void> => idbSet(key, value),
};

function slotKey(which: "a" | "b"): string {
  return which === "a" ? SLOT_A : SLOT_B;
}

/** A loaded, validated save: the live World, the wall-clock it was saved at, and the
 * `meta` it came from (so the Autosaver can seed its rotation to the OLDER slot and
 * never overwrite the freshly-loaded newest slot on the first save). */
export interface Loaded {
  world: World;
  lastSavedRealTime: number;
  meta: Meta;
}

/** Validate + deserialize a candidate blob; returns null if it is unusable. */
function tryLoadBlob(blob: SaveBlob | undefined): World | null {
  if (blob === undefined || blob === null) return null;
  // A version too new to understand, or a structurally-empty blob, is unusable.
  if (typeof blob.version !== "number") return null;
  if (blob.config === undefined || blob.config === null) return null;
  try {
    return deserialize(blob);
  } catch {
    return null;
  }
}

/**
 * Load the newest valid saved world, or null for a cold start. Reads `meta`, tries the
 * `newest` slot, falls back to the other slot on failure. If both are missing/corrupt,
 * returns null (the caller does a cold `createWorld`) — never throws.
 */
export async function loadNewest(store: KeyValStore = idbStore): Promise<Loaded | null> {
  const meta = await store.get<Meta>(META_KEY);
  if (meta === undefined) return null;

  const primary = meta.newest;
  const fallback: "a" | "b" = primary === "a" ? "b" : "a";
  for (const which of [primary, fallback]) {
    const blob = await store.get<SaveBlob>(slotKey(which));
    const world = tryLoadBlob(blob);
    if (world !== null) {
      // Report the meta as if `which` is newest, so the Autosaver rotates to the OTHER
      // slot first — the first post-load save never overwrites the slot we loaded from.
      return { world, lastSavedRealTime: meta.lastSavedRealTime, meta: { ...meta, newest: which } };
    }
  }
  return null;
}

/**
 * Autosave `world` crash-safely: write the OLDER slot, then flip `meta`. Stamps
 * `world.lastSavedRealTime` with `now` (the worker's wall-clock) — this is the one
 * place that value is written, and it never enters `tick()`. Returns the new `Meta`
 * (the caller caches it so it need not re-read `meta` every save). Pure w.r.t. the
 * store: all effects go through `store.set`.
 */
export async function autosave(
  store: KeyValStore,
  world: World,
  prevMeta: Meta | null,
  now: number,
): Promise<Meta> {
  // First save (no prior meta) writes slot A; otherwise write whichever is older.
  const older: "a" | "b" = prevMeta === null ? "a" : prevMeta.newest === "a" ? "b" : "a";
  world.lastSavedRealTime = now;
  await store.set(slotKey(older), serialize(world));
  const meta: Meta = { newest: older, lastSavedRealTime: now, savedTick: world.tick };
  await store.set(META_KEY, meta);
  return meta;
}

/**
 * A stateful autosave coordinator: holds the cached `Meta` and a single in-flight flag
 * so a `visibilitychange` save and a timer save never interleave a half-flip. The
 * worker owns one of these; the timer/visibility listeners call `save()`.
 */
export class Autosaver {
  private meta: Meta | null;
  private inFlight = false;

  constructor(
    private readonly store: KeyValStore,
    initialMeta: Meta | null = null,
  ) {
    this.meta = initialMeta;
  }

  /** The last-known meta (e.g. from the boot load), for the worker to seed progress. */
  currentMeta(): Meta | null {
    return this.meta;
  }

  /**
   * Save `world` now, unless a save is already in flight (in which case this is a
   * no-op — the in-flight save already captures at-or-after this world state closely
   * enough for a ~30s autosave cadence). Returns true if it saved, false if skipped or
   * failed. Never throws: a storage/quota failure resolves false so the worker can
   * surface a non-fatal indicator and keep simulating.
   */
  async save(world: World, now: number): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      this.meta = await autosave(this.store, world, this.meta, now);
      return true;
    } catch {
      return false;
    } finally {
      this.inFlight = false;
    }
  }
}
