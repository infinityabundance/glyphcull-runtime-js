//! Section payload models and constants (SPEC.md §2).
//!
//! Every fixed-size record layout from the specification, expressed as
//! typed records. Parsing (bounds-checked) lives in `reader.ts`; this
//! module is the vocabulary both the reader and the document model use.

import { CullError } from './errors.js';

// ---------------------------------------------------------------------------
// §2.2 CHNK — chunk graph

/** Chunk kinds (SPEC.md §2.2). */
export enum ChunkKind {
  Document = 1,
  Heading1 = 2,
  Heading2 = 3,
  Heading3 = 4,
  Heading4 = 5,
  Heading5 = 6,
  Heading6 = 7,
  Paragraph = 8,
  Quote = 9,
  List = 10,
  ListItem = 11,
  CodeBlock = 12,
  Table = 13,
  TableRow = 14,
  TableCell = 15,
  Image = 16,
  Caption = 17,
  Run = 18,
  Link = 19,
  Br = 20,
  Hr = 21,
}

/** Chunk flag bits (SPEC.md §2.2). */
export const CHUNK_FLAG_HIDDEN = 1 << 0;
export const CHUNK_FLAG_KEEP_WITH_NEXT = 1 << 1;
export const CHUNK_FLAG_BREAK_BEFORE = 1 << 2;
export const CHUNK_FLAG_NO_WRAP = 1 << 3;
export const CHUNK_FLAG_STRUCTURAL = 1 << 4;

/** A fixed 44-byte chunk record. */
export interface ChunkRecord {
  /** 1-based, dense in document order; 0 is the "none" sentinel in link fields. */
  readonly id: number;
  readonly kind: ChunkKind;
  readonly flags: number;
  readonly styleId: number;
  readonly parentId: number;
  readonly prevId: number;
  readonly nextId: number;
  readonly firstChildId: number;
  readonly lastChildId: number;
  /** 1-based index into CONT; 0 = none. */
  readonly contentIndex: number;
  /** 0-based, dense, document order. */
  readonly ordinal: number;
  readonly depth: number;
}

/** Chunk extra kinds (SPEC.md §2.2). */
export enum ExtraKind {
  LinkTarget = 1,
  CellSpan = 2,
  ListItemValue = 3,
  ImageAlt = 4,
}

/** A parsed chunk extra. */
export interface ChunkExtra {
  readonly chunkId: number;
  readonly kind: ExtraKind;
  /** kind-specific payload. */
  readonly data: LinkTargetExtra | CellSpanExtra | ListItemValueExtra | ImageAltExtra;
}

export interface LinkTargetExtra {
  readonly kind: ExtraKind.LinkTarget;
  readonly url: string;
}

export interface CellSpanExtra {
  readonly kind: ExtraKind.CellSpan;
  readonly colspan: number;
  readonly rowspan: number;
}

export interface ListItemValueExtra {
  readonly kind: ExtraKind.ListItemValue;
  /** 0 = auto (continue the sequence). */
  readonly value: number;
}

export interface ImageAltExtra {
  readonly kind: ExtraKind.ImageAlt;
  readonly alt: string;
}

// ---------------------------------------------------------------------------
// §2.3 STYL — resolved style table

/** Style property tags (SPEC.md §2.3). */
export enum PropertyTag {
  FontId = 1,
  FontSizePx = 2,
  LineHeight = 3,
  FontWeight = 4,
  Italic = 5,
  Color = 6,
  BackgroundColor = 7,
  MarginTop = 8,
  MarginBottom = 9,
  TextAlign = 10,
  TextIndent = 11,
  ListStyle = 12,
  Code = 13,
  Underline = 14,
  LetterSpacing = 15,
  WhiteSpace = 16,
}

/** `text_align` values (SPEC.md §2.3). */
export const enum TextAlign {
  Start = 0,
  Center = 1,
  End = 2,
  Justify = 3,
}

