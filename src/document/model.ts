//! The Document model — the trusted runtime view of a `.cull` package.
//!
//! `buildDocument` validates the package's semantic structure at load
//! (chunk-graph invariants, reference resolution) and then hands back a
//! model that layout, visibility, materialization, and selection treat as
//! trusted. **No geometry lives here**: geometry is produced by
//! materialization and owned by layout structures (Architecture.md §3.2).
//!
//! Models are self-contained — no global state — so any number of
//! Documents coexist (multi-document isolation).

import type { Package } from '../format/reader.js';
import { ChunkKind, PayloadKind } from '../format/sections.js';
import type {
  Atlas,
  ChunkExtra,
  ChunkRecord,
  ContentPayload,
  ImageRecord,
  Info,
  ResolvedStyle,
  StyleRecord,
} from '../format/sections.js';
import { resolveStyle } from '../format/sections.js';

/** A load-time document validation failure. */
export class DocumentError extends Error {
  readonly kind: DocumentErrorKind;

  constructor(kind: DocumentErrorKind, message: string) {
    super(message);
    this.name = 'DocumentError';
    this.kind = kind;
  }
}

export type DocumentErrorKind =
  | 'missing-section'
  | 'invalid-chunk-graph'
  | 'dangling-reference'
  | 'count-mismatch'
  | 'invalid-content';

/** The result of a document build. */
export type DocumentResult =
  { ok: true; value: DocumentModel } | { ok: false; error: DocumentError };

/** Chunk-kind classification (SPEC.md §2.2, mirroring the reference). */
export function isStructuralKind(kind: ChunkKind): boolean {
  return (
    kind === ChunkKind.Document ||
    kind === ChunkKind.List ||
    kind === ChunkKind.Table ||
    kind === ChunkKind.TableRow
  );
}

/** True for inline kinds (nested inside block chunks). */
export function isInlineKind(kind: ChunkKind): boolean {
  return kind === ChunkKind.Run || kind === ChunkKind.Link || kind === ChunkKind.Br;
}

/** True for block-level renderable kinds. */
export function isBlockKind(kind: ChunkKind): boolean {
  switch (kind) {
    case ChunkKind.Heading1:
    case ChunkKind.Heading2:
    case ChunkKind.Heading3:
    case ChunkKind.Heading4:
    case ChunkKind.Heading5:
    case ChunkKind.Heading6:
    case ChunkKind.Paragraph:
    case ChunkKind.Quote:
    case ChunkKind.ListItem:
    case ChunkKind.CodeBlock:
    case ChunkKind.TableCell:
    case ChunkKind.Image:
    case ChunkKind.Caption:
    case ChunkKind.Hr:
      return true;
    default:
      return false;
  }
}

/** The trusted runtime model of a document. */
export class DocumentModel {
  /** The validated package this model was built from. */
  readonly package: Package;
  readonly info: Info;
  /** Chunk records indexed by id (chunks[i] has id i+1). */
  readonly chunks: readonly ChunkRecord[];
  /** Extras per chunk id (document order). */
  readonly extras: ReadonlyMap<number, readonly ChunkExtra[]>;
  /** Resolved styles indexed by style id (defaults applied). */
  readonly styles: readonly ResolvedStyle[];
  /** Content payloads indexed by payload id. */
  readonly content: readonly ContentPayload[];
  /** Atlases indexed by font id. */
  readonly atlases: readonly Atlas[];
  /** Images indexed by image id. */
  readonly images: readonly ImageRecord[];
  /** The document root chunk. */
  readonly root: ChunkRecord;

  constructor(
    package_: Package,
    info: Info,
    chunks: ChunkRecord[],
    extras: Map<number, ChunkExtra[]>,
    styles: ResolvedStyle[],
    content: ContentPayload[],
    atlases: Atlas[],
    images: ImageRecord[],
  ) {
    this.package = package_;
    this.info = info;
    this.chunks = chunks;
    this.extras = extras;
    this.styles = styles;
    this.content = content;
    this.atlases = atlases;
    this.images = images;
    this.root = chunks[0]!;
  }

  /** The chunk with the given id, or undefined. */
  chunk(id: number): ChunkRecord | undefined {
    if (id < 1 || id > this.chunks.length) return undefined;
    return this.chunks[id - 1];
  }

  /** The child ids of a chunk, in document order (empty for leaves). */
  childIds(id: number): number[] {
    const chunk = this.chunk(id);
    if (chunk === undefined) return [];
    const out: number[] = [];
    let child = chunk.firstChildId;
    while (child !== 0) {
      out.push(child);
      if (child === chunk.lastChildId) break;
      const next = this.chunk(child);
      if (next === undefined) break;
      child = next.nextId;
    }
    return out;
  }

