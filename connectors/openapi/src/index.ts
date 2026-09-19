import { parse } from 'yaml';
import { z } from 'zod';
import type { Connector, ToolDefinition } from '../../../packages/connector-sdk/src/index.js';
import { AppError, type JsonObject, type Risk } from '../../../packages/shared/src/index.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AppError('INVALID_SPEC', 'Expected an OpenAPI object');
  return value as JsonObject;
}
export function parseSpec(source: unknown): JsonObject {
  const root = object(typeof source === 'string' ? parse(source, { maxAliasCount: 20 }) : source);
  if (!/^3\.[01]\./.test(String(root.openapi)))
    throw new AppError('INVALID_SPEC', 'OpenAPI 3.0 or 3.1 is required');
  if (JSON.stringify(root).length > 750000)
    throw new AppError('INVALID_SPEC', 'Specification exceeds size limit');
  return root;
}
export function dereference(value: unknown, root: JsonObject, stack: string[] = []): unknown {
  if (stack.length > 24) throw new AppError('INVALID_SPEC', 'Reference nesting limit exceeded');
  if (Array.isArray(value)) return value.map((v) => dereference(v, root, stack));
  if (value && typeof value === 'object') {
    const v = object(value);
    if (typeof v.$ref === 'string') {
      const ref = v.$ref;
      if (!ref.startsWith('#/') || stack.includes(ref))
        throw new AppError('INVALID_SPEC', 'External or cyclic references are not supported');
      let target: unknown = root;
      for (const p of ref.slice(2).split('/'))
        target = object(target)[p.replace(/~1/g, '/').replace(/~0/g, '~')];
      if (target === undefined) throw new AppError('INVALID_SPEC', 'Unresolved local reference');
      return dereference(target, root, [...stack, ref]);
    }
    return Object.fromEntries(Object.entries(v).map(([k, v]) => [k, dereference(v, root, stack)]));
  }
  return value;
}
export function operations(source: unknown, namespace: string): ToolDefinition[] {
  z.string()
    .regex(/^[a-z][a-z0-9_.-]*$/)
    .max(60)
    .parse(namespace);
  const root = parseSpec(source),
    paths = object(root.paths),
    tools: ToolDefinition[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('..'))
      throw new AppError('INVALID_SPEC', 'Unsafe operation path');
    const pathItem = object(dereference(item, root));
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head'].includes(method)) continue;
      const op = object(operation),
        parameters = [
          ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
          ...(Array.isArray(op.parameters) ? op.parameters : []),
        ].map((p) => object(dereference(p, root)));
      const properties: JsonObject = Object.create(null),
        required: string[] = [],
        locations: JsonObject = Object.create(null);
      for (const p of parameters) {
        const name = String(p.name);
        if (!['path', 'query', 'header'].includes(String(p.in)))
          throw new AppError(
            'INVALID_SPEC',
            'Only path, query, and safe header parameters are supported',
          );
        if (
          p.in === 'header' &&
          /authorization|cookie|host|connection|content-length|proxy|transfer-encoding|idempotency|api.?key|token|secret/i.test(
            name,
          )
        )
          throw new AppError(
            'INVALID_SPEC',
            'Credential and transport headers cannot be tool inputs',
          );
        if (properties[name])
          throw new AppError('INVALID_SPEC', 'Duplicate parameter names are unsupported');
        const schema = object(dereference(p.schema ?? { type: 'string' }, root));
        if (
          schema.type === 'object' ||
          p.content ||
          p.explode === false ||
          (p.style && p.style !== (p.in === 'query' ? 'form' : 'simple'))
        )
          throw new AppError(
            'INVALID_SPEC',
            'Custom parameter serialization requires a custom connector',
          );
        properties[name] = schema;
        locations[name] = p.in;
        if (p.required || p.in === 'path') required.push(name);
      }
      if (op.requestBody) {
        const body = object(dereference(op.requestBody, root)),
          json = object(object(body.content)['application/json']);
        properties.body = dereference(json.schema ?? { type: 'object' }, root);
        if (body.required) required.push('body');
      }
      const name = String(
        op.operationId ?? `${method}_${path.replace(/[{}]/g, '').replace(/\W+/g, '_')}`,
      ).replace(/[^a-zA-Z0-9_.-]/g, '_');
      const risk: Risk =
        method === 'get' || method === 'head' ? 'READ' : method === 'delete' ? 'CRITICAL' : 'WRITE';
      tools.push({
        namespace,
        name,
        description: `${String(op.summary ?? op.description ?? `${method.toUpperCase()} ${path}`).slice(0, 1500)} (${method.toUpperCase()} ${path})`,
        risk,
        inputSchema: { type: 'object', properties, required, additionalProperties: false },
        config: {
          operationId: op.operationId ?? name,
          path,
          method: method.toUpperCase(),
          locations,
        },
      });
    }
  }
  if (new Set(tools.map((t) => t.name)).size !== tools.length)
    throw new AppError('INVALID_SPEC', 'Operation IDs must be unique');
  if (tools.length > 500)
    throw new AppError('INVALID_SPEC', 'Limit 500 operations per specification');
  return tools;
}
export function openApiConnector(http = new SafeHttp()): Connector {
  return {
    id: 'openapi',
    name: 'OpenAPI / REST',
    version: '1.0.0',
    async discover(ctx) {
      const c = ctx.connection.config;
      let spec = c.spec;
      if (!spec && typeof c.specUrl === 'string') {
        const response = await http.fetch(c.specUrl, { signal: ctx.signal });
        if (!response.ok)
          throw new AppError(
            'UPSTREAM_ERROR',
            `Specification endpoint returned HTTP ${response.status}`,
            502,
          );
        spec = await response.text();
      }
      return operations(spec, String(c.namespace ?? 'api'));
    },
    async execute(tool, args, ctx) {
      const cfg = tool.config,
        base = new URL(z.url().parse(ctx.connection.config.baseUrl));
      if (base.search || base.hash)
        throw new AppError('INVALID_URL', 'Base URL must not contain query or fragment');
      let path = String(cfg.path);
      const query = new URLSearchParams(),
        headers: Record<string, string> = {
          accept: 'application/json',
          'idempotency-key': ctx.executionId,
        };
      if (ctx.secrets.bearerToken) headers.authorization = `Bearer ${ctx.secrets.bearerToken}`;
      for (const [name, where] of Object.entries(object(cfg.locations))) {
        const value = args[name];
        if (value === undefined) continue;
        if (where === 'path') {
          if (['.', '..'].includes(String(value)))
            throw new AppError('INVALID_ARGUMENTS', 'Invalid path parameter');
          path = path.replace(`{${name}}`, encodeURIComponent(String(value)));
        } else if (where === 'query') {
          if (Array.isArray(value)) value.forEach((v) => query.append(name, String(v)));
          else query.set(name, String(value));
        } else if (where === 'header') headers[name] = String(value);
      }
      const url = new URL(base.toString().replace(/\/$/, '') + path);
      if (url.origin !== base.origin)
        throw new AppError('SSRF_BLOCKED', 'Operation origin mismatch');
      url.search = query.toString();
      const body = args.body === undefined ? undefined : JSON.stringify(args.body);
      if (body) headers['content-type'] = 'application/json';
      return http.json(url, { method: String(cfg.method), headers, body, signal: ctx.signal });
    },
  };
}
