//! The chunk lifecycle state machine (Architecture.md §4).
//!
//! Every chunk moves through deterministic states:
//!
//! ```text
//! Compressed ──(enqueue)──▶ Queued ──(begin)──▶ Materializing ──(complete)──▶ Visible
//!     ▲                        │  ▲                 │                            │
//!     │                        │  └──(budget exhausted: stays Queued)           │
//!     │                        │ (dequeue)          │ (cancel)                  │
//!     │                        ▼                    ▼                            ▼
//!     └───────────(requeue)── Cooling ◀──────────(cull: left visible set)───────┘
//!                                │
//!                                │ (expire: cooling elapsed, no selection)
//!                                ▼
//!                            Evicted ──(resources released)──▶ (re-enters at Queued on enqueue)
//! ```
//!
//! Every transition is explicit, guarded, and recorded in a transition log
//! (deterministic under an injected clock). Hidden chunks never enter the
//! queue; a cooling chunk with an active selection cannot be evicted.

import type { Clock } from '../clock.js';

/** The six lifecycle states. */
export enum ChunkState {
  Compressed = 0,
  Queued = 1,
  Materializing = 2,
  Visible = 3,
  Cooling = 4,
  Evicted = 5,
}

/** The lifecycle events that drive transitions. */
export type LifecycleEvent =
  'enqueue' | 'begin' | 'dequeue' | 'complete' | 'cancel' | 'cull' | 'requeue' | 'expire';

/** One recorded transition. */
export interface Transition {
  readonly chunkId: number;
  readonly event: LifecycleEvent;
  readonly from: ChunkState;
  readonly to: ChunkState;
  /** `Clock.now()` at the transition (deterministic under an injected clock). */
  readonly time: number;
}

/** A lifecycle violation (guards / illegal transitions). */
export class LifecycleError extends Error {
  readonly chunkId: number;
  readonly event: LifecycleEvent;
  readonly state: ChunkState;

  constructor(chunkId: number, event: LifecycleEvent, state: ChunkState, detail: string) {
    super(`lifecycle: chunk ${chunkId} cannot ${event} from ${ChunkState[state]}: ${detail}`);
    this.name = 'LifecycleError';
    this.chunkId = chunkId;
    this.event = event;
    this.state = state;
  }
}
/** The allowed (event, from) transitions per state. */
const TRANSITIONS: Record<ChunkState, LifecycleEvent[]> = {
  [ChunkState.Compressed]: ['enqueue'],
  [ChunkState.Queued]: ['begin', 'dequeue'],
  [ChunkState.Materializing]: ['complete', 'cancel'],
  [ChunkState.Visible]: ['cull'],
  [ChunkState.Cooling]: ['requeue', 'expire'],
  [ChunkState.Evicted]: ['enqueue'],
};

/** The destination state for each allowed transition. */
function destination(event: LifecycleEvent): ChunkState {
  switch (event) {
    case 'enqueue':
      return ChunkState.Queued;
    case 'begin':
      return ChunkState.Materializing;
    case 'dequeue':
      return ChunkState.Compressed;
    case 'complete':
      return ChunkState.Visible;
    case 'cancel':
      return ChunkState.Compressed;
    case 'cull':
      return ChunkState.Cooling;
    case 'requeue':
      return ChunkState.Queued;
    case 'expire':
      return ChunkState.Evicted;
    default:
      // Exhaustive: every LifecycleEvent is covered above.
      throw new Error(`unhandled lifecycle event ${event as string}`);
  }
}

/** Per-chunk lifecycle configuration. */
export interface ChunkLifecycleConfig {
  /** Chunks excluded by semantic culling never enter the queue. */
  readonly hidden: boolean;
  /** The cooling period (ms) before an evicted chunk can be released. */
  readonly coolingPeriodMs: number;
}

/** Options for the lifecycle manager. */
export interface LifecycleOptions {
  /** The clock used for cooling timestamps (deterministic in tests). */
  readonly clock: Clock;
  /** Default cooling period for chunks without explicit configuration. */
  readonly defaultCoolingPeriodMs: number;
}

/**
 * The lifecycle manager: owns every chunk's state, guards every transition,
 * and records the transition log. Chunks register once at load with their
 * hidden flag; selection references pin cooling chunks against eviction.
 */
export class LifecycleManager {
  private readonly clock: Clock;
  private readonly defaultCoolingPeriodMs: number;
  private readonly states = new Map<number, ChunkState>();
  private readonly hidden = new Map<number, boolean>();
  private readonly coolingPeriod = new Map<number, number>();
  private readonly coolingStartedAt = new Map<number, number>();
  private readonly selectionRefs = new Map<number, number>();
  private readonly log: Transition[] = [];

