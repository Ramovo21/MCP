import { createClient } from '@supabase/supabase-js';
import type { Database } from '../../../packages/database/src/index.js';
import { AppError, uuid, type Principal, type Role } from '../../../packages/shared/src/index.js';
import { hash } from '../../../packages/shared/src/secrets.js';
export interface UserVerifier {
  getUser(token: string): Promise<{ id: string }>;
}
export function supabaseVerifier(url: string, key: string): UserVerifier {
  const client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return {
    async getUser(token) {
      const { data, error } = await client.auth.getUser(token);
      if (error || !data.user)
        throw new AppError('UNAUTHENTICATED', 'Invalid or expired bearer token', 401);
      return { id: data.user.id };
    },
  };
}
export class Authenticator {
  constructor(
    private db: Database,
    private verifier: UserVerifier,
  ) {}
  async authenticate(header: string | undefined, org: string | undefined): Promise<Principal> {
    if (!header?.startsWith('Bearer '))
      throw new AppError('UNAUTHENTICATED', 'Bearer authentication required', 401);
    const token = header.slice(7);
    if (token.length > 8192) throw new AppError('UNAUTHENTICATED', 'Invalid token', 401);
    if (token.startsWith('omni_')) {
      const r = await this.db.system.query<{
        id: string;
        organization_id: string;
        role: Role;
        scopes: string[];
      }>(
        'update api_keys set last_used_at=now() where key_hash=$1 and revoked_at is null returning id,organization_id,role,scopes',
        [hash(token)],
      );
      const k = r.rows[0];
      if (!k || (org && org !== k.organization_id))
        throw new AppError('UNAUTHENTICATED', 'Invalid API key or organization', 401);
      return { organizationId: k.organization_id, apiKeyId: k.id, role: k.role, scopes: k.scopes };
    }
    const user = await this.verifier.getUser(token);
    const organizationId = uuid.parse(org);
    const r = await this.db.system.query<{ role: Role }>(
      'select role from organization_members where organization_id=$1 and user_id=$2',
      [organizationId, user.id],
    );
    if (!r.rows[0]) throw new AppError('FORBIDDEN', 'Organization membership required', 403);
    return { organizationId, userId: user.id, role: r.rows[0].role };
  }
  async refresh(p: Principal): Promise<Principal> {
    if (p.apiKeyId) {
      const r = await this.db.system.query<{ role: Role; scopes: string[] }>(
        'select role,scopes from api_keys where organization_id=$1 and id=$2 and revoked_at is null',
        [p.organizationId, p.apiKeyId],
      );
      if (!r.rows[0]) throw new AppError('FORBIDDEN', 'Requesting API key was revoked', 403);
      return { ...p, ...r.rows[0] };
    }
    const r = await this.db.system.query<{ role: Role }>(
      'select role from organization_members where organization_id=$1 and user_id=$2',
      [p.organizationId, p.userId],
    );
    if (!r.rows[0]) throw new AppError('FORBIDDEN', 'Requesting user is no longer a member', 403);
    return { ...p, role: r.rows[0].role };
  }
}
