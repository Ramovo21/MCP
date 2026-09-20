import { z } from 'zod';

const base = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
  WORKER_TIMEOUT_MS: z.coerce.number().int().min(100).max(30000).default(30000),
});
const gateway = base.extend({
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  MASTER_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32),
  WEB_ORIGIN: z.url().default('http://localhost:3000'),
  OAUTH_REDIRECT_BASE: z.url().default('http://localhost:4000'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  GATEWAY_HOSTS: z.string().min(1).default('localhost,127.0.0.1'),
  WORKER_URL: z.url().optional(),
  WORKER_AUTH_TOKEN: z.string().min(32).optional(),
});
export function gatewayConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = gateway.safeParse(env);
  if (!parsed.success)
    throw new Error(
      'Invalid configuration: ' +
        [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', '),
    );
  const c = parsed.data;
  if (c.WORKER_URL && !c.WORKER_AUTH_TOKEN)
    throw new Error('WORKER_AUTH_TOKEN is required with WORKER_URL');
  if (['staging', 'production'].includes(c.APP_ENV)) {
    for (const key of ['SUPABASE_URL', 'WEB_ORIGIN', 'OAUTH_REDIRECT_BASE'] as const)
      if (new URL(c[key]).protocol !== 'https:') throw new Error(key + ' must use HTTPS');
    if (!c.WORKER_URL) throw new Error('WORKER_URL is required outside local development');
    if (!env.GATEWAY_HOSTS) throw new Error('GATEWAY_HOSTS must be explicitly configured');
  }
  return c;
}
export function workerConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = base
    .extend({
      WORKER_AUTH_TOKEN: z.string().min(32),
      WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    })
    .safeParse(env);
  if (!parsed.success)
    throw new Error(
      'Invalid worker configuration: ' +
        [...new Set(parsed.error.issues.map((i) => i.path.join('.')))].join(', '),
    );
  return parsed.data;
}
