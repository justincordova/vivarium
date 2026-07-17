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
});
