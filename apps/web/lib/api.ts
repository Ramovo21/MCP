import { createClient, type SupabaseClient } from '@supabase/supabase-js';
let client: SupabaseClient | undefined;
export function supabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key)
    throw new Error(
      'Configure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env, then restart the dashboard.',
    );
  return (client ??= createClient(url, key));
}
export const gateway = process.env.NEXT_PUBLIC_GATEWAY_URL ?? 'http://localhost:4000';
export async function api<T>(
  org: string,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const r = await fetch(gateway + path, {
    method,
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ''}`,
      'X-Organization-Id': org,
      'Content-Type': 'application/json',
      ...(path === '/api/invoke' ? { 'Idempotency-Key': crypto.randomUUID() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });
  const value = await r.json();
  if (!r.ok) throw new Error(value.error?.message ?? 'Request failed');
  return value as T;
}
export type Row = Record<string, unknown>;
export interface Tool extends Row {
  id: string;
  name: string;
  description: string;
  risk: string;
  enabled: boolean;
  input_schema: Row;
  connection_id: string;
  baseline_risk: string;
  usage_count?: number;
}
export interface ConsoleData {
  features: { naturalLanguage: boolean };
  organization: { id: string; name: string };
  role: string;
  connectors: { id: string; name: string }[];
  connections: Row[];
  tools: Tool[];
  metrics: { calls: number; succeeded: number; failed: number; latency: number };
  executions: Row[];
  approvals: Row[];
  audit: Row[];
  keys: Row[];
  members: Row[];
  servers: Row[];
  policy: { allow_write: boolean; sensitive_approval: boolean; allow_self_approval: boolean };
}
