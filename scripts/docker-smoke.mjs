/* global URL, fetch, AbortSignal, setTimeout */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
const docker = (...args) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
const suffix = randomBytes(5).toString('hex'),
  network = 'omnimcp-proof-' + suffix;
const worker = 'omni-worker-' + suffix,
  gateway = 'omni-gateway-' + suffix,
  web = 'omni-web-' + suffix;
const database = new URL(process.env.DATABASE_URL),
  supabase = new URL(process.env.SUPABASE_URL);
if (![database, supabase].every((u) => ['localhost', '127.0.0.1'].includes(u.hostname)))
  throw new Error('Docker smoke is local-only');
database.hostname = 'host.docker.internal';
supabase.hostname = 'host.docker.internal';
const token = randomBytes(32).toString('hex');
await mkdir('.local', { recursive: true });
const workerFile = resolve('.local', suffix + '-worker.env'),
  gatewayFile = resolve('.local', suffix + '-gateway.env');
const serialize = (env) =>
  Object.entries(env)
    .map(([k, v]) => {
      if (!v || /[\r\n]/.test(v)) throw new Error('Invalid local configuration: ' + k);
      return k + '=' + v;
    })
    .join('\n');
await writeFile(
  workerFile,
  serialize({ APP_ENV: 'test', DATABASE_URL: database.href, WORKER_AUTH_TOKEN: token }),
  { mode: 0o600 },
);
await writeFile(
  gatewayFile,
  serialize({
    APP_ENV: 'test',
    DATABASE_URL: database.href,
    WORKER_AUTH_TOKEN: token,
    WORKER_URL: `http://${worker}:4100`,
    SUPABASE_URL: supabase.href,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    MASTER_KEY: process.env.MASTER_KEY,
    GATEWAY_HOSTS: 'localhost,127.0.0.1',
  }),
  { mode: 0o600 },
);
const port = (name) =>
  docker(
    'inspect',
    '--format',
    '{{(index (index .NetworkSettings.Ports "' +
      (name === web ? '3000' : '4000') +
      '/tcp") 0).HostPort}}',
    name,
  );
async function ready(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Container readiness failed');
}
try {
  docker('network', 'create', network);
  docker(
    'run',
    '-d',
    '--name',
    worker,
    '--network',
    network,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--env-file',
    workerFile,
    'omnimcp-gateway:v1.2',
    'node',
    'dist/services/connector-worker/src/main.js',
  );
  docker(
    'run',
    '-d',
    '--name',
    gateway,
    '--network',
    network,
    '--add-host',
    'host.docker.internal:host-gateway',
    '--env-file',
    gatewayFile,
    '-p',
    '127.0.0.1::4000',
    'omnimcp-gateway:v1.2',
  );
  await ready('http://127.0.0.1:' + port(gateway) + '/ready');
  process.stdout.write(
    'PASS Docker Gateway and private Worker readiness with real local Supabase\n',
  );
  docker(
    'run',
    '-d',
    '--name',
    web,
    '--network',
    network,
    '-p',
    '127.0.0.1::3000',
    'omnimcp-web:v1.2',
  );
  await ready('http://127.0.0.1:' + port(web) + '/dashboard');
  process.stdout.write(
    'PASS Docker Next.js dashboard HTTP (placeholder public build configuration; authentication tested separately)\n',
  );
  for (const name of [worker, gateway, web])
    if (docker('inspect', '--format', '{{.Config.User}}', name) !== 'node')
      throw new Error('Container must run as node');
  process.stdout.write('PASS all application containers run as nonroot node user\n');
} finally {
  for (const name of [gateway, worker, web])
    try {
      docker('rm', '-f', name);
    } catch {
      /* only task-owned containers */
    }
  try {
    docker('network', 'rm', network);
  } catch {
    /* may not have been created */
  }
  await unlink(workerFile);
  await unlink(gatewayFile);
}
