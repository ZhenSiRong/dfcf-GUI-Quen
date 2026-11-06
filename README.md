# quan —— 东方财富模拟盘量化执行器

用 **Playwright 驱动真实浏览器**，在东方财富移动版 H5（`groupwap.eastmoney.com`）上操作**自己的模拟组合**：日线策略出信号 → 风控 → GUI 填单 → 确认弹窗 → 提交/撤单 → 落库 → 出日报。

> **边界**：只做模拟盘；只操作 `state/account.json` 里登记的账号；写入路径 100% 走页面 DOM；不逆向 APP、不调用 PC 交易接口、不绕过风控。

---

## 1. 安全设计

| 层 | 机制 |
|---|---|
| 默认只读 | 不加 `--live` 永远只到确认弹窗，点「取消」 |
| 模拟盘校验 | `account.sim !== true` 时拒绝真实下单（除非显式 `QUAN_ALLOW_NON_SIM=1`） |
| 金额 | 单笔 ≤ 5000 元；单票 ≤ 总资产 30%；最低现金保留 5% |
| 频率 | 单日真实委托 ≤ 20 笔；默认同一天同一代码只下一次 |
| 价格 | 偏离最新价 > 3% 拒单；超出涨跌停带拒单 |
| 熔断 | 连续失败 3 次自动停手并写告警 |
| 核对 | 填单后读回输入框；确认弹窗复述的代码/价格/数量/方向逐项比对，不一致绝不点「确定」 |
| 时段 | 15:00–17:00 清算、周末、集合竞价禁止真实下单；14:55 后不开新仓 |
| 节假日 | live 前检查行情最后更新时间，不是今天则跳过并告警（避免休市日空跑） |
| 调度 | `flock` 防并发；当天已有成功 live 运行则跳过（`--force` 可覆盖） |

---

## 2. 快速开始

环境要求：Linux、Node.js ≥ 24（使用内置 `node:sqlite`）、系统 Chrome（`/opt/google/chrome/chrome`）、Playwright 依赖已安装。

```bash
cd ~/VM-Share/quan
npm install                  # 只有 playwright-core 一个依赖

# 首次：登记模拟组合 zjzh（本机已配置可跳过）
cp state/account.example.json state/account.json   # 然后编辑 active.zjzh / name

# 1) 一次性登录（会打开有头 Chrome，扫码/短信/账密任选）
npm run login

# 2) 巡检：登录态、账户、时段
npm run doctor
npm run status          # 最近运行 / 今日信号 / 今日委托 / 告警

# 3) 离线端到端（不碰真实账户）
npm run run:mock

# 4) 真实账户 dry-run（会打开 5 个确认弹窗再取消）
npm run run

# 5) 真实链路自检：跌停价买入 100 股（不会成交）→ 撤单 dry-run → 真撤单
npm run verify

# 6) 真实下单（先看第 7 节“首次实盘清单”）
node src/runner.mjs --live --confirm --max-orders 1
```

产物：

- 日报：`reports/<日期>/<时分>-<模式>.md`，最新一份在 `reports/latest.md`
- 结构化日志：`logs/runner.jsonl`、`logs/doctor.jsonl`
- SQLite：`data/trading.db`（runs / signals / orders / fills / 快照 / kv）
- 告警：`logs/alerts/*.json`
- 下单截图：`logs/orders/*.png`
- 规则录屏：`reports/video/*.mp4`（红色光标环 + 点击涟漪，`WapBroker` 在 `recordVideo` 时自动开启）

---

## 3. 命令参数

```text
node src/runner.mjs [--live] [--mock] [--force] [--confirm]
                    [--max-orders N] [--at ISO]

--live          真实提交委托（默认 dry-run）
--mock          使用 fixtures/market.json + 内存 MockBroker
--force         跳过时段检查与“当天已跑过 live”检查
--confirm       每笔真实委托前在终端输入 yes
--max-orders N  本次最多提交 N 笔真实委托（0 = 不额外限制）
--at ISO        指定“现在”（仅 dry-run / --mock，测试用）
```

时段行为：

- `dry-run` 任何时间都能跑（只读 + 弹窗）
- `live` 只在交易日 09:30–11:30 / 13:00–15:00 的 14:55 前自动运行
- 清算期（15:00–17:00）与周末，`--force` 也不会真实下单
- 非交易时段 + `--force` 可下隔夜单（官方允许）

### 3.1 一次性规则（带录屏）

`state/rules/` 下放“只执行一次”的显式规则，适合“买入某只票固定数量”这类需求：

```bash
node scripts/run_rule.mjs --id <规则文件名>            # dry-run 预览
node scripts/run_rule.mjs --id <规则文件名> --live     # 按规则时间真实执行
```

