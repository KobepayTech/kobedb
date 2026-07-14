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
  status: string;
  host_port: number | null;
  container_id: string | null;
  image_tag: string | null;
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
      });

      await setApp(appId, { status: 'running', host_port: hostPort, container_id: containerId, image_tag: image });
      await query(
        `update deploy.deployments set status='running', image_tag=$2, logs=$3, finished_at=now() where id=$1`,
        [deploymentId, image, logbuf + 'deployment succeeded\n'],
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
  const mapped = s === 'running' ? 'running' : s === 'stopped' ? 'stopped' : app.status;
  if (mapped !== app.status) await setApp(app.id, { status: mapped });
  return mapped;
}
