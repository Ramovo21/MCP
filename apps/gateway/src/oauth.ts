import { randomBytes, createHash } from 'node:crypto';
import type { Database } from '../../../packages/database/src/index.js';
import { audit } from '../../../packages/database/src/index.js';
import { AppError, assertAdmin, type Principal } from '../../../packages/shared/src/index.js';
import { hash, type SecretVault } from '../../../packages/shared/src/secrets.js';
import type { OAuthProvider, OAuthTokens } from '../../../packages/connector-sdk/src/oauth.js';

export class OAuthService {
  constructor(
    private db: Database,
    private vault: SecretVault,
    private providers: OAuthProvider[],
    private redirectBase: string,
  ) {}
  private provider(id: string) {
    const provider = this.providers.find((p) => p.id === id);
    if (!provider) throw new AppError('NOT_FOUND', 'OAuth provider is not installed', 404);
    return provider;
  }
  async initiate(p: Principal, connection: string, providerId: string, scopes: string[]) {
    assertAdmin(p);
    const provider = this.provider(providerId);
    if (!scopes.length || scopes.some((s) => !provider.scopes.includes(s)))
      throw new AppError('INVALID_SCOPE', 'OAuth scope is not allowed');
    const state = randomBytes(32).toString('base64url'),
      verifier = randomBytes(32).toString('base64url');
    const redirectUri = this.redirectBase + '/oauth/callback/' + encodeURIComponent(providerId);
    await this.db.tenant(p.organizationId, async (sql) => {
      const current = (
        await sql.query<{ oauth_generation: number }>(
          "select oauth_generation from connections where organization_id=$1 and id=$2 and status='active'",
          [p.organizationId, connection],
        )
      ).rows[0];
      if (!current) throw new AppError('NOT_FOUND', 'Connection not found', 404);
      await sql.query(
        'insert into oauth_states(organization_id,connection_id,state_hash,user_id,provider_id,payload_encrypted) values($1,$2,$3,$4,$5,$6)',
        [
          p.organizationId,
          connection,
          hash(state),
          p.userId,
          providerId,
          this.vault.seal(
            { verifier, redirectUri, scopes, generation: current.oauth_generation },
            `${p.organizationId}:oauth-state:${hash(state)}`,
          ),
        ],
      );
      await audit(sql, p, 'oauth.initiated', connection, { provider: providerId, scopes });
    });
    return {
      authorizationUrl: provider.authorizationUrl({
        state,
        challenge: createHash('sha256').update(verifier).digest('base64url'),
        redirectUri,
        scopes,
      }),
    };
  }
  async callback(providerId: string, state: string, code: string) {
    // Opaque 256-bit state resolves tenant only; membership is rechecked before token exchange.
    const stateHash = hash(state);
    const locator = (
      await this.db.system.query<{ organization_id: string }>(
        'select organization_id from oauth_states where state_hash=$1',
        [stateHash],
      )
    ).rows[0];
    if (!locator)
      throw new AppError('INVALID_OAUTH_STATE', 'OAuth state is invalid or expired', 400);
    const org = locator.organization_id;
    const claimed = await this.db.tenant(org, async (sql) => {
      const row = (
        await sql.query<{
          connection_id: string;
          user_id: string;
          payload_encrypted: string;
          provider_id: string;
        }>(
          'delete from oauth_states where organization_id=$1 and state_hash=$2 and provider_id=$3 and expires_at>now() returning *',
          [org, stateHash, providerId],
        )
      ).rows[0];
      if (!row) throw new AppError('INVALID_OAUTH_STATE', 'OAuth state is invalid or expired');
      const member = (
        await sql.query(
          "select role from organization_members where organization_id=$1 and user_id=$2 and role in ('owner','admin')",
          [org, row.user_id],
        )
      ).rows[0];
      if (
        !member ||
        !(
          await sql.query(
            "select id from connections where organization_id=$1 and id=$2 and status='active'",
            [org, row.connection_id],
          )
        ).rows.length
      )
        throw new AppError('FORBIDDEN', 'OAuth authorization is no longer permitted', 403);
      return row;
    });
    const payload = this.vault.open<{
      verifier: string;
      redirectUri: string;
      scopes: string[];
      generation: number;
    }>(claimed.payload_encrypted, `${org}:oauth-state:${stateHash}`);
    let tokens: OAuthTokens;
    try {
      tokens = await this.provider(providerId).exchange({
        code,
        verifier: payload.verifier,
        redirectUri: payload.redirectUri,
      });
    } catch {
      throw new AppError(
        'OAUTH_EXCHANGE_FAILED',
        'OAuth exchange failed; start authorization again',
        502,
      );
    }
    if (tokens.scopes.some((s) => !payload.scopes.includes(s)))
      throw new AppError('INVALID_SCOPE', 'Provider granted unexpected scopes');
    await this.db.tenant(org, async (sql) => {
      // Connection revocation and callback serialize on the same row.
      const active = await sql.query(
        "select id from connections where organization_id=$1 and id=$2 and status='active' and oauth_generation=$3 for update",
        [org, claimed.connection_id, payload.generation],
      );
      if (!active.rows.length) throw new AppError('FORBIDDEN', 'Connection was revoked', 403);
      if (
        !(
          await sql.query(
            "select user_id from organization_members where organization_id=$1 and user_id=$2 and role in ('owner','admin') for share",
            [org, claimed.user_id],
          )
        ).rows.length
      )
        throw new AppError('FORBIDDEN', 'Membership changed during authorization', 403);
      await sql.query(
        `insert into oauth_tokens(organization_id,connection_id,provider_id,ciphertext,expires_at,scopes) values($1,$2,$3,$4,$5,$6)
        on conflict(organization_id,connection_id) do update set provider_id=excluded.provider_id,ciphertext=excluded.ciphertext,expires_at=excluded.expires_at,scopes=excluded.scopes,status='active'`,
        [
          org,
          claimed.connection_id,
          providerId,
          this.vault.seal(tokens, `${org}:oauth:${claimed.connection_id}`),
          new Date(tokens.expiresAt),
          tokens.scopes,
        ],
      );
      await audit(
        sql,
        { organizationId: org, userId: claimed.user_id, role: 'admin' },
        'oauth.connected',
        claimed.connection_id,
      );
    });
    return { connected: true };
  }
  async accessToken(org: string, connection: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const claim = await this.db.tenant(org, async (sql) => {
        const row = (
          await sql.query<{ provider_id: string; ciphertext: string; status: string }>(
            'select * from oauth_tokens where organization_id=$1 and connection_id=$2 for update',
            [org, connection],
          )
        ).rows[0];
        if (!row) return { token: undefined };
        if (row.status === 'refreshing') return { waiting: true };
        if (row.status !== 'active')
          throw new AppError('OAUTH_REAUTH_REQUIRED', 'Reconnect OAuth authorization', 403);
        const tokens = this.vault.open<OAuthTokens>(row.ciphertext, `${org}:oauth:${connection}`);
        if (tokens.expiresAt > Date.now() + 30000) return { token: tokens.accessToken };
        if (!tokens.refreshToken)
          throw new AppError('OAUTH_REAUTH_REQUIRED', 'OAuth token expired', 403);
        await sql.query(
          "update oauth_tokens set status='refreshing' where organization_id=$1 and connection_id=$2",
          [org, connection],
        );
        return { row, tokens };
      });
      if ('token' in claim) return claim.token;
      if ('waiting' in claim) {
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        continue;
      }
      const { row, tokens } = claim;
      try {
        const next = await this.provider(row.provider_id).refresh(tokens.refreshToken!);
        if (next.scopes.some((s) => !tokens.scopes.includes(s)))
          throw new Error('Scope escalation');
        next.refreshToken ??= tokens.refreshToken;
        await this.db.tenant(org, async (sql) => {
          const changed = await sql.query(
            "update oauth_tokens set ciphertext=$3,expires_at=$4,scopes=$5,status='active' where organization_id=$1 and connection_id=$2 and status='refreshing' and ciphertext=$6 returning connection_id",
            [
              org,
              connection,
              this.vault.seal(next, `${org}:oauth:${connection}`),
              new Date(next.expiresAt),
              next.scopes,
              row.ciphertext,
            ],
          );
          if (!changed.rows.length)
            throw new AppError(
              'OAUTH_REAUTH_REQUIRED',
              'Authorization changed during refresh',
              403,
            );
          await audit(sql, { organizationId: org, role: 'admin' }, 'oauth.refreshed', connection);
        });
        return next.accessToken;
      } catch {
        await this.db.tenant(org, (sql) =>
          sql.query(
            "update oauth_tokens set status='reauth_required' where organization_id=$1 and connection_id=$2 and status='refreshing' and ciphertext=$3",
            [org, connection, row.ciphertext],
          ),
        );
        throw new AppError(
          'OAUTH_REAUTH_REQUIRED',
          'OAuth refresh failed; reconnect authorization',
          403,
        );
      }
    }
    throw new AppError(
      'OAUTH_REAUTH_REQUIRED',
      'Refresh still pending or interrupted; reconnect if it does not recover',
      409,
    );
  }
  async revoke(p: Principal, connection: string) {
    assertAdmin(p);
    const row = await this.db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        'update connections set oauth_generation=oauth_generation+1 where organization_id=$1 and id=$2',
        [p.organizationId, connection],
      );
      await sql.query('delete from oauth_states where organization_id=$1 and connection_id=$2', [
        p.organizationId,
        connection,
      ]);
      const r = (
        await sql.query<{ provider_id: string; ciphertext: string }>(
          "update oauth_tokens set status='revoked' where organization_id=$1 and connection_id=$2 returning *",
          [p.organizationId, connection],
        )
      ).rows[0];
      await audit(sql, p, 'oauth.revoked_locally', connection);
      return r;
    });
    if (!row) return { revoked: true };
    const tokens = this.vault.open<OAuthTokens>(
      row.ciphertext,
      `${p.organizationId}:oauth:${connection}`,
    );
    try {
      await this.provider(row.provider_id).revoke(tokens.refreshToken ?? tokens.accessToken);
    } catch {
      throw new AppError(
        'OAUTH_REVOKE_FAILED',
        'Access disabled locally; provider revocation requires retry',
        502,
      );
    }
    await this.db.tenant(p.organizationId, (sql) =>
      sql.query(
        "delete from oauth_tokens where organization_id=$1 and connection_id=$2 and status='revoked'",
        [p.organizationId, connection],
      ),
    );
    return { revoked: true };
  }
}
export async function loadOAuthProviders(): Promise<OAuthProvider[]> {
  const providers: OAuthProvider[] = [];
  for (const url of (process.env.OAUTH_PROVIDER_MODULES ?? '').split(',').filter(Boolean))
    providers.push(((await import(url)) as { default: OAuthProvider }).default);
  return providers;
}
