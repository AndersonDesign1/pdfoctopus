// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A small seeded random number generator (mulberry32), so every fuzz run can be repeated
// exactly from its seed.

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** A whole number from 0 to 2^32 - 1. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** A whole number from 0 to n - 1 (0 when n is 0 or less). */
  int(n: number): number {
    if (n <= 0) return 0;
    return Math.floor((this.next() / 0x1_0000_0000) * n);
  }

  /** A whole number from min to max, both included. */
  range(min: number, max: number): number {
    return min + this.int(max - min + 1);
  }

  chance(p: number): boolean {
    return this.next() / 0x1_0000_0000 < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Nothing to pick from");
    return items[this.int(items.length)] as T;
  }

  /** A new generator whose numbers depend only on this one's seed and `salt`. */
  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0);
  }
}

/** Seeds for the variants of a run: the same run seed always gives the same list. */
export function variantSeed(runSeed: number, index: number): number {
  return new Rng((runSeed ^ Math.imul(index + 1, 0x85ebca6b)) >>> 0).next();
}
