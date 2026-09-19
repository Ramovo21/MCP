import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
if (existsSync('.env')) {
  console.log('.env already exists; preserving it.');
  process.exit(0);
}
const r = spawnSync(
  process.execPath,
  ['node_modules/supabase/dist/supabase.js', 'status', '-o', 'json'],
  {
    encoding: 'utf8',
    windowsHide: true,
  },
);
if (r.status !== 0) throw new Error('Start local Supabase before running local-env.');
const start = r.stdout.indexOf('{'),
  end = r.stdout.lastIndexOf('}');
const s = JSON.parse(r.stdout.slice(start, end + 1));
const values = {
  NODE_ENV: 'development',
  PORT: '4000',
  WEB_ORIGIN: 'http://localhost:3000',
  GATEWAY_HOSTS: 'localhost,127.0.0.1',
  DATABASE_URL: s.DB_URL,
  SUPABASE_URL: s.API_URL,
  SUPABASE_ANON_KEY: s.ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: s.SERVICE_ROLE_KEY,
  NEXT_PUBLIC_SUPABASE_URL: s.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: s.ANON_KEY,
  NEXT_PUBLIC_GATEWAY_URL: 'http://localhost:4000',
  MASTER_KEY: randomBytes(32).toString('base64'),
  SEED_EMAIL: 'developer@omnimcp.local',
  SEED_PASSWORD: randomBytes(20).toString('base64url'),
  CONNECTOR_PRIVATE_HOSTS: '127.0.0.1',
  CONNECTOR_INSECURE_PG_HOSTS: '127.0.0.1',
};
writeFileSync(
  '.env',
  Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n') + '\n',
  { mode: 0o600 },
);
console.log(
  'Created .env with local Supabase settings and a random seed password. No credentials printed.',
);
