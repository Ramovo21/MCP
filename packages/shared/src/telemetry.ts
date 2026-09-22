import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
  type Attributes,
} from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { randomBytes } from 'node:crypto';
import { traceContext } from './tracing.js';

let provider: NodeTracerProvider | undefined;
const allowed = new Set([
  'organizationId',
  'executionId',
  'connector',
  'tool',
  'operation',
  'method',
  'status',
  'risk',
  'decision',
  'code',
  'protocol',
  'pid',
  'durationMs',
]);
export function safeAttributes(values: Record<string, unknown>): Attributes {
  return Object.fromEntries(
    Object.entries(values)
      .filter(
        ([k, v]) =>
          allowed.has(k) &&
          (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'),
      )
      .map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : v]),
  ) as Attributes;
}
export function initializeTelemetry(service: string, exporter?: SpanExporter) {
  if (provider) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const output =
    exporter ??
    (endpoint ? new OTLPTraceExporter({ url: endpoint, timeoutMillis: 1500 }) : undefined);
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': service,
      'deployment.environment.name': process.env.APP_ENV ?? 'development',
    }),
    spanProcessors: output
      ? [
          new BatchSpanProcessor(output, {
            scheduledDelayMillis: 1000,
            exportTimeoutMillis: 2000,
            maxQueueSize: 512,
          }),
        ]
      : [],
  });
}
export function beginSpan(name: string, metadata: Record<string, unknown> = {}) {
  initializeTelemetry('omnimcp');
  const current = traceContext.getStore();
  const parent = current
    ? trace.setSpanContext(ROOT_CONTEXT, {
        traceId: current.traceId,
        spanId: current.spanId ?? randomBytes(8).toString('hex'),
        traceFlags: 1,
      })
    : ROOT_CONTEXT;
  const span = provider!
    .getTracer('omnimcp', '1.2')
    .startSpan(name, { attributes: safeAttributes(metadata) }, parent);
  return {
    span,
    context: {
      ...current,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      span,
    },
  };
}
export function failSpan(span: Span, error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute(
    'code',
    typeof code === 'string' && /^[A-Z_]{1,80}$/.test(code) ? code : 'INTERNAL_ERROR',
  );
  // Never record exception messages/stacks: SDK/provider failures may embed credentials.
}
export async function withSpan<T>(
  name: string,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const { span, context } = beginSpan(name, metadata);
  return traceContext.run(context, async () => {
    try {
      return await fn();
    } catch (error) {
      failSpan(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}
export async function flushTelemetry() {
  await provider?.forceFlush();
}
export async function shutdownTelemetry() {
  await provider?.shutdown();
  provider = undefined;
}
