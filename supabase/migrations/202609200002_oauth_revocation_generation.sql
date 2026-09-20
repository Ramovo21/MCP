-- A callback begun before revocation cannot reconnect a revoked authorization afterward.
alter table public.connections add column oauth_generation integer not null default 0;
