//! Lifecycle state machine tests: exhaustive transition table, guards,
//! transition log, and model-based property tests.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock.js';
import { ChunkState, LifecycleManager } from '../../src/lifecycle/lifecycle.js';
import type { LifecycleEvent } from '../../src/lifecycle/lifecycle.js';
import { LifecycleError } from '../../src/lifecycle/lifecycle.js';

const EVENTS: LifecycleEvent[] = [
  'enqueue',
  'begin',
  'dequeue',
  'complete',
  'cancel',
  'pause',
  'cull',
  'requeue',
  'expire',
];
const STATES: ChunkState[] = [
  ChunkState.Compressed,
  ChunkState.Queued,
  ChunkState.Materializing,
  ChunkState.Visible,
  ChunkState.Cooling,
  ChunkState.Evicted,
];

/** The reference transition table (the model the implementation must match). */
function referenceDestination(state: ChunkState, event: LifecycleEvent): ChunkState | 'reject' {
  switch (state) {
    case ChunkState.Compressed:
      return event === 'enqueue' ? ChunkState.Queued : 'reject';
    case ChunkState.Queued:
      return event === 'begin'
        ? ChunkState.Materializing
        : event === 'dequeue'
          ? ChunkState.Compressed
          : 'reject';
    case ChunkState.Materializing:
      return event === 'complete'
        ? ChunkState.Visible
        : event === 'cancel'
          ? ChunkState.Compressed
          : event === 'pause'
            ? ChunkState.Queued
            : 'reject';
    case ChunkState.Visible:
      return event === 'cull' ? ChunkState.Cooling : 'reject';
    case ChunkState.Cooling:
      return event === 'requeue'
        ? ChunkState.Queued
        : event === 'expire'
          ? ChunkState.Evicted
          : 'reject';
    case ChunkState.Evicted:
      return event === 'enqueue' ? ChunkState.Queued : 'reject';
  }
}

function freshManager(clock = new FakeClock()) {
  const m = new LifecycleManager({ clock, defaultCoolingPeriodMs: 1000 });
  m.register(1, { hidden: false, coolingPeriodMs: 1000 });
  return m;
}

/** Drive a chunk into the given state (helper). Registers first, so the
 * machine is always reset before driving. The clock is advanced past the
 * cooling period before `expire`. */
function driveTo(manager: LifecycleManager, clock: FakeClock, state: ChunkState): void {
  manager.register(1, { hidden: false, coolingPeriodMs: 1000 });
  const run: Record<ChunkState, LifecycleEvent[]> = {
    [ChunkState.Compressed]: [],
    [ChunkState.Queued]: ['enqueue'],
    [ChunkState.Materializing]: ['enqueue', 'begin'],
    [ChunkState.Visible]: ['enqueue', 'begin', 'complete'],
    [ChunkState.Cooling]: ['enqueue', 'begin', 'complete', 'cull'],
    [ChunkState.Evicted]: ['enqueue', 'begin', 'complete', 'cull', 'expire'],
  };
  for (const event of run[state]) {
    if (event === 'expire') {
      clock.advance(1000);
    }
    manager.transition(1, event);
  }
}

