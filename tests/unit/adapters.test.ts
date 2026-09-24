import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Authenticator } from '../../apps/gateway/src/auth.js';
import type { TenantResolver } from '../../packages/shared/src/auth.js';
import { AppError } from '../../packages/shared/src/index.js';
test('a custom identity provider and tenant resolver authenticate without Supabase or SQL', async () => {
  const org = randomUUID();
  const tenants: TenantResolver = {
    async fromUser(userId, organizationId) {
      if (userId !== 'verified-user' || organizationId !== org)
        throw new AppError('FORBIDDEN', 'Membership required', 403);
      return { organizationId, userId, role: 'viewer' };
    },
    async fromApiKey() {
      throw new AppError('UNAUTHENTICATED', 'Invalid key', 401);
    },
    async refresh() {
      throw new AppError('FORBIDDEN', 'Membership revoked', 403);
    },
  };
  const auth = new Authenticator(tenants, {
    async getUser(token) {
      if (token !== 'verified-token') throw new AppError('UNAUTHENTICATED', 'Invalid token', 401);
      return { id: 'verified-user' };
    },
  });
  const p = await auth.authenticate('Bearer verified-token', org);
  expect(p).toMatchObject({ organizationId: org, userId: 'verified-user', role: 'viewer' });
  await expect(auth.authenticate('Bearer verified-token', randomUUID())).rejects.toMatchObject({
    code: 'FORBIDDEN',
  });
  await expect(auth.authenticate('Bearer invalid', org)).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
  });
  await expect(auth.authenticate('Bearer omni_invalid', org)).rejects.toMatchObject({
    code: 'UNAUTHENTICATED',
  });
  await expect(auth.refresh(p)).rejects.toMatchObject({ code: 'FORBIDDEN' });
});
