// テスト用の使い捨て PostgreSQL(patches/pgdb.mjs)の後片付けとポートを確かめる(監査 AUDIT_20261015.md の L-6)。本番には接続しない。
//   stop() でディレクトリまで消える・stop() を呼ばずに終わっても(例外・SIGTERM)消える・同じプロセスで2つ同時に動かしてもぶつからない。
// 実行: node --experimental-strip-types test_pgdb.mjs
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { startPg } from "./pgdb.mjs";

let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const PGDB = new URL("./pgdb.mjs", import.meta.url).href;
const running = (base) => spawnSync("bash", ["-c", `ps -eo args | grep -F -- '-D ${base}/data' | grep -v grep | wc -l`], { encoding: "utf8" }).stdout.trim();

// ---- 1. 2つ同時に起動(別のポート・別のディレクトリ)→ stop() でサーバーもディレクトリも消える。stop() は2回呼んでもよい ----
{ const a = startPg(), b = startPg();
  try {
    assert.notEqual(a.port, b.port); assert.notEqual(a.base, b.base);
    assert.equal(a.exec("select 1;"), "1"); assert.equal(b.exec("select 2;"), "2");
    a.exec("create table x(v int); insert into x values (1);"); assert.equal(b.exec("select to_regclass('x') is null;"), "t");   // 別のサーバー
    if (process.env.PGT_RUN_ID) assert.match(a.base, new RegExp(`pgt-${process.env.PGT_RUN_ID}-`));
  } finally { a.stop(); }
  assert.equal(existsSync(a.base), false); assert.equal(running(a.base), "0");
  assert.equal(b.exec("select 3;"), "3");                                                     // もう一方は動いたまま
  b.stop(); b.stop(); assert.equal(existsSync(b.base), false); assert.equal(running(b.base), "0"); }
ok("同じプロセスで2つ同時に起動できる(別のポート・別のディレクトリ・別のサーバー)。stop() でサーバーが止まり、作業用のディレクトリ(pgt-*)も消える。2回呼んでも問題ない");

// ---- 2. stop() を呼ばずに例外で終わった子プロセス → 終了時のフックで消える ----
{ const code = `import { startPg } from ${JSON.stringify(PGDB)}; const pg = startPg(); console.log(pg.base); pg.exec("select 1;"); throw new Error("boom");`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", env: process.env });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /boom/);
  const base = r.stdout.trim().split("\n")[0]; assert.match(base, /pgt-/);
  assert.equal(existsSync(base), false); assert.equal(running(base), "0"); }
ok("stop() を呼ばずに例外で終わっても、終了時のフックでサーバーを止めてディレクトリを消す");

// ---- 3. 動いている途中で SIGTERM を受けた子プロセス → 消える ----
{ const code = `import { startPg } from ${JSON.stringify(PGDB)}; const pg = startPg(); console.log(pg.base); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: process.env });
  const base = await new Promise((res, rej) => { let out = ""; child.stdout.on("data", (d) => { out += d; if (out.includes("\n")) res(out.trim().split("\n")[0]); }); child.on("exit", () => rej(new Error("exited early"))); });
  assert.ok(existsSync(base)); assert.equal(running(base), "1");
  const exit = new Promise((res) => child.on("exit", (code, sig) => res({ code, sig })));
  child.kill("SIGTERM"); const e = await exit;
  assert.equal(e.code, 143);
  assert.equal(existsSync(base), false); assert.equal(running(base), "0"); }
ok("SIGTERM(Ctrl-C の SIGINT も同じ)で止められても、サーバーを止めてディレクトリを消してから終わる(終了コード 128+シグナル)");

console.log(`\n${n} pgdb harness tests passed`);
