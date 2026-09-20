alter table public.executions add column parent_span_id text;
alter table public.executions add constraint valid_parent_span_id
  check (parent_span_id is null or parent_span_id ~ '^[a-f0-9]{16}$');
