import test from "node:test";
import assert from "node:assert/strict";
import { parsePositionRows } from "../src/broker/wap.mjs";

test("wap: 持仓解析用 zqsl 股数，不用 holdPos 仓位占比", () => {
  const rows = [
    {
      __code: "603259", __name: "药明康德", __zxjg: "149.610",
      cbj: "149.831", kysl: "0", holdPos: "0.0150",
      mktVal: "14961.000", webYk: "-22.12", webYkRate: "-0.0015",
      dayYk: "-22.12", zqsl: "100",
    },
    {
      __code: "600036", __name: "招商银行", __zxjg: "42.610",
      cbj: "42.042", kysl: "2300", holdPos: "0.0974",
      mktVal: "98003.000", webYk: "1305.43", webYkRate: "0.0135",
      dayYk: "161.00", zqsl: "2300",
    },
  ];
  const [a, b] = parsePositionRows(rows);
  assert.equal(a.qty, 100);
  assert.equal(a.available, 0);
  assert.equal(a.marketValue, 14961);
  assert.equal(a.cost, 149.831);
  assert.equal(b.qty, 2300);
  assert.equal(b.available, 2300);
});

test("wap: 持仓缺 zqsl 时数量为 0，不把比例当股数", () => {
  const [p] = parsePositionRows([{ __code: "000001", __name: "平安银行", holdPos: "0.1234" }]);
  assert.equal(p.qty, 0);
  assert.equal(p.available, 0);
});
