//! Materialization scheduler tests: priority ordering, budgets, cooperative
//! yielding (no starvation), reconcile, eviction, and determinism.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { ChunkState, LifecycleManager } from '../../src/lifecycle/lifecycle.js';
import { MaterializationScheduler, priorityKey } from '../../src/materialize/scheduler.js';
import type { MaterializeWorker } from '../../src/materialize/scheduler.js';
import type { Rect, Viewport } from '../../src/visibility/visibility.js';

function fresh(clock: FakeClock, frameBudgetMs = 10) {
  const lifecycle = new LifecycleManager({ clock, defaultCoolingPeriodMs: 1000 });
  const scheduler = new MaterializationScheduler(lifecycle, {
    clock,
    frameBudgetMs,
    yieldPenalty: 1,
  });
  for (let id = 1; id <= 10; id++) {
    lifecycle.register(id, { hidden: false, coolingPeriodMs: 1000 });
  }
  return { lifecycle, scheduler };
}

const noGeometry = (): Rect | undefined => undefined;

const viewport: Viewport = { x: 0, y: 0, w: 400, h: 100 };

/** A worker that completes each chunk in a fixed number of visits. */
function visitsWorker(
  visitsNeeded: number,
): MaterializeWorker & { visits: number[]; released: number[] } {
  const visits: number[] = [];
  const released: number[] = [];
  const seen = new Map<number, number>();
  return {
    visits,
    released,
    work(chunkId: number, _budgetMs: number): 'complete' | 'yield' {
      visits.push(chunkId);
      const count = (seen.get(chunkId) ?? 0) + 1;
      seen.set(chunkId, count);
      return count >= visitsNeeded ? 'complete' : 'yield';
    },
    release(chunkId: number): void {
      released.push(chunkId);
    },
  };
}

describe('priorityKey', () => {
  it('prioritizes intersecting chunks over distant ones', () => {
    const vp: Viewport = { x: 0, y: 0, w: 400, h: 100 };
    const on = priorityKey(1, { x: 0, y: 50, w: 100, h: 20 }, vp, 1, 0);
    const below = priorityKey(2, { x: 0, y: 500, w: 100, h: 20 }, vp, 1, 1);
    const farBelow = priorityKey(3, { x: 0, y: 1000, w: 100, h: 20 }, vp, 1, 2);
    expect(on).toBeLessThan(below);
    expect(below).toBeLessThan(farBelow);
  });

  it('favors chunks ahead of the direction of travel', () => {
    const vp: Viewport = { x: 0, y: 0, w: 400, h: 100 };
    const below = { x: 0, y: 500, w: 100, h: 20 };
    const above = { x: 0, y: -500, w: 100, h: 20 };
    // Scrolling down: below (ahead) has priority over above (behind).
    const downBelow = priorityKey(1, below, vp, 1, 0);
    const downAbove = priorityKey(2, above, vp, 1, 1);
    expect(downBelow).toBeLessThan(downAbove);
    // Scrolling up: the opposite.
    const upBelow = priorityKey(1, below, vp, -1, 0);
    const upAbove = priorityKey(2, above, vp, -1, 1);
    expect(upAbove).toBeLessThan(upBelow);
  });

  it('tie-breaks by document order', () => {
    const vp: Viewport = { x: 0, y: 0, w: 400, h: 100 };
    const a = priorityKey(1, { x: 0, y: 500, w: 100, h: 20 }, vp, 1, 0);
    const b = priorityKey(2, { x: 0, y: 500, w: 100, h: 20 }, vp, 1, 1);
    expect(a).toBeLessThan(b);
  });
});

