import { load, RuntimeError, type Document, type LoadOptions } from 'glyphcull-runtime-js';
const options: LoadOptions = { canvas: null as unknown as HTMLCanvasElement, width: 800, height: 600 };
async function run(): Promise<Document> {
  const doc = await load(new Uint8Array(), options);
  return doc;
}
void run;
void RuntimeError;
