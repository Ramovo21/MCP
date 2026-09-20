import { PGlite } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import type { Database, Sql } from '../../packages/database/src/index.js';
export async function testDatabase(): Promise<Database & { raw: PGlite }> {
  const raw = new PGlite();
  await raw.exec(
    "create schema auth; create role authenticated; create table auth.users(id uuid primary key,email text); create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;",
  );
  const migrations = new URL('../../supabase/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort())
    await raw.exec(await readFile(new URL(file, migrations), 'utf8'));
  const wrap = (db: Pick<PGlite, 'query'>): Sql => ({
    async query<T extends Record<string, unknown>>(text: string, values?: unknown[]) {
      const r = await db.query<T>(text, values);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
    },
  });
  return {
    raw,
    system: wrap(raw),
    async tenant<T>(org: string, fn: (sql: Sql) => Promise<T>): Promise<T> {
      return raw.transaction(async (tx) => {
        await tx.exec('set local role omnimcp_gateway');
        await tx.query("select set_config('app.organization_id',$1,true)", [org]);
        return fn(wrap(tx));
      });
    },
    async close() {
      await raw.close();
    },
  };
}
