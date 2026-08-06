//! The streaming materialization scheduler (Architecture.md §3.4).
//!
//! Chunks enter a deterministic priority queue; work is executed within a
//! per-frame time budget and yields cooperatively (`yield` → the chunk pauses
//! back to Queued and is re-queued with a penalty, so no chunk can starve
//! others). Every state change goes through the lifecycle manager — the
//! scheduler never mutates chunk state directly.
//!
//! Priorities are pure functions of (geometry, viewport, direction of
//! travel): no wall clock affects decisions (the clock only *measures* the
//! frame budget), so behavior is reproducible. Eviction follows
//! LRU-with-age through the lifecycle's Cooling → Evicted path; memory
//! pressure evicts the furthest visible chunks first (never failing).

import type { Clock } from '../clock.js';
import { ChunkState } from '../lifecycle/lifecycle.js';
import type { LifecycleManager } from '../lifecycle/lifecycle.js';
import type { Rect, Viewport } from '../visibility/visibility.js';

/** The unit of materialization work. */
export interface MaterializeWorker {
  /**
   * Perform work for a chunk within the remaining frame budget.
   * @returns `complete` when the chunk's materialization is done, or
   *          `yield` when it needs another frame (budget exhausted or
   *          cooperatively yielding).
   */
  work(chunkId: number, budgetMs: number, elapsedMs: number): 'complete' | 'yield';
  /** Release the resources of a chunk being evicted. */
  release(chunkId: number): void;
}

/** Options for the scheduler. */
export interface SchedulerOptions {
  /** The clock used to measure frame budgets. */
  readonly clock: Clock;
  /** The default per-frame time budget in milliseconds. */
  readonly frameBudgetMs: number;
  /** The priority penalty applied per cooperative yield (anti-starvation). */
  readonly yieldPenalty: number;
}

/** One queued item. */
interface QueueItem {
  readonly chunkId: number;
  /** Deterministic priority: lower runs first. */
  readonly key: number;
  /** Document-order tie-break. */
  readonly ordinal: number;
}

/** A deterministic binary min-heap over (key, ordinal). */
class PriorityQueue {
  private items: QueueItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: QueueItem): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (less(items[i]!, items[parent]!)) {
        const tmp = items[i]!;
        items[i] = items[parent]!;
        items[parent] = tmp;
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): QueueItem | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && less(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        const tmp = items[i]!;
        items[i] = items[smallest]!;
        items[smallest] = tmp;
        i = smallest;
      }
    }
    return top;
  }

  /** Remove an item by chunk id (used when a queued chunk is culled). */
  remove(chunkId: number): void {
    const idx = this.items.findIndex((item) => item.chunkId === chunkId);
    if (idx === -1) return;
    const items = this.items;
    const last = items.pop()!;
    if (idx < items.length) {
      items[idx] = last;
      // Restore heap property from the replaced position (sift up then down).
      let i = idx;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (less(items[i]!, items[parent]!)) {
          const tmp = items[i]!;
          items[i] = items[parent]!;
          items[parent] = tmp;
          i = parent;
        } else {
          break;
        }
      }
      for (;;) {
        const left = i * 2 + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && less(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === i) break;
        const tmp = items[i]!;
        items[i] = items[smallest]!;
        items[smallest] = tmp;
        i = smallest;
      }
    }
  }
}

function less(a: QueueItem, b: QueueItem): boolean {
  return a.key !== b.key ? a.key < b.key : a.ordinal < b.ordinal;
}

/**
 * The deterministic priority key for a chunk: intersecting chunks first (in
 * document order), then distance tiers (1024 px), with chunks ahead of the
 * direction of travel preferred within a tier, then document order.
 * Chunks without geometry sort by document order (the sequential frontier).
 */
export function priorityKey(
  chunkId: number,
  rect: Rect | undefined,
  viewport: Viewport,
  direction: 1 | -1,
  ordinal: number,
): number {
  if (rect === undefined) {
    return ordinal;
  }
  const above = viewport.y - (rect.y + rect.h);
  const below = rect.y - (viewport.y + viewport.h);
  let distance: number;
  if (above > 0) {
    distance = above;
  } else if (below > 0) {
    distance = below;
  } else {
    distance = 0;
  }
  if (distance === 0) {
    // Intersecting the viewport: highest priority, document order.
    return ordinal;
  }
  const tier = 1 + Math.floor(distance / 1024);
  const ahead = direction === 1 ? below > 0 : above > 0;
  void chunkId;
  return tier * 0x1_0000_0000 + (ahead ? 0 : 0x8000_0000) + ordinal;
}

/** The materialization scheduler. */
export class MaterializationScheduler {
  private readonly clock: Clock;
  private readonly frameBudgetMs: number;
  private readonly yieldPenalty: number;
  private readonly lifecycle: LifecycleManager;
  private readonly queue = new PriorityQueue();
  private readonly pending = new Set<number>();
  private readonly attempts = new Map<number, number>();
  private lastVisible = new Set<number>();

  constructor(lifecycle: LifecycleManager, options: SchedulerOptions) {
    this.lifecycle = lifecycle;
    this.clock = options.clock;
    this.frameBudgetMs = options.frameBudgetMs;
    this.yieldPenalty = options.yieldPenalty;
  }

  /** Whether a chunk is currently queued. */
  isPending(chunkId: number): boolean {
    return this.pending.has(chunkId);
  }

