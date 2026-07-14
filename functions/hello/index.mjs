// A sample KobeDB edge function.
//   Invoke:  curl -X POST http://localhost:8000/functions/v1/hello -d '{"name":"Kobe"}'
//
// The handler receives a Web-standard `Request` and returns a `Response`,
// so the exact same file also runs under Deno (`deno serve index.mjs`).
export default async (request) => {
  let name = 'world';
  if (request.method === 'POST') {
    try {
      const body = await request.json();
      if (body?.name) name = body.name;
    } catch {
      /* ignore non-JSON bodies */
    }
  }
  return new Response(
    JSON.stringify({ message: `Hello, ${name}!`, from: 'kobedb-edge-function', ts: Date.now() }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};
