//! The injected clock — the determinism seam for time-based behavior.
//!
//! The lifecycle's cooling periods and the materializer's budgets are the
//! only time-sensitive decisions in the runtime. They never read the wall
//! clock directly: they call `Clock.now()`, so tests inject a `FakeClock`
//! and the transition log is byte-deterministic (Architecture.md §5).

/** A time source. `now()` returns monotonic-ish milliseconds. */
export interface Clock {
  now(): number;
}

/** The wall clock (production). */
export const realClock: Clock = {
  now: () => Date.now(),
};

/** A deterministic, test-injectable clock. */
export class FakeClock implements Clock {
  private t = 0;

  /** The current fake time in milliseconds. */
  now(): number {
    return this.t;
  }

  /** Advance the clock by `ms` milliseconds. */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`clock advance must be a non-negative finite number, got ${ms}`);
    }
    this.t += ms;
  }
}
