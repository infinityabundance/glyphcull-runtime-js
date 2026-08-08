//! API tests (TESTING.md §2 unit/api): the six-function contract —
//! `load` rejection paths (malformed bytes, invalid options, renderer
//! preference), scroll/paint, select/copy round-trips, destroyed-handle
//! errors, idempotent double-destroy, and multi-document isolation. The
//! renderers are browser-only; in Node both report a lost context and paint
//! no-ops, which still exercises the whole wiring (the browser harness
//! validates pixels).

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from '../../src/index.js';
import { CullError } from '../../src/format/errors.js';
import { DocumentError } from '../../src/document/model.js';
import { RuntimeError } from '../../src/api/errors.js';
import { pipelineGolden } from '../testkit/fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));

/** A canvas whose contexts are unavailable (Node has no WebGL/Canvas 2D). */
function fakeCanvas(clientWidth = 800, clientHeight = 600): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    clientWidth,
    clientHeight,
    style: {},
    getContext: () => null,
    addEventListener: () => undefined,
  } as unknown as HTMLCanvasElement;
}

/** Stub the DOM surface the renderers touch (canvas allocation only). */
function stubDom(): void {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
}

beforeAll(() => {
  stubDom();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('public surface', () => {
  it('exports exactly the six operations plus the typed errors', async () => {
    const mod = await import('../../src/index.js');
    expect(Object.keys(mod).sort()).toEqual(['CullError', 'DocumentError', 'RuntimeError', 'load']);
  });

  it('the document handle exposes exactly the six operations', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    const methods = ['scroll', 'paint', 'select', 'copy', 'destroy'];
    expect(
      methods.every((m) => typeof (doc as unknown as Record<string, unknown>)[m] === 'function'),
    ).toBe(true);
    expect(doc.destroyed).toBe(false);
    doc.destroy();
  });
});

describe('load', () => {
  it('rejects malformed bytes with the reader typed error', async () => {
    await expect(load(new Uint8Array([1, 2, 3]), { canvas: fakeCanvas() })).rejects.toBeInstanceOf(
      CullError,
    );
  });

  it('rejects a package that fails document validation', async () => {
    // A structurally valid container without CHNK.
    const bytes = readFileSync(join(here, '..', 'fixtures', 'v1-minimal.cull'));
    await expect(load(bytes, { canvas: fakeCanvas() })).rejects.toBeInstanceOf(DocumentError);
  });

  it('rejects invalid options with a typed runtime error', async () => {
    const cases = [
      { dpr: 0 },
      { dpr: -1 },
      { margin: -1 },
      { glyphBudgetBytes: -1 },
      { frameBudgetMs: 0 },
      { coolingPeriodMs: -1 },
      { theme: { ink: 'white' } },
      { theme: { ink: '#fff' } },
      { theme: { ink: '#gggggg' } },
    ];
    for (const overrides of cases) {
      await expect(
        load(pipelineGolden(), { canvas: fakeCanvas(), ...overrides }),
      ).rejects.toSatisfy((e) => e instanceof RuntimeError && e.kind === 'invalid-options');
    }
  });

  it('an explicit WebGL preference rejects when unavailable', async () => {
    await expect(
      load(pipelineGolden(), { canvas: fakeCanvas(), renderer: 'webgl' }),
    ).rejects.toSatisfy((e) => e instanceof RuntimeError && e.kind === 'renderer-unavailable');
  });

  it('auto falls back to Canvas 2D when WebGL is unavailable', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas(), renderer: 'auto' });
    expect(doc.destroyed).toBe(false);
    doc.destroy();
  });

  it('loads with a host theme (#rrggbb and #rrggbbaa ink) and paints', async () => {
    for (const ink of ['#ffffff', '#ffffff80']) {
      const doc = await load(pipelineGolden(), { canvas: fakeCanvas(), theme: { ink } });
      doc.scroll({ x: 0, y: 0, w: 800, h: 600 }, 1);
      doc.paint();
      expect(doc.destroyed).toBe(false);
      doc.destroy();
    }
  });
});

