alter table public.executions add column worker_claimed_at timestamptz;
alter table public.executions add column trace_id text not null default replace(gen_random_uuid()::text,'-','');
create index on public.executions(organization_id,trace_id);
create table public.oauth_states(organization_id uuid not null, connection_id uuid not null, state_hash text primary key, user_id uuid not null references auth.users(id), provider_id text not null, payload_encrypted text not null, expires_at timestamptz not null default now()+interval '10 minutes', foreign key(organization_id,connection_id) references public.connections(organization_id,id));
create table public.oauth_tokens(organization_id uuid not null, connection_id uuid not null, provider_id text not null, ciphertext text not null, expires_at timestamptz not null, scopes text[] not null, status text not null default 'active' check(status in ('active','reauth_required','revoked')), primary key(organization_id,connection_id), foreign key(organization_id,connection_id) references public.connections(organization_id,id));
do $$ declare t text; begin
 foreach t in array array['oauth_states','oauth_tokens'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy gateway_tenant on public.%I to omnimcp_gateway using(organization_id=public.gateway_org()) with check(organization_id=public.gateway_org())',t);
  execute format('grant select,insert,update,delete on public.%I to omnimcp_gateway',t);
 end loop;
end $$;
