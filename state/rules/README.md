# 一次性规则（state/rules）

这里存放「只执行一次」的显式交易规则，和日线 SMA 策略分开。
适合：用户指定买入某只票固定数量、带录屏、执行后自动失效。

## 规则字段

```json
{
  "id": "buy-603259-one-lot-20261106",
  "enabled": true,
  "status": "pending",
  "side": "buy",
  "code": "603259",
  "name": "药明康德",
  "qty": 100,
  "executeOn": "2026-11-06",
  "executeAfter": "10:20",
  "expiresAt": "14:50",
  "price": { "mode": "last_plus_pct", "offsetPct": 0.005 },
  "maxNotional": 16000,
  "video": true
}
```

- `status`：`pending` → `submitted` / `filled` / `failed`，非 `pending` 不会再执行。
- `qty`：必须是 100 的整数倍。
- `price.offsetPct`：限价 = 最新价 × (1 + offsetPct)，并夹在涨跌停之间；最大 3%。
- `maxNotional`：**仅本次规则**覆盖单笔 5000 上限，硬顶 20000 元。
- 其他风控（现金、单票 30%、现金保留 5%、偏离 3%、涨跌停、单日 20 笔、连败熔断）仍然全部生效。
- 如果已有同代码未成交委托，直接拒绝，避免重复买入。

## 运行

```bash
# dry-run 预览（随时可跑，只到确认弹窗后取消）
node scripts/run_rule.mjs --id <规则文件名>

# 真实执行（只在 executeOn / executeAfter~expiresAt / 交易时段）
node scripts/run_rule.mjs --id <规则文件名> --live
```

录屏输出：

- `reports/video/<规则id>-<日期-时间>-<模式>.mp4`
- 同目录保留 `.webm` 原始文件
- 报告：`reports/rules/<规则id>.md`（dry-run 为 `<规则id>-dry-run.md`，不会覆盖真实报告）
- 录屏会自动叠加**红色光标环 + 点击涟漪**（`WapBroker.clickMarker`，`recordVideo` 时默认开启）

## 定时执行

```bash
systemd-run --user --collect \
  --unit=quan-buy-603259-20261106 \
  --on-calendar="2026-11-06 10:20:10" \
  --working-directory=$HOME/VM-Share/quan \
  --setenv=PATH=$HOME/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin \
  $HOME/VM-Share/quan/scripts/rule.sh \
  --id buy-603259-one-lot-20261106 --live
```

`scripts/rule.sh` 自带 `flock`，不会并发执行。
