//! Block layout (Architecture.md §3.5): materialization turns semantic
//! chunks into renderable geometry.
//!
//! Text blocks (paragraphs, headings, captions, quotes) break lines with
//! the Knuth–Plass algorithm (UAX #29-grounded tokenization, `breaks.ts`,
//! `kp.ts`); code blocks are preformatted; lists emit markers; tables use a
//! deterministic auto layout honoring colspan/rowspan; images keep their
//! intrinsic aspect ratio. Every record is absolute geometry in document
//! pixels — the runtime owns no CSS cascade (styles are resolved in the
//! package).
//!
//! The engine drives a **sequential frontier**: top-level blocks are laid
//! out in document order, so chunks beyond the viewport are never laid out
//! (streaming). `extendTo` advances the frontier until the viewport is
//! covered; `materialize` lays out one top-level block (idempotent).

import type { DocumentModel } from '../document/model.js';
import { isBlockKind } from '../document/model.js';
import type { Atlas, ChunkRecord, ResolvedStyle } from '../format/sections.js';
import { ChunkKind, ExtraKind, ListStyle } from '../format/sections.js';
import type { Rect } from '../visibility/visibility.js';
import type { GeometrySource } from '../visibility/visibility.js';
import { atlasMetrics, lineStartShift, measureRun } from './measure.js';
import type { GlyphMetric } from './measure.js';
import { BreakClass, tokenizeForBreaking } from './breaks.js';
import { lineBreak } from './kp.js';
import type { KpItem, KpLine } from './kp.js';

/** One placed glyph. */
export interface GlyphInstance {
  readonly codepoint: number;
  /** Baseline origin in document pixels. */
  readonly x: number;
  readonly y: number;
  readonly advancePx: number;
  readonly atlasId: number;
  readonly fontSizePx: number;
  readonly color: number;
  /** The owning run chunk id. */
  readonly runChunkId: number;
  /** Offset into the run's payload text. */
  readonly offsetInText: number;
  readonly hasOutline: boolean;
  /** Index (into the line's glyphs) of the base glyph a mark attaches to. */
  readonly markOf: number | undefined;
}

/** One laid-out text run (a slice of a run chunk's text). */
export interface RunLayout {
  readonly chunkId: number;
  readonly text: string;
  /** Offset into the run's payload text. */
  readonly start: number;
  readonly end: number;
  /** Baseline origin. */
  readonly x: number;
  readonly y: number;
  /** Advance width in pixels. */
  readonly width: number;
  readonly style: ResolvedStyle;
  readonly atlasId: number;
}

/** One laid-out line. */
export interface LineLayout {
  /** Line box top in document pixels. */
  readonly y: number;
  /** The baseline of the line. */
  readonly baseline: number;
  /** The width the line was set to. */
  readonly width: number;
  readonly heightPx: number;
  /** The Knuth–Plass ratio (0 for preformatted lines). */
  readonly ratio: number;
  readonly runs: readonly RunLayout[];
  readonly glyphs: readonly GlyphInstance[];
}

/** A list-item marker. */
export interface MarkerLayout {
  readonly text: string;
  /** Baseline origin. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
}

/** A placed image quad. */
export interface ImageQuad {
  readonly imageId: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A table cell placement. */
export interface CellPlacement {
  readonly cell: BlockLayout;
  readonly colspan: number;
  readonly rowspan: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A laid-out table. */
export interface TableLayout {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly columns: readonly number[];
  readonly rows: readonly (readonly CellPlacement[])[];
}

/** The layout record of one block chunk. */
export interface BlockLayout {
  readonly chunkId: number;
  readonly kind: ChunkKind;
  readonly style: ResolvedStyle;
  /** Content box (absolute document pixels). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly lines: readonly LineLayout[];
  readonly children: readonly BlockLayout[];
  readonly marker: MarkerLayout | undefined;
  readonly image: ImageQuad | undefined;
  readonly table: TableLayout | undefined;
  readonly ruler: { readonly x: number; readonly y: number; readonly w: number } | undefined;
}

/** Options for the layout engine. */
export interface LayoutOptions {
  /** Device pixel ratio (affects natural image size). */
  readonly dpr: number;
  /** The page content width in CSS pixels. */
  readonly contentWidth: number;
}

/** The quote indent in CSS px. */
const QUOTE_INDENT = 24;
/** The list marker gutter width (em multiples). */
const MARKER_GUTTER = 1.6;

/** One measured, styled token (a slice of a run's text). */
interface LaidToken {
  readonly text: string;
  readonly runChunkId: number;
  readonly style: ResolvedStyle;
  readonly atlasId: number;
  readonly fontSizePx: number;
  readonly startChar: number;
  readonly endChar: number;
  readonly width: number;
  breakAfter: BreakClass;
}

/** The layout engine. */
export class LayoutEngine implements GeometrySource {
  private readonly doc: DocumentModel;
  private readonly dpr: number;
  private readonly contentWidth: number;
  private readonly records = new Map<number, BlockLayout>();
  private readonly runRects = new Map<number, Rect>();
  private readonly topLevelBlocks: number[];
  private blockIndex = 0;
  private cursorY = 0;

