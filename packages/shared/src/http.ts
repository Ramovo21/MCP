import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
import { AppError } from './index.js';
import { traceEvent, upstreamTraceHeaders } from './tracing.js';
export interface NetworkPolicy {
  privateHosts: readonly string[];
  allowHttp?: boolean;
}
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export async function resolveSafeHost(
  host: string,
  policy: NetworkPolicy,
  resolve: Resolver = (host) => lookup(host, { all: true }),
) {
  const normalized = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    ['metadata.google.internal', 'metadata', '169.254.169.254', '100.100.100.200'].includes(
      normalized,
    )
  )
    throw new AppError('SSRF_BLOCKED', 'Network destination is forbidden');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ips = await Promise.race([
    resolve(normalized),
    new Promise<never>((_r, reject) => {
      timer = setTimeout(
        () => reject(new AppError('DNS_TIMEOUT', 'Connector DNS lookup timed out', 502)),
        3000,
      );
    }),
  ]).finally(() => clearTimeout(timer));
  if (
    !ips.length ||
    ips.some((ip) => {
      const parsed = ipaddr.process(ip.address),
        range = parsed.range();
      return (
        range === 'linkLocal' ||
        range === 'multicast' ||
        range === 'unspecified' ||
        (!isPublicAddress(ip.address) && !policy.privateHosts.includes(normalized))
      );
    })
  )
    throw new AppError('SSRF_BLOCKED', 'Network destination is forbidden');
  return ips;
}
export class SafeHttp {
  constructor(
    readonly policy: NetworkPolicy = { privateHosts: [] },
    private resolver?: Resolver,
  ) {}
  async fetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new AppError('INVALID_URL', 'Invalid connector URL');
    }
    if (
      (url.protocol !== 'https:' && !(this.policy.allowHttp && url.protocol === 'http:')) ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new AppError(
        'SSRF_BLOCKED',
        'Connector URL must use HTTPS without embedded credentials',
      );
    const ips = await resolveSafeHost(url.hostname, this.policy, this.resolver),
      ip = ips[0]!;
    // DNS is resolved and checked once, then pinned in the socket lookup; Host/SNI retain original hostname.
    const agent = new Agent({
      connect: {
        lookup: (_host, options, cb) =>
          options.all
            ? cb(null, [{ address: ip.address, family: ip.family }])
            : cb(null, ip.address, ip.family),
      },
      maxResponseSize: 2 * 1024 * 1024,
    });
    const signal = AbortSignal.any([
      AbortSignal.timeout(15000),
      ...(init.signal ? [init.signal] : []),
    ]);
    try {
      traceEvent('upstream_started', { protocol: url.protocol, method: init.method ?? 'GET' });
      const response = await request(url, {
        dispatcher: agent,
        method: (init.method ?? 'GET') as 'GET',
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          ...upstreamTraceHeaders(),
        },
        body: typeof init.body === 'string' ? init.body : undefined,
        signal,
        headersTimeout: 10000,
        bodyTimeout: 15000,
      });
      traceEvent('upstream_response', { status: response.statusCode });
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.body.on('error', () => {});
        response.body.destroy();
        throw new AppError('REDIRECT_BLOCKED', 'Connector redirects are disabled');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) {
          response.body.on('error', () => {});
          response.body.destroy();
          throw new AppError('RESPONSE_TOO_LARGE', 'Connector response exceeds 2 MiB');
        }
        chunks.push(Buffer.from(chunk));
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers))
        if (value !== undefined)
          headers.set(key, Array.isArray(value) ? value.join(',') : String(value));
      return new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), {
        status: response.statusCode,
        headers,
      });
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(
        signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
        'Connector request failed',
        502,
      );
    } finally {
      await agent.close();
    }
  }
  async json(input: string | URL, init: RequestInit = {}) {
    const r = await this.fetch(input, init);
    if (!r.ok)
      throw new AppError(
        r.status === 429 || r.status >= 500 ? 'UPSTREAM_TRANSIENT' : 'UPSTREAM_PERMANENT',
        `Upstream returned HTTP ${r.status}`,
        502,
      );
    if (r.status === 204 || init.method === 'HEAD') return { ok: true, status: r.status };
    try {
      return (await r.json()) as unknown;
    } catch {
      throw new AppError('INVALID_RESPONSE', 'Upstream did not return valid JSON', 502);
    }
  }
}
