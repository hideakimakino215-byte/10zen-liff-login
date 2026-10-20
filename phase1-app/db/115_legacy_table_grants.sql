-- 115: 旧システムの表(customers・interactions・stores)から、ログインなしの利用者(anon)とログインした利用者(authenticated)の権限を外す。
--  なぜ: 3つとも anon / authenticated に全部の権限(読む・書く・消す・TRUNCATE など)が付いていた。行ごとのルール(RLS)が有効で許可のルールが0なので、
--        今は誰も読み書きできないが、だれかが許可のルールを1つ足すと外から読めるようになる。TRUNCATE(表を空にする)は RLS の対象外。
--  影響がない理由(2026-10-20 本番を読み取りで確認): この3つの表を使う関数はすべて SECURITY DEFINER(持ち主の権限で動く)で、
--        一覧(ビュー)も持ち主の権限で動く(security_invoker なし)。旧システム(GAS・Edge Function)は service_role を使い、service_role の権限は変えない。
--  手元のテスト用 DB には customers だけがあるので、ない表は飛ばす。
begin;
do $g$
declare t text;
begin
  foreach t in array array['customers','interactions','stores'] loop
    if to_regclass('public.' || t) is not null then
      execute format('revoke all on table public.%I from public, anon, authenticated', t);
    end if;
  end loop;
end $g$;
commit;