规则执行后状态写为 `filled` / `failed`，不会重复下单。录屏在 `reports/video/`，会自动叠加**红色光标环 + 点击涟漪**，点击落点一目了然。完整字段和定时方式见 `state/rules/README.md`。

---

## 4. 一次运行做了什么

1. `decideSession` 判断能不能下单（区分 dry-run / live）
2. `WapBroker.health` 检查 `ct/ut` cookie + 一次只读请求
3. 拉取资金、持仓、未成交委托，写入快照表
4. 取股票池行情（push2）+ 日 K（push2his）
5. SMA 策略生成 `buy / sell / hold`
6. 排除：已有未成交委托、当天已下过单（live）
7. 计算限价与数量 → `RiskGuard.checkOrder`
8. `WapBroker.place`：填代码 → 选建议行 → 填价/量 → 快照核对 → 点模拟买入/卖出 → 弹窗二次核对 → 点确定
9. 重新读账户 → 写日报 → 记录 run 结果

读取使用页面同源的只读 `getJson` 接口（带登录 cookie，快且稳）；**所有写操作只通过 DOM 按钮**。

---

## 5. 策略

`src/strategy/sma.mjs`，日线、低频、纯函数：

- `SMA(5)` 与 `SMA(20)`，带 **0.5% 迟滞带**（均线附近不反复摩擦）
- 空仓 + 多头趋势 → `buy`
- 持仓 + 空头趋势 → `sell`（卖出全部可用数量）
- 现价高于短均线 5% → 不追高
- 最少 30 根 K 线；开盘后把实时价并入当天 K 线

股票池在 `state/universe.json`，默认 6 只低价蓝筹（1 手 ≤ 5000 元）：
`601398 工商银行`、`600028 中国石化`、`000001 平安银行`、`600036 招商银行`、`601088 中国神华`、`600030 中信证券`。

仓位：每笔预算 = `min(5000, 总资产 × 30%)`，按 100 股整手向下取整；卖出来自 `可用`（自动遵守 T+1）。

---

## 6. 无人值守部署

### 6.1 cron（本机时区已是 Asia/Shanghai）

```cron
# 每交易日 09:00 巡检登录态
0 9 * * 1-5  cd ~/VM-Share/quan && scripts/doctor.sh
# 每交易日 14:30 决策并执行（最多 2 笔）
30 14 * * 1-5 cd ~/VM-Share/quan && scripts/daily.sh --live --max-orders 2
# 可选：10:30 再跑一次 dry-run 观察信号
30 10 * * 1-5 cd ~/VM-Share/quan && scripts/daily.sh
```

`scripts/daily.sh` 自带 `flock -n logs/runner.lock`，不会并发；输出追加到 `logs/cron.log`。

### 6.2 systemd timer（可选）