  constructor(doc: DocumentModel, options: LayoutOptions) {
    this.doc = doc;
    this.dpr = options.dpr;
    this.contentWidth = options.contentWidth;
    this.topLevelBlocks = doc.childIds(doc.root.id);
  }

  /** The document model this engine lays out. */
  get document(): DocumentModel {
    return this.doc;
  }

  /** The next top-level block chunk id to lay out (the frontier head). */
  nextFrontierBlock(): number | undefined {
    return this.topLevelBlocks[this.blockIndex];
  }

  /** Whether the frontier has advanced past every top-level block. */
  get frontierExhausted(): boolean {
    return this.blockIndex >= this.topLevelBlocks.length;
  }

  /** The y position the frontier has reached. */
  get frontierY(): number {
    return this.cursorY;
  }

  /** GeometrySource: the rect of a laid-out chunk (block or run). */
  rect(chunkId: number): Rect | undefined {
    const block = this.records.get(chunkId);
    if (block !== undefined) return { x: block.x, y: block.y, w: block.w, h: block.h };
    return this.runRects.get(chunkId);
  }

  /** The layout record of a laid-out block chunk. */
  record(chunkId: number): BlockLayout | undefined {
    return this.records.get(chunkId);
  }

  /** All laid-out block records, keyed by chunk id. */
  recordsAll(): ReadonlyMap<number, BlockLayout> {
    return this.records;
  }

  /**
   * Advance the frontier until the layout covers `bottomY` document pixels
   * (or every top-level block is laid out).
   */
  extendTo(bottomY: number): void {
    let guard = 0;
    while (
      !this.frontierExhausted &&
      this.cursorY < bottomY &&
      guard < this.topLevelBlocks.length + 1
    ) {
      const chunkId = this.topLevelBlocks[this.blockIndex]!;
      this.materialize(chunkId);
      guard++;
    }
  }

  /**
   * Lay out one top-level block (idempotent). Nested blocks (list items,
   * quote children, table cells) are laid out as part of their parent.
   */
  materialize(chunkId: number): BlockLayout | undefined {
    const existing = this.records.get(chunkId);
    if (existing !== undefined) return existing;
    const index = this.topLevelBlocks.indexOf(chunkId);
    if (index === -1) {
      const chunk = this.doc.chunk(chunkId);
      if (chunk === undefined || !isBlockKind(chunk.kind)) return undefined;
      const layout = this.layoutBlock(chunk, 0, this.cursorY, this.contentWidth);
      this.records.set(chunkId, layout);
      return layout;
    }
    const chunk = this.doc.chunk(chunkId)!;
    const layout = this.layoutBlock(chunk, 0, this.cursorY, this.contentWidth);
    this.records.set(chunkId, layout);
    this.cursorY = layout.y + layout.h;
    this.blockIndex = index + 1;
    return layout;
  }

  // -------------------------------------------------------------------------
  // Style helpers

  private styleOf(chunkId: number): ResolvedStyle {
    const chunk = this.doc.chunk(chunkId)!;
    return this.doc.styles[chunk.styleId] ?? this.doc.styles[0]!;
  }

  private atlasFor(style: ResolvedStyle): Atlas | undefined {
    return this.doc.atlases[style.fontId];
  }

  /** The baseline offset of a line box of the given style. */
  private baselineOffset(style: ResolvedStyle): number {
    const atlas = this.atlasFor(style);
    const fontSize = style.fontSizePx;
    const lineHeight = fontSize * style.lineHeight;
    if (atlas === undefined) return fontSize * 0.8;
    const m = atlasMetrics(atlas);
    return m.ascent * fontSize + (lineHeight - (m.ascent + m.descent) * fontSize) / 2;
  }

