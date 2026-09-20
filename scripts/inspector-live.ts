import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
// Uses a short-lived Supabase token and never prints it. No API key is persisted.
const client = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const signed = await client.auth.signInWithPassword({
  email: process.env.SEED_EMAIL!,
  password: process.env.SEED_PASSWORD!,
});
if (signed.error || !signed.data.session) throw new Error('Seed account sign-in failed');
const organizations = await client.from('organizations').select('id,name');
const org = organizations.data?.find((o) => o.name === 'Acme Labs');
if (!org) throw new Error('Seed organization missing');
const require = createRequire(import.meta.url),
  cli = resolve(
    dirname(require.resolve('@modelcontextprotocol/inspector/package.json')),
    'clients/launcher/build/index.js',
  );
const endpoint = process.env.INSPECTOR_ENDPOINT ?? 'http://localhost:4000/mcp';
try {
  for (const method of ['tools/list', 'tools/call']) {
    const args = [
      cli,
      '--cli',
      endpoint,
      '--protocol-era',
      'modern',
      '--format',
      'json',
      '--header',
      `Authorization: Bearer ${signed.data.session.access_token}`,
      `X-Organization-Id: ${org.id}`,
      '--method',
      method,
      ...(method === 'tools/call'
        ? ['--tool-name', 'demo.crm.customer.search', '--tool-args-json', '{}']
        : []),
    ];
    const output = await new Promise<string>((resolveOutput, reject) => {
      const child = spawn(process.execPath, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MCP_CATALOG_PATH: resolve('.local/inspector-live-catalog.json') },
      });
      let out = '';
      child.stdout.on('data', (b) => (out += String(b)));
      child.stderr.resume();
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0
          ? resolveOutput(out)
          : reject(new Error(`Inspector ${method} failed with exit ${code}`)),
      );
    });
    if (!output.includes(method === 'tools/list' ? 'demo.crm.customer.search' : 'Ada Nguyen'))
      throw new Error('Inspector response assertion failed');
    process.stdout.write(`Official Inspector ${method}: passed against ${endpoint}\n`);
  }
} finally {
  await client.auth.signOut({ scope: 'local' });
}
