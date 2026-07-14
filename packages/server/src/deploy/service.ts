import http from 'node:http';
import { query } from '../db.js';
import { containerRuntime, allocatePort, type BuildSpec } from './runtime.js';

export interface App {
  id: string;
  project_id: string;
  name: string;
  source_type: 'image' | 'git';
  source: string;
  git_ref: string;
  dockerfile: string;
  container_port: number;
  env: Record<string, string>;
  domain: string | null;
  volumes: { host: string; container: string }[];
  health_check_path: string | null;
  health_check_expected_status: number;
  health_check_retries: number;
  status: string;
  host_port: number | null;
  container_id: string | null;
  image_tag: string | null;
}

// Poll an app's published port until the health-check path returns the expected
// status (Coolify-style). Resolves true when healthy, false if retries exhaust.
function httpStatus(port: number, path: string, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
  });
}

async function waitHealthy(app: App, hostPort: number, onLog: (l: string) => void): Promise<boolean> {
  if (!app.health_check_path) return true; // no health check configured → assume healthy
  const path = app.health_check_path.startsWith('/') ? app.health_check_path : `/${app.health_check_path}`;
  const retries = Math.max(1, app.health_check_retries ?? 10);
  for (let i = 1; i <= retries; i++) {
    const code = await httpStatus(hostPort, path);
    if (code === app.health_check_expected_status) {
      onLog(`health check ${path} → ${code} (healthy)`);
      return true;
    }
    onLog(`health check ${path} attempt ${i}/${retries} → ${code || 'no response'}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function getApp(id: string): Promise<App> {
  const { rows } = await query<App>(`select * from deploy.apps where id = $1`, [id]);
  if (!rows.length) throw Object.assign(new Error('app not found'), { statusCode: 404 });
  return rows[0];
}

async function setApp(id: string, fields: Record<string, any>) {
  const keys = Object.keys(fields);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(`update deploy.apps set ${set}, updated_at = now() where id = $1`, [id, ...keys.map((k) => fields[k])]);
}

/**
 * Build + run an app: creates a deployment row, builds the image (pull or git build),
 * starts a container, publishes it on an allocated host port, and records logs/status.
 * Runs asynchronously; callers poll the deployment or app for status.
 */
export async function deployApp(appId: string): Promise<string> {
  const app = await getApp(appId);
  const rt = containerRuntime();

  const dep = await query<{ id: string }>(
    `insert into deploy.deployments (app_id, status) values ($1, 'building') returning id`,
    [appId],
  );
  const deploymentId = dep.rows[0].id;
  let logbuf = '';
  const onLog = (line: string) => {
    logbuf += line + '\n';
    // fire-and-forget log persistence
    query(`update deploy.deployments set logs = $2 where id = $1`, [deploymentId, logbuf]).catch(() => {});
  };

  // Run the build/run pipeline in the background so the API responds immediately.
  (async () => {
    try {
      await setApp(appId, { status: 'building' });
      const buildSpec: BuildSpec = {
        name: app.name,
        sourceType: app.source_type,
        source: app.source,
        gitRef: app.git_ref,
        dockerfile: app.dockerfile,
        onLog,
      };
      const image = await rt.build(buildSpec);

      // Stop any previous container for this app.
      if (app.container_id) await rt.remove(app.container_id).catch(() => {});

      const hostPort = app.host_port ?? (await allocatePort());
      onLog(`starting container on host port ${hostPort}`);
      const containerId = await rt.run({
        name: app.name,
        image,
        env: app.env ?? {},
        containerPort: app.container_port,
        hostPort,
        volumes: app.volumes ?? [],
      });

      // Health check before declaring the app running (Coolify-style gate).
      const healthy = await waitHealthy(app, hostPort, onLog);
      const finalStatus = healthy ? 'running' : 'unhealthy';
      await setApp(appId, { status: finalStatus, host_port: hostPort, container_id: containerId, image_tag: image });
      await query(
        `update deploy.deployments set status=$4, image_tag=$2, logs=$3, finished_at=now() where id=$1`,
        [deploymentId, image, logbuf + `deployment ${healthy ? 'succeeded' : 'unhealthy'}\n`, healthy ? 'running' : 'failed'],
      );
    } catch (err: any) {
      onLog(`ERROR: ${err.message}`);
      await setApp(appId, { status: 'failed' });
      await query(`update deploy.deployments set status='failed', logs=$2, finished_at=now() where id=$1`, [
        deploymentId,
        logbuf,
      ]);
    }
  })();

  return deploymentId;
}

export async function stopApp(appId: string) {
  const app = await getApp(appId);
  if (app.container_id) await containerRuntime().stop(app.container_id);
  await setApp(appId, { status: 'stopped' });
}

export async function startApp(appId: string) {
  // Re-deploy (idempotent) to bring a stopped/failed app back up.
  return deployApp(appId);
}

export async function destroyApp(appId: string) {
  const app = await getApp(appId);
  if (app.container_id) await containerRuntime().remove(app.container_id).catch(() => {});
  await query(`delete from deploy.apps where id = $1`, [appId]);
}

export async function appLogs(appId: string): Promise<string> {
  const app = await getApp(appId);
  if (!app.container_id) return '(app has never been deployed)';
  return containerRuntime().logs(app.container_id);
}

/** Refresh an app's status from the runtime (containers may exit on their own). */
export async function refreshStatus(app: App): Promise<string> {
  if (!app.container_id) return app.status;
  const s = await containerRuntime().status(app.container_id);
  // A stopped container always wins; otherwise keep app-level states (unhealthy, etc.).
  if (s === 'stopped' && app.status !== 'stopped') {
    await setApp(app.id, { status: 'stopped' });
    return 'stopped';
  }
  return app.status;
}