  /** The number of queued chunks. */
  get pendingCount(): number {
    return this.queue.size;
  }

  /**
   * Reconcile the visible set: enqueue newly visible chunks (priority from
   * geometry, viewport, and direction of travel) and cull/dequeue chunks
   * that left the visible set.
   */
  reconcile(
    visible: readonly number[],
    viewport: Viewport,
    direction: 1 | -1,
    geometry: (chunkId: number) => Rect | undefined,
  ): void {
    const nowVisible = new Set<number>(visible);
    for (const id of visible) {
      const state = this.lifecycle.state(id);
      if (state === ChunkState.Compressed || state === ChunkState.Evicted) {
        this.lifecycle.transition(id, 'enqueue');
      } else if (state === ChunkState.Cooling) {
        // A cooling chunk needed again re-enters the queue immediately.
        this.lifecycle.transition(id, 'requeue');
      }
      if (this.lifecycle.state(id) === ChunkState.Queued && !this.pending.has(id)) {
        this.enqueueWithPriority(id, viewport, direction, geometry);
      }
    }
    for (const id of this.lastVisible) {
      if (nowVisible.has(id)) continue;
      const state = this.lifecycle.state(id);
      switch (state) {
        case ChunkState.Queued:
          this.lifecycle.transition(id, 'dequeue');
          this.queue.remove(id);
          this.pending.delete(id);
          this.attempts.delete(id);
          break;
        case ChunkState.Materializing:
          this.lifecycle.transition(id, 'cancel');
          break;
        case ChunkState.Visible:
          this.lifecycle.transition(id, 'cull');
          break;
        default:
          break;
      }
    }
    this.lastVisible = nowVisible;
  }

  private enqueueWithPriority(
    chunkId: number,
    viewport: Viewport,
    direction: 1 | -1,
    geometry: (chunkId: number) => Rect | undefined,
  ): void {
    const ordinal = chunkId - 1; // ids are dense in document order
    const key = priorityKey(chunkId, geometry(chunkId), viewport, direction, ordinal);
    this.queue.push({ chunkId, key, ordinal });
    this.pending.add(chunkId);
  }

  /**
   * Run one frame of materialization work within the time budget. Returns
   * the elapsed milliseconds (measured, never affecting decisions).
   */
  runFrame(worker: MaterializeWorker): number {
    const start = this.clock.now();
    const budget = this.frameBudgetMs;
    while (this.queue.size > 0) {
      const elapsed = this.clock.now() - start;
      if (elapsed >= budget) break;
      const item = this.queue.pop()!;
      this.pending.delete(item.chunkId);
      if (this.lifecycle.state(item.chunkId) !== ChunkState.Queued) {
        // Culled or otherwise moved while queued; nothing to do.
        this.attempts.delete(item.chunkId);
        continue;
      }
      this.lifecycle.transition(item.chunkId, 'begin');
      const remaining = Math.max(0, budget - elapsed);
      const result = worker.work(item.chunkId, remaining, elapsed);
      if (result === 'complete') {
        this.lifecycle.transition(item.chunkId, 'complete');
        this.attempts.delete(item.chunkId);
      } else {
        // Cooperative yield: pause back to Queued and re-queue behind a
        // penalty so it cannot starve other chunks.
        this.lifecycle.transition(item.chunkId, 'pause');
        const attempts = (this.attempts.get(item.chunkId) ?? 0) + 1;
        this.attempts.set(item.chunkId, attempts);
        this.queue.push({
          chunkId: item.chunkId,
          key: item.key + attempts * this.yieldPenalty,
          ordinal: item.ordinal,
        });
        this.pending.add(item.chunkId);
      }
    }
    return this.clock.now() - start;
  }

  /**
   * Evict expired cooling chunks: releases resources through the worker,
   * then transitions Cooling → Evicted. Returns the number evicted.
   */
  tick(worker: MaterializeWorker): number {
    let evicted = 0;
    const ready: number[] = [];
    for (const [chunkId, remaining] of this.lifecycle.coolingRemaining()) {
      if (remaining <= 0 && !this.lifecycle.isSelected(chunkId)) {
        ready.push(chunkId);
      }
    }
    ready.sort((a, b) => a - b);
    for (const chunkId of ready) {
      worker.release(chunkId);
      this.lifecycle.transition(chunkId, 'expire');
      evicted++;
    }
    return evicted;
  }

  /**
   * Evict visible chunks for memory pressure: release the furthest-from-
   * viewport visible chunks first (deterministic), transitioning them to
   * Cooling. `freed` reports how many bytes each chunk's release frees.
   * Returns the number of chunks evicted.
   */
  evictForMemory(
    worker: MaterializeWorker,
    targetBytes: number,
    freed: (chunkId: number) => number,
    viewport: Viewport,
    direction: 1 | -1,
    geometry: (chunkId: number) => Rect | undefined,
  ): number {
    let freedSoFar = 0;
    let evicted = 0;
    const visibleChunks = this.lifecycle
      .chunksInState(ChunkState.Visible)
      .map((id) => ({
        id,
        key: priorityKey(id, geometry(id), viewport, direction, id - 1),
      }))
      .sort((a, b) => b.key - a.key || b.id - a.id); // furthest first
    for (const { id } of visibleChunks) {
      if (freedSoFar >= targetBytes) break;
      worker.release(id);
      this.lifecycle.transition(id, 'cull');
      freedSoFar += freed(id);
      evicted++;
    }
    return evicted;
  }
}
