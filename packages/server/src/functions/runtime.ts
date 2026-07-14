import { Worker } from 'node:worker_threads';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(here, 'worker.mjs');
const DENO_RUNNER = path.join(here, 'deno-runner.mjs');

// Detect the Deno binary once at startup.
let denoBin: string | null | undefined;
function findDeno(): string | null {
  if (denoBin !== undefined) return denoBin;
  try {
    const r = spawnSync('deno', ['--version'], { encoding: 'utf8' });
    denoBin = r.status === 0 ? 'deno' : null;
  } catch {
    denoBin = null;
  }
  return denoBin;
}

/** Which runtime will actually be used, given config + availability. */
export function activeRuntime(): 'deno' | 'worker' {
  if (config.functionsRuntime === 'worker') return 'worker';
  if (config.functionsRuntime === 'deno') return 'deno';
  return findDeno() ? 'deno' : 'worker';
}

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

/** Run a function in an isolated context (Deno isolate or worker thread) with a timeout. */
export function invokeFunction(modulePath: string, req: InvokeRequest): Promise<InvokeResult> {
  return activeRuntime() === 'deno'
    ? invokeWithDeno(modulePath, req)
    : invokeWithWorker(modulePath, req);
}

// ── Deno isolate (OS-enforced permissions) ─────────────────────────────────
function invokeWithDeno(modulePath: string, req: InvokeRequest): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const readRoot = path.resolve(config.functionsPath);
    const child = spawn(
      findDeno()!,
      [
        'run',
        '--quiet',
        '--allow-env',
        '--allow-net',
        `--allow-read=${readRoot}`,
        DENO_RUNNER,
        pathToUrl(modulePath),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(() => reject(Object.assign(new Error('function timed out'), { statusCode: 504 })));
    }, config.functionTimeoutMs);

    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => done(() => reject(Object.assign(e, { statusCode: 500 }))));
    child.on('close', (code) => {
      done(() => {
        try {
          const msg = JSON.parse(out.trim().split('\n').pop() || '{}');
          if (msg.ok) resolve({ status: msg.status, headers: msg.headers, body: msg.body });
          else reject(Object.assign(new Error(msg.error || err || `deno exited ${code}`), { statusCode: 500 }));
        } catch {
          reject(Object.assign(new Error(err || `deno produced no output (exit ${code})`), { statusCode: 500 }));
        }
      });
    });

    child.stdin.write(JSON.stringify(req));
    child.stdin.end();
  });
}

// ── Worker thread (portable fallback) ──────────────────────────────────────
function invokeWithWorker(modulePath: string, req: InvokeRequest): Promise<InvokeResult> {
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
