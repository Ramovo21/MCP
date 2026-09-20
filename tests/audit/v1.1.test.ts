import { beforeAll, afterAll, test, expect } from 'vitest';
import { config } from 'dotenv';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { PostgresDatabase } from '../../packages/database/src/index.js';
import { hash } from '../../packages/shared/src/secrets.js';
import { SafeHttp } from '../../packages/shared/src/http.js';
import { upstreams } from '../fixtures/upstreams.js';

config({ path: process.env.AUDIT_ENV_FILE ?? '.env', override: true, quiet: true });
const org = randomUUID(),
  foreign = randomUUID(),
  foreignConnection = randomUUID(),
  foreignTool = randomUUID(),
  foreignExecution = randomUUID(),
  foreignApproval = randomUUID(),
  foreignKey = randomUUID();
const port = Number(process.env.AUDIT_GATEWAY_PORT ?? 4100),
  base = `http://127.0.0.1:${port}`;
let db: PostgresDatabase, gateway: ChildProcess, upstream: Awaited<ReturnType<typeof upstreams>>;
let token = '',
  key = '',
  keyId = '',
  user = '',
  demoConnection = '',
  customer = '',
  restConnection = '',
  pgDatabase = '',
  logs = '';
type Result = {
  executionId: string;
  status: string;
  result?: unknown;
  traceId?: string;
  error?: { code: string; kind: string; retryable: boolean };
};
const headers = () => ({
  authorization: `Bearer ${token}`,
  'x-organization-id': org,
  'content-type': 'application/json',
});
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
) {
  return fetch(base + path, {
    method,
    headers: { ...headers(), ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api<T = Record<string, unknown>>(
  path: string,
  method = 'GET',
  body?: unknown,
  extra: Record<string, string> = {},
): Promise<T> {
  const r = await request(path, method, body, extra);
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T;
}
const invoke = (name: string, args = {}, extra = {}) =>
  api<Result>('/api/invoke', 'POST', { name, arguments: args }, extra);
async function approval(execution: string) {
  return (
    await db.system.query<{ id: string }>(
      'select id from approval_requests where organization_id=$1 and execution_id=$2',
      [org, execution],
    )
  ).rows[0]!.id;
}
async function inspect(method: string, name?: string, args = {}) {
  const require = createRequire(import.meta.url),
    cli = resolve(
      dirname(require.resolve('@modelcontextprotocol/inspector/package.json')),
      'clients/launcher/build/index.js',
    );
  return new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        '--cli',
        base + '/mcp',
        '--protocol-era',
        'modern',
        '--format',
        'json',
        '--header',
        `Authorization: Bearer ${key}`,
        '--method',
        method,
        ...(name ? ['--tool-name', name, '--tool-args-json', JSON.stringify(args)] : []),
      ],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MCP_CATALOG_PATH: resolve('.local/audit-inspector.json') },
      },
    );
    let output = '',
      errorOutput = '';
    child.stdout.on('data', (b) => (output += String(b)));
    child.stderr.on('data', (b) => (errorOutput += String(b)));
    child.on('error', reject);
    const timer = setTimeout(() => child.kill(), 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolveOutput(output);
      else
        reject(
          new Error(
            `Inspector ${method} failed (${code}): ${(errorOutput + output).replaceAll(key, '[REDACTED]').replaceAll(token, '[REDACTED]').slice(-800)}`,
          ),
        );
    });
  });
}
const executionId = (text: string) => {
  const id = text.replaceAll('\\"', '"').match(/"executionId"\s*:\s*"([a-f0-9-]+)"/)?.[1];
  if (!id) throw new Error('Inspector returned no execution ID');
  return id;
};

