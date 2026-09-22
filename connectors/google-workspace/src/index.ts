import { z } from 'zod';
import { AppError, type JsonObject } from '../../../packages/shared/src/index.js';
import { SafeHttp } from '../../../packages/shared/src/http.js';
import type {
  Connector,
  ConnectorContext,
  ToolDefinition,
} from '../../../packages/connector-sdk/src/index.js';

export const googleScopes = {
  gmail: 'https://www.googleapis.com/auth/gmail.readonly',
  drive: 'https://www.googleapis.com/auth/drive.metadata.readonly',
  calendar: 'https://www.googleapis.com/auth/calendar.events.readonly',
} as const;
const settings = z
  .object({
    services: z
      .array(z.enum(['gmail', 'drive', 'calendar']))
      .min(1)
      .default(['gmail']),
  })
  .strict();
const paging = {
  pageToken: { type: 'string', maxLength: 2048 },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
};
const object = (properties: JsonObject, required: string[] = []): JsonObject => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const definitions: (ToolDefinition & { service: keyof typeof googleScopes })[] = [
  {
    service: 'gmail',
    namespace: 'google.gmail.email',
    name: 'search',
    risk: 'READ',
    description:
      'Search the connected Google mailbox with Gmail search syntax (for example invoice newer_than:30d). Returns message IDs and thread IDs; use email.get to read a selected message. Does not send or modify email.',
    inputSchema: object(
      { query: { type: 'string', minLength: 1, maxLength: 1000, writeOnly: true }, ...paging },
      ['query'],
    ),
  },
  {
    service: 'gmail',
    namespace: 'google.gmail.email',
    name: 'get',
    risk: 'READ',
    description:
      'Read the headers, snippet and MIME payload of one message in the connected Google mailbox by message ID. MIME body data is base64url encoded; attachments are not downloaded.',
    inputSchema: object({ id: { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,200}$' } }, ['id']),
  },
  {
    service: 'drive',
    namespace: 'google.drive.file',
    name: 'search',
    risk: 'READ',
    description:
      'Search Google Drive file metadata using Drive query syntax. Returns IDs, names, MIME types, modification times and links, without file contents. Trashed files are excluded.',
    inputSchema: object({ query: { type: 'string', maxLength: 1000, writeOnly: true }, ...paging }),
  },
  {
    service: 'calendar',
    namespace: 'google.calendar.event',
    name: 'list',
    risk: 'READ',
    description:
      'List events from the connected account primary calendar or a known calendar ID. Supply RFC3339 timeMin/timeMax to limit the interval. Does not modify events.',
    inputSchema: object({
      calendarId: { type: 'string', minLength: 1, maxLength: 256 },
      timeMin: { type: 'string', format: 'date-time' },
      timeMax: { type: 'string', format: 'date-time' },
      ...paging,
    }),
  },
];
export function googleWorkspaceConnector(http = new SafeHttp()): Connector {
  const get = async (url: URL, ctx: ConnectorContext) => {
    if (!ctx.secrets.bearerToken)
      throw new AppError('OAUTH_REAUTH_REQUIRED', 'Connect Google authorization first', 403);
    const r = await http.fetch(url, {
      headers: { authorization: 'Bearer ' + ctx.secrets.bearerToken },
      signal: ctx.signal,
    });
    if (r.status === 401)
      throw new AppError(
        'OAUTH_REAUTH_REQUIRED',
        'Google authorization expired or revoked; reconnect',
        403,
      );
    if (r.status === 403)
      throw new AppError(
        'UPSTREAM_PERMISSION',
        'Google denied access; check granted scopes and enabled APIs',
        403,
      );
    if (!r.ok)
      throw new AppError(
        r.status === 429 || r.status >= 500 ? 'UPSTREAM_TRANSIENT' : 'UPSTREAM_PERMANENT',
        `Google returned HTTP ${r.status}`,
        502,
      );
    try {
      return (await r.json()) as unknown;
    } catch {
      throw new AppError('INVALID_RESPONSE', 'Google returned invalid JSON', 502);
    }
  };
  const connector: Connector = {
    id: 'google-workspace',
    name: 'Google Workspace (read only)',
    version: '1.0.0',
    async initialize(ctx) {
      settings.parse(ctx.connection.config);
    },
    async discover(ctx) {
      const config = settings.parse(ctx.connection.config);
      return definitions
        .filter((t) => config.services.includes(t.service))
        .map(({ service, ...tool }) => ({
          ...tool,
          config: {
            requiredOAuthProvider: 'google-workspace',
            requiredOAuthScopes: [googleScopes[service]],
          },
        }));
    },
    async execute(tool, args, ctx) {
      const found = (await connector.discover(ctx)).find(
        (t) => `${t.namespace}.${t.name}` === tool.name,
      );
      if (!found) throw new AppError('TOOL_NOT_FOUND', 'Google tool not selected', 404);
      let url: URL;
      switch (tool.name) {
        case 'google.gmail.email.search':
          url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
          url.searchParams.set('q', String(args.query));
          break;
        case 'google.gmail.email.get':
          url = new URL(
            'https://gmail.googleapis.com/gmail/v1/users/me/messages/' +
              encodeURIComponent(String(args.id)),
          );
          url.searchParams.set('format', 'full');
          break;
        case 'google.drive.file.search':
          url = new URL('https://www.googleapis.com/drive/v3/files');
          url.searchParams.set(
            'q',
            args.query ? `trashed = false and (${String(args.query)})` : 'trashed = false',
          );
          url.searchParams.set(
            'fields',
            'nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)',
          );
          url.searchParams.set('orderBy', 'modifiedTime desc');
          break;
        case 'google.calendar.event.list':
          url = new URL(
            'https://www.googleapis.com/calendar/v3/calendars/' +
              encodeURIComponent(String(args.calendarId ?? 'primary')) +
              '/events',
          );
          url.searchParams.set('singleEvents', 'true');
          url.searchParams.set('orderBy', 'startTime');
          for (const k of ['timeMin', 'timeMax'])
            if (args[k]) url.searchParams.set(k, String(args[k]));
          break;
        default:
          throw new AppError('TOOL_NOT_FOUND', 'Unknown Google tool', 404);
      }
      if (!tool.name.endsWith('.get')) {
        url.searchParams.set(
          tool.name.startsWith('google.drive.') ? 'pageSize' : 'maxResults',
          String(args.limit ?? 20),
        );
        if (args.pageToken) url.searchParams.set('pageToken', String(args.pageToken));
      }
      return get(url, ctx);
    },
    async test(ctx) {
      const first = (await connector.discover(ctx))[0]!;
      const service = settings.parse(ctx.connection.config).services[0]!;
      const url = new URL(
        service === 'gmail'
          ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile'
          : service === 'drive'
            ? 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)'
            : 'https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1',
      );
      if (!first) throw new AppError('INVALID_CONFIG', 'Select a Google service');
      await get(url, ctx);
    },
  };
  return connector;
}
