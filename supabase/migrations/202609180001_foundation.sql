-- All tenant foreign keys are composite: cross-organization references are impossible.
create type public.risk_level as enum ('READ','WRITE','SENSITIVE','CRITICAL');
create type public.member_role as enum ('owner','admin','developer','viewer');
create table public.organizations(id uuid primary key default gen_random_uuid(), name text not null check(length(name) between 1 and 120), created_at timestamptz not null default now());
create table public.profiles(id uuid primary key references auth.users(id) on delete cascade, display_name text not null default '', created_at timestamptz not null default now());
create table public.organization_members(organization_id uuid not null references public.organizations(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade, role public.member_role not null default 'viewer', primary key(organization_id,user_id));
create table public.connector_definitions(id text primary key, name text not null, version text not null);
create table public.connections(id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, connector_id text not null references public.connector_definitions(id), status text not null default 'active' check(status in ('active','disabled','revoked')), config jsonb not null default '{}', created_at timestamptz not null default now(), unique(organization_id,id));
create table public.connection_secrets(organization_id uuid not null, connection_id uuid not null, ciphertext text not null, primary key(organization_id,connection_id), foreign key(organization_id,connection_id) references public.connections(organization_id,id) on delete cascade);
create table public.mcp_servers(id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, connection_id uuid, created_at timestamptz not null default now(), foreign key(organization_id,connection_id) references public.connections(organization_id,id));
create table public.tools(id uuid primary key default gen_random_uuid(), organization_id uuid not null, connection_id uuid not null, name text not null check(name ~ '^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)+$'), description text not null, input_schema jsonb not null, risk public.risk_level not null, baseline_risk public.risk_level not null, enabled boolean not null default false, config jsonb not null default '{}', created_at timestamptz not null default now(), unique(organization_id,id), unique(organization_id,name), foreign key(organization_id,connection_id) references public.connections(organization_id,id));
create table public.tool_permissions(organization_id uuid not null, tool_id uuid not null, role public.member_role not null, allowed boolean not null, primary key(organization_id,tool_id,role), foreign key(organization_id,tool_id) references public.tools(organization_id,id));
create table public.approval_policies(organization_id uuid primary key references public.organizations(id), allow_write boolean not null default false, sensitive_approval boolean not null default true, allow_self_approval boolean not null default false, updated_at timestamptz not null default now());
create table public.api_keys(id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, prefix text not null, key_hash text not null unique, scopes text[] not null default '{}', role public.member_role not null default 'developer' check(role in ('developer','viewer')), created_by uuid not null references auth.users(id), created_at timestamptz not null default now(), last_used_at timestamptz, revoked_at timestamptz, unique(organization_id,id));
create table public.executions(id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), request_id uuid not null, user_id uuid references auth.users(id), api_key_id uuid, tool_id uuid, tool_name text not null, connector_id text, principal jsonb not null, arguments_redacted jsonb not null, arguments_encrypted text, request_hash text not null, idempotency_key text not null, status text not null check(status in ('pending','running','succeeded','failed','rejected','denied','expired','unknown')), result_metadata jsonb, error_metadata jsonb, started_at timestamptz not null default now(), finished_at timestamptz, duration_ms integer, unique(organization_id,id), unique(organization_id,idempotency_key), foreign key(organization_id,tool_id) references public.tools(organization_id,id), foreign key(organization_id,api_key_id) references public.api_keys(organization_id,id));
create table public.approval_requests(id uuid primary key default gen_random_uuid(), organization_id uuid not null, execution_id uuid not null, risk public.risk_level not null, reason text not null, status text not null default 'pending' check(status in ('pending','approved','rejected','expired')), requested_by uuid references auth.users(id), decided_by uuid references auth.users(id), created_at timestamptz not null default now(), decided_at timestamptz, expires_at timestamptz not null default now()+interval '24 hours', unique(organization_id,execution_id), foreign key(organization_id,execution_id) references public.executions(organization_id,id));
create table public.execution_steps(id bigint generated always as identity primary key, organization_id uuid not null, execution_id uuid not null, stage text not null, metadata jsonb not null default '{}', created_at timestamptz not null default now(), foreign key(organization_id,execution_id) references public.executions(organization_id,id));
create table public.audit_logs(id bigint generated always as identity primary key, organization_id uuid not null references public.organizations(id), actor_id text not null, action text not null, target_id text, metadata jsonb not null default '{}', created_at timestamptz not null default now());
create table public.webhook_events(id uuid primary key default gen_random_uuid(), organization_id uuid not null, connection_id uuid not null, event_hash text not null, payload_encrypted text not null, received_at timestamptz not null default now(), unique(organization_id,connection_id,event_hash), foreign key(organization_id,connection_id) references public.connections(organization_id,id));
create table public.rate_limit_buckets(bucket text primary key, count integer not null, window_start timestamptz not null);
create table public.demo_customers(id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id), name text not null, email text not null, company text not null, unique(organization_id,id));
create table public.demo_notes(id uuid primary key default gen_random_uuid(), organization_id uuid not null, customer_id uuid not null, body text not null, execution_id uuid not null, created_at timestamptz not null default now(), unique(organization_id,execution_id), foreign key(organization_id,customer_id) references public.demo_customers(organization_id,id), foreign key(organization_id,execution_id) references public.executions(organization_id,id));
create index on public.executions(organization_id,started_at desc);
create index on public.approval_requests(organization_id,status);
create index on public.audit_logs(organization_id,created_at desc);
create index on public.organization_members(user_id);

