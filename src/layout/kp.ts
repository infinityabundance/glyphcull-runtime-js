//! Knuth–Plass line breaking (Knuth & Plass, "Breaking Paragraphs into
//! Lines", 1981) — a faithful, deterministic implementation.
//!
//! Items are boxes, glue, and penalties. The dynamic program finds the
//! minimum-demerit sequence of feasible breakpoints; demerits are
//! `(line_penalty + badness + penalty)²`, badness is `100·|ρ|³` where `ρ`
//! is the adjustment ratio, and lines carry fitness classes (0 tight,
//! 1 decent, 2 loose, 3 very loose). The paper's twice-around fitness pass
//! is implemented: if the optimal solution has adjacent lines whose fitness
//! classes differ by more than one (0↔3), a second pass forbids those
//! transitions and its result is used.
//!
//! The caller must end the item list with a feasible breakpoint (a glue or a
//! forced-break penalty) so the final line always terminates.
//!
//! Determinism: ties (equal demerits) resolve to the first active node in
//! document order; no randomness anywhere.

/** A line-breaking item. */
export type KpItem =
  | { type: 'box'; width: number }
  | { type: 'glue'; width: number; stretch: number; shrink: number }
  | { type: 'penalty'; width: number; penalty: number };

/** One chosen line. */
export interface KpLine {
  /** Index of the first item of the line (inclusive). */
  readonly start: number;
  /** Index of the last item of the line (inclusive). */
  readonly end: number;
  /** The adjustment ratio ρ (0 = perfectly set). */
  readonly ratio: number;
  /** The line's badness. */
  readonly badness: number;
  /** The fitness class (0 tight … 3 very loose). */
  readonly fitness: number;
  /** Accumulated demerits up to and including this line. */
  readonly demerits: number;
}

/** A node in the active list. */
interface ActiveNode {
  readonly line: number;
  /** The breakpoint index where this node was created (0 for the start). */
  readonly breakpointIndex: number;
  readonly sumW: number;
  readonly sumS: number;
  readonly sumShrink: number;
  readonly sumDemerits: number;
  readonly fitness: number;
}

/** The chosen line ending at a breakpoint. */
interface ChosenLine {
  readonly startItem: number;
  readonly endItem: number;
  readonly ratio: number;
  readonly badness: number;
  readonly fitness: number;
  readonly demerits: number;
  readonly prevBreak: number;
}

const INF = Infinity;

function fitnessOf(ratio: number): number {
  if (ratio < -0.5) return 0;
  if (ratio < 0.5) return 1;
  if (ratio < 1) return 2;
  return 3;
}

/**
 * Compute the optimal line breaks for `items` given a target `lineWidth`.
 * `items` must end with a feasible breakpoint.
 */