/** `list_style` values (SPEC.md §2.3). */
export const enum ListStyle {
  None = 0,
  Disc = 1,
  Circle = 2,
  Square = 3,
  Decimal = 4,
  LowerAlpha = 5,
  UpperAlpha = 6,
  LowerRoman = 7,
  UpperRoman = 8,
}

/** `white_space` values (SPEC.md §2.3). */
export const enum WhiteSpace {
  Normal = 0,
  Pre = 1,
  Nowrap = 2,
}

/** One resolved style: absent properties take the SPEC defaults. */
export interface StyleProperties {
  fontId?: number;
  fontSizePx?: number;
  lineHeight?: number;
  fontWeight?: number;
  italic?: number;
  color?: number;
  backgroundColor?: number;
  marginTop?: number;
  marginBottom?: number;
  textAlign?: number;
  textIndent?: number;
  listStyle?: number;
  code?: number;
  underline?: number;
  letterSpacing?: number;
  whiteSpace?: number;
}

/** A parsed style record. */
export interface StyleRecord {
  readonly id: number;
  readonly properties: StyleProperties;
}

/** The fully-resolved view of a style with SPEC defaults applied. */
export interface ResolvedStyle {
  readonly fontId: number;
  readonly fontSizePx: number;
  readonly lineHeight: number;
  readonly fontWeight: number;
  readonly italic: boolean;
  readonly color: number;
  readonly backgroundColor: number;
  readonly marginTop: number;
  readonly marginBottom: number;
  readonly textAlign: TextAlign;
  readonly textIndent: number;
  readonly listStyle: ListStyle;
  readonly code: boolean;
  readonly underline: boolean;
  readonly letterSpacing: number;
  readonly whiteSpace: WhiteSpace;
}

/** SPEC §2.3 defaults. */
export const STYLE_DEFAULTS: ResolvedStyle = {
  fontId: 0,
  fontSizePx: 16,
  lineHeight: 1.5,
  fontWeight: 400,
  italic: false,
  color: 0x000000ff,
  backgroundColor: 0x00000000,
  marginTop: 0,
  marginBottom: 0,
  textAlign: TextAlign.Start,
  textIndent: 0,
  listStyle: ListStyle.None,
  code: false,
  underline: false,
  letterSpacing: 0,
  whiteSpace: WhiteSpace.Normal,
};

/** Apply SPEC defaults over a record's explicit properties. */
export function resolveStyle(record: StyleRecord | undefined): ResolvedStyle {
  const p = record?.properties;
  return {
    fontId: p?.fontId ?? STYLE_DEFAULTS.fontId,
    fontSizePx: p?.fontSizePx ?? STYLE_DEFAULTS.fontSizePx,
    lineHeight: p?.lineHeight ?? STYLE_DEFAULTS.lineHeight,
    fontWeight: p?.fontWeight ?? STYLE_DEFAULTS.fontWeight,
    italic: (p?.italic ?? (STYLE_DEFAULTS.italic ? 1 : 0)) !== 0,
    color: p?.color ?? STYLE_DEFAULTS.color,
    backgroundColor: p?.backgroundColor ?? STYLE_DEFAULTS.backgroundColor,
    marginTop: p?.marginTop ?? STYLE_DEFAULTS.marginTop,
    marginBottom: p?.marginBottom ?? STYLE_DEFAULTS.marginBottom,
    textAlign: p?.textAlign ?? STYLE_DEFAULTS.textAlign,
    textIndent: p?.textIndent ?? STYLE_DEFAULTS.textIndent,
    listStyle: p?.listStyle ?? STYLE_DEFAULTS.listStyle,
    code: (p?.code ?? (STYLE_DEFAULTS.code ? 1 : 0)) !== 0,
    underline: (p?.underline ?? (STYLE_DEFAULTS.underline ? 1 : 0)) !== 0,
    letterSpacing: p?.letterSpacing ?? STYLE_DEFAULTS.letterSpacing,
    whiteSpace: p?.whiteSpace ?? STYLE_DEFAULTS.whiteSpace,
  };
}