beforeAll(async () => {
  if (
    new URL(process.env.SUPABASE_URL!).hostname !== '127.0.0.1' ||
    new URL(process.env.DATABASE_URL!).hostname !== '127.0.0.1'
  )
    throw new Error('Audit requires explicitly local Supabase');
  await mkdir('.local', { recursive: true });
  db = new PostgresDatabase(process.env.DATABASE_URL!);
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const login = await supabase.auth.signInWithPassword({
    email: process.env.SEED_EMAIL!,
    password: process.env.SEED_PASSWORD!,
  });
  if (login.error || !login.data.session) throw new Error('Seed login failed');
  token = login.data.session.access_token;
  user = login.data.user!.id;
  await db.system.query(
    "insert into organizations(id,name) values($1,'V1.1 audit A'),($2,'V1.1 audit B')",
    [org, foreign],
  );
  await db.system.query("insert into organization_members values($1,$2,'owner')", [org, user]);
  await db.system.query(
    'insert into approval_policies(organization_id,allow_self_approval) values($1,true)',
    [org],
  );
  upstream = await upstreams();
  gateway = spawn(process.execPath, ['--import', 'tsx', 'apps/gateway/src/main.ts'], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      WEB_ORIGIN: 'http://localhost:3000',
      GATEWAY_HOSTS: '127.0.0.1,localhost',
      CONNECTOR_PRIVATE_HOSTS: '127.0.0.1',
      CONNECTOR_INSECURE_PG_HOSTS: '127.0.0.1',
      NODE_EXTRA_CA_CERTS: upstream.certificatePath,
      CONNECTOR_MODULES: pathToFileURL(resolve('tests/fixtures/failure-connector.ts')).href,
      WORKER_TIMEOUT_MS: '5000',
      WORKER_CONCURRENCY: '4',
    },
  });
  gateway.stdout!.on('data', (b) => (logs += String(b)));
  gateway.stderr!.on('data', (b) => (logs += String(b)));
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(base + '/health')).ok) {
        ready = true;
        break;
      }
    } catch {
      /* startup */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('Normal gateway startup failed: ' + logs.slice(-600));
  demoConnection = (
    await api<{ id: string }>('/api/connections', 'POST', {
      name: 'Audit CRM',
      connectorId: 'demo-crm',
    })
  ).id;
  await api(`/api/connections/${demoConnection}/import`, 'POST', {
    names: ['demo.crm.customer.search', 'demo.crm.customer.get', 'demo.crm.note.create'],
  });
  customer = (
    await db.system.query<{ id: string }>(
      'select id from demo_customers where organization_id=$1 limit 1',
      [org],
    )
  ).rows[0]!.id;
  const issued = await api<{ id: string; key: string }>('/api/keys', 'POST', {
    name: 'Audit agent',
    scopes: ['demo.crm.customer.search', 'demo.crm.note.create'],
  });
  key = issued.key;
  keyId = issued.id;
}, 60000);

afterAll(async () => {
  if (gateway?.exitCode === null) {
    gateway.kill();
    await once(gateway, 'exit');
  }
  await upstream?.close();
  if (!db) return;
  if (pgDatabase) await db.system.query(`drop database "${pgDatabase}" with (force)`);
  for (const tenant of [org, foreign]) {
    for (const table of [
      'oauth_states',
      'oauth_tokens',
      'demo_notes',
      'execution_steps',
      'approval_requests',
      'executions',
      'tool_permissions',
      'tools',
      'webhook_events',
      'mcp_servers',
      'connection_secrets',
      'connections',
      'api_keys',
      'audit_logs',
      'demo_customers',
      'approval_policies',
      'organization_members',
    ])
      await db.system.query(`delete from ${table} where organization_id=$1`, [tenant]);
    await db.system.query('delete from organizations where id=$1', [tenant]);
  }
  await db.close();
}, 30000);

