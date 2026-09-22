import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, connect, type Socket, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';

// Local production-bundle proof. Uses only the explicitly configured local Supabase.
const database = new URL(process.env.DATABASE_URL!);
if (!['localhost', '127.0.0.1'].includes(database.hostname))
  throw new Error('Local proof requires a local Supabase database');
const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const auth = await client.auth.signInWithPassword({
  email: process.env.SEED_EMAIL!,
  password: process.env.SEED_PASSWORD!,
});
if (auth.error || !auth.data.session) throw new Error('Local seed sign-in failed');
const org = (await client.from('organizations').select('id,name')).data?.find(
  (o) => o.name === 'Acme Labs',
);
if (!org) throw new Error('Seed organization missing');
const databasePort = Number(database.port || 5432);
const sockets = new Set<Socket>();
let databaseAvailable = true;
const proxy = createServer((inbound) => {
  if (!databaseAvailable) {
    inbound.destroy();
    return;
  }
  const outbound = connect(databasePort, database.hostname);
  for (const s of [inbound, outbound]) {
    sockets.add(s);
    s.on('error', () => {});
    s.on('close', () => sockets.delete(s));
  }
  inbound.pipe(outbound);
  outbound.pipe(inbound);
  inbound.on('close', () => outbound.destroy());
  outbound.on('close', () => inbound.destroy());
}).listen(0, '127.0.0.1');
await once(proxy, 'listening');
database.port = String((proxy.address() as AddressInfo).port);
async function freePort() {
  const s = createServer().listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
const workerPort = await freePort(),
  gatewayPort = await freePort();
const workerToken = randomBytes(32).toString('hex');
const endpoint = `http://127.0.0.1:${gatewayPort}`;
const environment = {
  ...process.env,
  APP_ENV: 'test',
  WORKER_PORT: String(workerPort),
  PORT: String(gatewayPort),
  WORKER_AUTH_TOKEN: workerToken,
  WORKER_URL: `http://127.0.0.1:${workerPort}`,
  DATABASE_URL: database.href,
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? 'http://127.0.0.1:4318/v1/traces',
};
let logs = '';
function start(path: string) {
  const child = spawn(process.execPath, [path], {
    env: environment,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (b) => {
    logs += String(b);
  });
  child.stderr.on('data', (b) => {
    logs += String(b);
  });
  return child;
}
async function stop(child: ChildProcess | undefined) {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await once(child, 'close');
  }
}
async function waitReady(url: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url, { headers, signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      /* startup may still be in progress */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Local service failed readiness');
}
const headers = {
  authorization: 'Bearer ' + auth.data.session.access_token,
  'x-organization-id': org.id,
  'content-type': 'application/json',
};
async function invoke(key: string) {
  const r = await fetch(endpoint + '/api/invoke', {
    method: 'POST',
    headers: { ...headers, 'idempotency-key': key },
    body: JSON.stringify({ name: 'demo.crm.customer.search', arguments: {} }),
  });
  if (!r.ok) throw new Error('Invoke HTTP failed');
  return (await r.json()) as { status: string; executionId: string; traceId: string };
}
let worker: ChildProcess | undefined, gateway: ChildProcess | undefined;
const checks: string[] = [];
function check(condition: unknown, label: string) {
  if (!condition) throw new Error(label);
  checks.push(label);
  process.stdout.write('PASS ' + label + '\n');
}
try {
  worker = start('dist/services/connector-worker/src/main.js');
  await waitReady(environment.WORKER_URL + '/ready', { authorization: 'Bearer ' + workerToken });
  gateway = start('dist/apps/gateway/src/main.js');
  await waitReady(endpoint + '/ready');
  const key = randomUUID(),
    first = await invoke(key);
  check(
    first.status === 'succeeded',
    'production Gateway → HTTP Worker → process connector → local Supabase',
  );
  await new Promise((r) => setTimeout(r, 4000));
  const trace = (await (
    await fetch('http://127.0.0.1:16686/api/traces/' + first.traceId)
  ).json()) as { data?: { spans: { operationName: string; duration: number }[] }[] };
  const spans = trace.data?.[0]?.spans ?? [];
  check(
    [
      'gateway.request',
      'gateway.authentication',
      'gateway.policy',
      'gateway.dispatch',
      'worker.job',
      'connector.execute',
    ].every((name) => spans.some((s) => s.operationName === name && s.duration > 0)),
    'OTLP collector and Jaeger contain correlated spans with real durations',
  );
  const inspector = spawn(process.execPath, ['--import', 'tsx', 'scripts/inspector-live.ts'], {
    env: { ...environment, INSPECTOR_ENDPOINT: endpoint + '/mcp' },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let inspectorOutput = '';
  inspector.stdout.on('data', (b) => {
    inspectorOutput += String(b);
  });
  inspector.stderr.resume();
  const [inspectorCode] = await once(inspector, 'close');
  check(
    inspectorCode === 0 && inspectorOutput.includes('tools/call: passed'),
    'official Inspector tools/list and tools/call via separate worker',
  );
  const malformed = await fetch(endpoint + '/mcp', { method: 'POST', headers, body: '{malformed' });
  check(malformed.status === 400, 'malformed MCP request rejected');
  await stop(gateway);
  gateway = start('dist/apps/gateway/src/main.js');
  await waitReady(endpoint + '/ready');
  const replay = await invoke(key);
  check(
    replay.executionId === first.executionId && replay.status === 'succeeded',
    'gateway restart preserves durable execution idempotency',
  );
  await stop(worker);
  check((await fetch(endpoint + '/ready')).status === 503, 'worker outage makes gateway unready');
  worker = start('dist/services/connector-worker/src/main.js');
  await waitReady(environment.WORKER_URL + '/ready', { authorization: 'Bearer ' + workerToken });
  await waitReady(endpoint + '/ready');
  check((await invoke(randomUUID())).status === 'succeeded', 'worker restart recovers execution');
  databaseAvailable = false;
  for (const socket of sockets) socket.destroy();
  check(
    (await fetch(endpoint + '/ready')).status === 503,
    'real database connection outage makes gateway unready',
  );
  check(
    (await fetch(endpoint + '/health')).status === 200,
    'gateway remains alive during database outage',
  );
  databaseAvailable = true;
  await waitReady(endpoint + '/ready');
  check(
    (await invoke(randomUUID())).status === 'succeeded',
    'database reconnection recovers execution',
  );
  for (const secret of [
    workerToken,
    process.env.MASTER_KEY!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    auth.data.session.access_token,
  ].filter(Boolean))
    check(!logs.includes(secret), 'runtime logs omit configured credential ' + checks.length);
  await mkdir('.local', { recursive: true });
  await writeFile(
    '.local/v1.2-local-proof.json',
    JSON.stringify(
      {
        time: new Date().toISOString(),
        checks,
        traceId: first.traceId,
        spanNames: spans.map((s) => s.operationName),
      },
      null,
      2,
    ),
  );
} finally {
  await stop(gateway);
  await stop(worker);
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((r) => proxy.close(() => r()));
  await client.auth.signOut({ scope: 'local' });
}
