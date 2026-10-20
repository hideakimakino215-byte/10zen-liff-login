#!/usr/bin/env node
// 本番の DB に SQL ファイルを「中身と結果を確かめてから」入れるための SQL を作る。
// 送る SQL が大きいと、管理ツール(MCP など)の通信が途中で切れる。そこで DB 自身に公開リポジトリの
// 「固定したコミット」のファイルを取得させ(pg_net)、手元と同じ中身(md5)のときだけ実行し、
// 実行後の「指紋」(関数の定義と権限・表の列と権限・RLS の方針・トリガー)が手元の使い捨て DB と同じときだけ確定する。
// どれかが違えば、1つの取引の中なので全部取り消される。
//
// 使い方:
//   1) 指紋を取る SQL(手元の使い捨て DB と本番の両方で同じものを流す)
//      node make_apply_sql.mjs fp-query [--functions a,b,c] [--tables x,y] [--exclude-tables customers]
//   2) 取得の SQL(本番で1回流し、返ってきた id を控える)
//      node make_apply_sql.mjs fetch --url https://raw.githubusercontent.com/<owner>/<repo>/<コミット>/<path>.sql
//   3) 適用の SQL(本番で流す)
//      node make_apply_sql.mjs apply --file db/115_x.sql --resp-id 219 --fp <手元で入れたあとの指紋> \
//        --version 20261101100000 --name x_115 [--functions …] [--tables …] [--exclude-tables …]
//
// 指紋の対象: --functions / --tables を渡せばその名前だけ。渡さなければ public の全部(--exclude-tables で除く)。
// 本番にだけある表(旧システムの表など)は除くか、対象を名前で絞る。
import fs from "node:fs";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const [, , cmd, ...rest] = process.argv;
const arg = (k) => { const i = rest.indexOf("--" + k); return i >= 0 ? rest[i + 1] : undefined; };
const list = (k) => (arg(k) ? arg(k).split(",").map((s) => s.trim()).filter(Boolean) : null);
const sqlArr = (xs) => "array[" + xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(",") + "]";

export function fpQuery({ functions = null, tables = null, excludeTables = [] } = {}) {
  const fnWhere = functions ? `and p.proname = any(${sqlArr(functions)})` : "and p.prokind = 'f'";
  const tbWhere = tables ? `and c.relname = any(${sqlArr(tables)})` : excludeTables.length ? `and not (c.relname = any(${sqlArr(excludeTables)}))` : "";
  const tbWhere2 = tables ? `and tablename = any(${sqlArr(tables)})` : excludeTables.length ? `and not (tablename = any(${sqlArr(excludeTables)}))` : "";
  return `with f as (select p.oid::regprocedure::text || chr(32) || left(md5(pg_get_functiondef(p.oid)),10) || chr(32) ||
  has_function_privilege('anon',p.oid,'execute')::int || has_function_privilege('authenticated',p.oid,'execute')::int || has_function_privilege('service_role',p.oid,'execute')::int as x
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' ${fnWhere}),
tb as (select c.relname || chr(32) || c.relrowsecurity::int || chr(32) ||
  left(md5((select string_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::int||':'||coalesce(pg_get_expr(d.adbin,d.adrelid),''), ',' order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped)),10) || chr(32) ||
  (select string_agg(r||':'||has_table_privilege(r,c.oid,'select')::int||has_table_privilege(r,c.oid,'insert')::int||has_table_privilege(r,c.oid,'update')::int||has_table_privilege(r,c.oid,'delete')::int, ',' order by r) from unnest(array['anon','authenticated','service_role']) r) as x
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','v','m') ${tbWhere}),
po as (select tablename||'.'||policyname||chr(32)||left(md5(coalesce(qual,'')||'|'||coalesce(with_check,'')||'|'||cmd||'|'||roles::text),10) as x from pg_policies where schemaname='public' ${tbWhere2}),
tr as (select c.relname||'.'||t.tgname as x from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal ${tbWhere})
select md5('## functions'||chr(10)||coalesce((select string_agg(x,chr(10) order by x) from f),'')||chr(10)||'## tables'||chr(10)||coalesce((select string_agg(x,chr(10) order by x) from tb),'')||chr(10)||'## policies'||chr(10)||coalesce((select string_agg(x,chr(10) order by x) from po),'')||chr(10)||'## triggers'||chr(10)||coalesce((select string_agg(x,chr(10) order by x) from tr),'')) as fingerprint`;
}

// ファイルの先頭・末尾の begin; / commit; を外した中身(DO ブロックの中で実行するため)と、その md5
export function stripTx(content) { return content.replace(/^(begin|commit);\n/gm, ""); }

export function applySql({ content, respId, fp, version, name, functions, tables, excludeTables = [] }) {
  if (!/^\d+$/.test(String(respId))) throw new Error("--resp-id は数字");
  if (!/^[0-9a-f]{32}$/.test(fp || "")) throw new Error("--fp は手元で取った32文字の指紋");
  if (!/^\d{14}$/.test(version || "")) throw new Error("--version は14桁(例 20261101100000)");
  if (!/^[a-z0-9_]+$/.test(name || "")) throw new Error("--name は英小文字・数字・_");
  const body = stripTx(content);
  const md5 = crypto.createHash("md5").update(body).digest("hex");
  const q = fpQuery({ functions, tables, excludeTables }).replace(/ as fingerprint$/, "");
  return `do $m$
declare s text; h text;
begin
  select regexp_replace(content, '^(begin|commit);\\n', '', 'gn') into s from net._http_response where id = ${respId} and status_code = 200;
  if s is null or md5(s) <> '${md5}' then raise exception 'checksum_mismatch_${name}'; end if;
  execute s;
  ${q} into h;
  if h <> '${fp}' then raise exception 'fingerprint_mismatch_${name}: %', h; end if;
  insert into supabase_migrations.schema_migrations(version, name, statements) values ('${version}', '${name}', array[s]);
end $m$;
select 'ok_${name}' as result;`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMain) { /* import されたときは何もしない */ }
else if (cmd === "fp-query") {
  console.log(fpQuery({ functions: list("functions"), tables: list("tables"), excludeTables: list("exclude-tables") || [] }) + ";");
} else if (cmd === "fetch") {
  const url = arg("url");
  if (!/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{7,40}\/.+\.sql$/.test(url || "")) throw new Error("--url は固定したコミット(ハッシュ)の raw URL にする(ブランチ名は不可: 中身が変わるため)");
  console.log(`select net.http_get('${url}') as request_id;  -- 数秒後に: select id, status_code, length(content) from net._http_response order by id desc limit 3;`);
} else if (cmd === "apply") {
  const content = fs.readFileSync(arg("file"), "utf8");
  console.log(applySql({ content, respId: arg("resp-id"), fp: arg("fp"), version: arg("version"), name: arg("name"),
    functions: list("functions"), tables: list("tables"), excludeTables: list("exclude-tables") || [] }));
} else {
  console.error("使い方: make_apply_sql.mjs fp-query | fetch --url … | apply --file … --resp-id … --fp … --version … --name …");
  process.exit(1);
}
