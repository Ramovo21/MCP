import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { PostgresDatabase } from '../packages/database/src/index.js';
import { AesGcmVault } from '../packages/shared/src/secrets.js';
import { loadRegistry } from '../apps/gateway/src/registry.js';
import { ConnectionService } from '../apps/gateway/src/connections.js';
const env = z
  .object({
    DATABASE_URL: z.string(),
    SUPABASE_URL: z.url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string(),
    SEED_EMAIL: z.email(),
    SEED_PASSWORD: z.string().min(12),
    MASTER_KEY: z.string(),
  })
  .parse(process.env);
if (process.env.NODE_ENV === 'production')
  throw new Error('Demo seeding is disabled in production');
const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  }),
  db = new PostgresDatabase(env.DATABASE_URL);
try {
  let user = (
    await db.system.query<{ id: string }>('select id from auth.users where email=$1', [
      env.SEED_EMAIL,
    ])
  ).rows[0];
  if (!user) {
    const result = await client.auth.admin.createUser({
      email: env.SEED_EMAIL,
      password: env.SEED_PASSWORD,
      email_confirm: true,
    });
    if (result.error) throw result.error;
    user = { id: result.data.user.id };
  }
  let org = (
    await db.system.query<{ organization_id: string }>(
      'select organization_id from organization_members where user_id=$1 limit 1',
      [user.id],
    )
  ).rows[0]?.organization_id;
  if (!org) {
    org = randomUUID();
    await db.system.query('insert into organizations(id,name) values($1,$2)', [org, 'Acme Labs']);
    await db.system.query("insert into organization_members values($1,$2,'owner')", [org, user.id]);
    await db.system.query(
      'insert into profiles(id,display_name) values($1,$2) on conflict do nothing',
      [user.id, 'Developer'],
    );
    await db.system.query('insert into approval_policies(organization_id) values($1)', [org]);
  }
  const p = { organizationId: org, userId: user.id, role: 'owner' as const };
  if (
    !(await db.system.query('select id from demo_customers where organization_id=$1', [org])).rows
      .length
  )
    for (const [name, email, company] of [
      ['Ada Nguyen', 'ada@example.test', 'Northstar Labs'],
      ['Minh Tran', 'minh@example.test', 'Orbit Commerce'],
      ['Sam Rivera', 'sam@example.test', 'Cloudworks'],
    ])
      await db.system.query(
        'insert into demo_customers(organization_id,name,email,company) values($1,$2,$3,$4)',
        [org, name, email, company],
      );
  let connection = (
    await db.system.query<{ id: string }>(
      "select id from connections where organization_id=$1 and connector_id='demo-crm' and status='active'",
      [org],
    )
  ).rows[0];
  const service = new ConnectionService(db, new AesGcmVault(env.MASTER_KEY), await loadRegistry());
  if (!connection)
    connection = await service.create(p, {
      name: 'Demo CRM',
      connectorId: 'demo-crm',
      config: {},
      secrets: {},
    });
  await service.import(
    p,
    connection.id,
    (await service.discover(p, connection.id)).map((t) => t.fullName),
  );
  process.stdout.write(
    `Seeded ${env.SEED_EMAIL} in organization ${org}. Password is SEED_PASSWORD in your local .env.\n`,
  );
} finally {
  await db.close();
}