describe('scroll and paint', () => {
  it('scrolls to a viewport and paints without error', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    doc.paint();
    doc.scroll({ x: 0, y: 100, w: 800, h: 600 });
    doc.paint();
    doc.destroy();
  });

  it('rejects an invalid viewport with a typed error', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    expect(() => {
      doc.scroll({ x: 0, y: 0, w: 0, h: 600 });
    }).toThrow(expect.objectContaining({ kind: 'invalid-options' }));
    expect(() => {
      doc.scroll({ x: Number.NaN, y: 0, w: 800, h: 600 });
    }).toThrow(expect.objectContaining({ kind: 'invalid-options' }));
    doc.destroy();
  });
});

describe('select and copy', () => {
  it('copy of a direct range reproduces the document text', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.select({ start: { chunkId: 3, offset: 0 }, end: { chunkId: 22, offset: 5 } });
    expect(doc.copy()).toBe(
      'Golden\nDeterministic golden fixture with a link.\none\ntwo\ncode block\n\nquote',
    );
    doc.destroy();
  });

  it('select by two points hit-tests and copies the covered text', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    // Both points land in the heading's line (the nearest text at y=10).
    doc.select({ x: 2, y: 10 }, { x: 200, y: 10 });
    expect(doc.copy()).toBe('Golden');
    doc.destroy();
  });

  it('a point selection is collapsed (empty copy)', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.select({ x: 2, y: 10 });
    expect(doc.copy()).toBe('');
    doc.destroy();
  });

  it('a reversed range is normalized to document order', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.select({ start: { chunkId: 22, offset: 5 }, end: { chunkId: 3, offset: 0 } });
    expect(doc.copy()).toBe(
      'Golden\nDeterministic golden fixture with a link.\none\ntwo\ncode block\n\nquote',
    );
    doc.destroy();
  });

  it('copy without a selection is the empty string', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    expect(doc.copy()).toBe('');
    doc.destroy();
  });
});

describe('destroy', () => {
  it('every operation after destroy rejects with a typed error', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.destroy();
    expect(doc.destroyed).toBe(true);
    expect(() => {
      doc.scroll({ x: 0, y: 0, w: 800, h: 600 });
    }).toThrow(expect.objectContaining({ kind: 'destroyed' }));
    expect(() => {
      doc.paint();
    }).toThrow(expect.objectContaining({ kind: 'destroyed' }));
    expect(() => {
      doc.select({ x: 0, y: 0 });
    }).toThrow(expect.objectContaining({ kind: 'destroyed' }));
    expect(() => {
      doc.select({ start: { chunkId: 3, offset: 0 }, end: { chunkId: 3, offset: 1 } });
    }).toThrow(expect.objectContaining({ kind: 'destroyed' }));
    expect(() => doc.copy()).toThrow(expect.objectContaining({ kind: 'destroyed' }));
  });

  it('double destroy is idempotent', async () => {
    const doc = await load(pipelineGolden(), { canvas: fakeCanvas() });
    doc.destroy();
    expect(() => {
      doc.destroy();
    }).not.toThrow();
    expect(doc.destroyed).toBe(true);
  });
});

describe('multi-document isolation', () => {
  it('documents coexist with independent state', async () => {
    const bytes = pipelineGolden();
    const a = await load(bytes, { canvas: fakeCanvas() });
    const b = await load(bytes, { canvas: fakeCanvas() });
    // Independent selections and copies.
    a.select({ start: { chunkId: 3, offset: 0 }, end: { chunkId: 3, offset: 6 } });
    expect(a.copy()).toBe('Golden');
    expect(b.copy()).toBe('');
    b.select({ start: { chunkId: 15, offset: 0 }, end: { chunkId: 15, offset: 3 } });
    expect(b.copy()).toBe('one');
    expect(a.copy()).toBe('Golden');
    // Destroying one leaves the other alive.
    a.destroy();
    expect(b.copy()).toBe('one');
    b.destroy();
  });

  it('concurrent loads resolve independently', async () => {
    const bytes = pipelineGolden();
    const [a, b] = await Promise.all([
      load(bytes, { canvas: fakeCanvas() }),
      load(bytes, { canvas: fakeCanvas() }),
    ]);
    a.select({ start: { chunkId: 18, offset: 0 }, end: { chunkId: 18, offset: 3 } });
    expect(a.copy()).toBe('two');
    expect(b.copy()).toBe('');
    b.destroy();
    a.destroy();
  });
});