  // -------------------------------------------------------------------------
  // Block dispatch

  private layoutBlock(chunk: ChunkRecord, x: number, y: number, width: number): BlockLayout {
    const block = this.layoutBlockRaw(chunk, x, y, width);
    // Register every laid-out block (nested included) so geometry queries
    // (visibility, hit testing) resolve it.
    this.records.set(chunk.id, block);
    return block;
  }

  private layoutBlockRaw(chunk: ChunkRecord, x: number, y: number, width: number): BlockLayout {
    const style = this.styleOf(chunk.id);
    const boxY = y + style.marginTop;
    switch (chunk.kind) {
      case ChunkKind.Paragraph:
      case ChunkKind.Heading1:
      case ChunkKind.Heading2:
      case ChunkKind.Heading3:
      case ChunkKind.Heading4:
      case ChunkKind.Heading5:
      case ChunkKind.Heading6:
      case ChunkKind.Caption:
        return this.layoutTextBlock(chunk.id, style, x, boxY, width);
      case ChunkKind.CodeBlock:
        return this.layoutCodeBlock(chunk.id, style, x, boxY, width);
      case ChunkKind.Quote:
        return this.layoutQuote(chunk.id, style, x, boxY, width);
      case ChunkKind.List:
        return this.layoutList(chunk.id, style, x, boxY, width);
      case ChunkKind.ListItem:
        return this.layoutListItem(chunk.id, style, x, boxY, width);
      case ChunkKind.Image:
        return this.layoutImage(chunk.id, style, x, boxY, width);
      case ChunkKind.Hr: {
        const ruler = { x, y: boxY + style.fontSizePx * 0.5, w: width };
        return {
          chunkId: chunk.id,
          kind: chunk.kind,
          style,
          x,
          y: boxY,
          w: width,
          h: style.fontSizePx,
          lines: [],
          children: [],
          marker: undefined,
          image: undefined,
          table: undefined,
          ruler,
        };
      }
      case ChunkKind.Table:
        return this.layoutTable(chunk.id, style, x, boxY, width);
      case ChunkKind.TableCell:
        return this.layoutCell(chunk.id, style, x, boxY, width);
      default:
        // Structural chunks (document, table row) produce no geometry here.
        return {
          chunkId: chunk.id,
          kind: chunk.kind,
          style,
          x,
          y: boxY,
          w: width,
          h: 0,
          lines: [],
          children: [],
          marker: undefined,
          image: undefined,
          table: undefined,
          ruler: undefined,
        };
    }
  }

  // -------------------------------------------------------------------------
  // Text blocks

  /** One measured, styled token (a slice of a run's text). */
  private laidToken(
    runChunkId: number,
    text: string,
    style: ResolvedStyle,
    startChar: number,
    endChar: number,
  ): LaidToken {
    const atlas = this.atlasFor(style);
    const fontSize = style.fontSizePx;
    let width: number;
    if (atlas !== undefined) {
      const measured = measureRun(atlas, text, fontSize, style.letterSpacing);
      width = sumAdvances(measured.glyphs, 0, text.length);
    } else {
      width = fontSize * 0.5 * text.length;
    }
    return {
      text,
      runChunkId,
      style,
      atlasId: style.fontId,
      fontSizePx: fontSize,
      startChar,
      endChar,
      width,
      breakAfter: BreakClass.Forbidden,
    };
  }

  /** Collect the styled token stream of a block's run children. */
  private collectTokens(chunkId: number): LaidToken[] {
    const tokens: LaidToken[] = [];
    for (const runId of this.doc.childIds(chunkId)) {
      const run = this.doc.chunk(runId);
      if (run === undefined) continue;
      const style = this.styleOf(runId);
      const text = this.doc.directText(runId) ?? '';
      if (text.length === 0) continue;
      const sub = tokenizeForBreaking(text);
      let charIndex = 0;
      for (const token of sub) {
        const end = charIndex + token.text.length;
        tokens.push(this.laidToken(runId, token.text, style, charIndex, end));
        tokens[tokens.length - 1]!.breakAfter = token.breakAfter;
        charIndex = end;
      }
    }
    return tokens;
  }

