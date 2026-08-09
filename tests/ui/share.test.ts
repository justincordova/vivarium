/**
 * share.test.ts — shareable-world URL encoding + gzip file roundtrip (Phase 5A.4).
 *
 * `parseHash`/`encodeHash` are pure string logic. The gzip export/import roundtrip is
 * exercised through `importWorld` fed a `File` built from a real gzip stream — Node 18+
 * provides `CompressionStream`/`Blob`/`Response`/`File`, so no DOM/jsdom is needed.
 */

import { makeConfig } from "@sim/config";
import { serialize } from "@sim/serialize";
import { createWorld } from "@sim/world";
import { describe, expect, it } from "vitest";
import { encodeHash, importWorld, parseHash } from "../../src/ui/share";

describe("URL hash encode/parse", () => {
  it("roundtrips a seed", () => {
    const encoded = encodeHash({ seed: 42 });
    expect(encoded).toBe("#seed=42");
    expect(parseHash(encoded)).toEqual({ seed: 42 });
  });

  it("roundtrips a seed + mutation-rate override via the `mut` alias", () => {
    const encoded = encodeHash({ seed: 7, tunables: { MUT_GLOBAL: 2.5 } });
    expect(encoded).toContain("seed=7");
    expect(encoded).toContain("mut=2.5");
    expect(parseHash(encoded)).toEqual({ seed: 7, tunables: { MUT_GLOBAL: 2.5 } });
  });

  it("encodes generic tunables as `t.KEY` and parses them back", () => {
    const encoded = encodeHash({ seed: 1, tunables: { CREATURE_CAP: 200 } });
    expect(encoded).toContain("t.CREATURE_CAP=200");
    expect(parseHash(encoded)).toEqual({ seed: 1, tunables: { CREATURE_CAP: 200 } });
  });

  it("returns null for an empty or seed-less hash", () => {
    expect(parseHash("")).toBeNull();
    expect(parseHash("#")).toBeNull();
    expect(parseHash("#mut=2")).toBeNull(); // no seed → not a valid share
  });

  it("rejects a non-numeric seed", () => {
    expect(parseHash("#seed=abc")).toBeNull();
  });

  it("rejects a blank/whitespace seed (a truncated link is not seed 0)", () => {
    expect(parseHash("#seed=")).toBeNull();
    expect(parseHash("#seed=%20%20")).toBeNull();
  });

  it("truncates a fractional seed to an integer (mirrors setSeed)", () => {
    expect(parseHash("#seed=1.9")).toEqual({ seed: 1 });
    expect(parseHash("#seed=-3.7")).toEqual({ seed: -3 });
  });
});

/** Gzip a string the same way `share.ts` does, and wrap it in a `File`. */
async function gzippedFile(text: string, name = "w.viv.gz"): Promise<File> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new File([buf], name, { type: "application/gzip" });
}

describe("gzip file import", () => {
  it("imports a gzipped serialized world (roundtrips through deserialize-able blob)", async () => {
    const world = createWorld(3, makeConfig({}));
    const blob = serialize(world);
    const file = await gzippedFile(JSON.stringify(blob));
    const imported = await importWorld(file);
    expect(imported.version).toBe(blob.version);
    expect(imported.tick).toBe(blob.tick);
    expect(imported.creatures.length).toBe(blob.creatures.length);
  });

  it("rejects a gzipped non-save file", async () => {
    const file = await gzippedFile(JSON.stringify({ hello: "world" }));
    await expect(importWorld(file)).rejects.toThrow();
  });

  it("rejects a gzipped `null`/primitive without a raw TypeError", async () => {
    const file = await gzippedFile("null");
    await expect(importWorld(file)).rejects.toThrow("not a valid vivarium save");
  });

  it("imports a raw (uncompressed) .viv JSON file too", async () => {
    const world = createWorld(5, makeConfig({}));
    const blob = serialize(world);
    const file = new File([JSON.stringify(blob)], "w.viv", { type: "application/json" });
    const imported = await importWorld(file);
    expect(imported.version).toBe(blob.version);
    expect(imported.creatures.length).toBe(blob.creatures.length);
  });

  // A `.viv.gz` is the documented way to hand someone else an evolved world, so its
  // content is untrusted. Buffering the whole stream would let a small decompression bomb
  // expand without bound and OOM the tab before any validation ran, losing everything
  // since the last autosave. 65 MB of one repeated byte gzips to a few tens of KB.
  it("aborts a decompression bomb instead of buffering it", async () => {
    const bomb = "a".repeat(65 * 1024 * 1024);
    const file = await gzippedFile(bomb, "bomb.viv.gz");
    // Comfortably smaller than what it expands to — that asymmetry is the attack.
    expect(file.size).toBeLessThan(1024 * 1024);
    await expect(importWorld(file)).rejects.toThrow(/too large/);
  }, 120_000);
});
