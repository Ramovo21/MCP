import express from 'express';
import helmet from 'helmet';
import pino from 'pino';
import { z, ZodError } from 'zod';
import { handleMcp } from '../../../packages/mcp-core/src/index.js';
import { AppError, publicError, toolName } from '../../../packages/shared/src/index.js';
import type { ExecutionService } from './execution.js';
import type { Authenticator } from './auth.js';
import type { RateLimiter } from './rate-limit.js';
import type { ConnectionService } from './connections.js';
import { mountInbound, mountManagement } from './management.js';
import { newTraceId, traceContext } from '../../../packages/shared/src/tracing.js';
import type { OAuthService } from './oauth.js';
import { uuid } from '../../../packages/shared/src/index.js';
export interface AppServices {
  execution: ExecutionService;
  auth: Authenticator;
  rateLimiter: RateLimiter;
  webOrigin: string;
  hosts: string[];
  connections?: ConnectionService;
  workerHealth?: () => unknown;
  oauth?: OAuthService;
}
export function createApp(s: AppServices): express.Express {
  const app = express(),
    logger = pino();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((_req, res, next) => {
    const traceId = newTraceId();
    res.set('X-Trace-Id', traceId);
    res.set('Cache-Control', 'no-store');
    traceContext.run({ traceId }, next);
  });
  app.use((req, res, next) => {
    if (!s.hosts.includes(req.hostname))
      return next(new AppError('INVALID_HOST', 'Host is not allowed', 403));
    const origin = req.get('origin');
    if (origin && origin !== s.webOrigin)
      return next(new AppError('INVALID_ORIGIN', 'Origin is not allowed', 403));
    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Organization-Id, Idempotency-Key, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
      );
      res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
  app.use(
    express.json({
      limit: '1mb',
      verify(req, _res, buf) {
        (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.get('/health', (_req, res) =>
    res.json({
      status: 'ok',
      service: 'omnimcp',
      protocol: '2026-07-28',
      worker: s.workerHealth?.(),
    }),
  );
  if (s.connections) mountInbound(app, s.connections);
  if (s.oauth)
    app.get('/oauth/callback/:provider', async (req, res) => {
      const input = z
        .object({ state: z.string().min(32).max(200), code: z.string().min(1).max(4000) })
        .parse(req.query);
      res.json(await s.oauth!.callback(String(req.params.provider), input.state, input.code));
    });
  app.use(async (req, res, next) => {
    try {
      const p = await s.auth.authenticate(req.get('authorization'), req.get('x-organization-id'));
      await s.rateLimiter.consume(`${p.organizationId}:${p.apiKeyId ?? p.userId}`);
      res.locals.principal = p;
      next();
    } catch (e) {
      next(e);
    }
  });
  app.all('/mcp', async (req, res) => {
    await handleMcp(req, res, res.locals.principal, s.execution);
  });
  if (s.oauth) {
    app.post('/api/connections/:id/oauth', async (req, res) => {
      const input = z
        .object({
          provider: z.string().min(1).max(100),
          scopes: z.array(z.string()).min(1).max(100),
        })
        .strict()
        .parse(req.body);
      res.json(
        await s.oauth!.initiate(
          res.locals.principal,
          uuid.parse(req.params.id),
          input.provider,
          input.scopes,
        ),
      );
    });
    app.delete('/api/connections/:id/oauth', async (req, res) =>
      res.json(await s.oauth!.revoke(res.locals.principal, uuid.parse(req.params.id))),
    );
  }
  app.get('/api/tools', async (_req, res) =>
    res.json(await s.execution.list(res.locals.principal)),
  );
  app.post('/api/invoke', async (req, res) => {
    const input = z
      .object({ name: toolName, arguments: z.record(z.string(), z.unknown()).default({}) })
      .strict()
      .parse(req.body);
    res.json(
      await s.execution.call(
        res.locals.principal,
        input.name,
        input.arguments,
        req.get('idempotency-key'),
      ),
    );
  });
  if (s.connections) mountManagement(app, s.execution, s.connections);
  app.use(
    (error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const safe =
        error instanceof ZodError
          ? new AppError('INVALID_INPUT', 'Request validation failed')
          : error;
      const parserStatus =
        typeof error === 'object' && error && 'type' in error ? error.type : undefined;
      const status =
        parserStatus === 'entity.too.large'
          ? 413
          : parserStatus === 'entity.parse.failed'
            ? 400
            : safe instanceof AppError
              ? safe.status
              : 500;
      logger.warn({ code: publicError(safe).code, status }, 'Request rejected');
      if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="OmniMCP"');
      res.status(status).json({ error: publicError(safe) });
    },
  );
  return app;
}