  private layoutTextBlock(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const tokens = this.collectTokens(chunkId);
    if (tokens.length === 0) {
      return this.emptyBlock(chunkId, style, x, y, width);
    }
    const lineHeight = style.fontSizePx * style.lineHeight;
    const indent = style.textIndent;
    const items: KpItem[] = [];
    const em = style.fontSizePx;
    for (const token of tokens) {
      items.push({ type: 'box', width: token.width });
      switch (token.breakAfter) {
        case BreakClass.Space:
          items.push({ type: 'glue', width: em * 0.25, stretch: em * 0.125, shrink: em * 0.0833 });
          break;
        case BreakClass.Allowed:
          items.push({ type: 'glue', width: 0, stretch: em * 0.25, shrink: 0 });
          break;
        case BreakClass.Forbidden:
          items.push({ type: 'penalty', width: 0, penalty: Number.POSITIVE_INFINITY });
          break;
        case BreakClass.Forced:
          items.push({ type: 'penalty', width: 0, penalty: Number.NEGATIVE_INFINITY });
          break;
      }
    }
    items.push({ type: 'penalty', width: 0, penalty: Number.NEGATIVE_INFINITY });

    const breaks = lineBreak(items, width);
    const lines: LineLayout[] = [];
    for (let i = 0; i < breaks.length; i++) {
      const br = breaks[i]!;
      const isFirst = i === 0;
      const lineX = x + (isFirst ? indent : 0);
      const lineWidth = isFirst ? Math.max(0, width - indent) : width;
      const line = this.buildStyledLine(chunkId, tokens, br, lineX, lineWidth, y + i * lineHeight);
      lines.push(line);
    }
    const height = breaks.length * Math.ceil(lineHeight);
    return this.blockWithLines(chunkId, style, x, y, width, height, lines);
  }

  private buildStyledLine(
    chunkId: number,
    tokens: LaidToken[],
    br: KpLine,
    lineX: number,
    lineWidth: number,
    lineTop: number,
  ): LineLayout {
    // The line's baseline comes from the block's own style (documented v1
    // simplification: mixed-size runs share the line baseline).
    const blockStyle = this.styleOf(chunkId);
    const baseline = lineTop + this.baselineOffset(blockStyle);
    const runs: RunLayout[] = [];
    const glyphs: GlyphInstance[] = [];
    // Phase G (line-start ink guard): the first glyph's ink must not start
    // left of the line origin — a negative left side bearing would paint ink
    // outside the viewport at a line start. Shift the line start right by the
    // overhang plus one document pixel of anti-aliasing margin. Deterministic:
    // computed from the first atlas-bearing token's first glyph (bearing,
    // scale, and the MSDF AA edge all enter through bearingX·fontSizePx).
    let lineShift = 0;
    let guardIndex = 0;
    for (const token of tokens) {
      if (guardIndex < br.start) {
        guardIndex++;
        continue;
      }
      if (guardIndex > br.end) break;
      const atlas = this.atlasFor(token.style);
      if (atlas === undefined) continue;
      const probe = measureRun(atlas, token.text, token.fontSizePx, token.style.letterSpacing);
      const first = probe.glyphs[0];
      if (first !== undefined && !first.isMark && first.glyph !== undefined) {
        lineShift = lineStartShift(first.glyph.bearingX, token.fontSizePx);
      }
      break;
    }
    let cursorX = lineX + lineShift;
    let tokenIndex = 0;
    for (const token of tokens) {
      if (tokenIndex < br.start) {
        tokenIndex++;
        continue;
      }
      if (tokenIndex > br.end) break;
      // The token's own style drives measurement and appearance.
      const atlas = this.atlasFor(token.style);
      if (atlas !== undefined) {
        const measured = measureRun(atlas, token.text, token.fontSizePx, token.style.letterSpacing);
        runs.push({
          chunkId: token.runChunkId,
          text: token.text,
          start: token.startChar,
          end: token.endChar,
          x: cursorX,
          y: baseline,
          width: token.width,
          style: token.style,
          atlasId: token.atlasId,
        });
        let localMarkBase: number | undefined;
        for (let gi = 0; gi < measured.glyphs.length; gi++) {
          const metric = measured.glyphs[gi]!;
          if (metric.isMark) {
            glyphs.push({
              codepoint: metric.codepoint,
              x: localMarkBase !== undefined ? glyphs[localMarkBase]!.x : cursorX,
              y: baseline,
              advancePx: 0,
              atlasId: token.atlasId,
              fontSizePx: token.fontSizePx,
              color: token.style.color,
              runChunkId: token.runChunkId,
              offsetInText: token.startChar + gi,
              hasOutline: metric.hasOutline,
              markOf: localMarkBase,
            });
          } else {
            localMarkBase = glyphs.length;
            glyphs.push({
              codepoint: metric.codepoint,
              x: cursorX,
              y: baseline,
              advancePx: metric.advancePx,
              atlasId: token.atlasId,
              fontSizePx: token.fontSizePx,
              color: token.style.color,
              runChunkId: token.runChunkId,
              offsetInText: token.startChar + gi,
              hasOutline: metric.hasOutline,
              markOf: undefined,
            });
            cursorX += metric.advancePx;
          }
        }
      } else {
        runs.push({
          chunkId: token.runChunkId,
          text: token.text,
          start: token.startChar,
          end: token.endChar,
          x: cursorX,
          y: baseline,
          width: token.width,
          style: token.style,
          atlasId: token.atlasId,
        });
        cursorX += token.width;
      }
      tokenIndex++;
    }
    const blockFontSize = blockStyle.fontSizePx;
    return {
      y: lineTop,
      baseline,
      width: lineWidth,
      heightPx: blockFontSize * blockStyle.lineHeight,
      ratio: br.ratio,
      runs,
      glyphs,
    };
  }

