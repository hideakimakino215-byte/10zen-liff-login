-- 100_phase1_schema.sql(本番適用済み)で search_path を固定していなかった補助関数4つに、固定を追加する。
-- 対象は 100 で作った新しい関数だけ。既存の関数・表には触れない。動作は変わらない(関数の本文は変更しない)。
begin;
alter function public._effective_lifetime(public.members) set search_path = public;
alter function public._jst_date(timestamptz)              set search_path = public;
alter function public.next_member_no()                    set search_path = public;
alter function public.next_test_member_no()               set search_path = public;
commit;
