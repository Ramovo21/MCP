import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Connector } from '../../../packages/connector-sdk/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
export const signature = (secret: string, timestamp: string, body: string | Buffer) =>
  createHmac('sha256', secret)
    .update(timestamp + '.')
    .update(body)
    .digest('hex');
export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  provided: string | undefined,
  body: Buffer,
  now = Date.now(),
) {
  if (
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp) * 1000) > 300000 ||
    !provided ||
    !/^sha256=[0-9a-f]{64}$/.test(provided)
  )
    throw new AppError('INVALID_SIGNATURE', 'Webhook signature invalid or expired', 401);
  const expected = Buffer.from(signature(secret, timestamp, body), 'hex'),
    actual = Buffer.from(provided.slice(7), 'hex');
  if (!timingSafeEqual(expected, actual))
    throw new AppError('INVALID_SIGNATURE', 'Webhook signature invalid or expired', 401);
}
const config = z
  .object({
    url: z.url().optional(),
    namespace: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]*$/)
      .default('webhook'),
    inbound: z.boolean().default(true),
  })
  .strict();
export function webhookConnector(http = new SafeHttp()): Connector {
  return {
    id: 'webhook',
    name: 'Webhook',
    version: '1.0.0',
    async discover(ctx) {
      const c = config.parse(ctx.connection.config);
      if (!ctx.secrets.signingSecret || ctx.secrets.signingSecret.length < 32)
        throw new AppError(
          'INVALID_SECRET',
          'Webhook signing secret must contain at least 32 characters',
        );
      return c.url
        ? [
            {
              namespace: c.namespace,
              name: 'send',
              description: 'Send a signed JSON event to the configured webhook destination.',
              risk: 'WRITE',
              inputSchema: {
                type: 'object',
                properties: {
                  event: { type: 'string', minLength: 1, maxLength: 100 },
                  payload: { type: 'object' },
                },
                required: ['event', 'payload'],
                additionalProperties: false,
              },
            },
          ]
        : [];
    },
    async execute(_tool, args, ctx) {
      const c = config.parse(ctx.connection.config);
      if (!c.url || !ctx.secrets.signingSecret)
        throw new AppError('INVALID_CONNECTION', 'Outbound webhook is not configured');
      const timestamp = String(Math.floor(Date.now() / 1000)),
        body = JSON.stringify(args);
      return http.json(c.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-omni-timestamp': timestamp,
          'x-omni-signature': 'sha256=' + signature(ctx.secrets.signingSecret, timestamp, body),
          'idempotency-key': ctx.executionId,
        },
        body,
        signal: ctx.signal,
      });
    },
  };
}
