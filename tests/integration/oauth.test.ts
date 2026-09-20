import { test, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { fixture } from '../helpers/fixture.js';
import { OAuthService } from '../../apps/gateway/src/oauth.js';
import type { OAuthProvider } from '../../packages/connector-sdk/src/oauth.js';
test('OAuth revocation invalidates an already-exchanging callback', async () => {
  const f = await fixture();
  let exchangeStarted!: () => void, release!: () => void;
  const started = new Promise<void>((r) => (exchangeStarted = r)),
    released = new Promise<void>((r) => (release = r));
  const provider: OAuthProvider = {
    id: 'race',
    scopes: ['read'],
    authorizationUrl: ({ state }) => 'https://oauth.example/?state=' + state,
    exchange: async () => {
      exchangeStarted();
      await released;
      return { accessToken: 'racing-access', expiresAt: Date.now() + 3600000, scopes: ['read'] };
    },
    refresh: async () => {
      throw new Error('Unexpected refresh');
    },
    revoke: async () => {},
  };
  try {
    const oauth = new OAuthService(f.db, f.vault, [provider], 'https://gateway.example');
    const init = await oauth.initiate(f.principal, f.connection, 'race', ['read']);
    const callback = oauth.callback(
      'race',
      new URL(init.authorizationUrl).searchParams.get('state')!,
      'code',
    );
    const rejected = expect(callback).rejects.toThrow('revoked');
    await started;
    await oauth.revoke(f.principal, f.connection);
    release();
    await rejected;
    expect((await f.db.system.query('select * from oauth_tokens')).rows).toHaveLength(0);
  } finally {
    await f.db.close();
  }
});
test('OAuth state, PKCE, encrypted tokens, scope binding, refresh claims and revocation', async () => {
  const f = await fixture();
  let challenge = '',
    refreshes = 0,
    revoked = false;
  const provider: OAuthProvider = {
    id: 'fixture',
    scopes: ['read'],
    authorizationUrl(input) {
      challenge = input.challenge;
      return 'https://oauth.example/authorize?state=' + input.state;
    },
    async exchange(input) {
      expect(createHash('sha256').update(input.verifier).digest('base64url')).toBe(challenge);
      return {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        expiresAt: Date.now() - 100,
        scopes: ['read'],
      };
    },
    async refresh(token) {
      expect(token).toBe('refresh-secret');
      refreshes++;
      await new Promise((r) => setTimeout(r, 100));
      return {
        accessToken: 'rotated-access',
        refreshToken: 'rotated-refresh',
        expiresAt: Date.now() + 3600000,
        scopes: ['read'],
      };
    },
    async revoke(token) {
      expect(token).toBe('rotated-refresh');
      revoked = true;
    },
  };
  const oauth = new OAuthService(f.db, f.vault, [provider], 'https://gateway.example');
  try {
    await expect(oauth.initiate(f.principal, f.connection, 'fixture', ['admin'])).rejects.toThrow(
      /scope/,
    );
    const started = await oauth.initiate(f.principal, f.connection, 'fixture', ['read']);
    const state = new URL(started.authorizationUrl).searchParams.get('state')!;
    await expect(oauth.callback('wrong', state, 'code')).rejects.toThrow(/state/);
    expect(await oauth.callback('fixture', state, 'code')).toEqual({ connected: true });
    await expect(oauth.callback('fixture', state, 'code')).rejects.toThrow(/state/);
    const raw = JSON.stringify((await f.db.system.query('select * from oauth_tokens')).rows);
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    expect(
      await Promise.all([
        oauth.accessToken(f.org, f.connection),
        oauth.accessToken(f.org, f.connection),
      ]),
    ).toEqual(['rotated-access', 'rotated-access']);
    expect(refreshes).toBe(1);
    await oauth.revoke(f.principal, f.connection);
    expect(revoked).toBe(true);
    expect(await oauth.accessToken(f.org, f.connection)).toBeUndefined();
  } finally {
    await f.db.close();
  }
});
test('ambiguous OAuth refresh is never retried and failures do not expose provider secrets', async () => {
  const f = await fixture();
  let calls = 0;
  const provider: OAuthProvider = {
    id: 'broken',
    scopes: ['read'],
    authorizationUrl: ({ state }) => 'https://oauth.example/?state=' + state,
    exchange: async () => ({
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      scopes: ['read'],
      expiresAt: 1,
    }),
    refresh: async () => {
      calls++;
      throw new Error('private-refresh');
    },
    revoke: async () => {},
  };
  try {
    const oauth = new OAuthService(f.db, f.vault, [provider], 'https://gateway.example');
    const start = await oauth.initiate(f.principal, f.connection, 'broken', ['read']);
    await oauth.callback(
      'broken',
      new URL(start.authorizationUrl).searchParams.get('state')!,
      'code',
    );
    await expect(oauth.accessToken(f.org, f.connection)).rejects.toThrow('reconnect');
    await expect(oauth.accessToken(f.org, f.connection)).rejects.toThrow('Reconnect');
    expect(calls).toBe(1);
  } finally {
    await f.db.close();
  }
});
