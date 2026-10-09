// 並列実行の検証用ワーカー: GAS のスクリプトプロパティとロックを、共有メモリ+Atomics で模す(実際の Apps Script の排他は実機で未確認)。
import { workerData, parentPort } from "node:worker_threads";
import vm from "node:vm";
import fs from "node:fs";
const { src, store, lockBuf, counter, delayMs } = workerData;
const last = new Float64Array(store), lock = new Int32Array(lockBuf), cnt = new Int32Array(counter);
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const ctx = vm.createContext({ Date, Number, String, console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: () => { const v = last[0]; sleepMs(delayMs); return v ? String(v) : null; }, setProperty: (_k, v) => { last[0] = Number(v); } }) },   // 読み取りに遅延を入れて競合を起こしやすくする
  LockService: { getScriptLock: () => ({
    tryLock: (ms) => { const end = Date.now() + ms; while (Atomics.compareExchange(lock, 0, 0, 1) !== 0) { if (Date.now() > end) return false; Atomics.wait(lock, 0, 1, 5); } return true; },
    releaseLock: () => { Atomics.store(lock, 0, 0); Atomics.notify(lock, 0); } }) } });
vm.runInContext(src, ctx);
vm.runInContext("dailyBackup_ = function () { return { ok: true, ran: true }; }", ctx);
const r = vm.runInContext("dailyBackup()", ctx);
if (r.ran) Atomics.add(cnt, 0, 1);
parentPort.postMessage(r);
