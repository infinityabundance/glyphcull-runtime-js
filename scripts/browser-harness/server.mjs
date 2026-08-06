#!/usr/bin/env node
//! The rendering-validation harness server (TESTING.md §2 rendering): a
//! tiny static server for the Playwright browser tests. Serves the built
//! runtime (`dist/`), the committed fixtures (`test/fixtures/`), and the
//! harness page that paints the golden and compares GPU pixels against the
//! CPU reference rasterizer.
//!
//! Port 4187 (see playwright.config.ts). Start with `npm run build` first,
//! then `npm run test:browser`.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const PORT = Number(process.env.PORT ?? 4187);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cull': 'application/octet-stream',
  '.md': 'text/plain; charset=utf-8',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = decodeURIComponent(url.pathname);
  let file;
  if (path === '/' || path === '/harness.html') {
    file = join(here, 'harness.html');
  } else if (path.startsWith('/dist/')) {
    file = join(root, 'dist', path.slice('/dist/'.length));
  } else if (path.startsWith('/fixtures/')) {
    file = join(root, 'test', 'fixtures', path.slice('/fixtures/'.length));
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`glyphcull browser harness: http://localhost:${PORT}/harness.html`);
});
