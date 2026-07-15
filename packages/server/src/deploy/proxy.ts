import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { FastifyBaseLogger } from 'fastify';
import { query } from '../db.js';
import { config } from '../config.js';

// Resolve TLS material for the proxy: use configured cert/key, else generate a
// self-signed pair (dev only) with openssl.
function resolveTls(log: FastifyBaseLogger): { cert: Buffer; key: Buffer } | null {
  let certFile = config.deployProxyCertFile;
  let keyFile = config.deployProxyKeyFile;

  if (!certFile || !keyFile) {
    const dir = path.resolve(config.certDir);
    certFile = path.join(dir, 'proxy.crt');
    keyFile = path.join(dir, 'proxy.key');
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      fs.mkdirSync(dir, { recursive: true });
      log.warn('deploy proxy TLS: generating a self-signed certificate (development only)');
      const r = spawnSync(
        'openssl',
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
         '-days', '365', '-subj', '/CN=kobedeploy.local'],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) {
        log.error(`deploy proxy TLS: openssl failed, falling back to HTTP: ${r.stderr}`);
        return null;
      }
    }
  }
  try {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
  } catch (e: any) {
    log.error(`deploy proxy TLS: could not read cert/key, falling back to HTTP: ${e.message}`);
    return null;
  }
}

// Reverse proxy: routes incoming requests to the app whose `domain` matches the
// Host header, forwarding to that app's published host port. This is the
// KobeDeploy equivalent of Coolify's Traefik/Caddy edge proxy.
export function startDeployProxy(log: FastifyBaseLogger): http.Server | https.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
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
  };

  let server: http.Server | https.Server;
  let scheme = 'http';
  if (config.deployProxyTls) {
    const tls = resolveTls(log);
    if (tls) {
      server = https.createServer({ cert: tls.cert, key: tls.key }, handler);
      scheme = 'https';
    } else {
      server = http.createServer(handler);
    }
  } else {
    server = http.createServer(handler);
  }

  server.listen(config.deployProxyPort, config.host, () => {
    log.info(`KobeDeploy proxy listening on ${scheme}://:${config.deployProxyPort} (routes by Host header)`);
  });
  return server;
}
