-- Buyer listing text and screenshots invalidate capture as well as downstream stages.
-- Keep the existing cumulative submission transaction and all of its ownership fences.
do $$
declare
  v_definition text;
  v_old text := 'where stage not in (''normalize_identity'', ''baseline_checks'', ''research'', ''enrich'', ''assemble_report'')';
begin
  select pg_get_functiondef('public.accept_analysis_submission_group(uuid,uuid,jsonb,text[])'::regprocedure) into v_definition;
  if position(v_old in v_definition) = 0 then
    raise exception 'Unexpected submission stage validation definition';
  end if;
  execute replace(v_definition, v_old, 'where stage not in (''capture_listing'', ''normalize_identity'', ''baseline_checks'', ''research'', ''enrich'', ''assemble_report'')');
end;
$$;