test('B: official Inspector negotiates modern MCP, lists tools, invokes READ/WRITE/CRITICAL and enforces both approval decisions', async () => {
  const client = new Client(
    { name: 'audit-independent-client', version: '1.1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
      requestInit: { headers: { authorization: 'Bearer ' + key } },
    }),
  );
  expect(client.getProtocolEra()).toBe('modern');
  await client.close();
  expect(await inspect('tools/list')).toContain('demo.crm.customer.search');
  expect(await inspect('tools/call', 'demo.crm.customer.search')).toContain('Ada Nguyen');
  const write = executionId(
    await inspect('tools/call', 'demo.crm.note.create', {
      customerId: customer,
      body: 'WRITE approval',
    }),
  );
  expect(
    (await db.system.query('select id from demo_notes where execution_id=$1', [write])).rows,
  ).toHaveLength(0);
  expect(
    (
      await api<Result>(`/api/approvals/${await approval(write)}/decide`, 'POST', {
        decision: 'approved',
      })
    ).status,
  ).toBe('succeeded');
  const tool = (
    await db.system.query<{ id: string }>(
      "select id from tools where organization_id=$1 and name='demo.crm.note.create'",
      [org],
    )
  ).rows[0]!.id;
  await api(`/api/tools/${tool}`, 'PATCH', { risk: 'CRITICAL' });
  for (const role of ['owner', 'developer'])
    await api(`/api/tools/${tool}/permissions`, 'PUT', { role, allowed: true });
  const rejected = executionId(
    await inspect('tools/call', 'demo.crm.note.create', {
      customerId: customer,
      body: 'Must never execute',
    }),
  );
  await api(`/api/approvals/${await approval(rejected)}/decide`, 'POST', { decision: 'rejected' });
  expect(
    (await db.system.query('select id from demo_notes where execution_id=$1', [rejected])).rows,
  ).toHaveLength(0);
  const accepted = executionId(
    await inspect('tools/call', 'demo.crm.note.create', {
      customerId: customer,
      body: 'Execute once',
    }),
  );
  const approvalId = await approval(accepted);
  const races = await Promise.all(
    Array.from({ length: 8 }, () =>
      request(`/api/approvals/${approvalId}/decide`, 'POST', { decision: 'approved' }),
    ),
  );
  expect(races.filter((r) => r.status === 200)).toHaveLength(1);
  expect(races.filter((r) => r.status === 409)).toHaveLength(7);
  expect(
    (await db.system.query('select id from demo_notes where execution_id=$1', [accepted])).rows,
  ).toHaveLength(1);
  expect(
    (
      await db.system.query(
        "select id from audit_logs where organization_id=$1 and target_id=$2 and action='tool.succeeded'",
        [org, accepted],
      )
    ).rows,
  ).toHaveLength(1);
}, 60000);

