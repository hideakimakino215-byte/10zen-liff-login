-- 101_search_path_fix.sql の取り消し(固定を外して 100 適用直後の状態に戻す)。
begin;
alter function public._effective_lifetime(public.members) reset search_path;
alter function public._jst_date(timestamptz)              reset search_path;
alter function public.next_member_no()                    reset search_path;
alter function public.next_test_member_no()               reset search_path;
commit;