  private layoutCodeBlock(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const atlas = this.atlasFor(style);
    const text = this.doc.directText(chunkId) ?? '';
    if (atlas === undefined || text.length === 0) {
      return this.emptyBlock(chunkId, style, x, y, width);
    }
    const fontSize = style.fontSizePx;
    const lineHeight = fontSize * style.lineHeight;
    const baseline = this.baselineOffset(style);
    const measured = measureRun(atlas, text, fontSize, style.letterSpacing);
    const rawLines = text.split('\n');
    const lines: LineLayout[] = [];
    let charIndex = 0;
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i]!;
      const lineTop = y + i * lineHeight;
      const runs: RunLayout[] = [];
      const glyphs: GlyphInstance[] = [];
      let cursorX = x;
      for (let gi = charIndex; gi < charIndex + raw.length; gi++) {
        const metric = measured.glyphs[gi]!;
        glyphs.push({
          codepoint: metric.codepoint,
          x: cursorX,
          y: lineTop + baseline,
          advancePx: metric.advancePx,
          atlasId: style.fontId,
          fontSizePx: fontSize,
          color: style.color,
          runChunkId: chunkId,
          offsetInText: gi,
          hasOutline: metric.hasOutline,
          markOf: undefined,
        });
        cursorX += metric.advancePx;
      }
      if (raw.length > 0) {
        runs.push({
          chunkId,
          text: raw,
          start: charIndex,
          end: charIndex + raw.length,
          x,
          y: lineTop + baseline,
          width: cursorX - x,
          style,
          atlasId: style.fontId,
        });
      }
      lines.push({
        y: lineTop,
        baseline: lineTop + baseline,
        width,
        heightPx: lineHeight,
        ratio: 0,
        runs,
        glyphs,
      });
      charIndex += raw.length + 1;
    }
    const height = rawLines.length * Math.ceil(lineHeight);
    return this.blockWithLines(chunkId, style, x, y, width, height, lines);
  }

  // -------------------------------------------------------------------------
  // Containers

  private layoutQuote(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const children: BlockLayout[] = [];
    let childY = y;
    for (const childId of this.doc.childIds(chunkId)) {
      const child = this.doc.chunk(childId)!;
      const childLayout = this.layoutBlock(
        child,
        x + QUOTE_INDENT,
        childY,
        Math.max(0, width - QUOTE_INDENT),
      );
      children.push(childLayout);
      childY = childLayout.y + childLayout.h;
    }
    const height = children.length > 0 ? childY - y : 0;
    return this.blockWithChildren(chunkId, style, x, y, width, height, children);
  }

  private layoutList(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    let value = 1;
    const children: BlockLayout[] = [];
    let childY = y;
    for (const childId of this.doc.childIds(chunkId)) {
      const child = this.doc.chunk(childId)!;
      const valueExtra = this.doc
        .extrasFor(child.id)
        .find((e) => e.kind === ExtraKind.ListItemValue);
      let itemValue = value;
      if (valueExtra?.data.kind === ExtraKind.ListItemValue && valueExtra.data.value !== 0) {
        itemValue = valueExtra.data.value;
      }
      const childLayout = this.layoutListItem(
        child.id,
        this.styleOf(child.id),
        x,
        childY,
        width,
        itemValue,
      );
      children.push(childLayout);
      childY = childLayout.y + childLayout.h;
      value = itemValue + 1;
    }
    const height = childY - y;
    return this.blockWithChildren(chunkId, style, x, y, width, height, children);
  }

