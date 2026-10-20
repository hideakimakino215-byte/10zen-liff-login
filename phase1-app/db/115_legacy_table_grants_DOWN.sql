-- 115 の戻し: 旧システムの表に、anon / authenticated の権限を元どおり(全部)付け直す。
begin;
do $g$
declare t text;
begin
  foreach t in array array['customers','interactions','stores'] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant all on table public.%I to anon, authenticated', t);
    end if;
  end loop;
end $g$;
commit;