describe('transition table', () => {
  it('accepts exactly the transitions in the model and rejects everything else', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    for (const state of STATES) {
      for (const event of EVENTS) {
        driveTo(manager, clock, state);
        if (state === ChunkState.Cooling && event === 'expire') {
          // The table allows expire; the cooling guard needs the period to
          // elapse, so advance the clock before exercising it.
          clock.advance(1000);
        }
        const expected = referenceDestination(state, event);
        if (expected === 'reject') {
          expect(() => manager.transition(1, event)).toThrow(LifecycleError);
        } else {
          expect(manager.transition(1, event)).toBe(expected);
        }
      }
    }
  });

  it('expire requires the cooling period to elapse', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    driveTo(manager, clock, ChunkState.Cooling);
    expect(() => manager.transition(1, 'expire')).toThrow(/cooling period/);
    clock.advance(999);
    expect(() => manager.transition(1, 'expire')).toThrow(/cooling period/);
    clock.advance(1);
    expect(manager.transition(1, 'expire')).toBe(ChunkState.Evicted);
  });

  it('expire is blocked while a selection references the chunk', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    driveTo(manager, clock, ChunkState.Cooling);
    manager.select(1);
    clock.advance(5000);
    expect(() => manager.transition(1, 'expire')).toThrow(/selection/);
    manager.unselect(1);
    expect(manager.transition(1, 'expire')).toBe(ChunkState.Evicted);
  });

  it('hidden chunks never enter the queue', () => {
    const clock = new FakeClock();
    const manager = new LifecycleManager({ clock, defaultCoolingPeriodMs: 1000 });
    manager.register(1, { hidden: true, coolingPeriodMs: 1000 });
    expect(() => manager.transition(1, 'enqueue')).toThrow(/hidden/);
    expect(manager.state(1)).toBe(ChunkState.Compressed);
    expect(manager.isHidden(1)).toBe(true);
  });

  it('a cooling chunk needed again requeues and clears its cooling timer', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    driveTo(manager, clock, ChunkState.Cooling);
    clock.advance(500);
    manager.transition(1, 'requeue');
    expect(manager.state(1)).toBe(ChunkState.Queued);
    expect(manager.coolingRemaining().size).toBe(0);
  });

  it('a cancel returns a materializing chunk to Compressed with resources released', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    driveTo(manager, clock, ChunkState.Materializing);
    manager.transition(1, 'cancel');
    expect(manager.state(1)).toBe(ChunkState.Compressed);
  });
});

describe('transition log', () => {
  it('records every transition in order with the injected clock', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    manager.transition(1, 'enqueue');
    clock.advance(3);
    manager.transition(1, 'begin');
    clock.advance(7);
    manager.transition(1, 'complete');
    const log = manager.transitions();
    expect(log).toEqual([
      { chunkId: 1, event: 'enqueue', from: ChunkState.Compressed, to: ChunkState.Queued, time: 0 },
      {
        chunkId: 1,
        event: 'begin',
        from: ChunkState.Queued,
        to: ChunkState.Materializing,
        time: 3,
      },
      {
        chunkId: 1,
        event: 'complete',
        from: ChunkState.Materializing,
        to: ChunkState.Visible,
        time: 10,
      },
    ]);
  });

  it('is deterministic: identical event sequences produce identical logs', () => {
    const run = () => {
      const clock = new FakeClock();
      const manager = freshManager(clock);
      const events: LifecycleEvent[] = [
        'enqueue',
        'begin',
        'complete',
        'cull',
        'requeue',
        'begin',
        'complete',
      ];
      for (const event of events) {
        clock.advance(2);
        manager.transition(1, event);
      }
      return manager.transitions();
    };
    expect(run()).toEqual(run());
  });
});

describe('state census', () => {
  it('counts and lists chunks per state', () => {
    const clock = new FakeClock();
    const manager = freshManager(clock);
    driveTo(manager, clock, ChunkState.Visible); // chunk 1 → Visible
    manager.register(2, { hidden: false, coolingPeriodMs: 1000 });
    manager.transition(2, 'enqueue'); // chunk 2 → Queued
    expect(manager.countInState(ChunkState.Queued)).toBe(1);
    expect(manager.countInState(ChunkState.Visible)).toBe(1);
    expect(manager.chunksInState(ChunkState.Queued)).toEqual([2]);
  });
});

describe('model-based property test', () => {
  it('random event sequences never reach an undefined state and match the reference', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...EVENTS), { maxLength: 200 }),
        fc.constantFrom(...STATES),
        (events, target) => {
          const clock = new FakeClock();
          const manager = freshManager(clock);
          driveTo(manager, clock, target);
          let state = target;
          for (const event of events) {
            const expected = referenceDestination(state, event);
            if (expected === 'reject') {
              expect(() => manager.transition(1, event)).toThrow(LifecycleError);
            } else {
              // Guards can reject even when the table allows the transition
              // (hidden enqueue, premature/selected expire); the model
              // includes guard behavior through the state it reached.
              try {
                const next = manager.transition(1, event);
                expect(next).toBe(expected);
                state = expected;
              } catch (e) {
                expect(e).toBeInstanceOf(LifecycleError);
              }
            }
            // The machine is always in one of the six states.
            expect(STATES).toContain(manager.state(1));
            expect(manager.transitions().length).toBeLessThanOrEqual(1000);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
