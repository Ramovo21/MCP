import pg from 'pg';
import { z } from 'zod';
import { AppError, type JsonObject } from '../../../packages/shared/src/index.js';
import { resolveSafeHost, type NetworkPolicy } from '../../../packages/shared/src/http.js';
import type {
  Connector,
  ConnectorContext,
  ToolDefinition,
} from '../../../packages/connector-sdk/src/index.js';
const identifier = z
  .string()
  .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
  .max(63);
export const quote = (name: string) => '"' + identifier.parse(name) + '"';
const selection = z
  .object({
    schema: identifier,
    table: identifier,
    columns: z.array(identifier).min(1).max(100),
    key: identifier.optional(),
    operations: z.array(z.enum(['search', 'get', 'insert'])).default(['search']),
  })
  .strict();
const configSchema = z
  .object({
    namespace: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .default('postgres'),
    tables: z.array(selection).max(100).default([]),
    allowWrites: z.boolean().default(false),
  })
  .strict();
export function buildSearch(config: JsonObject, args: JsonObject) {
  const c = selection.parse(config),
    filters = z
      .record(z.string(), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
      .parse(args.filters ?? {}),
    values: unknown[] = [];
  const predicates = Object.entries(filters).map(([key, value]) => {
    if (!c.columns.includes(key))
      throw new AppError('INVALID_COLUMN', 'Filter column is not selected');
    if (value === null) return `${quote(key)} is null`;
    values.push(value);
    return `${quote(key)}=$${values.length}`;
  });
  values.push(
    z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(args.limit ?? 25),
  );
  return {
    text: `select ${c.columns.map(quote).join(',')} from ${quote(c.schema)}.${quote(c.table)}${predicates.length ? ' where ' + predicates.join(' and ') : ''} limit $${values.length}`,
    values,
  };
}
export function postgresConnector(
  policy: NetworkPolicy & {insecurePgHosts?:readonly string[]} = { privateHosts: [] },
): Connector & { schema(ctx: ConnectorContext): Promise<unknown> } {
  async function session<T>(
    ctx: ConnectorContext,
    write: boolean,
    fn: (c: pg.Client) => Promise<T>,
  ): Promise<T> {
    const url = new URL(ctx.secrets.databaseUrl ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.search)
      throw new AppError(
        'INVALID_CONNECTION',
        'Use a PostgreSQL URL without connection option parameters',
      );
    const ip = (await resolveSafeHost(url.hostname, policy))[0]!;
    const client = new pg.Client({
      host: ip.address,
      port: Number(url.port || 5432),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      connectionTimeoutMillis: 5000,
      query_timeout: 10000,
      statement_timeout: 10000,
      ssl: policy.insecurePgHosts?.includes(url.hostname) && policy.privateHosts.includes(url.hostname) ? false : { rejectUnauthorized: true, servername: url.hostname },
    });
    try {
      await client.connect();
      await client.query(write ? 'begin' : 'begin read only');
      await client.query("set local statement_timeout='8s'");
      const result = await fn(client);
      await client.query('commit');
      return result;
    } catch (e) {
      try {
        await client.query('rollback');
      } catch {
        /* Connection may already be closed. */
      }
      if (e instanceof AppError) throw e;
      throw new AppError(
        'DATABASE_ERROR',
        'Database operation failed; check connection and selected schema',
        502,
      );
    } finally {
      await client.end();
    }
  }
  async function schema(ctx: ConnectorContext) {
    return session(
      ctx,
      false,
      async (c) =>
        (
          await c.query(
            "select table_schema,table_name,column_name,data_type from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema,table_name,ordinal_position limit 2000",
          )
        ).rows as { table_schema: string; table_name: string; column_name: string }[],
    );
  }
  return {
    id: 'postgres',
    name: 'PostgreSQL',
    version: '1.0.0',
    schema,
    async test(ctx) {
      await session(ctx, false, async (c) => {
        await c.query('select 1');
      });
    },
    async discover(ctx) {
      const config = configSchema.parse(ctx.connection.config),
        metadata = await schema(ctx),
        tools: ToolDefinition[] = [];
      for (const t of config.tables) {
        for (const col of t.columns)
          if (
            !metadata.some(
              (c) =>
                c.table_schema === t.schema && c.table_name === t.table && c.column_name === col,
            )
          )
            throw new AppError('INVALID_COLUMN', 'Selected table or column does not exist');
        if (t.key && !t.columns.includes(t.key))
          throw new AppError('INVALID_COLUMN', 'Key must be a selected column');
        for (const op of t.operations) {
          if (op === 'insert' && !config.allowWrites)
            throw new AppError(
              'WRITE_DISABLED',
              'Database writes require explicit administrator configuration',
            );
          if (op === 'get' && !t.key)
            throw new AppError('INVALID_COLUMN', 'Get requires a key column');
          const filterProperties = Object.fromEntries(
            t.columns.map((c) => [c, { type: ['string', 'number', 'boolean', 'null'] }]),
          );
          tools.push({
            namespace: `${config.namespace}.${t.schema}.${t.table}`,
            name: op,
            description: `${op === 'insert' ? 'Insert one row into' : op === 'get' ? 'Get a row by selected key from' : 'Search up to 100 rows in'} ${t.schema}.${t.table}; selected columns: ${t.columns.join(', ')}.`,
            risk: op === 'insert' ? 'WRITE' : 'READ',
            config: { ...t, operation: op },
            inputSchema:
              op === 'search'
                ? {
                    type: 'object',
                    properties: {
                      filters: {
                        type: 'object',
                        properties: filterProperties,
                        additionalProperties: false,
                      },
                      limit: { type: 'integer', minimum: 1, maximum: 100 },
                    },
                    additionalProperties: false,
                  }
                : op === 'get'
                  ? {
                      type: 'object',
                      properties: { id: { type: ['string', 'number'] } },
                      required: ['id'],
                      additionalProperties: false,
                    }
                  : {
                      type: 'object',
                      properties: {
                        values: {
                          type: 'object',
                          properties: filterProperties,
                          additionalProperties: false,
                          minProperties: 1,
                        },
                      },
                      required: ['values'],
                      additionalProperties: false,
                    },
          });
        }
      }
      return tools;
    },
    async execute(tool, args, ctx) {
      const current = configSchema.parse(ctx.connection.config),
        t = selection.parse(tool.config),
        operation = String(tool.config.operation);
      if (
        !current.tables.some(
          (s) =>
            s.schema === t.schema &&
            s.table === t.table &&
            t.columns.every((c) => s.columns.includes(c)) &&
            s.operations.includes(operation as 'search'),
        )
      )
        throw new AppError('FORBIDDEN', 'Table selection has changed', 403);
      if (operation === 'insert') {
        if (!current.allowWrites)
          throw new AppError('WRITE_DISABLED', 'Database writes are disabled');
        const values = args.values as JsonObject,
          keys = Object.keys(values);
        if (!keys.length || keys.some((k) => !t.columns.includes(k)))
          throw new AppError('INVALID_COLUMN', 'Unselected insert column');
        return session(
          ctx,
          true,
          async (c) =>
            (
              await c.query(
                `insert into ${quote(t.schema)}.${quote(t.table)} (${keys.map(quote).join(',')}) values (${keys.map((_, i) => '$' + (i + 1)).join(',')}) returning ${t.columns.map(quote).join(',')}`,
                keys.map((k) => values[k]),
              )
            ).rows,
        );
      }
      const query = buildSearch(
        t,
        operation === 'get' ? { filters: { [t.key!]: args.id }, limit: 1 } : args,
      );
      return session(ctx, false, async (c) => (await c.query(query.text, query.values)).rows);
    },
  };
}