// ---------------------------------------------------------------------------
// §2.4 CONT — content payloads

export const enum PayloadKind {
  TextUtf8 = 0,
  ImageRef = 1,
}

export interface TextPayload {
  readonly id: number;
  readonly kind: PayloadKind.TextUtf8;
  readonly text: string;
}

export interface ImageRefPayload {
  readonly id: number;
  readonly kind: PayloadKind.ImageRef;
  /** Index into IMGS. */
  readonly imageId: number;
}

export type ContentPayload = TextPayload | ImageRefPayload;

// ---------------------------------------------------------------------------
// §2.5 GLYF — MSDF glyph atlases

/** A glyph record (32 bytes, SPEC.md §2.5). */
export interface GlyphRecord {
  readonly codepoint: number;
  readonly advance: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly boxX: number;
  readonly boxY: number;
  readonly boxW: number;
  readonly boxH: number;
  readonly pageIndex: number;
  readonly noOutline: boolean;
  readonly combining: boolean;
}

/** A kerning pair adjustment in em units. */
export interface KerningPair {
  readonly left: number;
  readonly right: number;
  readonly adjust: number;
}

/** One MSDF atlas (SPEC.md §2.5). */
export interface Atlas {
  readonly fontId: number;
  readonly pageCount: number;
  readonly padding: number;
  /** Fixed-point ×1024. */
  readonly texelsPerEmRaw: number;
  readonly ascent: number;
  readonly descent: number;
  readonly lineGap: number;
  readonly capHeight: number;
  readonly xHeight: number;
  readonly unitsPerEm: number;
  readonly family: string;
  readonly weight: number;
  readonly italic: boolean;
  readonly pageWidth: number;
  readonly pageHeight: number;
  /** codepoint → glyph record. */
  readonly glyphs: ReadonlyMap<number, GlyphRecord>;
  /** left codepoint → (right codepoint → adjust em). */
  readonly kerning: ReadonlyMap<number, ReadonlyMap<number, number>>;
  /** Raw RGBA8 page texels (views into the package buffer). */
  readonly pages: readonly Uint8Array[];
}

/** Actual texels per em. */
export function texelsPerEm(atlas: Atlas): number {
  return atlas.texelsPerEmRaw / 1024;
}

// ---------------------------------------------------------------------------
// §2.6 IMGS — raster images

/** An image record (SPEC.md §2.6). */
export interface ImageRecord {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  /** 0 = RGBA8, 1 = RGB8. */
  readonly format: number;
  /** Raw pixels, row-major top-to-bottom. */
  readonly data: Uint8Array;
}

/** Bytes per pixel by image format. */
export function imageBytesPerPixel(format: number): number {
  if (format === 0) return 4;
  if (format === 1) return 3;
  throw new CullError('invalid-value', `unknown image format ${format}`);
}

// ---------------------------------------------------------------------------
// §2.7 SEAL — integrity hash tree

/** One covered section's hash. */
export interface SectionHash {
  readonly kind: number;
  readonly hash: Uint8Array;
}

/** A parsed SEAL section. */
export interface Seal {
  readonly mode: number;
  readonly algo: number;
  readonly hashes: readonly SectionHash[];
  readonly overall: Uint8Array;
}

// ---------------------------------------------------------------------------
// §2.1 INFO — metadata

/** The parsed INFO metadata object. */
export interface Info {
  readonly formatVersion: number;
  readonly generator: string;
  readonly generatorVersion: string;
  readonly sourceDigest: string;
  readonly documentId: string;
  readonly title?: string;
  readonly lang?: string;
  readonly chunkCount: number;
  readonly styleCount: number;
  readonly contentCount: number;
  readonly atlasCount: number;
  readonly imageCount: number;
}