  private layoutListItem(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
    value = 0,
  ): BlockLayout {
    const markerText = listMarkerText(style.listStyle, value);
    const markerWidth = style.fontSizePx * MARKER_GUTTER;
    const contentX = x + markerWidth;
    const contentWidth = Math.max(0, width - markerWidth);
    const children: BlockLayout[] = [];
    let childY = y;
    for (const childId of this.doc.childIds(chunkId)) {
      const child = this.doc.chunk(childId)!;
      const childLayout = this.layoutBlock(child, contentX, childY, contentWidth);
      children.push(childLayout);
      childY = childLayout.y + childLayout.h;
    }
    const height =
      children.length > 0 ? childY - y : Math.ceil(style.fontSizePx * style.lineHeight);
    // The marker's baseline aligns with the first line of the item content.
    const firstChild = children[0];
    const markerY =
      firstChild !== undefined && firstChild.lines.length > 0
        ? firstChild.lines[0]!.baseline
        : y + this.baselineOffset(style);
    const block: BlockLayout = {
      chunkId,
      kind: ChunkKind.ListItem,
      style,
      x,
      y,
      w: width,
      h: height,
      lines: [],
      children,
      marker: { text: markerText, x, y: markerY, width: markerWidth },
      image: undefined,
      table: undefined,
      ruler: undefined,
    };
    // List items are laid out through layoutList (not layoutBlock), so they
    // register themselves.
    this.records.set(chunkId, block);
    return block;
  }

  private layoutCell(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const children: BlockLayout[] = [];
    let childY = y;
    for (const childId of this.doc.childIds(chunkId)) {
      const child = this.doc.chunk(childId)!;
      const childLayout = this.layoutBlock(child, x, childY, width);
      children.push(childLayout);
      childY = childLayout.y + childLayout.h;
    }
    const height = children.length > 0 ? childY - y : 0;
    return this.blockWithChildren(chunkId, style, x, y, width, height, children);
  }

  // -------------------------------------------------------------------------
  // Images

