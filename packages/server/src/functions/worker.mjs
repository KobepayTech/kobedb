// Edge-function worker. Runs one invocation in an isolated thread and posts the
// result back. User functions export a default handler:
//     export default async (request) => new Response(body, init)
// This matches the Deno / Web standard `Request`/`Response` contract, so the same
// function file runs unmodified under Deno's `deno serve` too.
import { workerData, parentPort } from 'node:worker_threads';

const { modulePath, req, env } = workerData;

try {
  // Expose a Deno-style `Deno.env` shim + a KOBE binding for parity.
  globalThis.Deno = globalThis.Deno ?? { env: { get: (k) => env?.[k], toObject: () => env ?? {} } };

  const mod = await import(modulePath);
  const handler = mod.default ?? mod.handler;
  if (typeof handler !== 'function') {
    throw new Error('function must export a default handler');
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
  });

  const res = await handler(request);
  if (!(res instanceof Response)) {
    throw new Error('handler must return a Response');
  }
  const body = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  parentPort.postMessage({ ok: true, status: res.status, headers, body });
} catch (err) {
  parentPort.postMessage({ ok: false, error: String(err?.stack || err?.message || err) });
}
