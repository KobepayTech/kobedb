import http from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { query } from '../db.js';
import { config } from '../config.js';

// Reverse proxy: routes incoming requests to the app whose `domain` matches the
// Host header, forwarding to that app's published host port. This is the
// KobeDeploy equivalent of Coolify's Traefik/Caddy edge proxy.
export function startDeployProxy(log: FastifyBaseLogger): http.Server {
  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
    try {
      const { rows } = await query<{ host_port: number | null; status: string; name: string }>(
        `select host_port, status, name from deploy.apps where domain = $1`,
        [host],
      );
      if (!rows.length) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `no app routed for host '${host}'` }));
      }
      const app = rows[0];
      if (!app.host_port || app.status !== 'running') {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `app '${app.name}' is not running`, status: app.status }));
      }

      const proxyReq = http.request(
        { host: '127.0.0.1', port: app.host_port, method: req.method, path: req.url, headers: req.headers },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream error', detail: err.message }));
      });
      req.pipe(proxyReq);
    } catch (err: any) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(config.deployProxyPort, config.host, () => {
    log.info(`KobeDeploy proxy listening on port ${config.deployProxyPort} (routes by Host header)`);
  });
  return server;
}
