// 実 PostgreSQL に対する supabase-js 互換の最小アダプター(rpc / from().select().eq().maybeSingle() / auth.getUser のスタブ)。
// 各 rpc は別プロセス(=別接続)・service_role で実行する。本番には接続しない。
import { q } from "./pgdb.mjs";

export function rpcOver(pg, opts = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push(name);
      if (opts.failRpc && opts.failRpc(name)) return { data: null, error: { message: "injected failure" } };
      // 配列は PostgreSQL の配列の書き方({…})で渡す(PostgREST が JSON の配列を integer[] などへ変換するのと同じ)
      const lit = (v) => (Array.isArray(v) ? `{${v.map((x) => (x === null ? "NULL" : `"${String(x).replace(/["\\]/g, "\\$&")}"`)).join(",")}}` : typeof v === "object" ? JSON.stringify(v) : v);
      const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(lit(v))}`).join(", ");
      const r = await pg.runAsync(`set role service_role;\nselect public.${name}(${named});`);
      if (r.status !== 0) return { data: null, error: { message: r.stderr } };
      return { data: JSON.parse(r.stdout), error: null };
    },
    // 読み取りだけの最小版: from(表).select(列).eq(列, 値).order(列, { ascending }).limit(n) を await すると { data: 行の配列 }。表・列名はテストのコードからだけ渡す
    from(table) {
      const where = [], st = { cols: "*", order: "", limit: "" }, ident = (x) => { if (!/^[a-z_][a-z0-9_]*$/.test(x)) throw new Error("bad identifier " + x); return x; };
      const b = {
        select: (c) => { st.cols = c.split(",").map((x) => ident(x.trim())).join(", "); return b; },
        eq: (c, v) => { where.push(`${ident(c)} = ${q(typeof v === "boolean" ? String(v) : v)}`); return b; },
        order: (c, o = {}) => { st.order = ` order by ${ident(c)} ${o.ascending === false ? "desc" : "asc"}`; return b; },
        limit: (k) => { st.limit = ` limit ${Number(k) | 0}`; return b; },
        then: (res, rej) => (async () => {
          calls.push("from:" + table);
          if (opts.failRpc && opts.failRpc("from:" + table)) return { data: null, error: { message: "injected failure" } };
          const r = await pg.runAsync(`set role service_role;\nselect coalesce(json_agg(t), '[]') from (select ${st.cols} from public.${ident(table)}${where.length ? " where " + where.join(" and ") : ""}${st.order}${st.limit}) t;`);
          if (r.status !== 0) return { data: null, error: { message: r.stderr } };
          return { data: JSON.parse(r.stdout), error: null };
        })().then(res, rej),
      };
      return b;
    },
  };
}
