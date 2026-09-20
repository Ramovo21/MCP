alter table public.oauth_tokens drop constraint oauth_tokens_status_check;
alter table public.oauth_tokens add constraint oauth_tokens_status_check check(status in ('active','refreshing','reauth_required','revoked'));
