/**
 * persistence.test.ts — rotating-slot autosave/restore crash-safety.
 *
 * Verifies the write-older-then-flip scheme (design: phase-5a-persistence): a crash
 * between the slot write and the meta flip must still load the prior slot, and both-
 * corrupt must fall back to a cold start (null), never throw. Uses an in-memory
 * `KeyValStore` — Vitest runs in Node with no IndexedDB. Node env; no DOM.
 */

import { makeConfig } from "@sim/config";
import { type SaveBlob, serialize } from "@sim/serialize";
import { tick } from "@sim/tick";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";
import {
  Autosaver,
  autosave,
  type KeyValStore,
  loadNewest,
  META_KEY,
  type Meta,
  SLOT_A,
  SLOT_B,
} from "../../src/worker/persistence";

/** A trivial in-memory key-value store standing in for `idb-keyval`. */
function memStore(): KeyValStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
    set: async (key: string, value: unknown): Promise<void> => {
      map.set(key, value);
    },
  };
}

/** A store whose `set` throws on the Nth call — simulates a crash/quota mid-write. */
function crashingStore(
  throwOnCall: number,
): KeyValStore & { calls: number; map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const s = {
    calls: 0,
    map,
    get: async <T>(key: string): Promise<T | undefined> => map.get(key) as T | undefined,
    set: async (key: string, value: unknown): Promise<void> => {
      s.calls++;
      if (s.calls === throwOnCall) throw new Error("simulated write failure");
      map.set(key, value);
    },
  };
  return s;
}

describe("persistence — rotating slots", () => {
  it("first save writes slot A and flips meta to 'a'", async () => {
    const store = memStore();
    const w = createWorld(1, makeConfig({}));
    const meta = await autosave(store, w, null, 1000);
    expect(meta.newest).toBe("a");
    expect(meta.lastSavedRealTime).toBe(1000);
    expect(meta.savedTick).toBe(w.tick);
    expect(store.map.get(SLOT_A)).toBeDefined();
    expect(store.map.get(SLOT_B)).toBeUndefined();
    expect(w.lastSavedRealTime).toBe(1000); // stamped in the worker, not sim/
  });

  it("second save writes the OLDER slot (B) and flips to 'b'", async () => {
    const store = memStore();
    const w = createWorld(1, makeConfig({}));
    const m1 = await autosave(store, w, null, 1000); // → A
    for (let i = 0; i < 10; i++) tick(w);
    const m2 = await autosave(store, w, m1, 2000); // → B (older)
    expect(m2.newest).toBe("b");
    expect(store.map.get(SLOT_B)).toBeDefined();
    // A is untouched from the first save (both slots now hold a world).
    expect(store.map.get(SLOT_A)).toBeDefined();
  });

  it("loadNewest returns the newest slot's world", async () => {
    const store = memStore();
    const w = createWorld(3, makeConfig({}));
    for (let i = 0; i < 25; i++) tick(w);
    await autosave(store, w, null, 5000);
    const loaded = await loadNewest(store);
    expect(loaded).not.toBeNull();
    expect(loaded?.lastSavedRealTime).toBe(5000);
    expect(loaded?.world.tick).toBe(w.tick);
    expect(loaded?.world.creatures.length).toBe(w.creatures.length);
  });

  it("cold start: no meta → loadNewest returns null", async () => {
    const store = memStore();
    expect(await loadNewest(store)).toBeNull();
  });
});

describe("persistence — crash safety (write-older-then-flip)", () => {
  it("a crash between slot write and meta flip still loads the PRIOR slot", async () => {
    const store = memStore();
    const w = createWorld(7, makeConfig({}));
    // First save succeeds fully → slot A + meta{newest:a}.
    const m1 = await autosave(store, w, null, 1000);

    // Second save: write slot B succeeds, but the meta flip "crashes". Simulate by
    // manually writing the older slot then NOT flipping meta.
    for (let i = 0; i < 10; i++) tick(w);
    // Mimic autosave's internals up to — but NOT including — the meta flip: the older
    // slot (B) gets a valid world, but meta is never flipped (the "crash").
    store.map.set(SLOT_B, serialize(w));
    // meta still points at A (the flip never happened).
    const metaNow = store.map.get(META_KEY) as Meta;
    expect(metaNow.newest).toBe("a");

    // loadNewest must return the still-valid slot A (the pre-crash world).
    const loaded = await loadNewest(store);
    expect(loaded).not.toBeNull();
    expect(loaded?.lastSavedRealTime).toBe(m1.lastSavedRealTime);
  });

  it("newest slot corrupt → falls back to the other slot", async () => {
    const store = memStore();
    const w = createWorld(9, makeConfig({}));
    const m1 = await autosave(store, w, null, 1000); // A valid
    for (let i = 0; i < 5; i++) tick(w);
    await autosave(store, w, m1, 2000); // B valid, meta → b

    // Corrupt the newest slot (B).
    store.map.set(SLOT_B, { garbage: true } as unknown as SaveBlob);
    const loaded = await loadNewest(store);
    // Falls back to A (older but valid).
    expect(loaded).not.toBeNull();
    expect(loaded?.world.creatures.length).toBeGreaterThan(0);
  });

  it("both slots corrupt → cold start (null), never throws", async () => {
    const store = memStore();
    const w = createWorld(2, makeConfig({}));
    await autosave(store, w, null, 1000);
    store.map.set(SLOT_A, { junk: 1 } as unknown as SaveBlob);
    store.map.set(SLOT_B, undefined);
    const loaded = await loadNewest(store);
    expect(loaded).toBeNull();
  });
});

describe("Autosaver — in-flight guard + non-throwing", () => {
  it("caches meta across saves and rotates slots", async () => {
    const store = memStore();
    const w = createWorld(4, makeConfig({}));
    const saver = new Autosaver(store, null);
    expect(await saver.save(w, 1000)).toBe(true);
    expect(saver.currentMeta()?.newest).toBe("a");
    for (let i = 0; i < 3; i++) tick(w);
    expect(await saver.save(w, 2000)).toBe(true);
    expect(saver.currentMeta()?.newest).toBe("b");
  });

  it("returns false (never throws) when the store write fails", async () => {
    const store = crashingStore(1); // first set() throws
    const w = createWorld(4, makeConfig({}));
    const saver = new Autosaver(store, null);
    expect(await saver.save(w, 1000)).toBe(false);
  });
});