export function lineBreak(
  items: KpItem[],
  lineWidth: number,
  tolerance = 100,
  linePenalty = 10,
): KpLine[] {
  if (items.length === 0) return [];
  const n = items.length;

  // Prefix sums of widths / stretch / shrink over items[0..k].
  const sumW = new Array<number>(n + 1).fill(0);
  const sumS = new Array<number>(n + 1).fill(0);
  const sumH = new Array<number>(n + 1).fill(0);
  for (let k = 0; k < n; k++) {
    const item = items[k]!;
    sumW[k + 1] = sumW[k]! + item.width;
    if (item.type === 'glue') {
      sumS[k + 1] = sumS[k]! + item.stretch;
      sumH[k + 1] = sumH[k]! + item.shrink;
    } else {
      sumS[k + 1] = sumS[k]!;
      sumH[k + 1] = sumH[k]!;
    }
  }

  const isBreakpoint = (j: number): boolean => {
    const item = items[j]!;
    if (item.type === 'glue') return true;
    return item.type === 'penalty' && item.penalty < INF;
  };

  const run = (fitnessPenalty: number): { lines: KpLine[]; badTransitions: boolean } => {
    let active: ActiveNode[] = [
      { line: 0, breakpointIndex: 0, sumW: 0, sumS: 0, sumShrink: 0, sumDemerits: 0, fitness: 1 },
    ];
    // chosen[j] = the best line ending at breakpoint j.
    const chosen = new Array<ChosenLine | null>(n + 1).fill(null);

    for (let j = 1; j < n; j++) {
      if (!isBreakpoint(j)) continue;
      const item = items[j]!;
      const penalty = item.type === 'penalty' ? item.penalty : 0;
      const forced = item.type === 'penalty' && item.penalty === -INF;

      const newNodes: ActiveNode[] = [];
      const remaining: ActiveNode[] = [];
      for (const node of active) {
        const width = sumW[j]! - node.sumW - item.width;
        const stretch = sumS[j]! - node.sumS;
        const shrink = sumH[j]! - node.sumShrink;
        let ratio: number;
        if (forced) {
          // A forced break always breaks; an overflowing line pays an
          // emergency-stretch badness (TeX \emergencystretch), so paths that
          // avoid overflow are preferred while the paragraph still ends.
          ratio = width <= lineWidth + 1e-9 ? 0 : (width - lineWidth) / 10;
        } else if (width <= lineWidth + 1e-9) {
          ratio = stretch > 0 ? (lineWidth - width) / stretch : 0;
        } else {
          if (shrink <= 0) continue;
          ratio = (lineWidth - width) / shrink;
        }
        if (!forced && (ratio < -1 || ratio > tolerance)) continue;

        const badness = ratio === 0 ? 0 : 100 * Math.pow(Math.abs(ratio), 3);
        const effectivePenalty = forced ? 0 : penalty;
        const demerits = (linePenalty + badness + effectivePenalty) ** 2;
        const fitness = fitnessOf(ratio);
        const fitPenalty = Math.abs(fitness - node.fitness) > 1 ? fitnessPenalty : 0;
        const total = node.sumDemerits + demerits + fitPenalty;

        if (chosen[j] === null || total < chosen[j]!.demerits) {
          chosen[j] = {
            startItem: node.breakpointIndex === 0 ? 0 : node.breakpointIndex + 1,
            endItem: j,
            ratio,
            badness,
            fitness,
            demerits: total,
            prevBreak: node.breakpointIndex,
          };
        }
        newNodes.push({
          line: node.line + 1,
          breakpointIndex: j,
          sumW: sumW[j]!,
          sumS: sumS[j]!,
          sumShrink: sumH[j]!,
          sumDemerits: total,
          fitness,
        });
        // The node stays active: its sequence can still extend further.
        remaining.push(node);
      }
      // The paper keeps at most one active node per (breakpoint, fitness)
      // class: the future cost of a line starting at this breakpoint depends
      // only on its prefix sums and fitness class, so only the minimal-
      // demerits path to each class can ever win. Without this deduplication
      // every feasible node would spawn a copy at every later breakpoint and
      // the active list would double per breakpoint (exponential blowup).
      const best = new Map<number, ActiveNode>();
      for (const node of newNodes) {
        const previous = best.get(node.fitness);
        if (previous === undefined || node.sumDemerits < previous.sumDemerits) {
          best.set(node.fitness, node);
        }
      }
      active = remaining.concat([...best.values()]);
    }

    // The last item is a feasible breakpoint (caller guarantees it).
    const finalBreak = n - 1;
    if (chosen[finalBreak] == null) {
      // Fallback (should not happen with a forced final break): one line.
      return {
        lines: [{ start: 0, end: finalBreak, ratio: 0, badness: 0, fitness: 1, demerits: 0 }],
        badTransitions: false,
      };
    }

    // Reconstruct backwards.
    const lines: KpLine[] = [];
    let cursor = finalBreak;
    let badTransitions = false;
    let prevFitness = 1;
    while (cursor > 0) {
      const c = chosen[cursor];
      if (c == null) break;
      lines.push({
        start: Math.min(c.startItem, c.endItem),
        end: c.endItem,
        ratio: c.ratio,
        badness: c.badness,
        fitness: c.fitness,
        demerits: c.demerits,
      });
      if (Math.abs(c.fitness - prevFitness) > 1) badTransitions = true;
      prevFitness = c.fitness;
      cursor = c.prevBreak;
    }
    lines.reverse();
    return { lines, badTransitions };
  };

  const first = run(1);
  if (!first.badTransitions) return first.lines;
  const second = run(3000 ** 2);
  return second.lines;
}