test('C: real HTTPS OpenAPI discovery, selected publishing, schemas, destructive policy and traceable invocation', async () => {
  restConnection = (
    await api<{ id: string }>('/api/connections', 'POST', {
      name: 'Independent REST',
      connectorId: 'openapi',
      config: {
        baseUrl: upstream.url,
        specUrl: upstream.url + '/openapi.json',
        namespace: 'audit.rest',
      },
      secrets: { bearerToken: 'audit-stored-credential' },
    })
  ).id;
  const tools = await api<
    { fullName: string; risk: string; inputSchema: Record<string, unknown> }[]
  >(`/api/connections/${restConnection}/discover`, 'POST');
  expect(tools).toHaveLength(6);
  expect(tools.find((t) => t.fullName === 'audit.rest.customers.delete')?.risk).toBe('CRITICAL');
  expect(tools.find((t) => t.fullName === 'audit.rest.customers.list')?.risk).toBe('READ');
  expect(
    tools.find((t) => t.fullName === 'audit.rest.customers.create')?.inputSchema.required,
  ).toContain('body');
  await api(`/api/connections/${restConnection}/import`, 'POST', {
    names: tools.filter((t) => !t.fullName.endsWith('.delete')).map((t) => t.fullName),
  });
  expect(
    (await api<{ name: string }[]>('/api/tools')).some((t) => t.name.endsWith('customers.delete')),
  ).toBe(false);
  const read = await invoke('audit.rest.customers.get', { id: '1' });
  expect(read.status).toBe('succeeded');
  expect(read.result).toMatchObject({ name: 'Independent REST customer' });
  expect((await invoke('audit.rest.customers.create', { body: { other: true } })).status).toBe(
    'denied',
  );
  const write = await invoke('audit.rest.customers.create', {
    body: { name: 'Created through gateway' },
  });
  expect(write.status).toBe('pending');
  expect(upstream.writes).toHaveLength(0);
  await api(`/api/approvals/${await approval(write.executionId)}/decide`, 'POST', {
    decision: 'approved',
  });
  expect(upstream.writes).toEqual([write.executionId]);
  expect(JSON.stringify((await invoke('audit.rest.echo.get')).result)).not.toContain(
    'audit-stored-credential',
  );
  const echoClient = new Client(
    { name: 'credential-audit', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await echoClient.connect(
      new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
        requestInit: { headers: headers() },
      }),
    );
    expect(
      JSON.stringify(await echoClient.callTool({ name: 'audit.rest.echo.get', arguments: {} })),
    ).not.toContain('audit-stored-credential');
  } finally {
    await echoClient.close();
  }
  const detail = await api<{ trace_id: string; steps: { stage: string }[] }>(
    `/api/executions/${read.executionId}`,
  );
  expect(detail.trace_id).toBe(read.traceId);
  expect(detail.steps.map((s) => s.stage)).toEqual(
    expect.arrayContaining([
      'authenticated',
      'policy_evaluated',
      'worker_started',
      'connector_started',
      'upstream_started',
      'upstream_response',
      'succeeded',
    ]),
  );
  expect(upstream.traces.some((t) => t.includes(read.traceId!))).toBe(true);
}, 60000);

test('C: disposable PostgreSQL database discovers schema and uses read-only parameterized projections', async () => {
  pgDatabase = 'audit_' + randomUUID().replaceAll('-', '');
  await db.system.query(`create database "${pgDatabase}"`);
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/' + pgDatabase;
  const source = new pg.Client({ connectionString: url.href });
  await source.connect();
  try {
    await source.query(
      'create table public.customers(id text primary key,name text,private_data text)',
    );
    await source.query("insert into customers values('1','Database customer','hidden')");
  } finally {
    await source.end();
  }
  const connection = (
    await api<{ id: string }>('/api/connections', 'POST', {
      name: 'Disposable PostgreSQL',
      connectorId: 'postgres',
      secrets: { databaseUrl: url.href },
      config: {
        namespace: 'audit.pg',
        tables: [
          {
            schema: 'public',
            table: 'customers',
            columns: ['id', 'name'],
            key: 'id',
            operations: ['search', 'get'],
          },
        ],
        allowWrites: false,
      },
    })
  ).id;
  expect(await api<unknown[]>(`/api/connections/${connection}/schema`)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        table_schema: 'public',
        table_name: 'customers',
        column_name: 'name',
      }),
    ]),
  );
  const definitions = await api<{ fullName: string; risk: string }[]>(
    `/api/connections/${connection}/discover`,
    'POST',
  );
  expect(definitions.every((t) => t.risk === 'READ')).toBe(true);
  await api(`/api/connections/${connection}/import`, 'POST', {
    names: definitions.map((t) => t.fullName),
  });
  expect((await invoke('audit.pg.public.customers.get', { id: '1' })).result).toEqual([
    { id: '1', name: 'Database customer' },
  ]);
  expect(
    (
      await invoke('audit.pg.public.customers.search', {
        filters: { name: "'; DROP TABLE customers; --" },
      })
    ).result,
  ).toEqual([]);
  expect(
    (
      await invoke('audit.pg.public.customers.search', {
        filters: { 'name;drop table customers': 'x' },
      })
    ).status,
  ).toBe('denied');
  expect(
    (await invoke('audit.pg.public.customers.search', { sql: 'delete from customers' })).status,
  ).toBe('denied');
  expect((await invoke('audit.pg.public.customers.get', { id: '1' })).status).toBe('succeeded');
  expect(
    (
      await request(`/api/connections/${connection}/config`, 'PUT', {
        namespace: 'audit.pg',
        tables: [
          { schema: 'public', table: 'customers', columns: ['id', 'name'], operations: ['insert'] },
        ],
        allowWrites: false,
      })
    ).status,
  ).toBeGreaterThanOrEqual(400);
  const raw = JSON.stringify(
    (
      await db.system.query(
        'select * from connection_secrets where organization_id=$1 and connection_id=$2',
        [org, connection],
      )
    ).rows,
  );
  expect(raw).not.toContain(url.href);
  expect(raw).toContain('v1.');
}, 60000);

