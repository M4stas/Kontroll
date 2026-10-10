-- Stop timing collectors first. Preserve collected telemetry and all existing application data.
-- The previous application ignores the additive, service-only table.
drop function if exists public.record_photo_timing_spans(uuid,uuid,uuid,text,integer,jsonb);
revoke all on public.diagnostic_photo_spans from public,anon,authenticated;