  /** All chunk ids in document order (a pre-order walk from the root). */
  allIds(): number[] {
    const out: number[] = [];
    const stack = [this.root.id];
    while (stack.length > 0) {
      const id = stack.pop()!;
      out.push(id);
      const children = this.childIds(id);
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
    return out;
  }

  /** The extras attached to a chunk, if any. */
  extrasFor(id: number): readonly ChunkExtra[] {
    return this.extras.get(id) ?? [];
  }

  /** The text content of a single chunk's direct payload (no traversal). */
  directText(id: number): string | undefined {
    const chunk = this.chunk(id);
    if (chunk === undefined || chunk.contentIndex === 0) return undefined;
    const payload = this.content[chunk.contentIndex - 1];
    if (payload?.kind !== PayloadKind.TextUtf8) return undefined;
    return payload.text;
  }

  /** The image id referenced by an image chunk's payload. */
  imageRef(id: number): number | undefined {
    const chunk = this.chunk(id);
    if (chunk === undefined || chunk.contentIndex === 0) return undefined;
    const payload = this.content[chunk.contentIndex - 1];
    if (payload?.kind !== PayloadKind.ImageRef) return undefined;
    return payload.imageId;
  }

  /**
   * The plain text of a subtree in document order (used by selection/copy):
   * block chunks concatenate their descendants; code blocks contribute their
   * direct text; `br` chunks contribute a newline.
   */
  plainText(id: number): string {
    const chunk = this.chunk(id);
    if (chunk === undefined) return '';
    if (chunk.kind === ChunkKind.Br) return '\n';
    const direct = this.directText(id);
    const children = this.childIds(id);
    if (children.length === 0) return direct ?? '';
    let out = '';
    for (const childId of children) {
      out += this.plainText(childId);
    }
    if (direct !== undefined) out = direct + out;
    return out;
  }
}

/** Build and validate a DocumentModel from a parsed package. */
export function buildDocument(package_: Package): DocumentResult {
  try {
    const info = package_.info();
    if (info === undefined) {
      return {
        ok: false,
        error: new DocumentError('missing-section', 'package has no INFO section'),
      };
    }
    const chunkSection = package_.chunkSection();
    if (chunkSection === undefined) {
      return {
        ok: false,
        error: new DocumentError('missing-section', 'package has no CHNK section'),
      };
    }
    const { chunks, extras } = chunkSection;

    validateChunkGraph(chunks, package_, info);

    // Resolved styles (STYL optional: empty table → all defaults).
    const styleRecords: StyleRecord[] = package_.styles() ?? [];
    const styles = styleRecords.map((r) => resolveStyle(r));

    // Content payloads (CONT optional).
    const content: ContentPayload[] = package_.content() ?? [];

    // Atlases (GLYF optional) and images (IMGS optional).
    const atlases: Atlas[] = package_.atlases() ?? [];
    const images: ImageRecord[] = package_.images() ?? [];

    // Cross-check the INFO counts against the decoded sections.
    if (info.chunkCount !== chunks.length) {
      return {
        ok: false,
        error: new DocumentError(
          'count-mismatch',
          `INFO chunk_count ${info.chunkCount} != CHNK records ${chunks.length}`,
        ),
      };
    }
    if (info.styleCount !== styles.length) {
      return {
        ok: false,
        error: new DocumentError(
          'count-mismatch',
          `INFO style_count ${info.styleCount} != STYL records ${styles.length}`,
        ),
      };
    }
    if (info.contentCount !== content.length) {
      return {
        ok: false,
        error: new DocumentError(
          'count-mismatch',
          `INFO content_count ${info.contentCount} != CONT payloads ${content.length}`,
        ),
      };
    }
    if (info.atlasCount !== atlases.length) {
      return {
        ok: false,
        error: new DocumentError(
          'count-mismatch',
          `INFO atlas_count ${info.atlasCount} != GLYF atlases ${atlases.length}`,
        ),
      };
    }
    if (info.imageCount !== images.length) {
      return {
        ok: false,
        error: new DocumentError(
          'count-mismatch',
          `INFO image_count ${info.imageCount} != IMGS images ${images.length}`,
        ),
      };
    }

    const extrasByChunk = new Map<number, ChunkExtra[]>();
    for (const extra of extras) {
      const list = extrasByChunk.get(extra.chunkId);
      if (list === undefined) {
        extrasByChunk.set(extra.chunkId, [extra]);
      } else {
        list.push(extra);
      }
    }

    return {
      ok: true,
      value: new DocumentModel(
        package_,
        info,
        chunks,
        extrasByChunk,
        styles,
        content,
        atlases,
        images,
      ),
    };
  } catch (e) {
    if (e instanceof DocumentError) return { ok: false, error: e };
    return {
      ok: false,
      error: new DocumentError('invalid-chunk-graph', `document build failed: ${String(e)}`),
    };
  }
}

/** Validate the chunk-graph invariants (SPEC.md §2.2). */
function validateChunkGraph(chunks: ChunkRecord[], package_: Package, info: Info): void {
  if (chunks.length === 0) {
    throw new DocumentError('invalid-chunk-graph', 'chunk graph is empty');
  }
  const byId = new Map<number, ChunkRecord>();
  for (const chunk of chunks) {
    if (chunk.id !== chunk.ordinal + 1) {
      throw new DocumentError(
        'invalid-chunk-graph',
        `chunk ${chunk.id}: id does not match ordinal ${chunk.ordinal}`,
      );
    }
    if (byId.has(chunk.id)) {
      throw new DocumentError('invalid-chunk-graph', `duplicate chunk id ${chunk.id}`);
    }
    byId.set(chunk.id, chunk);
  }

  const root = byId.get(1);
  if (root?.kind !== ChunkKind.Document) {
    throw new DocumentError('invalid-chunk-graph', 'chunk 1 must be the document root');
  }
  if (root.depth !== 0 || root.parentId !== 0) {
    throw new DocumentError('invalid-chunk-graph', 'root must have depth 0 and parent 0');
  }

  // Reachability + depth + ring consistency from the root.
  const seen = new Set<number>();
  const stack = [root.id];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) {
      throw new DocumentError('invalid-chunk-graph', `cycle or duplicate visit at chunk ${id}`);
    }
    seen.add(id);
    const chunk = byId.get(id)!;
    if (chunk.id !== 1 && chunk.depth !== (byId.get(chunk.parentId)?.depth ?? -1) + 1) {
      throw new DocumentError(
        'invalid-chunk-graph',
        `chunk ${chunk.id}: depth ${chunk.depth} != parent.depth + 1`,
      );
    }
    // Ring consistency: first → next-chain → last in exactly child_count steps.
    let child = chunk.firstChildId;
    let count = 0;
    let lastSeen = 0;
    while (child !== 0) {
      if (seen.has(child)) {
        throw new DocumentError('invalid-chunk-graph', `child ${child} visited twice`);
      }
      const childChunk = byId.get(child);
      if (childChunk === undefined) {
        throw new DocumentError('dangling-reference', `chunk ${chunk.id}: child ${child} missing`);
      }
      if (childChunk.parentId !== chunk.id) {
        throw new DocumentError(
          'invalid-chunk-graph',
          `chunk ${child}: parent ${childChunk.parentId} != ${chunk.id}`,
        );
      }
      if (count > chunks.length) {
        throw new DocumentError(
          'invalid-chunk-graph',
          `sibling ring does not terminate at ${chunk.id}`,
        );
      }
      lastSeen = child;
      stack.push(child);
      count++;
      if (child === chunk.lastChildId) break;
      child = childChunk.nextId;
    }
    if (count > 0 && lastSeen !== chunk.lastChildId) {
      throw new DocumentError(
        'invalid-chunk-graph',
        `chunk ${chunk.id}: next-chain from first_child does not reach last_child`,
      );
    }
    if (count === 0 && chunk.lastChildId !== 0) {
      throw new DocumentError(
        'invalid-chunk-graph',
        `chunk ${chunk.id}: last_child set but no first_child`,
      );
    }
  }
  if (seen.size !== chunks.length) {
    throw new DocumentError(
      'invalid-chunk-graph',
      `chunk graph has ${chunks.length} records but only ${seen.size} reachable from the root`,
    );
  }

  // Reference resolution: style ids and content indices.
  const styleCount = info.styleCount;
  const contentCount = info.contentCount;
  const atlases = package_.atlases();
  for (const chunk of chunks) {
    if (chunk.styleId >= styleCount) {
      throw new DocumentError(
        'dangling-reference',
        `chunk ${chunk.id}: style_id ${chunk.styleId} out of range (${styleCount} styles)`,
      );
    }
    if (chunk.contentIndex !== 0) {
      if (chunk.contentIndex > contentCount) {
        throw new DocumentError(
          'dangling-reference',
          `chunk ${chunk.id}: content_index ${chunk.contentIndex} out of range (${contentCount} payloads)`,
        );
      }
      const payload = package_.content()?.[chunk.contentIndex - 1];
      if (chunk.kind === ChunkKind.Image) {
        if (payload?.kind !== PayloadKind.ImageRef) {
          throw new DocumentError(
            'invalid-content',
            `chunk ${chunk.id}: image chunk must reference an image_ref payload`,
          );
        }
        if (payload.imageId >= (package_.images()?.length ?? 0)) {
          throw new DocumentError(
            'dangling-reference',
            `chunk ${chunk.id}: image ref ${payload.imageId} out of range`,
          );
        }
      } else if (payload !== undefined && payload.kind !== PayloadKind.TextUtf8) {
        throw new DocumentError(
          'invalid-content',
          `chunk ${chunk.id}: non-image chunk must reference a text payload`,
        );
      }
    }
    // Style font_id must resolve against the atlas table when an atlas exists
    // (and against the empty table when GLYF is absent).
    const atlasCount = atlases === undefined ? 0 : atlases.length;
    const style = resolveStyle(
      package_.styles()?.[chunk.styleId] ?? { id: chunk.styleId, properties: {} },
    );
    if (style.fontId >= Math.max(atlasCount, 1)) {
      throw new DocumentError(
        'dangling-reference',
        `chunk ${chunk.id}: style font_id ${style.fontId} out of range (${atlasCount} atlases)`,
      );
    }
  }
}