`deploy/` 下已给出模板，按需复制：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/quan-*.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now quan-doctor.timer quan-run.timer
loginctl enable-linger "$USER"   # 注销后也继续跑
```

默认时间：巡检 09:00，交易 14:30（`Mon-Fri`，本机时区）。

---

## 7. 首次实盘清单（务必按顺序）

1. **把模拟组合设为「对外隐藏」**：公开组合的持仓可被未登录接口拉到（`spo_hold_detail`），这是隐私问题。
2. `npm run doctor` —— 登录态、余额、时段全部正常。
3. `npm run run` —— 真实账户 dry-run，确认 5 个弹窗的代码/价格/数量都正确。
4. `npm run verify` —— 用跌停价买 100 股（不会成交）验证「下单 → 撤单弹窗 → 真撤单」全链路，脚本会自动清理。
5. 交易时段内跑一笔小单：

   ```bash
   node src/runner.mjs --live --confirm --max-orders 1
   ```

   终端输入 `yes` 后，检查 `reports/latest.md` 和 H5「委托成交」页。
6. 确认无误后，再启用 cron/systemd 的全自动 `--live`。
7. 每天收盘后看 `reports/latest.md` 与 `logs/alerts/`。

> 建议长期使用独立的小资金模拟组合做执行器验证；本机 POC 组合（100 万、零持仓）就是其中之一。

---

## 8. 登录态与续期

- 登录态保存在 `state/storage_state.json`（含 `ct/ut/uidal/mtp` 等），**不要提交到 git、不要外发**。
- 本次登录的 cookie 有效期约 **90 天**（到 2027-02-03）。服务端也可能提前失效。
- `doctor` 会在剩余 < 7 天时写 `login_expiring` 告警；健康检查失败会写 `login_expired_or_api_failed`。
- 续期：停掉 cron → `npm run login` → 重新扫码/短信 → `npm run doctor` → 恢复 cron。旧进程无需重启。

### 两个本机环境坑（已固化）

- Chrome 必须带 `--ssl-version-max=tls1.2`，否则访问国内站点 HTTPS 会卡 30 秒（TLS1.3 握手问题）。
- 无头/远程桌面场景需要 `--ozone-platform=x11`；当前桌面已切到 Xorg，登录不再卡图形验证码。

---

## 9. 告警与巡检

告警文件：`logs/alerts/<时间戳>-<类型>.json`。类型：

| 类型 | 含义 | 处理 |
|---|---|---|
| `login_state_missing` | `storage_state.json` 不存在或缺关键 cookie | 重新登录 |
| `login_expiring` | cookie < 7 天 | 尽快续期 |
| `login_expired_or_api_failed` | 健康检查失败 | 重新登录，检查网络 |
| `broker_unhealthy` | 运行开始时检查失败 | 同上 |
| `order_failed` | 单笔委托失败 | 看截图与响应，必要时人工撤单 |
| `circuit_breaker` | 连败 3 次 | 停止自动交易，人工排查 |
| `run_failed` | 运行异常 | 看 `logs/runner.jsonl` 与截图 |
| `doctor_failed` | 巡检异常 | 看 `logs/doctor.jsonl` |

快速巡检命令：

```bash
npm run status                 # 最近运行 / 今日信号 / 今日委托 / 告警 / 日报路径
tail -n 50 logs/runner.jsonl
ls -lt logs/alerts | head
cat reports/latest.md
```

---

## 10. 数据库

`data/trading.db`（WAL）：

- `runs`：每次运行（mode/status/detail）
- `signals`：策略每次输出的信号（含 SMA 元数据）
- `orders`：委托（`dry_run=0` 才是真实委托，单日限额只统计它）
- `fills`：预留
- `positions_snapshot` / `balance_snapshot`：运行前后快照
- `kv`：连败计数等

时间戳存 UTC；按北京时间切日的查询统一用 `date(ts, '+8 hours')`。

---

## 11. 测试与自检

```bash
npm test          # 59 项单元/端到端测试
npm run verify    # 真实账户：跌停价下单 → 撤单 dry-run → 真撤单（会自动清理）
```

`npm test` 覆盖：风控边界、交易时段、SMA 策略、SQLite、MockBroker、持仓解析、dry-run/live 端到端、安全扫描（禁用端点、GUI 写入、默认 dry-run、冻结参数）。

> ⚠️ `npm run verify` 是**人工诊断工具**：为了构造永不成交的跌停价单，它绕过了日常风控的 3% 偏离限制。不要把它当交易入口。

`--mock` 用 `fixtures/market.json`（真实行情快照，生成命令 `npm run fixture:market`）和 `fixtures/snapshot_demo.json`（脱敏演示账户快照），完全离线、可重复。本地如果存在 `fixtures/snapshot_real.json`（已 gitignore），会优先使用真实快照。

---

## 12. 目录

```
src/
  config.mjs            常量 / 风控阈值 / 股票池 / 账号
  runner.mjs            主流程
  broker/wap.mjs        H5 GUI 读写适配器（核心写入路径）
  broker/mock.mjs       内存 MockBroker
  market/push2.mjs      实时行情 + 涨跌停
  market/history.mjs    日 K
  market/source.mjs     真实/离线行情源切换
  strategy/sma.mjs      SMA 趋势策略
  risk/guard.mjs        纯函数风控
  scheduler/session.mjs 运行时段决策
  store/db.mjs          SQLite
  report/daily.mjs      Markdown 日报
  util/time.mjs         上海时区 / 交易时段
  util/log.mjs          日志 / 告警
scripts/
  login_capture.mjs     一次性登录
  doctor.mjs            巡检
  status.mjs            终端状态总览
  probe_read.mjs        只读探针
  verify_broker.mjs     真实链路自检（下单→撤单）
  run_rule.mjs          一次性规则执行器（带录屏）
  daily.sh              交易入口（flock）
  doctor.sh             巡检入口（flock）
  rule.sh               一次性规则入口（flock）
  poc3_order.mjs        POC-3 下单/撤单闭环（历史验证脚本）
tools/                  一次性探针与 fixture 生成
tests/                  node:test
deploy/                 systemd 模板
state/                  账号、股票池、登录态（敏感）
state/rules/            一次性规则（schema 见该目录 README）
fixtures/               真实响应/行情快照
reports/                日报
logs/                   日志/截图/告警
data/                   SQLite
```

---

## 13. 非目标

- 不对接真实资金账户，不做实盘
- 不逆向 APP 私有协议，不调用 `jywg.18.cn` / `spzhapi.dfcfs.cn` / `simoper` 等写入接口
- 不做高频、不做盘中 T+0、不做自动打新
- 不保证收益；这是执行器 + 风控框架，策略可替换
