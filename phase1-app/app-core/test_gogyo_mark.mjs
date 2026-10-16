// 五行の図(app-core/gogyo-mark.mjs)。実行: node app-core/test_gogyo_mark.mjs
import assert from "node:assert/strict";
import { gogyoPoints, KOKU_PAIRS } from "./gogyo-mark.mjs";
import { ELEMENTS } from "./constitution.mjs";
let n = 0; const ok = (m) => console.log(`ok - ${++n} ${m}`);
const P = gogyoPoints();
assert.deepEqual(P.wood, [100, 30]); assert.ok(P.fire[0] > 100 && P.fire[1] < 100); assert.ok(P.earth[0] > 100 && P.earth[1] > 100);
assert.ok(P.metal[0] < 100 && P.metal[1] > 100); assert.ok(P.water[0] < 100 && P.water[1] < 100);
for (const e of ELEMENTS) assert.ok(Math.abs(Math.hypot(P[e][0] - 100, P[e][1] - 100) - 70) < 0.2, e);
ok("五行の並び: 上=木・右上=火・右下=土・左下=金・左上=水(中心から同じ距離)");
const idx = (e) => ELEMENTS.indexOf(e);
for (const [a, b] of KOKU_PAIRS) assert.equal((idx(b) - idx(a) + 5) % 5, 2, `${a}→${b}`);
assert.deepEqual(new Set(KOKU_PAIRS.map(([a]) => a)), new Set(ELEMENTS));
ok("相剋の線は、どの五行からも1つ飛ばし(木→土→水→火→金→木)");
console.log(`\n${n} gogyo mark tests passed`);