  constructor(options: LifecycleOptions) {
    this.clock = options.clock;
    this.defaultCoolingPeriodMs = options.defaultCoolingPeriodMs;
    if (!Number.isFinite(this.defaultCoolingPeriodMs) || this.defaultCoolingPeriodMs < 0) {
      throw new RangeError('default cooling period must be a non-negative finite number');
    }
  }

  /** Register a chunk (idempotent); resets its state to Compressed. */
  register(chunkId: number, config: ChunkLifecycleConfig): void {
    if (!Number.isSafeInteger(chunkId) || chunkId < 1) {
      throw new RangeError(`chunk id must be a positive integer, got ${chunkId}`);
    }
    this.states.set(chunkId, ChunkState.Compressed);
    this.hidden.set(chunkId, config.hidden);
    this.coolingPeriod.set(chunkId, config.coolingPeriodMs);
    this.coolingStartedAt.delete(chunkId);
    this.selectionRefs.delete(chunkId);
  }

  /** Whether a chunk is registered. */
  has(chunkId: number): boolean {
    return this.states.has(chunkId);
  }

  /** The current state of a registered chunk (Compressed when unregistered). */
  state(chunkId: number): ChunkState {
    return this.states.get(chunkId) ?? ChunkState.Compressed;
  }

  /** Whether the chunk is excluded by semantic culling. */
  isHidden(chunkId: number): boolean {
    return this.hidden.get(chunkId) ?? false;
  }

  /** Pin a chunk against eviction (selection). Idempotent. */
  select(chunkId: number): void {
    this.selectionRefs.set(chunkId, (this.selectionRefs.get(chunkId) ?? 0) + 1);
  }

  /** Release a selection pin. */
  unselect(chunkId: number): void {
    const current = this.selectionRefs.get(chunkId) ?? 0;
    if (current <= 1) {
      this.selectionRefs.delete(chunkId);
    } else {
      this.selectionRefs.set(chunkId, current - 1);
    }
  }

  /** Whether the chunk is referenced by an active selection. */
  isSelected(chunkId: number): boolean {
    return (this.selectionRefs.get(chunkId) ?? 0) > 0;
  }

  /** The recorded transition log (in order). */
  transitions(): readonly Transition[] {
    return this.log;
  }

  /** The number of chunks in a given state. */
  countInState(state: ChunkState): number {
    let count = 0;
    for (const s of this.states.values()) {
      if (s === state) count++;
    }
    return count;
  }

  /** All chunk ids in a given state. */
  chunksInState(state: ChunkState): number[] {
    const out: number[] = [];
    for (const [id, s] of this.states) {
      if (s === state) out.push(id);
    }
    return out;
  }

  /** The chunk ids currently cooling, with the time remaining (ms). */
  coolingRemaining(): Map<number, number> {
    const now = this.clock.now();
    const out = new Map<number, number>();
    for (const [id, started] of this.coolingStartedAt) {
      const period = this.coolingPeriod.get(id) ?? this.defaultCoolingPeriodMs;
      out.set(id, Math.max(0, period - (now - started)));
    }
    return out;
  }

  /**
   * Apply an event. Returns the destination state on success, or throws a
   * typed `LifecycleError` when the transition is illegal or a guard fails.
   */
  transition(chunkId: number, event: LifecycleEvent): ChunkState {
    const state = this.state(chunkId);
    const allowed = TRANSITIONS[state];
    if (!allowed.includes(event)) {
      throw new LifecycleError(chunkId, event, state, `transition not in {${allowed.join(', ')}}`);
    }
    switch (event) {
      case 'enqueue': {
        if (this.isHidden(chunkId)) {
          throw new LifecycleError(chunkId, event, state, 'hidden chunks never enter the queue');
        }
        break;
      }
      case 'expire': {
        const started = this.coolingStartedAt.get(chunkId);
        if (started === undefined) {
          throw new LifecycleError(chunkId, event, state, 'no cooling start recorded');
        }
        const period = this.coolingPeriod.get(chunkId) ?? this.defaultCoolingPeriodMs;
        if (this.clock.now() - started < period) {
          throw new LifecycleError(chunkId, event, state, 'cooling period has not elapsed');
        }
        if (this.isSelected(chunkId)) {
          throw new LifecycleError(chunkId, event, state, 'chunk is referenced by a selection');
        }
        break;
      }
      case 'cull': {
        this.coolingStartedAt.set(chunkId, this.clock.now());
        break;
      }
      default:
        break;
    }
    const to = destination(event);
    this.states.set(chunkId, to);
    this.log.push({ chunkId, event, from: state, to, time: this.clock.now() });
    if (event === 'requeue' || event === 'cancel' || event === 'dequeue') {
      this.coolingStartedAt.delete(chunkId);
    }
    if (to === ChunkState.Queued) {
      this.coolingStartedAt.delete(chunkId);
    }
    return to;
  }
}