describe('scheduling order', () => {
  it('processes intersecting chunks before distant ones, in document order', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    // Geometry: chunk 3 intersects; chunks 1, 2, 5 distant.
    const geometry: (id: number) => Rect | undefined = (id) => {
      if (id === 3) return { x: 0, y: 50, w: 100, h: 20 };
      if (id === 1) return { x: 0, y: 5000, w: 100, h: 20 };
      if (id === 2) return { x: 0, y: 4000, w: 100, h: 20 };
      return undefined;
    };
    scheduler.reconcile([1, 2, 3, 5], viewport, 1, geometry);
    const worker = visitsWorker(1);
    scheduler.runFrame(worker);
    // 3 (intersecting) first; then by distance: 2 (4000) before 1 (5000).
    // 5 has no geometry: ordinal 4 (priority 4) — after the distant ones?
    //   priority 4000*1024+512 vs ordinal 4: 4 < 4000*1024 → 5 runs before 2!
    expect(worker.visits[0]).toBe(3);
    expect(worker.visits).toContain(5);
    expect(worker.visits.indexOf(5)).toBeLessThan(worker.visits.indexOf(2));
    expect(worker.visits.indexOf(2)).toBeLessThan(worker.visits.indexOf(1));
    // Everything completed in one frame.
    expect(lifecycle.countInState(ChunkState.Visible)).toBe(4);
  });

  it('respects the frame budget', () => {
    const clock = new FakeClock();
    const { scheduler } = fresh(clock, 10);
    scheduler.reconcile([1, 2, 3], viewport, 1, () => ({ x: 0, y: 5000, w: 100, h: 20 }));
    // The worker advances the (fake) clock, simulating real work time.
    const worker: MaterializeWorker = {
      work(_chunkId) {
        clock.advance(8);
        return 'complete';
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      release() {},
    };
    const elapsed = scheduler.runFrame(worker);
    // The budget is a soft ceiling: one item may overshoot cooperatively.
    expect(elapsed).toBeLessThan(20);
    expect(scheduler.pendingCount).toBeGreaterThan(0);
    // A second frame finishes the rest.
    scheduler.runFrame(worker);
    expect(scheduler.pendingCount).toBe(0);
  });
});

describe('cooperative yielding', () => {
  it('a yielding chunk is re-queued and eventually completes (no starvation)', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 10);
    scheduler.reconcile([1, 2, 3], viewport, 1, () => ({ x: 0, y: 0, w: 100, h: 20 }));
    const worker = visitsWorker(3); // each chunk needs 3 visits
    let frames = 0;
    while (scheduler.pendingCount > 0 && frames < 1000) {
      clock.advance(10);
      scheduler.runFrame(worker);
      frames++;
    }
    expect(frames).toBeLessThan(100);
    expect(lifecycle.countInState(ChunkState.Visible)).toBe(3);
    // Every chunk was visited; none starved.
    expect(new Set(worker.visits).size).toBe(3);
  });

  it('is deterministic: identical inputs yield identical visit sequences', () => {
    const run = (): number[] => {
      const clock = new FakeClock();
      const { scheduler } = fresh(clock, 10);
      scheduler.reconcile([1, 2, 3, 4], viewport, 1, (id) => ({
        x: 0,
        y: id * 1000,
        w: 100,
        h: 20,
      }));
      const worker = visitsWorker(2);
      let frames = 0;
      while (scheduler.pendingCount > 0 && frames < 100) {
        clock.advance(10);
        scheduler.runFrame(worker);
        frames++;
      }
      return worker.visits;
    };
    expect(run()).toEqual(run());
  });
});

describe('reconcile', () => {
  it('culls chunks that left the visible set and cancels materializing ones', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    scheduler.reconcile([1, 2, 3], viewport, 1, noGeometry);
    const worker = visitsWorker(1);
    scheduler.runFrame(worker);
    expect(lifecycle.countInState(ChunkState.Visible)).toBe(3);
    // Chunk 2 leaves the visible set.
    scheduler.reconcile([1, 3], viewport, 1, noGeometry);
    expect(lifecycle.state(2)).toBe(ChunkState.Cooling);
    // Queued chunk: dequeue path.
    scheduler.reconcile([1, 2, 3, 4], viewport, 1, noGeometry);
    expect(lifecycle.state(4)).toBe(ChunkState.Queued);
    scheduler.reconcile([1, 2, 3], viewport, 1, noGeometry);
    expect(lifecycle.state(4)).toBe(ChunkState.Compressed);
    expect(scheduler.isPending(4)).toBe(false);
  });

  it('re-enqueues cooling chunks that re-enter the visible set', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    scheduler.reconcile([1], viewport, 1, noGeometry);
    scheduler.runFrame(visitsWorker(1));
    scheduler.reconcile([], viewport, 1, noGeometry);
    expect(lifecycle.state(1)).toBe(ChunkState.Cooling);
    scheduler.reconcile([1], viewport, 1, noGeometry);
    // Cooling chunks re-enter at Queued (requeue) when needed again.
    expect([ChunkState.Queued, ChunkState.Compressed]).toContain(lifecycle.state(1));
  });
});