test('C: independent MCP upstream is imported and approval remains mandatory', async () => {
  const connection = (
    await api<{ id: string }>('/api/connections', 'POST', {
      name: 'Independent MCP',
      connectorId: 'remote-mcp',
      config: { namespace: 'audit.remote', url: upstream.url + '/mcp' },
    })
  ).id;
  expect(await api(`/api/connections/${connection}/discover`, 'POST')).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ fullName: 'audit.remote.lookup', risk: 'CRITICAL' }),
    ]),
  );
  await api(`/api/connections/${connection}/import`, 'POST', { names: ['audit.remote.lookup'] });
  const tool = (
    await db.system.query<{ id: string }>(
      "select id from tools where organization_id=$1 and name='audit.remote.lookup'",
      [org],
    )
  ).rows[0]!.id;
  await api(`/api/tools/${tool}/permissions`, 'PUT', { role: 'owner', allowed: true });
  const result = await invoke('audit.remote.lookup', { query: 'customer' });
  expect(result.status).toBe('pending');
  const accepted = await api<Result>(
    `/api/approvals/${await approval(result.executionId)}/decide`,
    'POST',
    { decision: 'approved' },
  );
  expect(accepted.status).toBe('succeeded');
  expect(JSON.stringify(accepted.result)).toContain('Independent MCP response');
}, 30000);

