-- Management/discovery data goes through permission-aware Gateway routes.
-- The browser still reads organizations for the organization switcher.
-- An authenticated user's direct PostgREST request must not bypass tool permission filtering.
do $$ declare t text; begin
 foreach t in array array['connections','mcp_servers','tools','tool_permissions','approval_policies','approval_requests','execution_steps','audit_logs'] loop
  execute format('drop policy if exists member_read on public.%I',t);
 end loop;
end $$;
