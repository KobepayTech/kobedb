import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'worker.mjs');

export interface InvokeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface InvokeResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Resolve `<functionsPath>/<name>/index.(mjs|js)` to an absolute module path. */
export function resolveFunction(name: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null; // guard against traversal
  const base = path.resolve(config.functionsPath, name);
  for (const file of ['index.mjs', 'index.js']) {
    const full = path.join(base, file);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function listFunctions(): string[] {
  try {
    return fs
      .readdirSync(config.functionsPath, { withFileTypes: true })
      .filter((d) => d.isDirectory() && resolveFunction(d.name))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/** Run a function in an isolated worker thread with a hard timeout. */
export function invokeFunction(modulePath: string, req: InvokeRequest): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { modulePath: pathToUrl(modulePath), req, env: process.env },
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate();
      reject(Object.assign(new Error('function timed out'), { statusCode: 504 }));
    }, config.functionTimeoutMs);

    worker.on('message', (msg: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      if (msg.ok) resolve({ status: msg.status, headers: msg.headers, body: msg.body });
      else reject(Object.assign(new Error(msg.error), { statusCode: 500 }));
    });
    worker.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(err, { statusCode: 500 }));
    });
  });
}

// Worker `import()` needs a file:// URL for absolute paths on all platforms.
function pathToUrl(p: string): string {
  return new URL(`file://${path.resolve(p)}`).href;
}
