# 东方财富「移动版 模拟盘」程序化交易 —— 技术调研报告

> 调研目标：为一个**只能通过 App GUI 下单**的东方财富移动版模拟盘（模拟炒股/模拟组合）构建程序化/量化交易系统。
> 调研方式：Web 搜索 + 直接抓取 GitHub 仓库源码 / GitHub API（issues、blobs）+ 官方帮助中心页面。
> **所有结论均标注来源 URL；无法证实的明确标注「未证实」。**
> 调研日期：2026-11-05

---

## 0. 先澄清「东方财富 模拟盘」到底是哪一个（这是全部后续讨论的前提）

东财体系里**同时存在 4 套**互不相同、都叫"模拟/仿真"的交易环境。搞错对象会导致整个方案选错。

| # | 名称 | 载体 | 账户/资金 | 是否免费 | 是否属于"移动版 模拟盘" | 来源 |
|---|---|---|---|---|---|---|
| **A** | **模拟组合 / 模拟炒股** | 东方财富 **APP**（个人中心→我的组合→创建组合）+ 网页 `group.eastmoney.com/room/` | 通行证账号，初始虚拟资金 **100 万元**，每人最多 20 个组合 | 免费 | ✅ **就是它** | [group.eastmoney.com/CreateCom.html](https://group.eastmoney.com/CreateCom.html)、[mobapppages.eastmoney.com/helper/Q037.html](http://mobapppages.eastmoney.com/helper/Q037.html) |
| **B** | **妙想模拟组合 API**（官方 AI Skill 后端） | 官方 HTTPS API `mkapi2.dfcfs.com` | 同 A，需在"妙想 Skills"页绑定模拟组合 | 免费（有调用限额） | ✅ **A 的官方程序化入口** | [flp516/eastmoney-mx-skills-suite-v2](https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md) |
| **C** | **东财掘金 仿真账户**（量化平台） | PC 终端 + Python/C++/Matlab SDK | 需申请仿真账户 + Token | 需开户 | ❌ | [emquant.18.cn 帮助文档](https://emquant.18.cn/help/doc/guide/book.pdf)、[emquant.18.cn 常见问题](https://emquant.18.cn/help/doc/faq/book.pdf) |
| **D** | **东方财富证券 仿真交易**（EMC 终端） | PC 终端 `emt.18.cn`，底层 `jywg.18.cn` 仿真线路 | 手机号申请仿真账号 | 需申请 | ❌ | [东方财富 EMC 智能交易终端说明书 PDF](https://swdlcdn.eastmoney.com/emt/EmtHelp/%E4%B8%9C%E8%B4%A2EMC%E4%BA%A4%E6%98%93%E7%BB%88%E7%AB%AF%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E4%B9%A61.2.pdf)、[机构交易终端说明书 PDF](https://swdlcdn.eastmoney.com/emt/EmtHelp/%E6%9C%BA%E6%9E%84%E4%BA%A4%E6%98%93%E7%BB%88%E7%AB%AF%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E4%B9%A6V1.2.pdf) |

**结论：用户要的「移动版 模拟盘」= A（模拟组合），而 A 有一个官方 API（B）。这从根本上改变了方案选择 —— 见「结论速览」第 1 条。**

补充事实：A 与 B 是否同一个账户体系？**高度可能但未证实**。证据链：
- Aniu 项目 README 描述的获取流程是「下载东方财富 APP，首页搜索『妙想 Skills』领取 → 点击 APP 下方**交易 → 上方模拟**，领取 20 万元模拟资金 → 下滑找到『妙想模拟组合管理』skill，**绑定模拟组合**」——说明 APP 里的"模拟"入口和妙想 skill 绑定的"模拟组合"是同一个东西（[AnacondaKC/Aniu](https://github.com/AnacondaKC/Aniu)）。
- 但 100 万（A 的官方初始资金）vs 20 万（妙想 skill 页面显示）**数字对不上**，因此"是否同一账户、能否直接互通"需要用户实测。

**关于"是否有独立的东方财富证券 模拟炒股 App"**：未找到任何独立 App。模拟盘就是主 App 内的一个 tab/组合。相邻但不同的产品有：东方财富**期货** APP（帮助中心明确写了「登录通行证后在【交易】页面最上方点击【模拟】按钮」，且期货**模拟账户支持条件单**，见 [qhweb.eastmoney.com/help/2299652.html](https://qhweb.eastmoney.com/help/2299652.html) 与 [qhweb.eastmoney.com/help/2586405.html](https://qhweb.eastmoney.com/help/2586405.html)）。

---

## 1. 结论速览（8 条，每条带来源）

### ① 「只能 GUI」这个约束**有官方解法**，而且是东财自己出的
东方财富「妙想」平台提供**官方**的模拟组合 API：`POST https://mkapi2.dfcfs.com/finskillshub/api/claw/mockTrading/{positions,trade,cancel,orders,balance}`，Header 传 `apikey: <MX_APIKEY>`，JSON body。功能覆盖持仓/资金/委托查询/限价·市价买卖/单笔与一键撤单。
> 来源：[flp516/eastmoney-mx-skills-suite-v2 / references/mx-stock-simulator.md](https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md)、[cattomgithub/eastmoney-mx-skills](https://github.com/cattomgithub/eastmoney-mx-skills)、[ClawHub eastmoney-stock-simulator](https://clawhub.ai/qqk000/eastmoney-stock-simulator)、[360 安全技能中心](https://skillhub.360.com/skills/eastmoney-stock-simulator)
> 已有两个真实项目在用： [AnacondaKC/Aniu](https://github.com/AnacondaKC/Aniu)（183★，AI 模拟炒股工作台）、[zxinyun/yygmx](https://github.com/zxinyun/yygmx)。

**但**：拿到 key 需要在东财 APP 内领取，且**有调用限额**（"妙想相关技能使用有限额"，错误码 113 = 调用次数达上限）。若限额太低，仍需 GUI 兜底。

### ② `easytrader` **不支持**东方财富，且它根本不是"网页版模拟盘"路线
- 上游 `shidenggui/easytrader` 支持的是：银河/华泰/国金 **PC 同花顺客户端**（GUI 自动化）、雪球组合、joinquant/ricequant 模拟跟踪、miniqmt。**没有东方财富**。官方文档亦未列出。→ [easytrader.readthedocs.io](https://easytrader.readthedocs.io/)、[GitHub](https://github.com/shidenggui/easytrader)
- 社区做法是**复制**一份改造成 `EastMoneyTrader`，且**走 HTTP 表单 POST 打 `jywg.18.cn`**，不是 GUI。→ [jadepeng/pytrader](https://github.com/jadepeng/pytrader)（`easytrader/eastmoney_trader.py`）
- 而 `jywg.18.cn` 是**东财证券实盘/仿真交易网关**，**不是**散户的"模拟组合"。用它下单＝动实盘资金。

### ③ 现成的东方财富 HTTP 交易库有 3 个，端点完全一致，可直接抄
| 库 | 语言 | 仓库 | 说明 |
|---|---|---|---|
| `emtl` | Python | [riiy/emtl](https://github.com/riiy/emtl) | ★80，106 commits，**最干净、最完整**，文档在 [emtl.readthedocs.io](https://emtl.readthedocs.io/) |
| `pytrader` | Python | [jadepeng/pytrader](https://github.com/jadepeng/pytrader) | easytrader 魔改版 + 回测框架；**缺撤单实现** |
| `eastmoneyapi` | Go | [wmo-v/eastmoneyapi](https://github.com/wmo-v/eastmoneyapi) | ★38，含 `GetRevokeList` |
| `stock-api` | Java | [joechen2010/stock-api](https://github.com/joechen2010/stock-api) | 实现**闭源**（作者微信 13560038322），Rest API 付费；用 `H5TradeApi` |

### ④ 东财交易网关的密码是 **RSA/1024 + PKCS#1 v1.5** 加密后 base64，公钥硬编码在客户端
登录 `POST https://jywg.18.cn/Login/Authentication?validatekey=`，表单字段：`userId` / `password`(RSA密文b64) / `randNumber` / `identifyCode`(图形验证码) / `duration` / `authCode` / `type=Z` / `secInfo`。
公钥（三个库完全一致，1024-bit）：
```
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDHdsyxT66pDG4p73yope7jxA92
c0AT4qIJ/xtbBcHkFPK77upnsfDTJiVEuQDH+MiMeb+XhCLNKZGp0yaUU6GlxZdp
+nLW8b7Kmijr3iepaDhcbVTsYBWchaWUXauj9Lrhz58/6AE/NF0aMolxIGpsi+ST
2hSHPu3GSXMdhPCkWQIDAQAB
-----END PUBLIC KEY-----
```
> 来源：[riiy/emtl/src/emtl/utils.py](https://github.com/riiy/emtl/blob/master/src/emtl/utils.py)、[wmo-v/eastmoneyapi/client/client.go](https://github.com/wmo-v/eastmoneyapi/blob/master/client/client.go)、[jadepeng/pytrader/easytrader/eastmoney_trader.py](https://github.com/jadepeng/pytrader/blob/main/easytrader/eastmoney_trader.py)

### ⑤ 东财 App 移动版的请求签名：**没有找到任何可用的签名算法**，但也**不需要**
- 行情接口确实带 `ut` token（例：`ut=fa5fd1943c7b386f172d6893dbfba10b`，公开页面公共 token，非登录凭证）。→ [roiding/shadowflow/docs/EASTMONEY_PUSH2_API.md](https://github.com/roiding/shadowflow/blob/main/docs/EASTMONEY_PUSH2_API.md)
- Web 端 JS 逆向有 `secids` 的 AES 加密（`window.d` 标准 AES）→ [阿里云开发者社区](https://developer.aliyun.com/article/1582351)、[CSDN](https://blog.csdn.net/weixin_52392194/article/details/141111116)
- **但移动版 APP 的交易链路签名机制：未证实**。没有找到任何公开的 Frida/Frida hook/算法还原的东财 APP 交易签名方案。
- **实际结论：不要走这条路。** 因为官方妙想 API 已经给了免签名的模拟组合交易接口；而且模拟组合本身不是撮合柜台，不存在"绕过柜台风控"的收益。

### ⑥ GUI 自动化（真·只能 GUI 时的唯一路径）**有一个可直接复用的完整参考实现**
[mrz-itz/qwen3.5-4b-quant-trading](https://github.com/mrz-itz/qwen3.5-4b-quant-trading) —— **雷电模拟器 + 同花顺 App「模拟炒股」+ adb/uiautomator + 截图多模态校验** 的全自动量化程序。它的架构就是你要的东西，只是把同花顺换成东财：
- `emulator.py`：雷电/adb 驱动（截图、点按、uiautomator）
- `ths_app.py`：页面驱动（持仓识别、时间命名截图、下单）
- `selectors.json`：UI 锚点，**校准后填写中文文案**
- `vision.py`：截图交给多模态模型读图核实弹窗/持仓
- `run.py probe` → 手改 `selectors.json` → `once --dry` → `--live` 的**校准流程**
这是目前最接近"移动版模拟盘 GUI 自动化"的公开代码，**强烈建议作为骨架**。

### ⑦ 合规上是明确的灰色/红线区：东财用户协议明确禁止"插件/外挂/第三方软件干扰"
《东方财富用户服务协议》（生效 2025-07-18）第二条 2：
> 「除非得到东方财富的事先书面许可，您不得从事以下任何一项行为：…（3）**采用任何方式（包括但不限于使用第三方软件、插件、外挂、系统、设备等）对本产品的功能和运行效果进行干扰、破坏、修改或施加其他影响。**」

第三条 2 规定东财可「通过技术等手段采取必要措施，包括但不限于对您的通行证账户采取临时或永久禁言措施、…对您的通行证账户部分功能进行限制、或中止或终止向您提供服务」。
且该协议第 1 条明确适用范围含「**东方财富移动客户端（"APP"）**」。
> 来源：[about.eastmoney.com/home/protocol](https://about.eastmoney.com/home/protocol)
> 另有《东方财富网法律声明》四：「您不得以任何方式（包括但不限于**使用任何设备、软件或程序**）干扰或试图干扰本网站的正常运作…您同意不会从事任何可能会对本网站及其相关的架构、系统、网络带来不合理或不成比例的高负载的行为。」→ [about.eastmoney.com/home/legal](https://about.eastmoney.com/home/legal)

**但官方智能条件单、妙想 API、掘金仿真都是被明确支持的** —— 合规的边界不是"自动化 vs 不自动化"，而是**"用官方允许的通道 vs 逆向/外挂客户端"**。

### ⑧ 模拟盘**没有**"只需下单一次"的条件单红利（大概率）
- 东财官方 FAQ 明确：模拟炒股**不支持新股申购、市值配售、增发申购**，且**没有集合竞价阶段的挂单限制**；交易品种仅沪深 A 股股票和基金；T+1；15:00–17:00 清算不接受委托；当日未成交委托在清算时自动撤销。→ [emdesk 模拟交易 FAQ](https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/link/mnjy.html)、[mobapppages Q037](http://mobapppages.eastmoney.com/helper/Q037.html)
- **期货**模拟账户明确**支持模拟条件单**（含止盈止损/反手）→ [qhweb.eastmoney.com/help/2586405.html](https://qhweb.eastmoney.com/help/2586405.html)
- **股票模拟组合是否支持条件单：未证实**（未找到任何官方说明）。社区回答里提到"模拟盘可以先用『条件单』功能演练止损止盈"（[叩富](https://licai.cofool.com/ask/qa_5735264.html)），但那是**券商营销号**回答，与官方 FAQ 口径不一致，**不可信**。
- 实盘的**智能条件单**（价格/时间/网格/止盈止损/策略清仓，7×24 云端监控）只对**已开户的东财证券用户**开放，个人门槛据称 10 万资产+半年交易经验（**该门槛未在东财官方页面证实**，仅见于营销号回答）。→ [emdesk 智能交易](https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/aitrade.html)、[财富号文章](https://caifuhao.eastmoney.com/news/20260226170950641497300)

---

## 2. 方案对比表

### 2.1 主方案对比

| 方案 | 是否 GUI | 稳定度 | 开发量 | 维护成本 | 风险 | 关键依据 |
|---|---|---|---|---|---|---|
| **S1. 妙想官方 API**（`mkapi2.dfcfs.com/.../mockTrading/*`） | ❌ 非 GUI | ★★★★☆ 官方维护，但有**调用限额**（错误码 113） | ★☆☆☆☆ 半天 | ★☆☆☆☆ 极低 | 低。官方授权通道；但需在 APP 内领 key，且**是否与 APP 端"模拟组合"同账户待证实** | [mx-stock-simulator.md](https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md)、[Aniu](https://github.com/AnacondaKC/Aniu) |
| **S2. 模拟盘 GUI 自动化**（模拟器 + uiautomator2/Maestro/Airtest） | ✅ 真 GUI | ★★☆☆☆ 依赖 UI 文案/控件，App 一改就挂；行情刷新会抖 | ★★★★☆ 2–4 周 | ★★★★☆ 高（每次 App 更新需重新校准） | **中高**：违反用户协议"插件/外挂/设备干扰"条款；App 弹窗/验证码/风控弹窗；技术性误单 | [用户协议](https://about.eastmoney.com/home/protocol)、[qwen3.5-4b-quant-trading](https://github.com/mrz-itz/qwen3.5-4b-quant-trading) |
| **S3. 网页模拟炒股 HTTP**（`group.eastmoney.com/room/`） | ❌ 非 GUI | ★★☆☆☆ 逆向 web 接口，无公开文档，易变 | ★★★★☆ 需抓包逆向 | ★★★★☆ 高 | **高**：非官方通道，协议禁止"干扰网站正常运作/高负载"；且**模拟盘 web 接口未找到任何现成实现** | [group.eastmoney.com](https://group.eastmoney.com/)、[法律声明](https://about.eastmoney.com/home/legal) |
| **S4. 东财证券交易网关 HTTP**（`jywg.18.cn/Trade/SubmitTradeV2`） | ❌ 非 GUI | ★★★☆☆ 库成熟但需图形验证码 OCR | ★★☆☆☆ 1–3 天（抄 `emtl`） | ★★☆☆☆ 中（接口会变、有频率限制疑问） | **高（但只影响实盘）**：这是**实盘/仿真**通道，误接=真金白银。用于模拟盘是**错配** | [riiy/emtl](https://github.com/riiy/emtl)、[pytrader issue #16](https://github.com/jadepeng/pytrader/issues/16) |
| **S5. 东财掘金 仿真账户 + Python SDK** | ❌ 非 GUI | ★★★★★ 官方量化通道，回测→仿真→实盘一体 | ★★★☆☆ 需开户+装终端+绑仿真账户 | ★☆☆☆☆ 低 | 低（官方允许）。但**不是"移动版模拟盘"**，是 PC 终端仿真 | [emquant.18.cn 快速开始 PDF](https://emquant.18.cn/help/doc/guide/book.pdf) |
| **S6. 半自动/人机协同**（程序出信号 → 推送 → 人点确认） | ✅ 半 GUI | ★★★★★ 几乎不会出错 | ★★☆☆☆ 2–3 天 | ★☆☆☆☆ 低 | 低。资金与决策分离，误伤最小 | — |
| **S7. 程序自动点，但需 final 确认**（S2 + 最后一步人工点"确定"） | ✅ GUI | ★★★☆☆ 半自动 | ★★★★☆ 同 S2 | ★★★★☆ 高 | 中。相比 S2 显著降低"误单"风险，但**协议风险不变** | — |
| **S8. 官方智能条件单（实盘）** | ✅ GUI（一次设置） | ★★★★★ 云端执行 | ★☆☆☆☆ | ★☆☆☆☆ | 低。但需东财证券账户+门槛；**模拟组合大概率不支持** | [emdesk 智能交易](https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/aitrade.html) |

### 2.2 GUI 自动化框架横向对比（面向"Android 上的炒股 App"）

| 框架 | 定位方式 | 需要 Appium 服务 | 需要 App 源码 | 学习成本 | 稳定性 | 适配东财模拟盘 |
|---|---|---|---|---|---|---|
| **uiautomator2 (openatx)** | UIAutomator resource-id / text / description；**3.x 支持 XPath**；截图 + OpenCV | ❌ | ❌ | 低 | ★★★☆☆ | ✅ **首选**。自带 `u2cli` CLI；`d(text="买入")`、`d.xpath("//*[@text='买入']")` 直击中文文案；`watcher` 弹窗自动处理 |
| **Maestro** | YAML flow，`tapOn`/`inputText`/`assertVisible`/`scrollUntilVisible`/`extendedWaitUntil`/`retry`/`runFlow` | ❌（自带 driver） | ❌ | 低（YAML） | ★★★☆☆ | ✅ 适合写"下单流水线"；但 flow 文件对 App 改版同样敏感 |
| **Airtest** | **纯图像模板匹配**（`Template` + `touch`） | ❌ | ❌ | 中 | ★★☆☆☆ | △ 抗改版能力取决于模板；行情刷新会导致模板失效 |
| **Poco** | 直接读 UI widget 树（引擎无关） | ❌ | 部分场景需要 | 中 | ★★★☆☆ | △ 对**原生 Android View** 有效；对 **WebView/H5 渲染的模拟盘界面无效**（重要，见 §3.6） |
| **Appium + UiAutomator2 driver** | 同上，多一层 server | ✅ 需要 | ❌ | **高** | ★★☆☆☆ | ❌ 不推荐：多一个 Java/Node 服务要维护，中文文案匹配还得额外处理 |
| **scrcpy + PC 端 OpenCV** | 投屏画面 + 电脑侧视觉 | ❌ | ❌ | 中 | ★★☆☆☆ | △ 适合"我要看到人在干什么"的场景；`--otg` 模式甚至不需要投屏 |
| **模拟器 + pyautogui** | 纯鼠标坐标点击 | ❌ | ❌ | 低 | ★☆☆☆☆ | ❌ 最脆：与窗口位置/DPI/分辨率强耦合 |

> 框架 API 事实来源：[uiautomator2 QUICK_REFERENCE.md](https://github.com/openatx/uiautomator2/blob/master/QUICK_REFERENCE.md)、[uiautomator2 SKILL.md](https://github.com/openatx/uiautomator2/blob/master/skills/uiautomator2/SKILL.md)、[Maestro commands](https://docs.maestro.dev/reference/commands-available)、[Airtest README](https://github.com/AirtestProject/Airtest)、[scrcpy README](https://github.com/Genymobile/scrcpy)

---

## 3. 关键技术细节

### 3.1 妙想官方 API（推荐路径）— 端点、字段、错误码

**Base URL**：`https://mkapi2.dfcfs.com/finskillshub`（部分文档写作 `.../finskillshub/api/claw`）
**认证**：Header `apikey: <MX_APIKEY>`；**全部 POST**，`Content-Type: application/json`
**Key 获取**：APP 首页搜索「妙想 Skills」→ 领取 → `https://dl.dfcfs.com/m/itc4` 创建模拟账户并**绑定模拟组合**
**来源**：[flp516/eastmoney-mx-skills-suite-v2](https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md)、[cattomgithub/eastmoney-mx-skills](https://github.com/cattomgithub/eastmoney-mx-skills)、[18816132863/xiaoyi-claw-omega-final](https://github.com/18816132863/xiaoyi-claw-omega-final/blob/main/skills/eastmoney-mx-skills-suite/references/mx-stock-simulator.md)

| 功能 | Method | Path | Body |
|---|---|---|---|
| 持仓 | POST | `/api/claw/mockTrading/positions` | `{}` |
| 买卖 | POST | `/api/claw/mockTrading/trade` | `{"type":"buy"\|"sell","stockCode":"600519","price":1780.00,"quantity":100,"useMarketPrice":false}` |
| 撤单 | POST | `/api/claw/mockTrading/cancel` | `{"type":"order"\|"all","orderId":"...","stockCode":"..."}` |
| 委托查询 | POST | `/api/claw/mockTrading/orders` | `{"fltOrderDrt":0,"fltOrderStatus":0}` |
| 资金 | POST | `/api/claw/mockTrading/balance` | `{}` |

**响应字段（重要：单位是"厘"，即 1 元 = 1000 厘）**
- `totalAssets` / `availBalance` / `totalPosValue` / `totalProfit`（Int64，÷1000 = 元）
- `posList[]`：`secCode`、`secMkt`、`secName`、`currentPrice`、`price`、`priceDec`、`dayProfit`、`profit`、`profitPct`
- 委托：`orderNo`、`dbStatus`、`time`(unix)、`secCode`、`secType`（9=沪市基金，10=深市基金，其他=股票）、`secMkt`（**0=深交所，1=上交所，116=港交所，105=纳斯达克**）、`drt`（**1=买入，2=卖出**）、`priceDec`、`price`（真实价 = price / 10^priceDec）、`type`（**1=限价，2=增强限价，5=市价**）
- 委托状态码：`1 未报 / 2 已报 / 3 部成 / 4 已成 / 5? / 6 已报待撤 / 7 部撤 / 8 已撤 / 9 废单`

**错误码**：`113` 调用次数达上限 → 等待或更新 Key；`114` API 密钥失效；`115` 未携带密钥；`116` 密钥不存在；`404` 未绑定模拟组合 → 引导用户创建模拟账户；`501` 非交易时间/委托失败（见下方 skill 文档中的"交易时间限制"）

**限制**：`stockCode` 仅 A 股 6 位数字；`quantity` 必须是 100 的整数倍；价格需符合市场小数位；非交易时间（A股 9:30-11:30 / 13:00-15:00）无法下单。

**现成代码**：[cattomgithub/eastmoney-mx-skills/mx_moni.py](https://github.com/cattomgithub/eastmoney-mx-skills)、[jm12138/eastmoney-mx-finance-mcp-server](https://github.com/jm12138/eastmoney-mx-finance-mcp-server)（把妙想 API 包成 MCP server，可直接给 LLM 用）

### 3.2 东财证券交易网关 `jywg.18.cn`（**实盘/仿真**，非模拟组合；仅作技术参考与备份路线）

**Base**：`https://jywg.18.cn`（`riiy/emtl` issue #1 提到官方主页用的是 `https://jywg.eastmoneysec.com/` 这个域名，值得实测）
**端点表**（来自 [riiy/emtl/src/emtl/const.py](https://github.com/riiy/emtl/blob/master/src/emtl/const.py) 与 [jadepeng/pytrader/easytrader/config/jywg.json](https://github.com/jadepeng/pytrader/blob/main/easytrader/config/jywg.json)）：

| 用途 | Method | Path | 关键参数 |
|---|---|---|---|
| 图形验证码 | GET | `/Login/YZM?randNum=<random float>` | 返回图片（ddddocr 识别，必须是 4 位纯数字） |
| 登录 | POST | `/Login/Authentication?validatekey=` | `userId`, `password`(RSA b64), `randNumber`, `identifyCode`, `duration`(30/1800), `authCode`(""), `type`("Z"), `secInfo`("") |
| 取 validatekey | GET | `/Trade/Buy` | 解析 `<input id="em_validatekey" type="hidden" value="...">` |
| 资金+持仓 | POST | `/Com/queryAssetAndPositionV1?validatekey=` | `moneyType=RMB` |
| 持仓 | POST | `/Search/GetStockList?validatekey=` | `qqhs=10`, `dwc=""` |
| 当日委托 | POST | `/Search/GetOrdersData?validatekey=` | `qqhs=100`, `dwc=""` |
| 当日成交 | POST | `/Search/GetDealData?validatekey=` | `qqhs=100` |
| 历史委托/成交 | POST | `/Search/GetHisOrdersData` / `GetHisDealData` | `qqhs`, `dwc=""`, `st`/`et`（`%Y-%m-%d`） |
| 资金流水 | POST | `/Search/GetFundsFlow?validatekey=` | `qqhs`, `dwc`, `st`, `et` |
| **下单** | POST | `/Trade/SubmitTradeV2?validatekey=` | `stockCode`, `tradeType`(**B=买 / S=卖**), `zqmc`, `market`(**HA=上交所 / SA=深交所**), `price`, `amount` |
| 可撤委托 | POST | `/Trade/GetRevokeList?validatekey=` | `qqhs=100` |
| **撤单** | POST | `/Trade/RevokeOrders?validatekey=` | `revokes="<YYYYMMDD>_<Wtbh>,<YYYYMMDD>_<Wtbh>"` |
| 批量下单 | POST | `/Trade/SubmitBatTradeV2?validatekey=` | — |
| 可打新列表 | POST | `/Trade/GetCanBuyNewStockListV3?validatekey=` | — |
| 可转债列表 | POST | `/Trade/GetConvertibleBondListV2?validatekey=` | — |

**注意 `market` 取值**：`HA`=上交所（`60*`/`51*`/`68*`），`SA`=深交所（`00*`/`15*`/`30*`）。→ [wmo-v/eastmoneyapi/util/common.go](https://github.com/wmo-v/eastmoneyapi/blob/master/util/common.go)

**响应字段速查**
- 委托：`Wtbh` 委托编号、`Wtrq` 委托日期、`Wtsj` 委托时间、`Zqdm`/`Zqmc` 代码/名称、`Mmsm`/`Mmlb` 方向、`Wtzt` 状态、`Wtjg` 价格、`Wtsl` 数量、`Cjbh` 成交编号、`Cjjg`/`Cjsl` 成交价/量、`Cjsj` 成交时间
- 资金：`Zzc` 总资产、`Kyzj` 可用资金、`Kqzj` 可取、`Djzj` 冻结、`Zxsz` 最新市值
- 持仓：`Zqsl` 持仓数量、`Kysl` 可用数量、`Cbjg` 成本价、`Zxjg` 最新价

**已知坑（来自 issue，有据可查）**
- 频率限制存疑：`pytrader` issue #16「东方财富对 jywg.18.cn 这个有频率限制吗，会触发风控吗」——**至今无官方答复（未证实）**。→ [issue #16](https://github.com/jadepeng/pytrader/issues/16)
- 登录返回 `{'Status': '-1', 'Message': '您输入的信息有误，请重新输入!'}` → [issue #9](https://github.com/jadepeng/pytrader/issues/9)
- "东财web登录接口加安全控件了"（Windows-only 控件，Mac/Linux 需 `utils/base.exe`）→ [issue #8](https://github.com/jadepeng/pytrader/issues/8)、[issue #7](https://github.com/jadepeng/pytrader/issues/7)（"请输入交易密码!"，且 base.exe 在 Mac 上 Permission denied）
- 登录密码已改 RSA 加密 → [issue #3](https://github.com/jadepeng/pytrader/issues/3)、修复 PR [#4](https://github.com/jadepeng/pytrader/pull/4)
- 可用资金字段语义坑：`enable_balance` 才是可用金额，`current_balance` 不含当日卖出 → PR [#12](https://github.com/jadepeng/pytrader/pull/12)
- 翻页逻辑"很恶心"，只能按每页条数取 → [wmo-v README](https://github.com/wmo-v/eastmoneyapi)
- 撤单返回值**没有状态码**，只是一串 `委托编号: 执行结果` 文本 → [wmo-v README](https://github.com/wmo-v/eastmoneyapi)
- 撤单参数格式易错：`Wtrq`（交易日）+ `Wtbh`（委托编号）→ `emtl.cancel_order` docstring

### 3.3 关于任务里提到的那些字段名 —— **大部分在东财代码里不存在**

我逐一在上述三个开源库的真实源码里核对过：

| 你给的字段名 | 东财真实代码里 | 结论 |
|---|---|---|
| `price` | ✅ `price` | 存在 |
| `amount` | ✅ `amount` | 存在 |
| `market` | ✅ `market`（**值是 HA/SA，不是 0/1**） | 存在但取值不同 |
| `stockid` | ❌ 实际是 **`stockCode`** | 字段名不同 |
| `trade_type` | ❌ 实际是 **`tradeType`**（值 `B`/`S`） | 字段名不同 |
| `loginid` / `accountid` | ❌ 实际是 **`userId`**（jywg）；妙想用 header `apikey` | 字段名不同 |
| `password` | ✅ `password`（但必须 RSA 加密后 b64） | 存在但语义不同 |
| `otp` | ❌ 未在东财任何代码中找到 | **未证实（很可能不是东财的）** |
| `cmd` | ❌ 未找到 | **未证实** |
| `sort` | ❌ 未找到（东财用 `qqhs`/`st`/`et`） | **未证实** |
| `transfer_amount` | ❌ 未找到 | **未证实** |
| `batchflag` | ❌ 未找到（东财批量下单是 `SubmitBatTradeV2`） | **未证实** |
| `bankurl` / `partnerid` | ❌ 未找到 | **未证实** |
| `gbbc`（交易密码） | ❌ 未找到 | **未证实**。东财的"交易密码"是 `jywg.18.cn` 登录用的**同一个密码**（RSA 加密），没有独立 `gbbc` 字段 |
| `bankurl`/`partnerid` | ❌ | 唯一相近的是 `joechen2010/stock-api` 的 **`gdk`**（`orderRequest.setGdk("5700")`），含义未明 | → [joechen2010/stock-api README](https://github.com/joechen2010/stock-api) |

> **推断（非东财）**：这组字段名（`cmd`/`sort`/`batchflag`/`bankurl`/`partnerid`/`gbbc`）风格非常像**通达信 / 某些中小券商的 Web 交易网关**，不是东财的。**建议不要按这组字段去设计 schema**，否则一定会踩空。

### 3.4 模拟盘（模拟组合）业务规则 —— 直接影响系统设计

**官方口径 A（散户模拟组合）**，来源 [mobapppages.eastmoney.com/helper/Q037.html](http://mobapppages.eastmoney.com/helper/Q037.html)：
- 需注册通行证 + 绑手机号；每人**至多 20 个**投资组合，每个初始虚拟资金 **100 万元**
- 交易时间：**15:00–17:00 是清算时间，不能接受委托**；其他时间均可接受委托/撤单，**包含隔夜单**
- **当日未成交的委托单在日中清算时自动撤销**（⇒ 不做隔夜单策略）
- 交易品种：**仅沪深交易所上市的 A 股股票和基金**；不支持其他品种，**不支持新股申购**
- 买入申报数量为 **100 股整数倍**；价格最小变动 0.01 元；单笔 < 100 万股；卖出可零股
- **T+1**；撮合：买价 ≥ 最新价按最新价成交，买价 < 最新价进撮合队列
- 涨跌停：涨停板不开则不成交；跌停同理
- 费用：**佣金千分之一（双向，含过户费）**；**印花税千分之一（卖出）**；配股不收费
- 派息 R 日到账、扣 10% 所得税；送股/配股按交易所公告
- 风险声明：系统异常时东财**有权暂停操作并把异常时段买卖数据重置回当日或前一日开盘前状态**

**官方口径 B（东方财富金融终端内模拟交易）**，来源 [emdesk 模拟交易 FAQ](https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/link/mnjy.html)：
- 首次进入需创建账户，自定账户名与初始金额；每个账号最多 4 个账户（**与 A 的 20 个冲突 —— 两套系统，以哪个为准需实测**）
- 支持调整佣金费率，范围 0.03%–0.3%
- **不支持新股申购、市值配售、增发申购；没有集合竞价阶段的挂单限制**
- 历史成交/资金流水查询时间范围 < 30 天

**官方口径 C（金融挑战赛专用模拟盘）**，来源 [young.eastmoney.com/xyds/H5/pop/introduceshare.html](https://young.eastmoney.com/xyds/H5/pop/introduceshare.html)：
- 交易时间 9:30–11:30 / 13:00–15:00；**清算 16:30–17:00，清算期间不允许下单委托**
- 手续费双边 **0.025%，最低 5 元**（含印花税和过户费）—— 与 A 的千分之一不同
- 初始资金 100 万；T+1；**不支持基金拆分、新股申购、市值配售、增发申购、配股**
- 成交价**每 3 秒更新一次**，不是完全实时 ⇒ 委托可能不按预期成交
- 当天未成交委托收市后自动作废

> ⚠️ **三套口径费率/清算时间不一致，说明"模拟盘"在东财内部不止一个子系统。** 你的系统必须**先明确到底用哪一个**（APP「模拟组合」 vs 「金融挑战赛」比赛盘 vs PC 终端模拟交易），并把清算时间写进调度器。

### 3.5 东财 APP 里模拟盘的入口路径（**未经本人实测，仅来自官方/第三方文字描述**）

- 「APP 首页 → 更多 → 模拟交易 → 立即参赛」/「APP 首页点击【模拟交易】入口注册账户，默认给你 100 万虚拟资金」→ [叩富网](https://licai.cofool.com/ask/qa_5735264.html)、[叩富网 2](https://licai.jiantou8.com/ask/vipqa_6318109_39281106.html)
- 「APP → 首页左上角人头像 → 个人中心 → **我的组合** → 创建组合 → 创建模拟组合」→ [百度知道](https://zhidao.baidu.com/question/1938340640621559427.html)
- 「APP 下方**交易 → 上方模拟** → 一键领取模拟金（默认 10 万，可自选额度）」（此条来自**期货** APP，但"交易页顶部模拟按钮"这个 UI 模式与股票 APP 高度相似）→ [qhweb.eastmoney.com/help/2299652.html](https://qhweb.eastmoney.com/help/2299652.html)
- 妙想 flow：「APP 首页搜索『妙想 Skills』领取 → APP 下方交易 → 上方模拟，领取 20 万模拟资金 → 下滑找到『妙想模拟组合管理』skill，绑定模拟组合」→ [AnacondaKC/Aniu](https://github.com/AnacondaKC/Aniu)

> **控件 id / resource-id：全部未证实。** 任何人贴出东财 APP 的 resource-id 都需要实测核对；本报告不编造。

### 3.6 GUI 自动化在"模拟盘"场景的具体坑（结合真实参考实现）

参考实现：[mrz-itz/qwen3.5-4b-quant-trading](https://github.com/mrz-itz/qwen3.5-4b-quant-trading)（同花顺模拟炒股，雷电模拟器 + adb/uiautomator + 截图多模态）

**它踩过的坑（原文要点）**
1. **`input text` 只能输数字/字母/符号** —— 中文必须走剪贴板或逐字 `set_text`
2. **UI 会随版本变化** ⇒ 必须有「校准」流程：`probe` 导出当前屏可见元素坐标 + 截图 → 人工填写 `selectors.json` → `--dry` 验证 → `--live` 小额实测
3. **行情接口是公开免费源但会限流/断连** ⇒ 极端情况**跳过该股继续，不硬下单**（这一点直接对应"宁可漏单不可错单"）
4. 盘中调用大模型要限频（`MODEL_CALL_MIN_INTERVAL`）
5. 模拟器分辨率必须固定（示例用 1440×2560）

**它给出的 `selectors.json` 模板（可直接照抄结构给东财用）**
```json
{
  "search_entry": { "by": "text", "text": "搜索" },
  "trade_tab":    { "by": "text", "text": "交易" },
  "sim_entry":    { "by": "text", "text": "模拟" },
  "positions_tab":{ "by": "text", "text": "持仓" },
  "buy_btn":      { "by": "text", "text": "买" },
  "sell_btn":     { "by": "text", "text": "卖" },
  "qty_field":    { "by": "text", "text": "数量" },
  "confirm_buy":  { "by": "text", "text": "买入" },
  "confirm_sell": { "by": "text", "text": "卖出" }
}
```
> `by=text` = 按节点文本匹配，`by=desc` = 按 `content-desc` 匹配。

**东财模拟盘场景额外要处理的（部分基于通用 Android 自动化经验，需实测）**
| 坑 | 说明 | 缓解 |
|---|---|---|
| **行情刷新导致控件抖动** | 价格/涨跌幅每秒变，文本 selector 会"看起来存在但值不对"；某些 App 用 `RecyclerView` 复用 item | 定位用**稳定文案/资源 id**，**数值一律从行情源单独取**，不要从 UI 读价格 |
| **集合竞价** | 9:15–9:25 集合竞价，9:20–9:25 不可撤单；官方口径 A/B 都说模拟盘**没有集合竞价挂单限制**，口径 C 有交易时间限制 | 调度器避开 9:15–9:30；且**以官方口径为准实测** |
| **当日未成交委托在清算时自动撤销** | 挂了不成交就没了 | 撤单逻辑必须在清算窗口前触发 |
| **弹窗风暴** | 开户营销、Level-2 推送、活动广告、半屏推荐 | `uiautomator2` 的 `d.watcher.when("...").click()` 监听并自动关；或 Maestro `retry` |
| **滑动/图形验证码** | 若模拟盘也走通行证登录，可能出现 | 模拟组合只需**通行证**登录（不是资金账号），风险低于实盘；但仍需预案。**未证实模拟盘登录是否要验证码** |
| **指纹/面容 / 交易密码弹窗** | 实盘必然有；模拟组合大概率不需要 | — |
| **横竖屏 / 分屏 / 字体缩放** | 改字体大小会让像素模板失效 | 锁定模拟器：固定分辨率 + 固定 font_scale + `d.freeze_rotation(True)`（uiautomator2 支持） |
| **息屏/后台杀进程** | 息屏后 uiautomator2 的 watcher 可能死 | `d.screen_on()`；给 uiautomator2 agent 进程加保活；scrcpy 场景用 `--keep-active` |
| **adb over WiFi 掉线** | 移动网络断流 | 优先 USB / 有线；或用雷电模拟器本机 adb |
| **uiautomator2 agent 被杀** | 内存不足 | 模拟器给足内存；`adb shell ps` 监控 |
| **模拟盘不支持新股申购** | "一键打新"在模拟盘上没有 | 别设计打新策略 |
| **融资融券 / ETF / 港股通** | 官方口径 A：仅沪深 A 股股票和**基金**；**未提及两融、港股通** | 港股通/两融在模拟盘上**未证实**，需实测 |

**若模拟盘界面是 WebView/H5 渲染（可能性不低，因为它与网页端数据同步）** ⇒
- `uiautomator2` 只能看到一个 `WebView` 节点，**内部控件不可见** ⇒ 必须切换到 **Airtest 图像模式** 或 **scrcpy + PC 视觉**
- **这是选技术路线前必须先做的第一个实验**（见 §4）

**通用框架要点**
- **uiautomator2**：`d(text="买入")` / `d(resourceId="...")` / `d.xpath("//*[@text='买入']")`（XPath 支持中文，仓库有专门 `XPATH_CN.md`）；`d.screenshot()` 返回 Pillow Image 可直接喂 OpenCV；`d.implicitly_wait(10)`；`d.app_start(pkg, stop=True)`；`d.shell("...")` 跑 adb 命令；`d.press("back")`；`d.screen_on()`；`d.freeze_rotation(True)`；`d.settings['wait_timeout']=20`；watcher 弹窗自动点击。
  > 来源：[openatx/uiautomator2 QUICK_REFERENCE.md](https://github.com/openatx/uiautomator2/blob/master/QUICK_REFERENCE.md)
- **Maestro**：`tapOn` / `inputText` / `assertVisible` / `assertNotVisible` / `extendedWaitUntil` / `scrollUntilVisible` / `repeat` / `retry` / `runFlow` / `takeScreenshot` / `setOrientation` / `waitForAnimationToEnd` / `copyTextFrom` / `pasteText` / `evalScript` / `runScript`。声明式 YAML，无代码量。
  > 来源：[docs.maestro.dev/reference/commands-available](https://docs.maestro.dev/reference/commands-available)
- **Airtest**：`init_device("Android")` / `touch(Template("x.png"))` / `swipe(Template(a), Template(b))` / `assert_exists(Template(...))`；CLI `airtest run <dir> --device Android:///` + `airtest report`。
  > 来源：[AirtestProject/Airtest README](https://github.com/AirtestProject/Airtest)
- **scrcpy**：v5.0.1；`--otg` 免投屏直接键鼠控制；`--no-audio`；`--keep-active`（息屏保持镜像）；右键=BACK，中键=HOME；`-m1024` 降分辨率提升性能；需开 `USB debugging (Security Settings)` 才能用键鼠控制。
  > 来源：[Genymobile/scrcpy README](https://github.com/Genymobile/scrcpy)

### 3.7 半自动 / 人机协同方案（S6/S7）具体形态

推荐「**程序出信号 + 一键确认**」：
1. 程序（行情源：`push2.eastmoney.com` 或 `emhsmarketwg.eastmoneysec.com/api/SHSZQuoteSnapshot`）算信号 → 生成待下单清单
2. 推送（企业微信/钉钉/邮件/本地 Webhook）到手机或桌面
3. 人在**东财 APP** 里手动点确认下单（满足"只能 GUI"的约束，且人确认这一步天然规避误单）
4. 或反过来：程序用 uiautomator2 **填好代码/价格/数量，停在"确定"按钮前**，等人点一下（=S7）。这在协议上是"辅助输入"而非"自动交易"，但**法律定性仍不明确**，需自行判断。

行情接口（模拟盘/实盘都可用，只读）：
- `GET https://push2.eastmoney.com/api/qt/stock/get?secid=1.600519&ut=<token>&fields=f43,f57,f58,...` → [roiding/shadowflow 文档](https://github.com/roiding/shadowflow/blob/main/docs/EASTMONEY_PUSH2_API.md)
- `GET https://emhsmarketwg.eastmoneysec.com/api/SHSZQuoteSnapshot?id=600519&market=HA`（东财证券自建行情网关，`riiy/emtl` 在用）→ [riiy/emtl/src/emtl/core.py](https://github.com/riiy/emtl/blob/master/src/emtl/core.py)
- 完整 K 线：`GET https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=...&ut=...&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61`
- ⚠️ 文档实测：**push2 对非浏览器 UA 的 curl/Go 请求会随机返回 `Empty reply from server` / EOF**，同标的最短成功间隔约 5s、最短失败间隔约 8s；这是实测观察**不是公开规则** → 同上 shadowflow 文档

---

## 4. 未解问题 / 需要用户自己验证的点（按优先级）

### P0 —— 决定整个方案走向，必测
1. **【决定性】"移动版 模拟盘"到底指哪一个？**
   - ① APP「模拟组合」（group.eastmoney.com 那种，100 万）
   - ② APP「交易 → 模拟」里的妙想模拟金账户（10 万/20 万）
   - ③ 「金融挑战赛」专用比赛盘
   三者资金量、费率、清算时间、接口都不同（见 §3.4）。**请给一张 APP 截图或描述确切路径。**
2. **妙想 API 拿到的 key，操作的是不是 APP 里同一个模拟组合？**
   实测：APP 里创建组合 → 妙想 API `positions`/`balance` 是否能读到该组合。
3. **妙想 API 的调用限额是多少？**（错误码 113 触发阈值）够不够你的策略频率？拿不到就测 limit。
4. **模拟盘界面是原生 View 还是 WebView/H5？**
   决定 uiautomator2 可用性。方法：`adb shell dumpsys activity top` 看当前 Activity；或 `u2cli dump-hierarchy` 看模拟盘页面里有没有 `android.webkit.WebView` 节点。

### P1 —— 影响实现细节
5. 东财 APP 的 **package name**（大概率是 `com.eastmoney.android.berlin` 或类似，**未证实，不要直接抄**）—— 用 `adb shell pm list packages | grep -i east` 自己查。
6. **模拟盘下单流程的具体控件文案与 resource-id**：`u2cli dump-hierarchy` 逐屏导出 → 建 `selectors.json`（照 §3.6 的模板）。
7. **模拟盘登录是否需要图形验证码/短信？** 会话能维持多久？后台是否掉线？
8. **模拟盘是否支持条件单/止盈止损单？** 官方只证实了**期货**模拟账户支持模拟条件单；**股票模拟组合未证实**。若不支持 ⇒ 止盈止损必须自己写。
9. **模拟盘是否支持 ETF / 可转债 / 两融 / 港股通 / 北交所？** 官方口径只说"沪深 A 股股票和基金"。
10. **模拟盘是否支持市价单？** 妙想 API 支持 `useMarketPrice`；APP 是否也支持？
11. **"一键打新"在模拟盘是否存在？** 官方口径说不支持新股申购 ⇒ 大概率没有。

### P2 —— 合规与运维
12. 是否愿意承担违反《东方财富用户服务协议》第二条 2 第(3)项（"插件/外挂/第三方软件/设备干扰"）的风险？东财有权"限制账户功能、中止或终止服务"。→ [协议原文](https://about.eastmoney.com/home/protocol)
13. 是否愿意做**程序化交易报备**？按《证券市场程序化交易管理规定（试行）》（证监会公告〔2024〕8 号，**2024-10-08 施行**）第二条，"通过计算机程序自动生成或者下达交易指令在证券交易所进行证券交易"即为程序化交易；**但第二条列举的适用主体是私募基金/QFII/券商自营/公募/保险等机构与"交易所认定的其他投资者"**，普通个人散户是否被纳入报告管理范围 **未证实**（需看沪深北交易所《程序化交易管理实施细则》的具体界定）。→ [证监会公告](http://www.csrc.gov.cn/csrc/c101954/c7480579/content.shtml)、[国务院公报全文](https://www.gov.cn/gongbao/2024/issue_11426/202406/content_6959680.html)、[证监会答记者问](http://jrj.sh.gov.cn/RDHY238/20240711/6ae54f9d16bc4686a855eaf9977e9209.html)
    - 特别注意：该规定**不区分是否用 GUI**。"用 uiautomator2 点 App" 与 "直接 POST 交易接口" 在监管定义上**都是程序化交易**。
14. 用**模拟盘**做程序化交易，在交易所/券商层面是否需要报备？**未证实**（模拟盘不产生真实成交，通常不在报告范围内，但需要看细则）。
15. 是否已确认 `jywg.18.cn` 的频率限制？`pytrader` issue #16 至今无答案。→ [issue #16](https://github.com/jadepeng/pytrader/issues/16)

### P3 —— 已知但需长期观察
16. 模拟组合的**3 秒级成交价刷新**（金融挑战赛口径）意味着 GUI 读到的价格可能已过期 ⇒ 价格必须由独立行情源给。
17. 东财 APP 宕机历史（2024-03-21、2022-11-09 早盘均曾全网崩盘）⇒ 你的调度器必须有"下单失败重试/告警"，不能假设交易时段系统可用。

---

## 5. 参考链接列表

### 5.1 东方财富官方
| 内容 | URL |
|---|---|
| **东方财富用户服务协议**（含"插件/外挂/设备干扰"禁止条款） | https://about.eastmoney.com/home/protocol |
| 东方财富网法律声明（"使用任何设备、软件或程序干扰"） | https://about.eastmoney.com/home/legal |
| 东方财富隐私保护指引 | https://about.eastmoney.com/home/conceal |
| 产品最终用户许可协议及隐私政策（终端） | https://zqhd.eastmoney.com/cp/yhxkxy2.htm |
| 东方财富网网站服务使用协议 | https://passport2.eastmoney.com/pub/FAQ/Service.html |
| 财富号平台服务协议（"不得使用插件、外挂"） | https://mycaifuhao.eastmoney.com/usercenter/home/qaq |
| 妙想服务协议 | https://ai.eastmoney.com/privacy/#/fwxy |
| **模拟交易 FAQ（官方）** | https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/link/mnjy.html |
| 终端常见问题解答（模拟交易问 23/24/25） | https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/link/zjl.html |
| **智能交易（条件单/网格/止盈止损/策略清仓）** | https://emdesk.eastmoney.com/pc_activity/Pages/VIPTrade/pages/aitrade.html |
| **APP 帮助中心 Q037「沪深模拟组合怎么用」** | http://mobapppages.eastmoney.com/helper/Q037.html |
| **金融挑战赛规则（模拟交易规则/成交规则）** | https://young.eastmoney.com/xyds/H5/pop/introduceshare.html |
| 创建模拟组合（web 端） | https://group.eastmoney.com/CreateCom.html |
| 模拟组合交易页（web 端） | https://group.eastmoney.com/room/index.html |
| 期货 APP 帮助：模拟账户创建流程 | https://qhweb.eastmoney.com/help/2299652.html |
| 期货 APP 帮助：模拟账户穿仓 / **模拟条件单** | https://qhweb.eastmoney.com/help/2586405.html |
| EMC 智能交易终端说明书（仿真登录，PDF） | https://swdlcdn.eastmoney.com/emt/EmtHelp/%E4%B8%9C%E8%B4%A2EMC%E4%BA%A4%E6%98%93%E7%BB%88%E7%AB%AF%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E4%B9%A61.2.pdf |
| 机构交易终端说明书（PDF） | https://swdlcdn.eastmoney.com/emt/EmtHelp/%E6%9C%BA%E6%9E%84%E4%BA%A4%E6%98%93%E7%BB%88%E7%AB%AF%E4%BD%BF%E7%94%A8%E8%AF%B4%E6%98%8E%E4%B9%A6V1.2.pdf |
| 东方财富证券机构交易平台（EMT/EMQ API 测试账号） | https://emt.eastmoneysec.com/article/article-info/87436563 |
| 东财掘金 快速开始（回测/仿真/实盘，PDF） | https://emquant.18.cn/help/doc/guide/book.pdf |
| 东财掘金 常见问题（仿真 FAQ，PDF） | https://emquant.18.cn/help/doc/faq/book.pdf |
| 掘金 Python 交易函数 | https://emquant.18.cn/help/doc/python/python_trade_api.html |
| 掘金量化帮助文档 | https://emt.18.cn/api/quant-help/guide/book.pdf |

### 5.2 开源代码
| 项目 | URL | 要点 |
|---|---|---|
| **riiy/emtl** | https://github.com/riiy/emtl | ★80，Python，`jywg.18.cn` 全端点；[const.py](https://github.com/riiy/emtl/blob/master/src/emtl/const.py)、[core.py](https://github.com/riiy/emtl/blob/master/src/emtl/core.py)、[utils.py](https://github.com/riiy/emtl/blob/master/src/emtl/utils.py)；[issue #1](https://github.com/riiy/emtl/issues/1) |
| **jadepeng/pytrader** | https://github.com/jadepeng/pytrader | easytrader 魔改；[eastmoney_trader.py](https://github.com/jadepeng/pytrader/blob/main/easytrader/eastmoney_trader.py)、[config/jywg.json](https://github.com/jadepeng/pytrader/blob/main/easytrader/config/jywg.json)；[issues](https://github.com/jadepeng/pytrader/issues) |
| **wmo-v/eastmoneyapi** | https://github.com/wmo-v/eastmoneyapi | Go 版；[client/client.go](https://github.com/wmo-v/eastmoneyapi/blob/master/client/client.go)、[util/common.go](https://github.com/wmo-v/eastmoneyapi/blob/master/util/common.go) |
| **joechen2010/stock-api** | https://github.com/joechen2010/stock-api | Java，H5TradeApi，**实现闭源/付费**；含 `gdk` 字段 |
| shidenggui/easytrader（上游） | https://github.com/shidenggui/easytrader | **不支持东方财富**；[文档](https://easytrader.readthedocs.io/) |
| **mrz-itz/qwen3.5-4b-quant-trading** | https://github.com/mrz-itz/qwen3.5-4b-quant-trading | ⭐ **GUI 自动化模拟炒股参考实现**（同花顺 + 雷电 + uiautomator + 多模态） |
| **AnacondaKC/Aniu** | https://github.com/AnacondaKC/Aniu | ★183，用**妙想官方 API** 的 AI 模拟炒股平台（FastAPI+React+SQLite） |
| zxinyun/yygmx | https://github.com/zxinyun/yygmx | 妙想 API 版本 Aniu |
| jm12138/eastmoney-mx-finance-mcp-server | https://github.com/jm12138/eastmoney-mx-finance-mcp-server | 妙想 API → MCP server |
| cattomgithub/eastmoney-mx-skills | https://github.com/cattomgithub/eastmoney-mx-skills | 妙想 `mx_moni.py` 参考实现 |
| flp516/eastmoney-mx-skills-suite-v2 | https://github.com/flp516/eastmoney-mx-skills-suite-v2 | [mx-stock-simulator.md 最完整接口文档](https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md) |
| 18816132863/xiaoyi-claw-omega-final | https://github.com/18816132863/xiaoyi-claw-omega-final/blob/main/skills/eastmoney-mx-skills-suite/references/mx-stock-simulator.md | 妙想 skill 完整字段表 |
| roiding/shadowflow | https://github.com/roiding/shadowflow/blob/main/docs/EASTMONEY_PUSH2_API.md | push2 行情接口规范 + 反爬实测 |

### 5.3 GUI 自动化框架
| 项目 | URL |
|---|---|
| openatx/uiautomator2 | https://github.com/openatx/uiautomator2（[QUICK_REFERENCE.md](https://github.com/openatx/uiautomator2/blob/master/QUICK_REFERENCE.md)、[XPATH_CN.md](https://github.com/openatx/uiautomator2/blob/master/XPATH_CN.md)、[SKILL.md](https://github.com/openatx/uiautomator2/blob/master/skills/uiautomator2/SKILL.md)） |
| Maestro 文档 | https://docs.maestro.dev/reference/commands-available |
| Airtest | https://github.com/AirtestProject/Airtest |
| Poco | https://github.com/AirtestProject/Poco |
| scrcpy | https://github.com/Genymobile/scrcpy |
| Appium UiAutomator2 driver | https://appium.io/docs/en/latest/ |

### 5.4 法规与社区
| 内容 | URL |
|---|---|
| **《证券市场程序化交易管理规定（试行）》**（证监会公告〔2024〕8 号，2024-10-08 施行） | http://www.csrc.gov.cn/csrc/c101954/c7480579/content.shtml ｜ [PDF](http://www.csrc.gov.cn/csrc/c101954/c7480579/7480579/files/%E9%99%84%E4%BB%B61%EF%BC%9A%E8%AF%81%E5%88%B8%E5%B8%82%E5%9C%BA%E7%A8%8B%E5%BA%8F%E5%8C%96%E4%BA%A4%E6%98%93%E7%AE%A1%E7%90%86%E8%A7%84%E5%AE%9A%EF%BC%88%E8%AF%95%E8%A1%8C%EF%BC%89.pdf) ｜ [国务院公报全文](https://www.gov.cn/gongbao/2024/issue_11426/202406/content_6959680.html) |
| 证监会答记者问（程序化交易监管进展） | http://jrj.sh.gov.cn/RDHY238/20240711/6ae54f9d16bc4686a855eaf9977e9209.html |
| 证监会发布稿 | https://www.csrc.gov.cn/csrc/c100028/c7480577/content.shtml |
| 掘金：东方财富交易 web 接口 | https://juejin.cn/post/7205928315587543098 |
| 博客：东方财富 Python 下单（pytrader 实践） | https://blog.hejiangda.top/2024/05/24/20-45-00 |
| 博客园：pytrader 介绍 | https://www.cnblogs.com/xiaoqi/p/pytrader.html |
| 东方财富行情接口 JS 逆向（secids / AES） | https://developer.aliyun.com/article/1582351 ｜ https://blog.csdn.net/weixin_52392194/article/details/141111116 |
| 叩富：东方财富模拟交易流程（含"条件单"说法，营销号内容，仅作线索） | https://licai.cofool.com/ask/qa_5735264.html |
| 百度知道：APP 内创建模拟组合路径 | https://zhidao.baidu.com/question/1938340640621559427.html |

---

## 6. 给决策者的一句话建议

> **先用妙想官方 API（§3.1）验证"能不能读到这个模拟组合、能不能下单"**（半天工作量）。
> 如果 key 拿不到 / 限额不够 / 账户对不上，再走 GUI 路线，并且**直接 fork `mrz-itz/qwen3.5-4b-quant-trading` 做骨架**（它已经解决了模拟器、uiautomator、弹窗、截图校验、校准流程、熔断全部问题）。
> **无论走哪条路，"下单前人工确认"这一步都建议保留** —— 它把协议风险和误单风险同时降一个数量级。