  private layoutImage(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const imageId = this.doc.imageRef(chunkId);
    if (imageId === undefined) {
      return this.emptyBlock(chunkId, style, x, y, width);
    }
    const image = this.doc.images[imageId];
    if (image === undefined) {
      return this.emptyBlock(chunkId, style, x, y, width);
    }
    const naturalW = image.width / this.dpr;
    const naturalH = image.height / this.dpr;
    const w = Math.min(naturalW, width);
    const h = w * (naturalH / Math.max(1, naturalW));
    return {
      chunkId,
      kind: ChunkKind.Image,
      style,
      x,
      y,
      w,
      h,
      lines: [],
      children: [],
      marker: undefined,
      image: { imageId, x, y, w, h },
      table: undefined,
      ruler: undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Tables (deterministic auto layout honoring colspan/rowspan)

  private layoutTable(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    const chunk = this.doc.chunk(chunkId)!;
    // A table caption is a `caption` chunk child (SPEC.md §2.2): lay it out
    // above the rows and advance the table's origin by its height.
    let caption: BlockLayout | undefined;
    const rows: { cellIds: number[]; spans: { colspan: number; rowspan: number }[] }[] = [];
    for (const childId of this.doc.childIds(chunk.id)) {
      const child = this.doc.chunk(childId)!;
      if (child.kind === ChunkKind.Caption) {
        caption = this.layoutTextBlock(childId, style, x, y, width);
        continue;
      }
      const cellIds: number[] = [];
      const spans: { colspan: number; rowspan: number }[] = [];
      for (const cellId of this.doc.childIds(childId)) {
        cellIds.push(cellId);
        let colspan = 1;
        let rowspan = 1;
        for (const extra of this.doc.extrasFor(cellId)) {
          if (extra.data.kind === ExtraKind.CellSpan) {
            colspan = extra.data.colspan;
            rowspan = extra.data.rowspan;
          }
        }
        spans.push({ colspan, rowspan });
      }
      rows.push({ cellIds, spans });
    }

    // Column count and natural widths.
    const columnCount = rows.reduce((max, r) => {
      const total = r.spans.reduce((a, s) => a + s.colspan, 0);
      return Math.max(max, total);
    }, 1);
    const columns = new Array<number>(columnCount).fill(0);
    for (const row of rows) {
      let col = 0;
      for (let c = 0; c < row.cellIds.length; c++) {
        const cellId = row.cellIds[c]!;
        const span = row.spans[c]!;
        const natural = this.cellNaturalWidth(cellId, width);
        const per = span.colspan > 0 ? natural / span.colspan : 0;
        for (let k = 0; k < span.colspan; k++) {
          columns[col + k] = Math.max(columns[col + k]!, per);
        }
        col += span.colspan;
      }
    }
    const totalNatural = columns.reduce((a, b) => a + b, 0);
    const scale = totalNatural > 0 ? Math.min(1, width / totalNatural) : 1;
    const colWidths = columns.map((w) => Math.max(20, w * scale));

    // Row heights (rowspan grows the last spanned row when needed).
    const rowHeights = new Array<number>(rows.length).fill(0);
    for (let r = 0; r < rows.length; r++) {
      let rowH = 0;
      let col = 0;
      for (let c = 0; c < rows[r]!.cellIds.length; c++) {
        const span = rows[r]!.spans[c]!;
        if (span.rowspan <= 1) {
          const cellId = rows[r]!.cellIds[c]!;
          const cellW = colWidths.slice(col, col + span.colspan).reduce((a, b) => a + b, 0);
          rowH = Math.max(rowH, this.cellHeight(cellId, cellW));
        }
        col += span.colspan;
      }
      rowHeights[r] = Math.max(rowH, style.fontSizePx * 1.2);
    }
    for (let r = 0; r < rows.length; r++) {
      let col = 0;
      for (let c = 0; c < rows[r]!.cellIds.length; c++) {
        const span = rows[r]!.spans[c]!;
        if (span.rowspan > 1) {
          const cellId = rows[r]!.cellIds[c]!;
          const cellW = colWidths.slice(col, col + span.colspan).reduce((a, b) => a + b, 0);
          const h = this.cellHeight(cellId, cellW);
          const spanRows = Math.min(span.rowspan, rows.length - r);
          const current = rowHeights.slice(r, r + spanRows).reduce((a, b) => a + b, 0);
          if (h > current) {
            const idx = r + spanRows - 1;
            rowHeights[idx] = (rowHeights[idx] ?? 0) + (h - current);
          }
        }
        col += span.colspan;
      }
    }

    // Lay out cells at their final positions.
    const colX: number[] = [];
    let acc = x;
    for (const w of colWidths) {
      colX.push(acc);
      acc += w;
    }
    const placements: CellPlacement[][] = [];
    let rowY = y + (caption !== undefined ? caption.h : 0);
    const rowYPositions: number[] = [];
    for (const h of rowHeights) {
      rowYPositions.push(rowY);
      rowY += h;
    }
    for (let r = 0; r < rows.length; r++) {
      let col = 0;
      const rowPlacements: CellPlacement[] = [];
      for (let c = 0; c < rows[r]!.cellIds.length; c++) {
        const cellId = rows[r]!.cellIds[c]!;
        const span = rows[r]!.spans[c]!;
        const cellX = colX[col]!;
        const cellW = colWidths.slice(col, col + span.colspan).reduce((a, b) => a + b, 0);
        const spanRows = Math.min(span.rowspan, rows.length - r);
        const cellH = rowHeights.slice(r, r + spanRows).reduce((a, b) => a + b, 0);
        const layout = this.layoutBlock(this.doc.chunk(cellId)!, cellX, rowYPositions[r]!, cellW);
        rowPlacements.push({
          cell: layout,
          colspan: span.colspan,
          rowspan: span.rowspan,
          x: cellX,
          y: rowYPositions[r]!,
          w: cellW,
          h: cellH,
        });
        col += span.colspan;
      }
      placements.push(rowPlacements);
    }
    const table: TableLayout = { x, y: rowYPositions[0] ?? y, w: acc - x, columns: colWidths, rows: placements };
    const height = rowY - (rowYPositions[0] ?? y) + (caption !== undefined ? caption.h : 0);
    const cellChildren = placements.flat().map((p) => p.cell);
    return {
      chunkId,
      kind: ChunkKind.Table,
      style,
      x,
      y,
      w: acc - x,
      h: height,
      lines: [],
      children: caption !== undefined ? [caption, ...cellChildren] : cellChildren,
      marker: undefined,
      image: undefined,
      table,
      ruler: undefined,
    };
  }

  private cellHeight(cellId: number, width: number): number {
    const cell = this.doc.chunk(cellId)!;
    const style = this.styleOf(cellId);
    const layout = this.layoutBlock(cell, 0, 0, width);
    void style;
    return layout.h;
  }

  private cellNaturalWidth(cellId: number, maxWidth: number): number {
    const style = this.styleOf(cellId);
    const atlas = this.atlasFor(style);
    let max = 0;
    for (const childId of this.doc.childIds(cellId)) {
      const child = this.doc.chunk(childId)!;
      const text = this.doc.directText(child.id) ?? '';
      if (atlas !== undefined && text.length > 0) {
        const measured = measureRun(atlas, text, style.fontSizePx, style.letterSpacing);
        max = Math.max(max, measured.widthPx);
      }
    }
    return Math.min(Math.max(max, style.fontSizePx * 2), maxWidth);
  }

  // -------------------------------------------------------------------------
  // Record constructors

  private emptyBlock(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
  ): BlockLayout {
    return this.blockWithLines(chunkId, style, x, y, width, 0, []);
  }

  private blockWithLines(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
    height: number,
    lines: LineLayout[],
  ): BlockLayout {
    const chunk = this.doc.chunk(chunkId)!;
    // Register run rects for geometry queries (visibility, hit testing).
    for (const line of lines) {
      for (const run of line.runs) {
        const top = line.y;
        const h = line.heightPx;
        this.runRects.set(run.chunkId, { x: run.x, y: top, w: run.width, h });
      }
    }
    return {
      chunkId,
      kind: chunk.kind,
      style,
      x,
      y,
      w: width,
      h: height,
      lines,
      children: [],
      marker: undefined,
      image: undefined,
      table: undefined,
      ruler: undefined,
    };
  }

  private blockWithChildren(
    chunkId: number,
    style: ResolvedStyle,
    x: number,
    y: number,
    width: number,
    height: number,
    children: BlockLayout[],
  ): BlockLayout {
    const chunk = this.doc.chunk(chunkId)!;
    return {
      chunkId,
      kind: chunk.kind,
      style,
      x,
      y,
      w: width,
      h: height,
      lines: [],
      children,
      marker: undefined,
      image: undefined,
      table: undefined,
      ruler: undefined,
    };
  }
}

function sumAdvances(glyphs: readonly GlyphMetric[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i < end; i++) {
    sum += glyphs[i]!.advancePx;
  }
  return sum;
}

/** Marker text for a list style and value. */
export function listMarkerText(style: ListStyle, value: number): string {
  switch (style) {
    case ListStyle.Disc:
      return '\u2022';
    case ListStyle.Circle:
      return '\u25e6';
    case ListStyle.Square:
      return '\u25aa';
    case ListStyle.Decimal:
      return `${value}.`;
    case ListStyle.LowerAlpha:
      return `${toAlpha(value)}.`;
    case ListStyle.UpperAlpha:
      return `${toAlpha(value).toUpperCase()}.`;
    case ListStyle.LowerRoman:
      return `${toRoman(value)}.`;
    case ListStyle.UpperRoman:
      return `${toRoman(value).toUpperCase()}.`;
    default:
      return '';
  }
}

function toAlpha(value: number): string {
  let v = value - 1;
  let out = '';
  do {
    out = String.fromCharCode(97 + (v % 26)) + out;
    v = Math.floor(v / 26) - 1;
  } while (v >= 0);
  return out;
}

function toRoman(value: number): string {
  if (value <= 0) return String(value);
  const table: [number, string][] = [
    [1000, 'm'],
    [900, 'cm'],
    [500, 'd'],
    [400, 'cd'],
    [100, 'c'],
    [90, 'xc'],
    [50, 'l'],
    [40, 'xl'],
    [10, 'x'],
    [9, 'ix'],
    [5, 'v'],
    [4, 'iv'],
    [1, 'i'],
  ];
  let v = value;
  let out = '';
  for (const [n, s] of table) {
    while (v >= n) {
      out += s;
      v -= n;
    }
  }
  return out;
}
