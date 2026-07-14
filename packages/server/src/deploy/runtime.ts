import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { config } from '../config.js';

export interface BuildSpec {
  name: string;
  sourceType: 'image' | 'git';
  source: string;
  gitRef: string;
  dockerfile: string;
  onLog: (line: string) => void;
}

export interface RunSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  containerPort: number;
  hostPort: number;
  volumes?: { host: string; container: string }[];
}

export interface ContainerRuntime {
  readonly name: string;
  build(spec: BuildSpec): Promise<string>; // resolves to an image tag
  run(spec: RunSpec): Promise<string>; // resolves to a container id
  stop(containerId: string): Promise<void>;
  remove(containerId: string): Promise<void>;
  logs(containerId: string): Promise<string>;
  status(containerId: string): Promise<'running' | 'stopped' | 'unknown'>;
}

// Allocate a free TCP port by binding to 0 and reading the assigned port.
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function sh(bin: string, args: string[], onLog?: (l: string) => void): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let out = '';
    const cap = (d: Buffer) => {
      const s = d.toString();
      out += s;
      if (onLog) for (const line of s.split('\n')) if (line.trim()) onLog(line);
    };
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    child.on('error', (e) => resolve({ code: 1, out: out + String(e) }));
    child.on('close', (code) => resolve({ code: code ?? 0, out }));
  });
}

// ── Real Docker runtime ────────────────────────────────────────────────────
class DockerRuntime implements ContainerRuntime {
  name = 'docker';

  async build(spec: BuildSpec): Promise<string> {
    if (spec.sourceType === 'image') {
      spec.onLog(`pulling image ${spec.source}`);
      const r = await sh('docker', ['pull', spec.source], spec.onLog);
      if (r.code !== 0) throw new Error(`docker pull failed: ${spec.source}`);
      return spec.source;
    }
    // git: clone then docker build
    const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'kobedeploy-'));
    spec.onLog(`cloning ${spec.source}@${spec.gitRef}`);
    let r = await sh('git', ['clone', '--depth', '1', '--branch', spec.gitRef, spec.source, workdir], spec.onLog);
    if (r.code !== 0) throw new Error('git clone failed');
    const tag = `kobedeploy/${spec.name}:${Date.now()}`;
    spec.onLog(`building image ${tag}`);
    r = await sh('docker', ['build', '-f', path.join(workdir, spec.dockerfile), '-t', tag, workdir], spec.onLog);
    await fs.rm(workdir, { recursive: true, force: true });
    if (r.code !== 0) throw new Error('docker build failed');
    return tag;
  }

  async run(spec: RunSpec): Promise<string> {
    const container = `kobedeploy_${spec.name}_${Date.now()}`;
    const args = ['run', '-d', '--name', container, '-p', `${spec.hostPort}:${spec.containerPort}`];
    for (const [k, v] of Object.entries(spec.env)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) args.push('-e', `${k}=${v}`);
    }
    for (const vol of spec.volumes ?? []) {
      if (vol.host && vol.container) args.push('-v', `${vol.host}:${vol.container}`);
    }
    args.push(spec.image);
    const r = await sh('docker', args);
    if (r.code !== 0) throw new Error(`docker run failed: ${r.out}`);
    return r.out.trim().split('\n').pop() || container;
  }

  async stop(id: string) { await sh('docker', ['stop', id]); }
  async remove(id: string) { await sh('docker', ['rm', '-f', id]); }
  async logs(id: string) { return (await sh('docker', ['logs', '--tail', '500', id])).out; }
  async status(id: string): Promise<'running' | 'stopped' | 'unknown'> {
    const r = await sh('docker', ['inspect', '-f', '{{.State.Running}}', id]);
    if (r.code !== 0) return 'unknown';
    return r.out.trim() === 'true' ? 'running' : 'stopped';
  }
}

// ── Mock runtime ────────────────────────────────────────────────────────────
// Runs a real minimal HTTP server per "container" so deploys and the reverse
// proxy can be exercised end-to-end without Docker installed.
class MockRuntime implements ContainerRuntime {
  name = 'mock';
  private servers = new Map<string, { server: http.Server; logs: string }>();

  async build(spec: BuildSpec): Promise<string> {
    spec.onLog(`[mock] preparing ${spec.sourceType}:${spec.source}`);
    spec.onLog('[mock] build complete');
    return `mock/${spec.name}:${Date.now()}`;
  }

  async run(spec: RunSpec): Promise<string> {
    const id = `mock-${spec.name}-${Date.now()}`;
    const started = new Date().toISOString();
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          app: spec.name,
          image: spec.image,
          runtime: 'mock',
          path: req.url,
          env_keys: Object.keys(spec.env),
          started,
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(spec.hostPort, '127.0.0.1', () => resolve());
    });
    this.servers.set(id, { server, logs: `[mock] container ${id} listening on :${spec.hostPort}\n` });
    return id;
  }

  async stop(id: string) {
    const c = this.servers.get(id);
    if (c) await new Promise<void>((r) => c.server.close(() => r()));
  }
  async remove(id: string) {
    await this.stop(id);
    this.servers.delete(id);
  }
  async logs(id: string) { return this.servers.get(id)?.logs ?? '[mock] no such container'; }
  async status(id: string): Promise<'running' | 'stopped' | 'unknown'> {
    const c = this.servers.get(id);
    if (!c) return 'unknown';
    return c.server.listening ? 'running' : 'stopped';
  }
}

let dockerAvailable: boolean | undefined;
function hasDocker(): boolean {
  if (dockerAvailable === undefined) {
    try {
      dockerAvailable = spawnSync('docker', ['info'], { encoding: 'utf8' }).status === 0;
    } catch {
      dockerAvailable = false;
    }
  }
  return dockerAvailable;
}

let runtime: ContainerRuntime | null = null;
export function containerRuntime(): ContainerRuntime {
  if (!runtime) {
    const choice =
      config.deployRuntime === 'auto' ? (hasDocker() ? 'docker' : 'mock') : config.deployRuntime;
    runtime = choice === 'docker' ? new DockerRuntime() : new MockRuntime();
  }
  return runtime;
}

export function activeDeployRuntime(): string {
  return containerRuntime().name;
}
