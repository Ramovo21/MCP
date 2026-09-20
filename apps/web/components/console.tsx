'use client';
import { useCallback, useEffect, useState, useRef, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  ArrowUpRight,
  Blocks,
  BookOpen,
  Braces,
  CheckCheck,
  ChevronRight,
  Code2,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Network,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Users,
  Zap,
} from 'lucide-react';
import { api, gateway, supabase, type ConsoleData, type Row, type Tool } from '../lib/api';
const nav = [
  ['dashboard', 'Overview', LayoutDashboard],
  ['connections', 'Connections', Blocks],
  ['tools', 'Tool registry', Braces],
  ['mcp-servers', 'MCP servers', Server],
  ['approvals', 'Approvals', ShieldCheck],
  ['executions', 'Executions', Activity],
  ['logs', 'Audit logs', BookOpen],
  ['playground', 'Playground', Play],
  ['api-keys', 'API keys', KeyRound],
  ['organization', 'Organization', Users],
  ['settings', 'Developer settings', Settings],
] as const;
const text = (v: unknown) => (v == null ? '—' : String(v));
const date = (v: unknown) => (v ? new Date(String(v)).toLocaleString() : '—');
function Badge({ children }: { children: unknown }) {
  return <span className={`badge ${String(children)}`}>{text(children)}</span>;
}
function Json({ value }: { value: unknown }) {
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}
function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <Network size={28} style={{ margin: '0 auto 12px', opacity: 0.5 }} />
      {children}
    </div>
  );
}
function Field({
  name,
  value,
  onChange,
  type = 'text',
}: {
  name: string;
  value: string;
  onChange: (s: string) => void;
  type?: string;
}) {
  return (
    <label>
      {name}
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} required />
    </label>
  );
}
export default function Console() {
  const section = usePathname().split('/')[1] || 'dashboard';
  const [session, setSession] = useState(false),
    [initialized, setInitialized] = useState(false),
    [org, setOrg] = useState(''),
    [memberships, setMemberships] = useState<{ id: string; name: string }[]>([]),
    [data, setData] = useState<ConsoleData>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [search, setSearch] = useState(''),
    [detail, setDetail] = useState<Row>(),
    [selectedTool, setSelectedTool] = useState<Tool>(),
    [newConnection, setNewConnection] = useState(false),
    [discovered, setDiscovered] = useState<{ id: string; tools: Row[]; selected: string[] }>(),
    [schema, setSchema] = useState<{ id: string; columns: Row[]; selected: string[] }>();
  const identity = useRef<string | undefined>(undefined),
    currentOrg = useRef(org);
  currentOrg.current = org;
  const clearWorkspace = useCallback(() => {
    setData(undefined);
    setDetail(undefined);
    setSelectedTool(undefined);
    setDiscovered(undefined);
    setSchema(undefined);
    setNewConnection(false);
    setError('');
    setNotice('');
  }, []);
  const load = useCallback(async () => {
    if (!org) return;
    const requestedIdentity = identity.current;
    const result = await api<ConsoleData>(org, '/api/console');
    if (currentOrg.current === org && identity.current === requestedIdentity) setData(result);
  }, [org]);
  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operation failed');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    let active = true;
    try {
      const auth = supabase();
      const sync = async () => {
        const { data } = await auth.auth.getSession();
        if (!active) return;
        const nextIdentity = data.session?.user.id;
        if (identity.current !== nextIdentity) {
          identity.current = nextIdentity;
          currentOrg.current = '';
          setOrg('');
          setMemberships([]);
          clearWorkspace();
        }
        setSession(Boolean(data.session));
        setInitialized(true);
        if (data.session) {
          const response = await auth.from('organizations').select('id,name');
          if (response.error) {
            setError(response.error.message);
            return;
          }
          const orgs = response.data ?? [];
          setMemberships(orgs);
          const saved = sessionStorage.getItem(`omnimcp.organization.${data.session.user.id}`);
          setOrg((old) =>
            orgs.some((o) => o.id === old)
              ? old
              : orgs.some((o) => o.id === saved)
                ? saved!
                : (orgs[0]?.id ?? ''),
          );
        }
      };
      void sync();
      const { data } = auth.auth.onAuthStateChange(() => {
        setTimeout(() => void sync(), 0);
      });
      return () => {
        active = false;
        data.subscription.unsubscribe();
      };
    } catch (e) {
      setError((e as Error).message);
      setInitialized(true);
    }
  }, [clearWorkspace]);
  useEffect(() => {
    if (org) void run(load);
  }, [org, run, load]);
  useEffect(() => {
    if (!org) return;
    const timer = setInterval(() => {
      void load().catch(() => {});
    }, 15000);
    return () => clearInterval(timer);
  }, [org, load]);
  useEffect(() => {
    setDetail(undefined);
    setSelectedTool(undefined);
    setSearch('');
  }, [section]);
  const mutate = (path: string, method: string, body?: unknown) =>
    run(async () => {
      await api(org, path, method, body);
      await load();
      setNotice('Changes saved.');
    });
  if (!initialized)
    return (
      <main className="login panel" role="status">
        Loading OmniMCP…
      </main>
    );
  if (!session) return <Auth error={error} onError={setError} />;
  if (!org)
    return (
      <main className="login panel">
        <div className="brand">
          <span>◈</span> OmniMCP
        </div>
        <h1>Create your workspace</h1>
        <p>Your tools, policies, and execution history stay within your organization.</p>
        {error && (
          <div role="alert" className="error">
            {error}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const name = String(new FormData(e.currentTarget).get('name'));
            void run(async () => {
              const result = await supabase().rpc('create_organization', { org_name: name });
              if (result.error) throw result.error;
              setMemberships([{ id: result.data, name }]);
              setOrg(result.data);
            });
          }}
        >
          <label>
            Organization name
            <input name="name" required maxLength={120} />
          </label>
          <button className="primary" disabled={busy}>
            Create organization
          </button>
        </form>
      </main>
    );
  const admin = data && ['owner', 'admin'].includes(data.role),
    pending = data?.approvals.filter((a) => a.status === 'pending') ?? [];
  const executions = (rows: Row[]) =>
    rows.length ? (
      <table>
        <thead>
          <tr>
            <th>Tool / request</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Started</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={text(e.id)}>
              <td className="code">
                {text(e.tool_name)}
                <div className="muted">{text(e.id).slice(0, 8)}</div>
              </td>
              <td>
                <Badge>{e.status}</Badge>
              </td>
              <td>{text(e.duration_ms)} ms</td>
              <td>{date(e.started_at)}</td>
              <td>
                <button
                  aria-label={`View execution ${e.id}`}
                  onClick={() =>
                    void run(async () => setDetail(await api<Row>(org, `/api/executions/${e.id}`)))
                  }
                >
                  <ArrowUpRight size={15} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : (
      <Empty>No executions yet. Invoke a tool from the Playground to see its trace here.</Empty>
    );
  return (
    <div className="shell">
      <aside className="sidebar">
        <Link href="/dashboard" className="brand">
          <span>
            <Network size={28} />
          </span>
          OmniMCP
        </Link>
        <div className="muted" style={{ fontSize: 10, letterSpacing: 2, marginTop: 8 }}>
          INTEGRATION & ACTION GATEWAY
        </div>
        <nav className="nav" aria-label="Main navigation">
          {nav.map(([id, label, Icon]) => (
            <Link key={id} className={section === id ? 'active' : ''} href={`/${id}`}>
              <Icon size={17} />
              {label}
              {id === 'approvals' && pending.length > 0 && <Badge>{pending.length}</Badge>}
            </Link>
          ))}
        </nav>
        <div className="panel spacer" style={{ padding: 14 }}>
          <ShieldCheck size={18} color="#6ee7b7" />
          <p style={{ fontSize: 12 }}>
            Every action is governed.
            <br />
            Every execution is traced.
          </p>
          <span className="badge">MCP 2026-07-28</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <div className="row">
            <span className="muted">Workspace</span>
            <ChevronRight size={14} />
            <select
              aria-label="Organization"
              style={{ width: 210 }}
              value={org}
              onChange={(e) => {
                currentOrg.current = e.target.value;
                if (identity.current)
                  sessionStorage.setItem(
                    `omnimcp.organization.${identity.current}`,
                    e.target.value,
                  );
                clearWorkspace();
                setOrg(e.target.value);
              }}
            >
              {memberships.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <span className="badge">{data?.role ?? 'Connecting'}</span>
            <button aria-label="Refresh dashboard" disabled={busy} onClick={() => void run(load)}>
              <RefreshCw size={15} />
            </button>
            <button aria-label="Sign out" onClick={() => void supabase().auth.signOut()}>
              <LogOut size={15} />
            </button>
          </div>
        </header>
        <main className="content">
          <div className="heading">
            <div>
              <div className="muted" style={{ fontSize: 11, letterSpacing: 2, marginBottom: 7 }}>
                WORKSPACE / {section.toUpperCase()}
              </div>
              <h1>{nav.find((n) => n[0] === section)?.[1] ?? 'Overview'}</h1>
              <p>
                {section === 'dashboard'
                  ? 'A clear view of your AI integration infrastructure.'
                  : section === 'connections'
                    ? 'Connect systems. Select tools. Set boundaries.'
                    : section === 'approvals'
                      ? 'Review high-impact actions before they run.'
                      : 'Manage access and inspect every action across your systems.'}
              </p>
            </div>
            {section === 'connections' && admin && (
              <button className="primary row" onClick={() => setNewConnection(!newConnection)}>
                <Plus size={16} />
                New connection
              </button>
            )}
          </div>
          {error && (
            <div role="alert" className="error">
              {error}
            </div>
          )}
          {notice && (
            <div role="status" className="panel">
              {notice}
            </div>
          )}
          {busy && (
            <div role="status" className="muted">
              Working…
            </div>
          )}
          {!data ? (
            <div className="panel">
              <Empty>Connecting to your gateway…</Empty>
            </div>
          ) : (
            <>
              {section === 'dashboard' && (
                <>
                  <div className="grid">
                    {[
                      ['Tool calls', data.metrics.calls],
                      ['Successful', data.metrics.succeeded],
                      ['Failed / denied', data.metrics.failed],
                      ['Average latency', `${data.metrics.latency} ms`],
                      ['Pending approvals', pending.length],
                      [
                        'Connected systems',
                        data.connections.filter((c) => c.status === 'active').length,
                      ],
                    ].map(([label, value]) => (
                      <div className="panel" key={label}>
                        <div className="row muted">
                          <Activity size={15} />
                          {label}
                        </div>
                        <div className="metric">{value}</div>
                        <div className="muted" style={{ fontSize: 11 }}>
                          ALL TIME · THIS ORGANIZATION
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="split">
                    <section className="panel">
                      <h2>Most-used tools</h2>
                      {[...data.tools]
                        .sort((a, b) => Number(b.usage_count ?? 0) - Number(a.usage_count ?? 0))
                        .slice(0, 5)
                        .map((t) => (
                          <div
                            className="row"
                            key={t.id}
                            style={{ justifyContent: 'space-between', marginBottom: 20 }}
                          >
                            <span className="code">{t.name}</span>
                            <Badge>{`${t.usage_count ?? 0} calls`}</Badge>
                          </div>
                        ))}
                      {!data.tools.length && (
                        <Empty>Import your first tool from Connections.</Empty>
                      )}
                    </section>
                    <section className="panel">
                      <h2>Your gateway endpoint</h2>
                      <p>Connect any compatible MCP client using a scoped API key.</p>
                      <pre>{gateway}/mcp</pre>
                      <div className="row">
                        <Badge>Streamable HTTP</Badge>
                        <Badge>Policy enforced</Badge>
                      </div>
                      <Link className="row spacer" href="/settings">
                        Client configuration <ArrowUpRight size={16} />
                      </Link>
                    </section>
                  </div>
                  <section className="panel">
                    <h2>Recent executions</h2>
                    {executions(data.executions.slice(0, 6))}
                  </section>
                </>
              )}
              {section === 'connections' && (
                <>
                  {newConnection && (
                    <ConnectionForm
                      org={org}
                      connectors={data.connectors}
                      onDone={() => {
                        setNewConnection(false);
                        void run(load);
                      }}
                      onError={setError}
                    />
                  )}
                  <div className="grid">
                    {data.connections.map((c) => (
                      <article className="panel" key={text(c.id)}>
                        <div className="row" style={{ justifyContent: 'space-between' }}>
                          <Blocks size={23} color="#6ee7b7" />
                          <Badge>{c.status}</Badge>
                        </div>
                        <h2 className="spacer">{text(c.name)}</h2>
                        <p>
                          {text(c.connector_id)} ·{' '}
                          {data.tools.filter((t) => t.connection_id === c.id).length} tools
                        </p>
                        {admin && c.status !== 'revoked' && (
                          <div className="row">
                            <button
                              onClick={() =>
                                void run(async () => {
                                  await api(org, `/api/connections/${c.id}/test`, 'POST', {});
                                  setNotice('Connection test passed.');
                                })
                              }
                            >
                              Test
                            </button>
                            <button
                              onClick={() =>
                                void run(async () =>
                                  setDiscovered({
                                    id: text(c.id),
                                    tools: await api<Row[]>(
                                      org,
                                      `/api/connections/${c.id}/discover`,
                                      'POST',
                                      {},
                                    ),
                                    selected: [],
                                  }),
                                )
                              }
                            >
                              Discover tools
                            </button>
                            {c.connector_id === 'postgres' && (
                              <button
                                onClick={() =>
                                  void run(async () =>
                                    setSchema({
                                      id: text(c.id),
                                      columns: await api<Row[]>(
                                        org,
                                        `/api/connections/${c.id}/schema`,
                                      ),
                                      selected: [],
                                    }),
                                  )
                                }
                              >
                                Select columns
                              </button>
                            )}
                            <button
                              onClick={() =>
                                void mutate(`/api/connections/${c.id}`, 'PATCH', {
                                  status: c.status === 'active' ? 'disabled' : 'active',
                                })
                              }
                            >
                              {c.status === 'active' ? 'Disable' : 'Enable'}
                            </button>
                            <button
                              onClick={() =>
                                void mutate(`/api/connections/${c.id}`, 'PATCH', {
                                  status: 'revoked',
                                })
                              }
                            >
                              Revoke
                            </button>
                          </div>
                        )}
                      </article>
                    ))}
                  </div>
                  {!data.connections.length && (
                    <div className="panel">
                      <Empty>
                        No connections yet. Start with Demo CRM; no external credentials are needed.
                      </Empty>
                    </div>
                  )}
                  {discovered && (
                    <section className="panel">
                      <h2>Select tools to publish</h2>
                      <p>Only selected operations will be added to the registry.</p>
                      {discovered.tools.map((t) => (
                        <label className="row" key={text(t.fullName)}>
                          <input
                            style={{ width: 18 }}
                            type="checkbox"
                            checked={discovered.selected.includes(text(t.fullName))}
                            onChange={(e) =>
                              setDiscovered({
                                ...discovered,
                                selected: e.target.checked
                                  ? [...discovered.selected, text(t.fullName)]
                                  : discovered.selected.filter((n) => n !== t.fullName),
                              })
                            }
                          />
                          <span className="code">{text(t.fullName)}</span>
                          <Badge>{t.risk}</Badge>
                          <span className="muted">{text(t.description)}</span>
                        </label>
                      ))}
                      <button
                        className="primary"
                        disabled={busy || !discovered.selected.length}
                        onClick={() =>
                          void run(async () => {
                            await api(org, `/api/connections/${discovered.id}/import`, 'POST', {
                              names: discovered.selected,
                            });
                            setDiscovered(undefined);
                            await load();
                          })
                        }
                      >
                        Publish selected tools
                      </button>
                    </section>
                  )}
                  {schema && (
                    <section className="panel">
                      <h2>Select database columns</h2>
                      <p>
                        Only selected columns will be searchable. V1 defaults to read-only tools.
                      </p>
                      {schema.columns.map((c) => {
                        const id = `${c.table_schema}.${c.table_name}.${c.column_name}`;
                        return (
                          <label className="row" key={id}>
                            <input
                              type="checkbox"
                              style={{ width: 18 }}
                              checked={schema.selected.includes(id)}
                              onChange={(e) =>
                                setSchema({
                                  ...schema,
                                  selected: e.target.checked
                                    ? [...schema.selected, id]
                                    : schema.selected.filter((s) => s !== id),
                                })
                              }
                            />
                            {id}
                            <span className="muted">{text(c.data_type)}</span>
                          </label>
                        );
                      })}
                      <button
                        className="primary"
                        disabled={!schema.selected.length}
                        onClick={() =>
                          void run(async () => {
                            const tables: Record<
                              string,
                              {
                                schema: string;
                                table: string;
                                columns: string[];
                                operations: string[];
                              }
                            > = {};
                            for (const id of schema.selected) {
                              const [s, t, c] = id.split('.');
                              const key = s + '.' + t;
                              tables[key] ??= {
                                schema: s,
                                table: t,
                                columns: [],
                                operations: ['search'],
                              };
                              tables[key].columns.push(c);
                            }
                            await api(org, `/api/connections/${schema.id}/config`, 'PUT', {
                              namespace: 'postgres',
                              tables: Object.values(tables),
                              allowWrites: false,
                            });
                            setSchema(undefined);
                            setNotice('Columns saved. Discover tools to select and publish them.');
                          })
                        }
                      >
                        Save column selection
                      </button>
                    </section>
                  )}
                </>
              )}
              {section === 'tools' && (
                <>
                  <div className="toolbar">
                    <Search size={20} />
                    <input
                      aria-label="Search tools"
                      placeholder="Search namespace, description, or risk…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                  <section className="panel">
                    <table>
                      <thead>
                        <tr>
                          <th>Tool</th>
                          <th>Risk</th>
                          <th>Enabled</th>
                          <th>Calls</th>
                          <th>Approval</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {data.tools
                          .filter((t) =>
                            `${t.name} ${t.description} ${t.risk}`
                              .toLowerCase()
                              .includes(search.toLowerCase()),
                          )
                          .map((t) => (
                            <tr key={t.id}>
                              <td>
                                <button className="code" onClick={() => setSelectedTool(t)}>
                                  {t.name}
                                </button>
                                <div className="muted">{t.description.slice(0, 95)}</div>
                              </td>
                              <td>
                                <Badge>{t.risk}</Badge>
                              </td>
                              <td>
                                {admin ? (
                                  <input
                                    aria-label={`Enable ${t.name}`}
                                    style={{ width: 18 }}
                                    type="checkbox"
                                    checked={t.enabled}
                                    onChange={(e) =>
                                      void mutate(`/api/tools/${t.id}`, 'PATCH', {
                                        enabled: e.target.checked,
                                      })
                                    }
                                  />
                                ) : (
                                  String(t.enabled)
                                )}
                              </td>
                              <td>{t.usage_count ?? 0}</td>
                              <td>
                                {t.risk === 'CRITICAL' ||
                                (t.risk === 'SENSITIVE' && data.policy.sensitive_approval) ||
                                (t.risk === 'WRITE' && !data.policy.allow_write)
                                  ? 'Required'
                                  : 'Automatic'}
                              </td>
                              <td>
                                <ArrowUpRight size={15} />
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                    {!data.tools.length && <Empty>No tools imported yet.</Empty>}
                  </section>
                </>
              )}
              {selectedTool && (
                <section className="panel">
                  <h2>{selectedTool.name}</h2>
                  <p>{selectedTool.description}</p>
                  <p>
                    Connection:{' '}
                    {text(data.connections.find((c) => c.id === selectedTool.connection_id)?.name)}
                  </p>
                  <Json value={selectedTool.input_schema} />
                  {admin && (
                    <div className="split">
                      <label>
                        Risk classification
                        <select
                          value={selectedTool.risk}
                          onChange={(e) => {
                            void mutate(`/api/tools/${selectedTool.id}`, 'PATCH', {
                              risk: e.target.value,
                            });
                            setSelectedTool({ ...selectedTool, risk: e.target.value });
                          }}
                        >
                          {['READ', 'WRITE', 'SENSITIVE', 'CRITICAL'].map((r) => (
                            <option key={r}>{r}</option>
                          ))}
                        </select>
                      </label>
                      <div>
                        <p>Explicit permissions by role</p>
                        {['owner', 'admin', 'developer', 'viewer'].map((role) => (
                          <div className="row" key={role} style={{ marginBottom: 8 }}>
                            {role}
                            <button
                              onClick={() =>
                                void mutate(`/api/tools/${selectedTool.id}/permissions`, 'PUT', {
                                  role,
                                  allowed: true,
                                })
                              }
                            >
                              Allow
                            </button>
                            <button
                              onClick={() =>
                                void mutate(`/api/tools/${selectedTool.id}/permissions`, 'PUT', {
                                  role,
                                  allowed: false,
                                })
                              }
                            >
                              Deny
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <h2 className="spacer">Recent executions</h2>
                  {executions(
                    data.executions.filter((e) => e.tool_name === selectedTool.name).slice(0, 5),
                  )}
                </section>
              )}
              {section === 'mcp-servers' && (
                <>
                  <section className="panel">
                    <h2>OmniMCP gateway</h2>
                    <pre>{gateway}/mcp</pre>
                    <p>
                      Dynamic tool discovery follows organization, connection status, enabled state,
                      and permissions.
                    </p>
                    <Link href="/api-keys">Create a scoped API key →</Link>
                  </section>
                  <div className="grid">
                    {data.servers.map((s) => (
                      <section className="panel" key={text(s.id)}>
                        <Server color="#6ee7b7" />
                        <h2 className="spacer">{text(s.name)}</h2>
                        <p>Upstream MCP connection</p>
                        <Link href="/connections">Manage connection →</Link>
                      </section>
                    ))}
                  </div>
                </>
              )}
              {section === 'approvals' && (
                <>
                  {!admin ? (
                    <Empty>Approval decisions require an administrator.</Empty>
                  ) : data.approvals.length ? (
                    data.approvals.map((a) => (
                      <section className="panel" key={text(a.id)}>
                        <div className="row">
                          <Badge>{a.risk}</Badge>
                          <h2 style={{ margin: 0 }}>{text(a.tool_name)}</h2>
                          <Badge>{a.status}</Badge>
                        </div>
                        <p>
                          {text(a.reason)} · {text(a.connection_name)}
                        </p>
                        <p>
                          Requested {date(a.created_at)} · Expires {date(a.expires_at)}
                        </p>
                        <Json value={{ requester: a.principal, arguments: a.arguments_redacted }} />
                        {a.status === 'pending' && (
                          <div className="row">
                            <button
                              className="primary"
                              disabled={busy}
                              onClick={() =>
                                void mutate(`/api/approvals/${a.id}/decide`, 'POST', {
                                  decision: 'approved',
                                })
                              }
                            >
                              <CheckCheck size={15} style={{ display: 'inline', marginRight: 8 }} />
                              Approve & execute
                            </button>
                            <button
                              disabled={busy}
                              onClick={() =>
                                void mutate(`/api/approvals/${a.id}/decide`, 'POST', {
                                  decision: 'rejected',
                                })
                              }
                            >
                              Reject
                            </button>
                          </div>
                        )}
                      </section>
                    ))
                  ) : (
                    <div className="panel">
                      <Empty>
                        No approval requests. Actions that need a review will appear here.
                      </Empty>
                    </div>
                  )}
                </>
              )}
              {section === 'executions' && (
                <section className="panel">{executions(data.executions)}</section>
              )}
              {detail && (
                <section className="panel">
                  <div className="heading">
                    <h2>Execution timeline</h2>
                    <button onClick={() => setDetail(undefined)}>Close</button>
                  </div>
                  <div className="row">
                    <span className="code">{text(detail.id)}</span>
                    <Badge>{detail.status}</Badge>
                  </div>
                  <Json
                    value={{
                      traceId: detail.trace_id,
                      requestId: detail.request_id,
                      arguments: detail.arguments_redacted,
                      result: detail.result_metadata,
                      error: detail.error_metadata,
                    }}
                  />
                  {((detail.steps as Row[]) ?? []).map((s, i) => (
                    <div className="trace" key={i}>
                      <strong>{text(s.stage).replaceAll('_', ' ')}</strong>
                      <div className="muted">{date(s.created_at)}</div>
                      {Object.keys((s.metadata as Row) ?? {}).length > 0 && (
                        <Json value={s.metadata} />
                      )}
                    </div>
                  ))}
                </section>
              )}
              {section === 'logs' && (
                <section className="panel">
                  <h2>Immutable audit trail</h2>
                  {data.audit.length ? (
                    <table>
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Action</th>
                          <th>Actor</th>
                          <th>Target</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.audit.map((a) => (
                          <tr key={text(a.id)}>
                            <td>{date(a.created_at)}</td>
                            <td>
                              <Badge>{a.action}</Badge>
                            </td>
                            <td className="code">{text(a.actor_id).slice(0, 12)}</td>
                            <td className="code">{text(a.target_id).slice(0, 12)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <Empty>No audit events available.</Empty>
                  )}
                </section>
              )}
              {section === 'playground' && (
                <Playground
                  org={org}
                  naturalLanguage={data.features?.naturalLanguage ?? false}
                  tools={data.tools.filter((t) => t.enabled)}
                  onExecuted={() => void run(load)}
                />
              )}
              {section === 'api-keys' && (
                <>
                  {admin && <KeyForm org={org} tools={data.tools} onDone={() => void run(load)} />}
                  <section className="panel">
                    <h2>Organization API keys</h2>
                    {data.keys.length ? (
                      <table>
                        <thead>
                          <tr>
                            <th>Name</th>
                            <th>Prefix</th>
                            <th>Scopes</th>
                            <th>Last used</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {data.keys.map((k) => (
                            <tr key={text(k.id)}>
                              <td>{text(k.name)}</td>
                              <td className="code">{text(k.prefix)}…</td>
                              <td>{(k.scopes as string[]).length} tools</td>
                              <td>{date(k.last_used_at)}</td>
                              <td>
                                {k.revoked_at ? (
                                  <Badge>Revoked</Badge>
                                ) : (
                                  <button
                                    onClick={() => void mutate(`/api/keys/${k.id}`, 'DELETE')}
                                  >
                                    Revoke
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <Empty>No API keys issued.</Empty>
                    )}
                  </section>
                </>
              )}
              {section === 'organization' && (
                <section className="panel">
                  <h2>{data.organization.name}</h2>
                  <p className="code">Organization ID: {org}</p>
                  <p>Members must have a Supabase account before being added.</p>
                  <table>
                    <thead>
                      <tr>
                        <th>User ID</th>
                        <th>Role</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((m) => (
                        <tr key={text(m.user_id)}>
                          <td className="code">{text(m.user_id)}</td>
                          <td>
                            <Badge>{m.role}</Badge>
                          </td>
                          <td>
                            {data.role === 'owner' && m.role !== 'owner' && (
                              <button
                                onClick={() => void mutate(`/api/members/${m.user_id}`, 'DELETE')}
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.role === 'owner' && (
                    <form
                      className="spacer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate('/api/members', 'POST', {
                          userId: f.get('userId'),
                          role: f.get('role'),
                        });
                      }}
                    >
                      <label>
                        User UUID
                        <input name="userId" required />
                      </label>
                      <label>
                        Role
                        <select name="role">
                          <option>developer</option>
                          <option>admin</option>
                          <option>viewer</option>
                        </select>
                      </label>
                      <button>Add or update member</button>
                    </form>
                  )}
                </section>
              )}
              {section === 'settings' && (
                <>
                  <section className="panel">
                    <h2>Client configuration</h2>
                    <p>
                      Use a dedicated, scoped key for each agent. Pass the bearer token in the
                      Authorization header.
                    </p>
                    <Json
                      value={{
                        mcpServers: {
                          omnimcp: {
                            url: gateway + '/mcp',
                            headers: { Authorization: 'Bearer <your-api-key>' },
                          },
                        },
                      }}
                    />
                    <p>MCP Inspector verification</p>
                    <pre>{`pnpm inspect ${gateway}/mcp --protocol-era modern --method tools/list --header "Authorization: Bearer <your-api-key>"`}</pre>
                  </section>
                  <section className="panel">
                    <h2>Execution policy</h2>
                    {Object.entries(data.policy)
                      .filter(([k]) =>
                        ['allow_write', 'sensitive_approval', 'allow_self_approval'].includes(k),
                      )
                      .map(([k, v]) => (
                        <label className="row" key={k}>
                          <input
                            type="checkbox"
                            style={{ width: 18 }}
                            checked={Boolean(v)}
                            disabled={!admin}
                            onChange={(e) =>
                              void mutate('/api/policy', 'PUT', {
                                allow_write: data.policy.allow_write,
                                sensitive_approval: data.policy.sensitive_approval,
                                allow_self_approval: data.policy.allow_self_approval,
                                [k]: e.target.checked,
                              })
                            }
                          />
                          {k === 'allow_write'
                            ? 'Allow WRITE tools without approval'
                            : k === 'sensitive_approval'
                              ? 'Require approval for SENSITIVE tools'
                              : 'Allow requester to approve their own requests'}
                        </label>
                      ))}
                    <p>
                      CRITICAL tools always require approval. SENSITIVE and CRITICAL tools also need
                      explicit role permission.
                    </p>
                  </section>
                  <section className="panel">
                    <h2>Connector SDK</h2>
                    <p>
                      Integrations are deployed as trusted connector modules. Add modules through
                      the gateway deployment configuration.
                    </p>
                    <pre>{`defineConnector({\n  id: "my-crm", name: "My CRM", version: "1.0.0",\n  tools: [{ namespace: "crm.customer", name: "search",\n    description: "Search customers", risk: "READ",\n    inputSchema: { type: "object", properties: {} },\n    execute: async (args, context) => { /* integration */ }\n  }]\n})`}</pre>
                  </section>
                </>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
function Auth({ error, onError }: { error: string; onError: (s: string) => void }) {
  const [signup, setSignup] = useState(false),
    [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    onError('');
    const f = new FormData(e.currentTarget);
    try {
      const credentials = { email: String(f.get('email')), password: String(f.get('password')) };
      const result = signup
        ? await supabase().auth.signUp(credentials)
        : await supabase().auth.signInWithPassword(credentials);
      if (result.error) throw result.error;
      if (signup && !result.data.session)
        onError('Check your email to confirm your account, then sign in.');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login panel">
      <div className="brand">
        <Network color="#6ee7b7" /> OmniMCP
      </div>
      <h1 className="spacer">{signup ? 'Create your account' : 'Welcome back'}</h1>
      <p>One secure gateway for all your AI tools.</p>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <form onSubmit={submit}>
        <label>
          Email
          <input name="email" type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            minLength={8}
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
          />
        </label>
        <button className="primary" disabled={busy} style={{ width: '100%', marginTop: 12 }}>
          {busy ? 'Connecting…' : signup ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <button className="spacer" onClick={() => setSignup(!signup)}>
        {signup ? 'Already have an account? Sign in' : 'Create an account'}
      </button>
    </main>
  );
}
function ConnectionForm({
  org,
  connectors,
  onDone,
  onError,
}: {
  org: string;
  connectors: { id: string; name: string }[];
  onDone: () => void;
  onError: (s: string) => void;
}) {
  const [type, setType] = useState('demo-crm'),
    [name, setName] = useState(''),
    [url, setUrl] = useState(''),
    [namespace, setNamespace] = useState('company'),
    [secret, setSecret] = useState(''),
    [spec, setSpec] = useState(''),
    [specUrl, setSpecUrl] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <h2>Connect a system</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          onError('');
          let config: Row = {},
            secrets: Record<string, string> = {};
          if (type === 'openapi') {
            config = { baseUrl: url, namespace, ...(spec ? { spec } : { specUrl }) };
            if (secret) secrets = { bearerToken: secret };
          }
          if (type === 'remote-mcp') {
            config = { url, namespace };
            if (secret) secrets = { bearerToken: secret };
          }
          if (type === 'postgres') {
            config = { namespace: 'postgres', tables: [], allowWrites: false };
            secrets = { databaseUrl: secret };
          }
          if (type === 'webhook') {
            config = { namespace, inbound: true, ...(url ? { url } : {}) };
            secrets = { signingSecret: secret };
          }
          void api(org, '/api/connections', 'POST', { name, connectorId: type, config, secrets })
            .then(() => {
              setSecret('');
              onDone();
            })
            .catch((e) => onError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <div className="split">
          <Field name="Connection name" value={name} onChange={setName} />
          <label>
            Connector
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setSecret('');
              }}
            >
              {connectors.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {['openapi', 'remote-mcp', 'webhook'].includes(type) && (
          <div className="split">
            <label>
              {type === 'webhook' ? 'Outbound URL (optional)' : 'Base / server URL'}
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required={type !== 'webhook'}
                placeholder="https://api.example.com"
              />
            </label>
            <Field name="Namespace" value={namespace} onChange={setNamespace} />
          </div>
        )}
        {type === 'openapi' && (
          <>
            <label>
              OpenAPI document URL (or upload / paste below)
              <input type="url" value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} />
            </label>
            <label>
              Upload OpenAPI JSON or YAML
              <input
                type="file"
                accept=".json,.yaml,.yml"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    if (file.size > 750000) {
                      onError('Maximum specification size is 750 KB');
                      return;
                    }
                    void file.text().then(setSpec);
                  }
                }}
              />
            </label>
            <label>
              OpenAPI specification
              <textarea
                rows={7}
                value={spec}
                onChange={(e) => setSpec(e.target.value)}
                placeholder="Paste your OpenAPI 3.0 or 3.1 document"
              />
            </label>
          </>
        )}
        {type !== 'demo-crm' && (
          <label>
            {type === 'postgres'
              ? 'PostgreSQL connection URL'
              : type === 'webhook'
                ? 'Signing secret (32+ characters)'
                : 'Bearer token (optional)'}
            <input
              type="password"
              autoComplete="new-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required={['postgres', 'webhook'].includes(type)}
            />
            <small className="muted">Encrypted at rest. Stored secrets are never returned.</small>
          </label>
        )}
        {type === 'demo-crm' && (
          <p>
            The demo connector uses sample customers in your organization. After connecting,
            discover and select its tools.
          </p>
        )}
        <button className="primary" disabled={busy}>
          Save connection
        </button>
      </form>
    </section>
  );
}
function Playground({
  org,
  tools,
  onExecuted,
  naturalLanguage,
}: {
  org: string;
  tools: Tool[];
  onExecuted: () => void;
  naturalLanguage: boolean;
}) {
  const [name, setName] = useState(''),
    [args, setArgs] = useState('{}'),
    [result, setResult] = useState<unknown>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const selected = tools.find((t) => t.name === name);
  return (
    <div className="split">
      <section className="panel">
        <h2 className="row">
          <Code2 size={20} /> Tool Playground
        </h2>
        <p>Invoke a tool through the same gateway and policies used by AI clients.</p>
        {naturalLanguage && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              const prompt = String(new FormData(e.currentTarget).get('prompt'));
              void api<{ name: string; arguments: Row }>(org, '/api/assist', 'POST', { prompt })
                .then((proposal) => {
                  setName(proposal.name);
                  setArgs(JSON.stringify(proposal.arguments, null, 2));
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <label>
              Describe your task
              <input
                name="prompt"
                required
                maxLength={2000}
                placeholder="Find a customer named Ada"
              />
            </label>
            <button disabled={busy}>Suggest a tool</button>
            <p>Review the proposed arguments, then invoke the tool below.</p>
          </form>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            setResult(undefined);
            void Promise.resolve()
              .then(() => api(org, '/api/invoke', 'POST', { name, arguments: JSON.parse(args) }))
              .then((v) => {
                setResult(v);
                onExecuted();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Tool
            <select
              aria-label="Tool"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            >
              <option value="">Select a tool</option>
              {tools.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <>
              <p>{selected.description}</p>
              <Badge>{selected.risk}</Badge>
              <details className="spacer">
                <summary>Input schema</summary>
                <Json value={selected.input_schema} />
              </details>
            </>
          )}
          <label>
            Arguments (JSON)
            <textarea
              rows={9}
              className="code"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </label>
          <button className="primary row" disabled={busy || !name}>
            <Zap size={16} />
            {busy ? 'Executing…' : 'Invoke tool'}
          </button>
        </form>
        {error && (
          <div className="error spacer" role="alert">
            {error}
          </div>
        )}
      </section>
      <section className="panel">
        <h2>Result & execution</h2>
        {result ? (
          <Json value={result} />
        ) : (
          <Empty>
            Select a tool and send a request. Results, duration, and approval status appear here.
          </Empty>
        )}
        <p>
          Pending requests can be reviewed in Approvals. The execution ID links the request to its
          trace.
        </p>
        <Link href="/executions">View execution traces →</Link>
      </section>
    </div>
  );
}
function KeyForm({ org, tools, onDone }: { org: string; tools: Tool[]; onDone: () => void }) {
  const [scopes, setScopes] = useState<string[]>([]),
    [key, setKey] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <h2>Issue a scoped key</h2>
      {key ? (
        <div>
          <p>Copy this key now. It will not be shown again after you leave this page.</p>
          <pre>{key}</pre>
          <button onClick={() => void navigator.clipboard.writeText(key)}>Copy key</button>
          <button onClick={() => setKey('')}>Dismiss</button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            const f = new FormData(e.currentTarget);
            void api<{ key: string }>(org, '/api/keys', 'POST', {
              name: f.get('name'),
              scopes,
              role: 'developer',
            })
              .then((v) => {
                setKey(v.key);
                onDone();
              })
              .catch((e) => setError(e.message))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Key name
            <input name="name" required placeholder="Research agent" />
          </label>
          <p>Allowed tools</p>
          {tools.map((t) => (
            <label className="row" key={t.id}>
              <input
                style={{ width: 18 }}
                type="checkbox"
                checked={scopes.includes(t.name)}
                onChange={(e) =>
                  setScopes(
                    e.target.checked ? [...scopes, t.name] : scopes.filter((s) => s !== t.name),
                  )
                }
              />
              <span className="code">{t.name}</span>
              <Badge>{t.risk}</Badge>
            </label>
          ))}
          <button className="primary" disabled={busy || !scopes.length}>
            Create API key
          </button>
        </form>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
        </div>
      )}
    </section>
  );
}