test('D: API and real Supabase RLS isolate connections/tools/executions/approvals/keys; key secrets and revocation are enforced', async () => {
  await db.system.query(
    "insert into connections(id,organization_id,name,connector_id) values($1,$2,'Foreign','demo-crm')",
    [foreignConnection, foreign],
  );
  await db.system.query(
    "insert into tools(id,organization_id,connection_id,name,description,input_schema,risk,baseline_risk) values($1,$2,$3,'foreign.tool.read','Foreign','{}','READ','READ')",
    [foreignTool, foreign, foreignConnection],
  );
  await db.system.query(
    "insert into api_keys(id,organization_id,name,prefix,key_hash,created_by) values($1,$2,'Foreign','omni_', $3,$4)",
    [foreignKey, foreign, hash(randomBytes(32).toString('hex')), user],
  );
  await db.system.query(
    "insert into executions(id,organization_id,request_id,tool_name,principal,arguments_redacted,request_hash,idempotency_key,status) values($1,$2,$3,'foreign.tool.read','{}','{}','hash','foreign','pending')",
    [foreignExecution, foreign, randomUUID()],
  );
  await db.system.query(
    "insert into approval_requests(id,organization_id,execution_id,risk,reason) values($1,$2,$3,'CRITICAL','Foreign')",
    [foreignApproval, foreign, foreignExecution],
  );
  expect((await request(`/api/connections/${foreignConnection}/discover`, 'POST')).status).toBe(
    404,
  );
  expect((await request(`/api/tools/${foreignTool}`, 'PATCH', { enabled: true })).status).toBe(404);
  expect((await request(`/api/executions/${foreignExecution}`)).status).toBe(404);
  expect(
    (await request(`/api/approvals/${foreignApproval}/decide`, 'POST', { decision: 'approved' }))
      .status,
  ).toBe(404);
  await request(`/api/keys/${foreignKey}`, 'DELETE');
  expect(
    (await db.system.query('select revoked_at from api_keys where id=$1', [foreignKey])).rows[0]
      ?.revoked_at,
  ).toBeNull();
  for (const path of ['/api/console', '/api/tools'])
    expect((await request(path, 'GET', undefined, { 'x-organization-id': foreign })).status).toBe(
      403,
    );
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    global: { headers: { Authorization: 'Bearer ' + token } },
    auth: { persistSession: false },
  });
  for (const table of [
    'connections',
    'tools',
    'executions',
    'approval_requests',
    'api_keys',
    'oauth_tokens',
    'connection_secrets',
  ]) {
    const result = await supabase.from(table).select('*').eq('organization_id', foreign);
    expect(result.data ?? []).toHaveLength(0);
    expect(
      (
        await db.tenant(org, (sql) =>
          sql.query(`select * from ${table} where organization_id=$1`, [foreign]),
        )
      ).rows,
    ).toHaveLength(0);
  }
  expect(
    (await supabase.from('tools').select('*').eq('organization_id', org)).data ?? [],
  ).toHaveLength(0);
  expect(
    (
      await request('/api/connections', 'POST', {
        name: 'Invalid nested secret',
        connectorId: 'openapi',
        config: { nested: { authorization: 'never-store-plaintext' } },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await request('/api/tools', 'GET', undefined, {
        authorization: 'Bearer ' + key,
        'x-organization-id': foreign,
      })
    ).status,
  ).toBe(401);
  expect(
    (await request('/api/tools', 'GET', undefined, { authorization: 'Bearer omni_invalid' }))
      .status,
  ).toBe(401);
  const stored = (await db.system.query('select * from api_keys where id=$1', [keyId])).rows[0]!;
  expect(stored.key_hash).toBe(hash(key));
  expect(JSON.stringify(stored)).not.toContain(key);
  const data = await api('/api/console');
  expect(JSON.stringify(data)).not.toContain(key);
  expect(JSON.stringify(data)).not.toContain('ciphertext');
  const temporary = await api<{ id: string; key: string }>('/api/keys', 'POST', {
    name: 'Revoke test',
    scopes: ['demo.crm.customer.search'],
  });
  await api(`/api/keys/${temporary.id}`, 'DELETE');
  expect(
    (await request('/api/tools', 'GET', undefined, { authorization: 'Bearer ' + temporary.key }))
      .status,
  ).toBe(401);
});

test('D: CRITICAL cannot bypass policy through Playground REST, MCP, API keys or forged payload fields', async () => {
  for (const auth of [headers(), { authorization: 'Bearer ' + key }]) {
    const result = await invoke(
      'demo.crm.note.create',
      { customerId: customer, body: 'Bypass attempt' },
      auth,
    );
    expect(result.status).toBe('pending');
    expect(
      (
        await db.system.query('select id from demo_notes where execution_id=$1', [
          result.executionId,
        ])
      ).rows,
    ).toHaveLength(0);
  }
  const forged = await request('/api/invoke', 'POST', {
    name: 'demo.crm.note.create',
    arguments: { customerId: customer, body: 'Forged' },
    approved: true,
    risk: 'READ',
    organizationId: foreign,
  });
  expect(forged.status).toBe(400);
  expect(
    (
      await request(
        '/api/approvals/' + foreignApproval + '/decide',
        'POST',
        { decision: 'approved' },
        { authorization: 'Bearer ' + key },
      )
    ).status,
  ).toBe(403);
  expect(logs).not.toContain('audit-stored-credential');
  expect(logs).not.toContain(token);
  expect(logs).not.toContain(key);
});

test('D: SSRF rejects loopback/private/metadata destinations without administrator exceptions', async () => {
  const http = new SafeHttp();
  for (const host of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.0.1',
    '169.254.169.254',
    '100.100.100.200',
  ])
    await expect(http.fetch(`https://${host}/`)).rejects.toThrow(/forbidden/);
});

