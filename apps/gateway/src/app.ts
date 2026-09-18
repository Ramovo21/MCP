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
export interface AppServices {
  execution: ExecutionService;
  auth: Authenticator;
  rateLimiter: RateLimiter;
  webOrigin: string;
  hosts: string[];
  connections?: ConnectionService;
}
export function createApp(s: AppServices) {
  const app = express(),
    logger = pino();
  app.disable('x-powered-by');
  app.use(helmet());
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
      res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
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
    res.json({ status: 'ok', service: 'omnimcp', protocol: '2026-07-28' }),
  );
  if (s.connections) mountInbound(app, s.connections);
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
      const status = safe instanceof AppError ? safe.status : 500;
      logger.warn({ code: publicError(safe).code, status }, 'Request rejected');
      if (status === 401) res.set('WWW-Authenticate', 'Bearer realm="OmniMCP"');
      res.status(status).json({ error: publicError(safe) });
    },
  );
  return app;
}
