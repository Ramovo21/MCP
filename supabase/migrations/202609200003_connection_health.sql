alter table public.connections add column health_status text not null default 'unknown'
  check (health_status in ('unknown','healthy','failed'));
alter table public.connections add column health_checked_at timestamptz;
