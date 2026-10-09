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
      const named = Object.entries(args).map(([k, v]) => `${k} => ${v === null || v === undefined ? "null" : q(typeof v === "object" ? JSON.stringify(v) : v)}`).join(", ");
      const r = await pg.runAsync(`set role service_role;\nselect public.${name}(${named});`);
      if (r.status !== 0) return { data: null, error: { message: r.stderr } };
      return { data: JSON.parse(r.stdout), error: null };
    },
  };
}
