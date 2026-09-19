import 'dotenv/config';
import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { PostgresDatabase } from '../../packages/database/src/index.js';
import { ConnectionService } from '../../apps/gateway/src/connections.js';
import { Authenticator, supabaseVerifier } from '../../apps/gateway/src/auth.js';
import { ExecutionService } from '../../apps/gateway/src/execution.js';
import { ApprovalService } from '../../apps/gateway/src/approvals.js';
import { ConnectorWorker } from '../../services/connector-worker/src/index.js';
import { AesGcmVault } from '../../packages/shared/src/secrets.js';
import { loadRegistry } from '../../apps/gateway/src/registry.js';

test('live Supabase Auth/RLS, TCP PostgreSQL connector and concurrent approval claims', async () => {
  if (new URL(process.env.SUPABASE_URL!).hostname !== '127.0.0.1')
    throw new Error('Live tests require local Supabase');
  const db = new PostgresDatabase(process.env.DATABASE_URL!);
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const auth = new Authenticator(
    db,
    supabaseVerifier(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!),
  );
  const org = randomUUID(),
    foreign = randomUUID(),
    table = 'fixture_' + randomUUID().replaceAll('-', '');
  try {
    const signed = await supabase.auth.signInWithPassword({
      email: process.env.SEED_EMAIL!,
      password: process.env.SEED_PASSWORD!,
    });
    expect(signed.error).toBeNull();
    const user = signed.data.user!,
      token = signed.data.session!.access_token;
    await db.system.query(
      "insert into organizations(id,name) values($1,'Temporary live verification'),($2,'Isolated live verification')",
      [org, foreign],
    );
    await db.system.query("insert into organization_members values($1,$2,'owner')", [org, user.id]);
    await db.system.query(
      'insert into approval_policies(organization_id,allow_self_approval) values($1,true)',
      [org],
    );
    await db.system.query(
      "insert into connections(organization_id,name,connector_id) values($1,'Foreign secret CRM','demo-crm')",
      [foreign],
    );
    const visible = await supabase.from('connections').select('organization_id');
    expect(visible.error).toBeNull();
    expect(visible.data?.some((c) => c.organization_id === foreign)).toBe(false);
    expect((await supabase.from('connection_secrets').select('*')).data ?? []).toHaveLength(0);
    await expect(auth.authenticate('Bearer ' + token, foreign)).rejects.toThrow(/membership/);
    const p = await auth.authenticate('Bearer ' + token, org),
      vault = new AesGcmVault(process.env.MASTER_KEY!),
      registry = await loadRegistry();
    const connections = new ConnectionService(db, vault, registry),
      execution = new ExecutionService(db, vault, new ConnectorWorker(registry), auth);
    await db.system.query(
      `create table public."${table}" (id integer primary key,name text not null,secret text)`,
    );
    await db.system.query(`insert into public."${table}" values(1,'Actual PostgreSQL','hidden')`);
    const pgConnection = await connections.create(p, {
      name: 'Live PostgreSQL verification',
      connectorId: 'postgres',
      secrets: { databaseUrl: process.env.DATABASE_URL! },
      config: {
        namespace: 'verify',
        tables: [
          {
            schema: 'public',
            table,
            columns: ['id', 'name'],
            key: 'id',
            operations: ['search', 'get'],
          },
        ],
        allowWrites: false,
      },
    });
    expect(await connections.test(p, pgConnection.id)).toEqual({ ok: true });
    const definitions = await connections.discover(p, pgConnection.id);
    expect(definitions).toHaveLength(2);
    await connections.import(
      p,
      pgConnection.id,
      definitions.map((t) => t.fullName),
    );
    const result = await execution.call(p, `verify.public.${table}.get`, { id: 1 });
    expect(result.status).toBe('succeeded');
    expect(result.result).toEqual([{ id: 1, name: 'Actual PostgreSQL' }]);
    const ctx = await connections.context(p, pgConnection.id);
    await expect(
      registry
        .get('postgres')
        .discover({
          ...ctx,
          connection: {
            ...ctx.connection,
            config: {
              namespace: 'verify',
              tables: [{ schema: 'public', table, columns: ['id'], operations: ['insert'] }],
              allowWrites: false,
            },
          },
        }),
    ).rejects.toThrow(/writes require/);
    const demo = await connections.create(p, {
      name: 'Approval verification',
      connectorId: 'demo-crm',
      config: {},
      secrets: {},
    });
    await connections.import(
      p,
      demo.id,
      (await connections.discover(p, demo.id)).map((t) => t.fullName),
    );
    const tool = (
      await db.system.query<{ id: string }>(
        "select id from tools where organization_id=$1 and name='demo.crm.note.create'",
        [org],
      )
    ).rows[0]!;
    await db.system.query("update tools set risk='CRITICAL' where organization_id=$1 and id=$2", [
      org,
      tool.id,
    ]);
    await db.system.query("insert into tool_permissions values($1,$2,'owner',true)", [
      org,
      tool.id,
    ]);
    const customer = (
      await db.system.query<{ id: string }>(
        'select id from demo_customers where organization_id=$1 limit 1',
        [org],
      )
    ).rows[0]!.id;
    const pending = await execution.call(
      p,
      'demo.crm.note.create',
      { customerId: customer, body: 'Concurrent approval' },
      randomUUID(),
    );
    expect(pending.status).toBe('pending');
    const approval = (
      await db.system.query<{ id: string }>(
        'select id from approval_requests where execution_id=$1',
        [pending.executionId],
      )
    ).rows[0]!.id;
    const service = new ApprovalService(execution),
      decisions = await Promise.allSettled([
        service.decide(p, approval, 'approved'),
        service.decide(p, approval, 'approved'),
      ]);
    expect(decisions.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await db.system.query('select id from demo_notes where execution_id=$1', [
          pending.executionId,
        ])
      ).rows,
    ).toHaveLength(1);
  } finally {
    // Only UUIDs and a table generated by this test are cleaned up; no seed/user data is reset.
    await db.system.query(`drop table if exists public."${table}"`);
    for (const tenant of [org, foreign]) {
      for (const entity of [
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
        await db.system.query(`delete from ${entity} where organization_id=$1`, [tenant]);
      await db.system.query('delete from organizations where id=$1', [tenant]);
    }
    await db.close();
    await supabase.auth.signOut();
  }
}, 60000);
