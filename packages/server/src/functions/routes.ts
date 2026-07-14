import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { resolveFunction, invokeFunction, listFunctions, activeRuntime, type InvokeRequest } from './runtime.js';

// Normalise a Fastify request body (Buffer or parsed JSON) back to a raw string.
function rawBody(body: unknown): string | undefined {
  if (body == null) return undefined;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

export async function functionRoutes(app: FastifyInstance) {
  app.get('/functions/v1', async () => ({ functions: listFunctions(), runtime: activeRuntime() }));

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/functions/v1/:name',
    handler: async (req, reply) => {
      const { name } = req.params as { name: string };
      const modulePath = resolveFunction(name);
      if (!modulePath) return reply.code(404).send({ error: `function not found: ${name}` });

      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const invoke: InvokeRequest = {
        method: req.method,
        url: `${config.publicUrl}/functions/v1/${name}`,
        headers,
        body: rawBody(req.body),
      };

      const result = await invokeFunction(modulePath, invoke);
      reply.code(result.status);
      for (const [k, v] of Object.entries(result.headers)) reply.header(k, v);
      return reply.send(result.body);
    },
  });
}