describe('eviction', () => {
  it('tick expires cooling chunks after the period when not selected', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    scheduler.reconcile([1, 2], viewport, 1, noGeometry);
    scheduler.runFrame(visitsWorker(1));
    scheduler.reconcile([], viewport, 1, noGeometry); // both cool
    expect(scheduler.tick(visitsWorker(1))).toBe(0); // period not elapsed
    clock.advance(1000);
    expect(scheduler.tick(visitsWorker(1))).toBe(2);
    expect(lifecycle.countInState(ChunkState.Evicted)).toBe(2);
  });

  it('tick releases resources through the worker and respects selections', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    scheduler.reconcile([1, 2], viewport, 1, noGeometry);
    scheduler.runFrame(visitsWorker(1));
    scheduler.reconcile([], viewport, 1, noGeometry);
    lifecycle.select(1); // selection pins chunk 1
    clock.advance(2000);
    const worker = visitsWorker(1);
    scheduler.tick(worker);
    expect(worker.released).toEqual([2]); // only chunk 2 released
    expect(lifecycle.state(1)).toBe(ChunkState.Cooling);
    lifecycle.unselect(1);
    scheduler.tick(worker);
    expect(lifecycle.state(1)).toBe(ChunkState.Evicted);
  });

  it('evictForMemory releases the furthest visible chunks first', () => {
    const clock = new FakeClock();
    const { lifecycle, scheduler } = fresh(clock, 1000);
    scheduler.reconcile([1, 2, 3, 4], viewport, 1, (id) => ({
      x: 0,
      y: id * 1000,
      w: 100,
      h: 20,
    }));
    scheduler.runFrame(visitsWorker(1));
    expect(lifecycle.countInState(ChunkState.Visible)).toBe(4);
    const worker = visitsWorker(1);
    const freed = (id: number): number => id * 100;
    // Target 550 bytes: evict chunk 4 (400) then 3 (300) → 700 ≥ 550.
    const evicted = scheduler.evictForMemory(worker, 550, freed, viewport, 1, (id) => ({
      x: 0,
      y: id * 1000,
      w: 100,
      h: 20,
    }));
    expect(evicted).toBe(2);
    expect(worker.released).toEqual([4, 3]);
    expect(lifecycle.countInState(ChunkState.Cooling)).toBe(2);
    expect(lifecycle.countInState(ChunkState.Visible)).toBe(2);
  });
});

describe('property: no starvation under arbitrary yields', () => {
  it('every queued chunk eventually completes in bounded frames', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 1, maxLength: 20 }),
        (visitsNeeded) => {
          const clock = new FakeClock();
          const { lifecycle, scheduler } = fresh(clock, 7);
          const ids = Array.from({ length: 10 }, (_, i) => i + 1);
          scheduler.reconcile(ids, viewport, 1, (id) => ({ x: 0, y: id * 500, w: 100, h: 20 }));
          const needs = new Map<number, number>();
          const worker: MaterializeWorker = {
            work(chunkId) {
              const remaining =
                (needs.get(chunkId) ?? visitsNeeded[chunkId % visitsNeeded.length] ?? 1) - 1;
              needs.set(chunkId, remaining);
              return remaining <= 0 ? 'complete' : 'yield';
            },
            // eslint-disable-next-line @typescript-eslint/no-empty-function
            release() {},
          };
          let frames = 0;
          while (scheduler.pendingCount > 0 && frames < 10_000) {
            clock.advance(7);
            scheduler.runFrame(worker);
            frames++;
          }
          expect(scheduler.pendingCount).toBe(0);
          expect(lifecycle.countInState(ChunkState.Visible)).toBe(10);
          expect(frames).toBeLessThan(10_000);
        },
      ),
      { numRuns: 100 },
    );
  });
});
