// Deno entrypoint for running a single edge-function invocation in a real Deno
// isolate (with OS-enforced permissions). Reads a request JSON from stdin, imports
// the user's handler, and writes the response JSON to stdout.
//
// Spawned as:
//   deno run --allow-env --allow-net --allow-read=<functionsPath> deno-runner.mjs <moduleUrl>
//
// The user handler is identical to the worker-thread contract:
//   export default async (request: Request) => Response
const moduleUrl = Deno.args[0];

async function readStdin() {
  const chunks = [];
  const reader = Deno.stdin.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

try {
  const req = JSON.parse((await readStdin()) || '{}');
  const mod = await import(moduleUrl);
  const handler = mod.default ?? mod.handler;
  if (typeof handler !== 'function') throw new Error('function must export a default handler');

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: hasBody ? req.body : undefined,
  });

  const res = await handler(request);
  if (!(res instanceof Response)) throw new Error('handler must return a Response');
  const body = await res.text();
  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  console.log(JSON.stringify({ ok: true, status: res.status, headers, body }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err?.stack || err?.message || err) }));
}
