import type { Principal } from './index.js';

/** Verifies bearer identity. Never derive a user ID from an unverified JWT. */
export interface AuthProvider {
  getUser(token: string): Promise<{ id: string }>;
}
/** Resolves verified membership or an organization-bound, non-revoked API key. */
export interface TenantResolver {
  fromUser(userId: string, organizationId: string): Promise<Principal>;
  fromApiKey(token: string, organizationId?: string): Promise<Principal>;
  refresh(principal: Principal): Promise<Principal>;
}
