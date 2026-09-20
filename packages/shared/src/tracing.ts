import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import type { Span } from '@opentelemetry/api';
import { safeAttributes } from './telemetry.js';

export interface TraceContext {
  traceId: string;
  spanId?: string;
  span?: Span;
  executionId?: string;
  emit?: (stage: string, metadata: Record<string, unknown>) => void;
}
export const traceContext = new AsyncLocalStorage<TraceContext>();
export const newTraceId = () => randomBytes(16).toString('hex');
/** An OTel adapter may consume these metadata-only events; never pass arguments or results. */
export interface TraceExporter {
  emit(event: {
    traceId: string;
    executionId?: string;
    stage: string;
    time: string;
    metadata: Record<string, unknown>;
  }): void;
}
let exporter: TraceExporter | undefined;
export function setTraceExporter(value: TraceExporter) {
  exporter = value;
}
export function traceEvent(stage: string, metadata: Record<string, unknown> = {}) {
  const context = traceContext.getStore();
  if (!context) return;
  metadata = safeAttributes(metadata);
  context.span?.addEvent(stage, metadata as Record<string, string | number | boolean>);
  context.emit?.(stage, metadata);
  exporter?.emit({
    traceId: context.traceId,
    executionId: context.executionId,
    stage,
    time: new Date().toISOString(),
    metadata,
  });
}
export function upstreamTraceHeaders() {
  const context = traceContext.getStore();
  return context
    ? {
        traceparent: `00-${context.traceId}-${context.spanId ?? randomBytes(8).toString('hex')}-01`,
      }
    : {};
}
