//! The DOM shim for Node-based tests: the renderers are browser-only, so
//! Node tests stub the two surfaces they touch — canvas allocation
//! (`document.createElement`) and a canvas whose contexts report
//! unavailable. Every renderer path is null-guarded, so a lost-context
//! renderer no-ops and the full pipeline still runs (the Playwright harness
//! validates actual pixels).

import { vi } from 'vitest';

/** A canvas whose contexts are unavailable (Node has no WebGL/Canvas 2D). */
export function fakeCanvas(clientWidth = 800, clientHeight = 600): HTMLCanvasElement {
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

/** Stub the global `document` the renderers touch; call `vi.unstubAllGlobals()` after. */
export function stubDom(): void {
  vi.stubGlobal('document', { createElement: () => fakeCanvas() });
}