test('I: concurrent reads, upstream failures, malformed MCP and crashing/hanging connectors leave Gateway healthy', async () => {
  const results: { ok: boolean; ms: number }[] = [];
  for (let batch = 0; batch < 5; batch++)
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const start = performance.now();
        const r = await invoke('demo.crm.customer.search', {}, { authorization: 'Bearer ' + key });
        results.push({ ok: r.status === 'succeeded', ms: performance.now() - start });
      }),
    );
  const times = results.map((r) => r.ms).sort((a, b) => a - b);
  const measurements = {
    date: new Date().toISOString(),
    count: results.length,
    concurrency: 8,
    successRate: results.filter((r) => r.ok).length / results.length,
    failures: results.filter((r) => !r.ok).length,
    averageMs: Math.round(times.reduce((a, b) => a + b, 0) / times.length),
    p95Ms: Math.round(times[Math.ceil(times.length * 0.95) - 1]!),
  };
  await writeFile('.local/audit-load.json', JSON.stringify(measurements, null, 2));
  expect(measurements.successRate).toBe(1);
  const pending = await Promise.all(
    Array.from({ length: 4 }, () =>
      invoke('demo.crm.note.create', {
        customerId: customer,
        body: 'Concurrent distinct approvals',
      }),
    ),
  );
  const approvalIds = await Promise.all(pending.map((p) => approval(p.executionId)));
  const approved = await Promise.all(
    approvalIds.map((id) =>
      api<Result>(`/api/approvals/${id}/decide`, 'POST', { decision: 'approved' }),
    ),
  );
  expect(approved.every((p) => p.status === 'succeeded')).toBe(true);
  for (const execution of approved)
    expect(
      (
        await db.system.query('select id from demo_notes where execution_id=$1', [
          execution.executionId,
        ])
      ).rows,
    ).toHaveLength(1);
  for (const status of ['429', '500']) {
    const r = await invoke('audit.rest.failure.get', { id: status });
    expect(r.status).toBe('failed');
    expect(r.error).toMatchObject({ kind: 'transient_upstream_failure', retryable: true });
  }
  const fixture = (
    await api<{ id: string }>('/api/connections', 'POST', {
      name: 'Failure fixtures',
      connectorId: 'audit-failure',
    })
  ).id;
  await api(`/api/connections/${fixture}/import`, 'POST', {
    names: [
      'audit.fixture.crash',
      'audit.fixture.timeout',
      'audit.fixture.oversized',
      'audit.fixture.writeCrash',
    ],
  });
  expect((await invoke('audit.fixture.crash')).error?.kind).toBe('connector_failure');
  expect((await invoke('audit.fixture.timeout')).error?.kind).toBe('timeout');
  expect((await invoke('audit.fixture.oversized')).error?.code).toBe('RESPONSE_TOO_LARGE');
  const idempotency = { 'idempotency-key': randomUUID() };
  const writeCrash = await invoke(
    'audit.fixture.writeCrash',
    { customerId: customer },
    idempotency,
  );
  expect(writeCrash.status).toBe('pending');
  expect(
    (
      await api<Result>(`/api/approvals/${await approval(writeCrash.executionId)}/decide`, 'POST', {
        decision: 'approved',
      })
    ).status,
  ).toBe('unknown');
  expect(
    (await invoke('audit.fixture.writeCrash', { customerId: customer }, idempotency)).status,
  ).toBe('unknown');
  expect(
    (
      await db.system.query('select id from demo_notes where execution_id=$1', [
        writeCrash.executionId,
      ])
    ).rows,
  ).toHaveLength(1);
  expect(
    (await fetch(base + '/mcp', { method: 'POST', headers: headers(), body: '{ malformed' }))
      .status,
  ).toBe(400);
  expect(
    (
      await fetch(base + '/api/invoke', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ data: 'x'.repeat(1024 * 1024 + 1) }),
      })
    ).status,
  ).toBe(413);
  expect((await fetch(base + '/health')).status).toBe(200);
  expect((await invoke('demo.crm.customer.search')).status).toBe('succeeded');
}, 120000);