-- Gateway role can only access the organization set by its verified request transaction.
do $$ begin if not exists(select from pg_roles where rolname='omnimcp_gateway') then create role omnimcp_gateway nologin nobypassrls; end if; end $$;
grant omnimcp_gateway to postgres;
grant usage on schema public to omnimcp_gateway;
grant usage on type public.risk_level,public.member_role to omnimcp_gateway;
create function public.gateway_org() returns uuid language sql stable as $$ select nullif(current_setting('app.organization_id',true),'')::uuid $$;
create function public.is_org_member(org uuid) returns boolean language sql stable security definer set search_path='' as $$ select exists(select 1 from public.organization_members where organization_id=org and user_id=auth.uid()) $$;
revoke all on function public.is_org_member(uuid) from public;
grant execute on function public.is_org_member(uuid) to authenticated;

do $$ declare t text; begin
 foreach t in array array['connections','connection_secrets','mcp_servers','tools','tool_permissions','approval_policies','api_keys','executions','approval_requests','execution_steps','audit_logs','webhook_events','demo_customers','demo_notes'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy gateway_tenant on public.%I to omnimcp_gateway using(organization_id=public.gateway_org()) with check(organization_id=public.gateway_org())',t);
  execute format('grant select,insert,update,delete on public.%I to omnimcp_gateway',t);
  -- Browser access is read-only and excludes secrets, arguments ciphertext and key hashes.
  if t in ('connections','mcp_servers','tools','tool_permissions','approval_policies','approval_requests','execution_steps','audit_logs') then
   execute format('create policy member_read on public.%I for select to authenticated using(public.is_org_member(organization_id))',t);
   execute format('grant select on public.%I to authenticated',t);
  end if;
 end loop;
end $$;
revoke update,delete on public.audit_logs from omnimcp_gateway;
grant usage,select on all sequences in schema public to omnimcp_gateway;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.profiles enable row level security;
alter table public.connector_definitions enable row level security;
alter table public.rate_limit_buckets enable row level security;
create policy own_orgs on public.organizations for select to authenticated using(public.is_org_member(id));
create policy own_members on public.organization_members for select to authenticated using(public.is_org_member(organization_id));
create policy own_profile on public.profiles for select to authenticated using(id=auth.uid());
create policy connector_read on public.connector_definitions for select to authenticated,omnimcp_gateway using(true);
create policy gateway_orgs on public.organizations to omnimcp_gateway using(id=public.gateway_org()) with check(id=public.gateway_org());
create policy gateway_members on public.organization_members to omnimcp_gateway using(organization_id=public.gateway_org()) with check(organization_id=public.gateway_org());
grant select on public.organizations,public.organization_members,public.profiles,public.connector_definitions to authenticated;
grant select,update on public.organizations to omnimcp_gateway;
grant select,insert,update,delete on public.organization_members to omnimcp_gateway;
grant select on public.connector_definitions to omnimcp_gateway;

create function public.create_organization(org_name text) returns uuid language plpgsql security definer set search_path='' as $$
declare org uuid; begin
 if auth.uid() is null then raise exception 'Authentication required'; end if;
 insert into public.organizations(name) values(org_name) returning id into org;
 insert into public.organization_members values(org,auth.uid(),'owner');
 insert into public.approval_policies(organization_id) values(org);
 insert into public.profiles(id) values(auth.uid()) on conflict do nothing;
 return org;
end $$;
revoke all on function public.create_organization(text) from public;
grant execute on function public.create_organization(text) to authenticated;
insert into public.connector_definitions values ('demo-crm','Demo CRM','1.0.0'),('openapi','OpenAPI / REST','1.0.0'),('postgres','PostgreSQL','1.0.0'),('remote-mcp','Remote MCP','1.0.0'),('webhook','Webhook','1.0.0');
