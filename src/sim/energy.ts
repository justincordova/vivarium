/**
 * energy.ts — guarded transfer helpers + cost formulas for the closed ledgers.
 *
 * Every energy/water movement in the sim goes through `transfer` (SPEC.md §Energy:
 * "energy is only ever *moved* between compartments, never created or destroyed").
 * The helper enforces `qty >= 0` and `qty <= source` and moves the identical
 * integer out of one compartment and into another, so no call site can mint or
 * destroy quanta. The authoritative sums live in `stats.ts`.
 *
 * Part of `sim/`: imports nothing.
 */

/**
 * A mutable named endpoint of a ledger. Heterogeneous compartments — the `World`
 * scalar `solarReservoir`, a `creature.energy` object field, a field-array cell —
 * all present this same tiny interface, so one guarded `transfer` serves them all.
 */
export interface Compartment {
  get(): number;
  add(delta: number): void;
}

/** A compartment backed by an object property. */
export function fieldCompartment<K extends string>(obj: Record<K, number>, key: K): Compartment {
  return {
    get: () => obj[key],
    add: (delta) => {
      obj[key] = obj[key] + delta;
    },
  };
}

/** A compartment backed by one cell of an integer field array. */
export function cellCompartment(arr: Int32Array, index: number): Compartment {
  return {
    get: () => arr[index] as number,
    add: (delta) => {
      arr[index] = (arr[index] as number) + delta;
    },
  };
}

/**
 * Move exactly `qty` integer quanta from `from` to `to`. **This is the only
 * sanctioned way to move energy or water.** Guards:
 *  - `qty` must be a non-negative integer (a non-integer or negative amount is a
 *    programming error — throws, not silently clamps, so bugs surface in tests);
 *  - `qty` must not exceed `from`'s current contents (never overdraw a compartment
 *    negative).
 * Both endpoints are updated by the identical amount, so any `totalEnergy`/
 * `totalWater` sum spanning both is unchanged.
 *
 * Returns the amount moved (always `qty` on success) for call-site convenience.
 */
export function transfer(from: Compartment, to: Compartment, qty: number): number {
  if (!Number.isInteger(qty)) {
    throw new Error(`transfer qty must be an integer, got ${qty}`);
  }
  if (qty < 0) {
    throw new Error(`transfer qty must be non-negative, got ${qty}`);
  }
  const available = from.get();
  if (qty > available) {
    throw new Error(`transfer would overdraw: qty ${qty} > available ${available}`);
  }
  from.add(-qty);
  to.add(qty);
  return qty;
}

/**
 * Move `min(qty, from)` — a saturating transfer for call sites where drawing
 * "up to" an amount is the intended semantics (e.g. headroom-limited plant
 * photosynthesis, corpse decay of whatever remains). Still integer-guarded and
 * still conservative (never mints, never overdraws). Returns the amount moved.
 */
export function transferUpTo(from: Compartment, to: Compartment, qty: number): number {
  if (!Number.isInteger(qty)) {
    throw new Error(`transferUpTo qty must be an integer, got ${qty}`);
  }
  if (qty < 0) {
    throw new Error(`transferUpTo qty must be non-negative, got ${qty}`);
  }
  const moved = Math.min(qty, from.get());
  from.add(-moved);
  to.add(moved);
  return moved;
}

/**
 * Convert a float quantity to the integer quantum actually entering a ledger.
 * **`Math.round`, once, at the moment it enters the ledger** — the single pinned
 * rule (plan Conventions block); never `floor`/`ceil`, never round twice. This is
 * what makes two runs subtract the identical integer and stay bit-identical.
 */
export function toQuantum(value: number): number {
  return Math.round(value);
}
