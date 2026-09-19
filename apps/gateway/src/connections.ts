import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audit, type Database } from '../../../packages/database/src/index.js';
import {
  AppError,
  assertAdmin,
  toolName,
  type Principal,
  type Connection,
  type JsonObject,
} from '../../../packages/shared/src/index.js';
import type { SecretVault } from '../../../packages/shared/src/secrets.js';
import { validateToolSchema } from '../../../packages/mcp-core/src/validation.js';
import type {
  ConnectorRegistry,
  ConnectorContext,
} from '../../../packages/connector-sdk/src/index.js';
export const connectionInput = z
  .object({
    name: z.string().min(1).max(120),
    connectorId: z.string().min(1).max(80),
    config: z.record(z.string(), z.unknown()).default({}),
    secrets: z.record(z.string(), z.string().max(20000)).default({}),
  })
  .strict();
export class ConnectionService {
  constructor(
    readonly db: Database,
    readonly vault: SecretVault,
    readonly registry: ConnectorRegistry,
  ) {}
  async context(p: Principal, id: string): Promise<ConnectorContext> {
    return this.db.tenant(p.organizationId, async (sql) => {
      const connection = (
        await sql.query<Connection>(
          "select * from connections where organization_id=$1 and id=$2 and status<>'revoked'",
          [p.organizationId, id],
        )
      ).rows[0];
      if (!connection) throw new AppError('NOT_FOUND', 'Connection not found', 404);
      const secret = (
        await sql.query<{ ciphertext: string }>(
          'select ciphertext from connection_secrets where organization_id=$1 and connection_id=$2',
          [p.organizationId, id],
        )
      ).rows[0];
      return {
        connection,
        organizationId: p.organizationId,
        secrets: secret
          ? this.vault.open<Record<string, string>>(
              secret.ciphertext,
              `${p.organizationId}:connection:${id}`,
            )
          : {},
        database: this.db,
        executionId: randomUUID(),
        signal: AbortSignal.timeout(25000),
      };
    });
  }
  async create(p: Principal, input: z.infer<typeof connectionInput>) {
    assertAdmin(p);
    const plugin = this.registry.get(input.connectorId),
      id = randomUUID();
    for (const [key, value] of Object.entries(input.config)) {
      if (/password|secret|token|authorization|credential/i.test(key))
        throw new AppError('SECRET_IN_CONFIG', 'Store credentials in the secrets object');
      if (typeof value === 'string' && /url$/i.test(key)) {
        const url = new URL(value);
        if (url.username || url.password || url.search)
          throw new AppError(
            'SECRET_IN_URL',
            'Connector URLs cannot contain credentials or query parameters',
          );
      }
    }
    await this.db.system.query(
      'insert into connector_definitions(id,name,version) values($1,$2,$3) on conflict(id) do nothing',
      [plugin.id, plugin.name, plugin.version],
    );
    await this.db.tenant(p.organizationId, async (sql) => {
      await sql.query(
        'insert into connections(id,organization_id,name,connector_id,config) values($1,$2,$3,$4,$5)',
        [id, p.organizationId, input.name, input.connectorId, JSON.stringify(input.config)],
      );
      if (Object.keys(input.secrets).length)
        await sql.query(
          'insert into connection_secrets(organization_id,connection_id,ciphertext) values($1,$2,$3)',
          [
            p.organizationId,
            id,
            this.vault.seal(input.secrets, `${p.organizationId}:connection:${id}`),
          ],
        );
      if (input.connectorId === 'remote-mcp')
        await sql.query(
          'insert into mcp_servers(organization_id,name,connection_id) values($1,$2,$3)',
          [p.organizationId, input.name, id],
        );
      await audit(sql, p, 'connection.created', id, { connector: input.connectorId });
    });
    if (plugin.initialize) await plugin.initialize(await this.context(p, id));
    return { id };
  }
  async discover(p: Principal, id: string) {
    assertAdmin(p);
    const ctx = await this.context(p, id),
      definitions = await this.registry.get(ctx.connection.connector_id).discover(ctx);
    if (definitions.length > 500)
      throw new AppError('TOO_MANY_TOOLS', 'Connection tool limit is 500');
    const tools = definitions.map(({ execute: _handler, ...t }) => ({
      ...t,
      fullName: toolName.parse(`${t.namespace}.${t.name}`),
    }));
    if (new Set(tools.map((t) => t.fullName)).size !== tools.length)
      throw new AppError('DUPLICATE_TOOL', 'Discovered tool names are not unique');
    for (const tool of tools) validateToolSchema(tool.inputSchema);
    return tools;
  }
  async import(p: Principal, id: string, names: string[]) {
    assertAdmin(p);
    const definitions = await this.discover(p, id);
    if (names.some((n) => !definitions.some((t) => t.fullName === n)))
      throw new AppError('INVALID_TOOL', 'Selected tool was not discovered');
    return this.db.tenant(p.organizationId, async (sql) => {
      let imported = 0;
      for (const t of definitions.filter((t) => names.includes(t.fullName))) {
        const result = await sql.query(
          `insert into tools(organization_id,connection_id,name,description,input_schema,risk,baseline_risk,enabled,config) values($1,$2,$3,$4,$5,$6,$6,true,$7) on conflict(organization_id,name) do nothing returning id`,
          [
            p.organizationId,
            id,
            t.fullName,
            t.description,
            JSON.stringify(t.inputSchema),
            t.risk,
            JSON.stringify(t.config ?? {}),
          ],
        );
        if (result.rows.length) imported++;
        else {
          const existing = (
            await sql.query<{ connection_id: string }>(
              'select connection_id from tools where organization_id=$1 and name=$2',
              [p.organizationId, t.fullName],
            )
          ).rows[0];
          if (existing?.connection_id !== id)
            throw new AppError(
              'TOOL_NAME_CONFLICT',
              'A selected tool name belongs to another connection; use a different namespace',
              409,
            );
        }
      }
      await audit(sql, p, 'tools.imported', id, { names });
      return { imported };
    });
  }
  async test(p: Principal, id: string) {
    assertAdmin(p);
    const ctx = await this.context(p, id),
      plugin = this.registry.get(ctx.connection.connector_id);
    if (plugin.test) await plugin.test(ctx);
    else await plugin.discover(ctx);
    return { ok: true };
  }
  async update(p: Principal, id: string, status: Connection['status']) {
    assertAdmin(p);
    await this.db.tenant(p.organizationId, async (sql) => {
      const r = await sql.query(
        "update connections set status=$3 where organization_id=$1 and id=$2 and status<>'revoked' returning id",
        [p.organizationId, id, status],
      );
      if (!r.rows[0]) throw new AppError('NOT_FOUND', 'Connection not found', 404);
      if (status === 'revoked') {
        await sql.query(
          'delete from connection_secrets where organization_id=$1 and connection_id=$2',
          [p.organizationId, id],
        );
        await sql.query(
          'update tools set enabled=false where organization_id=$1 and connection_id=$2',
          [p.organizationId, id],
        );
      }
      await audit(sql, p, `connection.${status}`, id);
    });
  }
  async schema(p: Principal, id: string) {
    assertAdmin(p);
    const ctx = await this.context(p, id),
      connector = this.registry.get(ctx.connection.connector_id) as {
        schema?: (ctx: ConnectorContext) => Promise<unknown>;
      };
    if (!connector.schema)
      throw new AppError('UNSUPPORTED', 'Connector does not expose schema discovery');
    return connector.schema(ctx);
  }
  async configure(p: Principal, id: string, config: JsonObject) {
    assertAdmin(p);
    const ctx = await this.context(p, id);
    if (ctx.connection.connector_id !== 'postgres')
      throw new AppError('UNSUPPORTED', 'Create a replacement connection to change configuration');
    await this.registry
      .get('postgres')
      .discover({ ...ctx, connection: { ...ctx.connection, config } });
    await this.db.tenant(p.organizationId, async (sql) => {
      await sql.query('update connections set config=$3 where organization_id=$1 and id=$2', [
        p.organizationId,
        id,
        JSON.stringify(config),
      ]);
      await sql.query(
        'update tools set enabled=false where organization_id=$1 and connection_id=$2',
        [p.organizationId, id],
      );
      await audit(sql, p, 'connection.configured', id);
    });
  }
}
