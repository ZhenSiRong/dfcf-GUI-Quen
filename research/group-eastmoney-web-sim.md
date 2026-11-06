# 东方财富网页版「模拟炒股 / 模拟组合」浏览器自动化（Playwright/Selenium/Puppeteer）可行性调研

> 调研日期：2026-11-05　调研范围：中国 A 股语境
> 目标：判断 `https://group.eastmoney.com/room/`（投资组合交易中心）能否被 Playwright/Selenium/Puppeteer 驱动，作为比 Android UI 自动化更稳的「走官方 UI」路线。
> 方法：直接抓取站点静态资源 + 用真实 Chrome（Playwright）实测渲染/网络/登录弹窗 + GitHub 代码搜索 + 官方帮助中心/妙想 Skills 前端 JS 逆向式阅读。

---

## 0. 结论摘要（TL;DR）

| 结论 | 强度 |
|---|---|
| **可以。** 东方财富网页版模拟盘（PC）**和移动 H5 版**都存在完整的下单 UI，且底层是**明文 JSONP/POST 接口**，浏览器自动化完全可行 | ✅ 已实测 |
| PC 端 `https://group.eastmoney.com/room/` 是 **jQuery + webpack 的客户端渲染交易台**（非 SSR），交易 UI 由 `js/index.js` 驱动 | ✅ 已实测 |
| **PC 端「买入/卖出」是单击即下单，没有二次确认弹窗**（`#btnOrder` → `spo_order` 直接发出）→ Playwright 自动化极简 | ✅ 源码证实 |
| 移动 H5 `https://groupwap.eastmoney.com/group/simulation/buy.html` 是**完整可用的手机模拟盘交易页**（买入/卖出/撤单/持仓/委托成交），自带「买入确认」弹窗 | ✅ 已实测 |
| APP 与 WEB 的模拟组合**是同一套数据**（官方明示「web端和APP端的投资组合数据是同步更新的」） | ✅ 官方文案 |
| 官方 **妙想 mockTrading API** 操作的就是**你自己已创建的沪深模拟组合**（Skills 页面让你「选择已有建沪深模拟组合进行绑定」）→ 妙想 API = 同一组合，只是另一条通道 | ✅ 官方前端 JS |
| group.eastmoney.com / groupwap.eastmoney.com **未发现 JS 反爬（无 `acw_sc__v2`、无 `__jsl_clearance`、无 `_0x` 混淆、无 webdriver 检测）** | ✅ 已实测（但见 §5.6 保留意见） |
| ⚠️ **硬坑**：`https://group.eastmoney.com/room/` 引用了 `http://` 的 jQuery 与 topnav1200.js，**HTTPS 下被浏览器 Mixed-Content 拦截 → 整页 JS 挂掉**。必须用 `http://` 或做请求重写 | ✅ 已实测（重要） |
| ⚠️ 登录走 `exaccount.eastmoney.com` **iframe 弹窗**，且存在**条件性图形验证码**（`hdAccountCaptRtn` / "请点击刷新"） | ✅ 已实测 |
| ⚠️ 妙想 API **有严格日限额**（免费版基础 50 次/天，休眠账户 10 次/天），不适合高频策略 | ✅ 官方前端 JS |
| 已有可借鉴的 Playwright 案例：`LilianaMajamay/jiarenmens`（Playwright 爬 group.eastmoney.com 实盘组合）、`trading-a/ai_ths_moni_trading_mcp`（Playwright+CDP 驱动同花顺**网页模拟盘**） | ✅ 已核实 |

**总体建议**：如果目标是「在官方 UI 上自动下单、且组合要与 APP 互通」，**优先级排序**：

1. **WEB 模拟盘 + Playwright（直接驱动 DOM）** —— 组合与 APP 天然同步，无 API 限额，单击下单；风险是页面是 2015 年代的老 jQuery 代码 + 混合内容坑。
2. **WAP 模拟盘 H5 + Playwright（移动 UA）** —— 页面更现代、有确认弹窗、URL 直达，最接近"手机上操作"，同样与 APP 同步。
3. **官方妙想 API** —— 最稳、最省事，但**有日限额**，且需在 APP 里领取 Key + 绑定组合；适合低频决策型策略，不适合高频/盘中轮询。

---

## 1. `https://group.eastmoney.com/room/` 今天是什么？

### 1.1 页面身份与渲染方式

```
$ curl -sL -D- https://group.eastmoney.com/room/ -o room.html
HTTP/1.1 200 OK
Server: Tengine
Content-Type: text/html
Content-Length: 51571
Last-Modified: Fri, 18 Sep 2026 09:06:27 GMT
X-Powered-By: ASP.NET
```

* `<title>` = **投资组合交易中心-东方财富网**
* `<meta name="keywords">` = `投资组合,股票组合,模拟交易,模拟组合,自选组合,组合管理,股票收益走势,股票持仓,组合收益排行`
* 顶部导航：`../index.html`（投资组合首页）、`../mcombin.html`（模拟组合）、`../OperatLog.html`（操盘日志）、`../CombinComment.html`（组合评论）
* 服务器是 ASP.NET（`.aspx` 后端），但**页面本体是静态 HTML + 客户端 JS**

**渲染方式：客户端渲染（SPA-like, jQuery + webpack）**，不是 SSR：

| 资源 | 作用 |
|---|---|
| `https://group.eastmoney.com/room/js/config.js?1.3.7` | API 主机表（见 §2） |
| `https://group.eastmoney.com/room/js/index.js?1.3.7` | webpack bundle（292 KB），包含全部交易逻辑与 API 调用 |
| `https://group.eastmoney.com/room/js/libs.js?1.3.7` | jQuery tmpl、boxy 弹窗、图表辅助 |
| `https://group.eastmoney.com/room/js/tread/common.js` | 公共工具（`bind_phone`、`getMarketCode`、`thisCodeFormat` 等） |
| `//emcharts.dfcfw.com/ec/3.14.0/emcharts.min.js` | 图表（canvas/ECharts 风格，**对下单无影响**） |
| `//emcharts.dfcfw.com/suggest/stocksuggest2017.min.js` | 股票搜索框 |
| `//emres.dfcfw.com/public/js/topnav1200.js` | 顶部导航 + 登录/登出 |

页面 DOM 中，交易区是**静态骨架**（`#futcode`、`#price`、`#codenumber`、`#btnOrder`、`#ulzhlist`、持仓/委托/成交表格容器），数据全部由 `index.js` 里的 `dataevent.*` 函数通过 AJAX 填充。

### 1.2 登录：需要东方财富通行证（cookie）

* 未登录时，`index.js` 的 `dataevent.获取用户状态()` 走：`if (!newtraed.userinfo.CToken) { jysisok = false; _login(); } else { dataevent.获取组合列表(p); }`
* `_login()` 定义在 `//emcharts.dfcfw.com/usercollect/usercollect.min.js`（实测 `typeof window._login === 'function'`）。
* 实测（Playwright，`http://group.eastmoney.com/room/`）**自动弹出通行证登录 iframe**：

```html
<iframe id="loginframe" width="360" height="460"
  src="http://exaccount.eastmoney.com/Home/Login?request=%7B%22autoResize%22%3Afalse,
       %22agentPageUrl%22%3A%22%2F%2Fgroup.eastmoney.com%2Flogin_agent.html%22,
       %22callBack%22%3A%22loginok%22,
       %22redirectUrl%22%3A%22http%253A%252F%252Fgroup.eastmoney.com%252Froom%252F%22,
       %22data%22%3A%7B%22domainName%22%3A%22group.eastmoney.com%22,%22deviceType%22%3A%22web%22,
       %22productType%22%3A%22dongcai%22,%22version%22%3A%2216.0.0%22%7D%7D">
```

* 登录成功后 `loginok()` → `self.location.reload()`。
* **认证靠 3 个 cookie**（`index.js` + `common.js` 实测）：

| Cookie | 含义 | 解析方式 |
|---|---|---|
| `uidal` | `uid`(前 16 字符) + 用户名 | `decodeURI(cookie['uidal']).substring(0,16)` |
| `uid` | 用户 id（WAP 侧使用） | 取前 16 字符 |
| `ct` | CToken（通行证会话） | 直接透传 |
| `ut` | UToken（通行证会话） | 直接透传 |

  `index.js`：
  ```js
  var decuidal = decodeURI($.cookie('uidal')) || "";
  this.userinfo.uid    = decuidal.substring(0, 16);
  this.userinfo.name   = decuidal.substring(16);
  this.userinfo.CToken = $.cookie("ct") || "";
  this.userinfo.UToken = $.cookie("ut") || "";
  ```

### 1.3 行情/成交推送通道：**没有 WebSocket / SSE**

* 行情：`//push2.eastmoney.com/api/qt/ulist.np/get?...&ut=b2884a393a59ad64002292a3e90d46a5`，**JSONP 轮询**。
  - 页面头部三大指数：`setInterval(getHqData, 60000)`（60 秒）
  - 逐笔成交：`//{0}.push2.eastmoney.com` JSONP 轮询
  - K 线：`http://pdfm2.eastmoney.com/EM_UBG_PDTI_Fast/api/js`（token `894050c76af8597a853f5b408b759f5d`）
* 交易侧刷新：`index.js` 里
  ```js
  var traedtimer = setInterval(function () {
      if (window.iskp && jysisok && zjzh) {
          if (nowtime - ldatatime > 5000) { loadtabdata(); dataevent.加载资金信息(zjzh); }
      }
  }, 300);
  ```
  即**每 5 秒**刷新一次持仓/委托/成交/资金（仅在开盘时间 `window.iskp`）。
* 结论：**全站无 WebSocket / SSE**，全是 JSONP/HTTP 轮询 → 对浏览器自动化非常友好（无需要维持的长连接状态机）。

### 1.4 ⚠️ 实测发现的重大坑：HTTPS 下 Mixed Content 导致整页 JS 失效

`room.html` 里写的是 **http://** 脚本：

```html
<script type="text/javascript" src="http://www.eastmoney.com/js/jquery.min.js"></script>
<script src="http://emres.dfcfw.com/public/js/topnav1200.js" type="text/javascript"></script>
```

Playwright 实测 `https://group.eastmoney.com/room/`：

```
[console.error] Mixed Content: The page at 'https://group.eastmoney.com/room/' was loaded over HTTPS,
                but requested an insecure script 'http://www.eastmoney.com/js/jquery.min.js'.
                This request has been blocked; the content must be served over HTTPS.
[PAGEERROR] ReferenceError: $ is not defined
[PAGEERROR] ReferenceError: jQuery is not defined
→ jQuery 加载：function ?  否（undefined）
→ 自选股 API 未发出，交易 UI 无任何事件绑定
```

换成 `http://group.eastmoney.com/room/` 立刻正常：

```
-- jQuery loaded? -- function
-- _login -- function
-- login frame present? -- true
API: GET http://myfavor.eastmoney.com/v4/webouter/gsaandcheck?cb=jQuery...&appkey=e9166c7e9cdfad3aa3fd7d93b757e9b1
```

**给自动化实现的直接建议**：

* 方案 A：直接用 `http://group.eastmoney.com/room/`（最简单；代价是明文传输，登录密码/Token 走明文 —— **不建议**在不可信网络上做）。
* 方案 B：坚持 HTTPS，用 Playwright 路由把这两个 `http://` 资源重写到 `https://`：
  ```js
  await ctx.route('http://www.eastmoney.com/js/jquery.min.js',
                  r => r.continue({ url: r.request().url().replace('http://','https://') }));
  await ctx.route('http://emres.dfcfw.com/public/js/topnav1200.js',
                  r => r.continue({ url: r.request().url().replace('http://','https://') }));
  ```
* 方案 C（推荐）：**直接用 WAP 移动版**（§4）—— 纯 HTTPS、无混合内容、页面现代。

---

## 2. Web 模拟盘交易 API（完整端点表，全部来自官方前端代码）

### 2.1 主机与参数

来源：`https://group.eastmoney.com/room/js/config.js?1.3.7`（实测原文）：

```js
var config = {
    apiurl: {
        "mystock": "//myfavor.eastmoney.com/v4/",
        "simqry":  "https://simqry2.eastmoney.com/qry_tzzh_v2",
        "simoper": "https://simoper.eastmoney.com/oper_tzzh_v2",
        "group":   "https://group.eastmoney.com",
        hqlist:    "//push2.eastmoney.com",
        hqsz:     "//{0}.push2.eastmoney.com",
        hqfs:     "//{0}.push2.eastmoney.com",
        hqut:     "b2884a393a59ad64002292a3e90d46a5"
    }
}
```

`https://group.eastmoney.com/JS/common/config.js?v=20250220` 另有一份等价配置（`CONFIG.interfaceURL`）：

```js
interfaceURL: [
    'https://simqry2.eastmoney.com/',
    'https://simoper.eastmoney.com/',
    '//myfavor.eastmoney.com/v4/',
    'https://group.eastmoney.com/'
]
```

**传输方式**：全部 **JSONP GET**（`dataType:'jsonp'`, `jsonp:'cb'`），因此**无需 CORS 处理**，用 `requests` 也能直接抓。

**公共参数**（`index.js` 的 `traed.prototype.ajax`）：

```js
var paramdata = $.extend({
    userid:   _this.userinfo.uid,      // cookie uidal 前 16 位
    ctToken:  _this.userinfo.CToken,   // cookie ct
    utToken:  _this.userinfo.UToken,   // cookie ut
    zjzh:     _this.userinfo.zjzh == "" ? "10000101708040407097" : _this.userinfo.zjzh,
    plat:     '2',
    ver:      'web20',
    type:     p.method
}, p.data);
```

> `10000101708040407097` 是**游客组合**的默认 `zjzh`（`fus_reg_moni_zjzh` 会用 `spo_create_zuhe` + `zuheName:'游客'` 创建游客账号）。

**统一响应外壳**（`index.js`）：

```json
{ "result": 0, "message": "...", "isList": 0|1, "listSize": N, "totalCnt": N, "data": { ... } }
```

`result == 0` 表示成功；`isReturn:true` 的调用会返回整个对象（含 `result`/`message`），否则只回 `result.data`。

**实测（未带有效 token）**：

```
$ curl "https://simoper.eastmoney.com/oper_tzzh_v2?type=spo_bal_info"
{"isList":0,"listSize":1,"message":"组合已隐藏或无权访问","result":-10001,"totalCnt":1}

$ curl "https://simoper.eastmoney.com/oper_tzzh_v2?type=spo_create_zuhe&zuheName=%E6%B8%B8%E5%AE%A2"
{"isList":0,"listSize":1,"message":"token缺失","result":-10001,"totalCnt":1}
```

带 `cb` 参数时返回 JSONP 包裹：
```
jQuery3710123456789_1700000000000({"isList":0,"listSize":1,"message":"组合已隐藏或无权访问","result":-10001,"totalCnt":1})
```

### 2.2 交易类端点（`simoper` = `https://simoper.eastmoney.com/oper_tzzh_v2`）

参数默认值直接抄自 `https://group.eastmoney.com/JS/common/config.js` 的 `oper_tzzh_v2` 块（该文件同时给出 `type / plat / ver / utToken / ctToken / zjzh` 及各自业务参数）。

| 业务 | `type` | 业务参数 | 备注 |
|---|---|---|---|
| **下单** | `spo_order` | `zjzh`, `mmfx`(1=买 2=卖), `mktCode`(1=沪 0=深), `stkCode`, `price`, `wtsl`(数量), `r`(随机数) | `index.js` `spo_order()`；`r: Math.floor(Math.random()*100000000+1)` |
| **撤单** | `spo_cancel` | `zjzh`, `stkCode`, `mktCode`, `wth`(委托号), `mmfx` | `index.js` `spo_cancel()` |
| **最大可买/可卖** | `spo_order_limit` | `zjzh`, `mmfx`, `mktCode`, `stkCode`, `price`, `wtsl`(买=0/卖=-1), `asset:"0"` | 返回 `data.orderLimit`、`data.fund` |
| **资金查询** | `spo_bal_info` | `zjzh` | 返回 `zzc`(总资产) `sdje`(可用余额) `mktVal`(参考市值) `fdyk` `fdykRat`(浮动盈亏/比) |
| **当日委托** | `spo_orders_all` | `zjzh`, `reqUserid:""`, `recIdx`, `recCnt`(100) | |
| **当日成交** | `spo_deal_today` | `zjzh`, `reqUserid:""`, `recIdx`, `recCnt`(100) | |
| **持仓明细** | `spo_hold` | `zjzh`, `reqUserid:""`, `recIdx`, `recCnt`(100) | |
| **可撤委托** | `spo_orders_cancel` | `zjzh`, `reqUserid:""`, `recIdx`, `recCnt`(100) | |
| **历史成交** | `spo_deal_his` | `zjzh`, `begDate`, `endDate`, `recIdx`, `recCnt`(20), `reqUserid:""` | |
| **资金流水** | `spo_bal_change` | `zjzh`, `begDate`, `endDate`, `recIdx`, `recCnt`(20) | |
| **新建组合** | `spo_create_zuhe` | `zuheName`, `comment`, `authority`(1=公开) | 游客账号用 `zuheName:'游客'` |
| **改组合设置** | `spo_save_settings` | `zjzh`, `zhComment`, `authority` | `index.js` 里 `type` 字符串是 `'spo_save_settings'`，而 config 里 key 写成 `spo_save_setting`（**官方自身不一致，调用时以 `type=spo_save_settings` 为准**） |
| **删除组合** | `spo_delete_zuhe` | `zjzh` | |
| **组合权限** | `spo_modify_authority` | `zjzh`, `authority` | |
| **关注/取关组合** | `spo_concern` | `operType`(-1) | |
| **关注状态** | `spo_concern_stat` | `zuhelist` | |
| **组合收益率走势** | `spo_syl_tendency` | `zjzh`, `sylType`, `standardType` | |
| **评论/日志** | `spo_comment_detail` / `spo_tradelog_detail` | `userid`, `reqUserid`, `recIdx`, `recCnt` | |

### 2.3 查询类端点（`simqry` = `https://simqry2.eastmoney.com/qry_tzzh_v2`）

| 业务 | `type` | 业务参数 |
|---|---|---|
| **我的组合列表** | `spo_zuhe_preview` | `userid` |
| **组合基本信息** | `spo_zuhe_detail_basic` | `zjzh` |
| **组合收益统计** | `spo_syl_survey` | `zjzh` |
| **用户信息** | `spo_user_basic` | `userid` |
| **持仓（板块/明细）** | `spo_hold_detail` / `spo_hold_plate` | `zjzh`, `recIdx`, `recCnt` |
| **调仓明细** | `spo_hldchg_detail` / `spo_hldchg_home` | `zjzh`, `recIdx`, `recCnt` |
| **历史调仓明细** | `spo_hldchg_detail_his` | `fullcode`, `zjzh`, `recIdx`, `recCnt` |
| **排行榜/特色组合/高手操作** | `spo_rank_champion_home`, `spo_rank_syl`, `spo_rank_feature`, `spo_rank_tiger`, `spo_rank_hot`, `spo_superior_detail`, `spo_superior_stk_detail`, `spo_superior_top` | `rankType`, `sylType`, `timePeriod`, `recIdx`, `recCnt`, `mktcode`, `fullcode` |
| **操盘日志** | `spo_tradelog_home` / `spo_tradelog_information` | `recIdx`, `recCnt` |
| **评论** | `spo_comment_information` | `recIdx`, `recCnt` |

### 2.4 响应字段名（从页面 jQuery tmpl 模板反推，**真实字段名**）

模板位于 `room.html` 的 `<script id="*-template" type="text/x-jquery-tmpl">`：

| 模板 | 字段 |
|---|---|
| `#bottom-template`（资金条） | `zzc`(总资产) `sdje`(可用余额) `mktVal`(参考市值) `fdyk`(浮动盈亏) `fdykRat`(浮动盈亏比) |
| `#ccxxlist-template`（持仓信息） | `stkCode` `stkName` `zqsl`(证券数量) `kysl`(可用数量) `newPrc`(市价) `zqlb`(持仓/市值) `rateMax`(盈亏比) `mktVal` `fdyk` |
| `#gdlist-template`（挂单） | `stkCode` `stkName` `wth`(委托号) `wtjg2`(委托价) `wtsl`(委托量) `wtrq`(委托时间) `mmTypes`(买/卖) |
| `#drwtlist-template`（当日委托） | `stkCode` `stkName` `wth` `wtjg2` `wtsl` `cjsl`(成交量) `cjjg2`(成交价) `wtsj`(委托时间) `wtzts`(委托状态) `mmTypes` |
| `#drcjlist-template`（当日成交） | `stkCode` `stkName` `wth` `cjjg2` `cjsl` `cjsj`(成交时间) `mmTypes` |
| `#jsd-template`（资金流水） | `fsrq`(发生日期) `fssj`(发生时间) `qye`(前余额) `zy`(摘要) `fsje`(发生金额) `bcye`(本次余额) `cjje`(成交金额) `cjsxf`(其他费用) |
| `#lscj-template`（历史成交） | `cjrq` `cjsj` `cjlsh`(成交编号) `stkCode` `stkName` `mmTypes` `cjjg2` `cjsl` `cjsj` `qsyj`(手续费) |
| 委托状态枚举 | `window.wtzts = ["未成交","全部成交","部分成交","全部撤单","部分撤单","非法委托"]` |
| 买卖方向枚举 | `window.mmTypes = ["买入","卖出"]` |

### 2.5 第三方代码里对这些接口的使用（佐证）

* **油猴脚本「模拟组合持仓分析」**（Tampermonkey，作者 You，v0.12）
  <https://greasyfork.org/zh-CN/scripts/448337-%E6%A8%A1%E6%8B%9F%E7%BB%84%E5%90%88%E6%8C%81%E4%BB%93%E5%88%86%E6%9E%90/code>
  ```js
  // @match https://group.eastmoney.com/other*
  var matchRankURL1 = CONFIG.interfaceURL[0] + interface.getUrl('spo_hldchg_detail',
                        { zjzh: zjzh, recIdx: pageIndex, recCnt: pageSize }, true);
  _commonAjaxFunc(matchRankURL1, getTranRecord);
  ```
  → 证明外部脚本可以直接复用 `group.eastmoney.com` 的 `CONFIG.interfaceURL` + `interface.getUrl()` 构造 `simqry2` 请求。
* **`zvtvz/eastmoneypy`** <https://github.com/zvtvz/eastmoneypy> —— 管理**自选股组合**（web/mobile 双通道），不是模拟组合，但同一套 cookie 体系。
* **`joechen2010/stock-api`**（Java）<https://github.com/joechen2010/stock-api> —— "基于爬虫实现的对东方财富证券的在线网上交易的封装，下单、撤单、查询持仓、资金、历史订单、查询委托、查询成交"，带 `captcha/`（`CaptchaRecognize`、`MyCaptchaRecognize`）与 `RSAUtils`；这是**实盘**通道，不是模拟盘。

### 2.6 关于题面里提到的 `stkzs / stko / stk / st`、`PassToken`、`isFS`、`bkjs` 字段

**未证实 / 与模拟盘无关**。这些字段属于**东方财富实盘交易客户端**（`nuff.eastmoney.com/EM_Finance2015TradeInterface/JS.ashx`、`EM_Finance2014NumericApplication/JS.aspx`）体系，见 `wmo-v/eastmoneyapi` <https://github.com/wmo-v/eastmoneyapi>（Go，需 ddddocr 识别验证码）、`riiy/emtl` <https://github.com/riiy/emtl>（Python，`pip install emtl`）。模拟盘的 `spo_order` 系列**不使用**这些字段。

### 2.7 GitHub 上是否有直接自动化 `group.eastmoney.com` 模拟盘下单的仓库？

**未证实存在**。检索结果：

* GitHub 仓库搜索 `group.eastmoney.com` → **total_count = 0**。
* `grep.app` / `searchcode.com` 的代码搜索在本环境被拦截（Vercel Security Checkpoint / 404），未能完成全量代码检索 —— 这是本次调研的**主要盲区**。
* `easytrader` 明确**不支持**东方财富：
  <https://github.com/shidenggui/easytrader/issues/399> —— 提问「东方财富可以使用吗」，维护者回复「**不支持**」。
* `jadepeng/pytrader` 的 `eastmoney` broker 同样基于 easytrader 的实盘适配器。
* 已找到的**全部**与东方财富模拟盘相关的第三方项目都走**妙想 API**，不走网页（见 §6）。

---

## 3. APP「模拟组合」与 WEB「模拟组合」是同一个吗？—— **是**

### 3.1 官方明文（最硬的证据）

`https://group.eastmoney.com/CreateCom.html`（实测抓取正文）：

> **东方财富网的模拟组合是免费的功能，而且东方财富网web端和APP端的投资组合数据是同步更新的，您也可以在东方财富网APP端进行模拟交易。**
>
> 一个模拟组合对应一个模拟资金账号，初始模拟资金为100万元。……建议您将模拟组合的数据公开出来，展示给更多网友，大家可以一起互动交流。
>
> 一个人能建多少模拟组合？ 一个用户至多能创建20个组合

（`https://group.eastmoney.com/createcom.html` 同文。）

### 3.2 官方帮助中心 Q037（模拟组合规则全文）

`http://mobapppages.eastmoney.com/helper/Q037.html`（标题「组合问题」）：

* **创建投资组合**
  1. 您需要注册东方财富网通行证账号，且绑定手机号码
  2. 每位用户至多可以创建20个投资组合，每个投资组合初始虚拟资金100万元。
  3. 组合名称最长 8 个汉字或 16 个字符；**组合创建成功后，名称可修改一次**
  4. 组合描述最多 140 字；可设公开/隐藏，隐藏不参与排名
* **交易时间**：15:00—17:00 为清算时间不能接受委托；其他时间均可接受委托、撤单，**包含隔夜单**；当日未成交委托在日中清算时自动撤销
* **交易品种**：沪深 A 股股票和基金；不支持新股申购
* **交易单位**：买入 100 股（份）整数倍，价格最小变动 0.01 元，单笔 < 100 万股；卖出可卖零股；单只个股限额已删除（线上未限制）
* **交易制度**：T+1
* **撮合规则**：买入委托价 ≥ 最新价按最新价成交；< 最新价进入撮合；卖出对称
* **涨跌停特殊规则**：涨停价委托单若涨停打开且卖一有挂单即可成交；不打开不成交
* **清算交割**：委托买入冻结可用资金，成交时自动清算交割并计费；委托卖出立即减少可卖数，成交后资金刷新
* **交易费用**：佣金千分之一双向（含过户费）；印花税千分之一卖出收取
* **单只股票限额**：30% 规则已删除（线上未限制）

### 3.3 组合说明页（WAP）

`https://groupwap.eastmoney.com/group/invest/introduce.html`：

> **模拟组合，是东方财富模拟炒股的资金账户。** 您可在自选组合页创建新的投资组合并进行模拟交易，最多可创建 20 个投资组合。
> **实盘组合**是基于东方财富证券账户和东方财富通行证创建的附属展示账户……
> 实盘与模拟组合的区别：实盘组合反映的是用户证券账户的真实收益情况，涉及真实的资金交易；而**模拟组合使用的是虚拟资金，不涉及真实资金交易**。

### 3.4 统一标识符

WEB 与 WAP 都用同一个 **`zjzh`（资金账号 / 组合号）** 作为组合主键：
* WEB：`simoper`/`simqry` 的 `zjzh` 参数。
* WAP：`urlParm` 里的 `{"zh":"7521774"}`。
* 同一个 `ct`/`ut`/`uid` cookie 在两个站点通用（WAP 的 `getUserInfo()` 读的正是 `uid`/`uidal`/`ct`/`ut`）。
* 官方组合列表页可见 `组合操盘日志` URL 形如 `https://group.eastmoney.com/operate,10000000000493011.html`（`zjzh` 直接出现在 URL 中）。

### 3.5 结论

**APP 我的组合 == WEB 模拟组合 == WAP 模拟组合 == 妙想 API 绑定的模拟组合**（妙想见 §6.4，官方让你「选择已有建沪深模拟组合进行绑定」）。
唯一未证实项：妙想侧流程里"领取模拟资金"的具体金额与普通模拟组合的 100 万是否同一账户资金池（见 §6.5）。

---

## 4. 移动端 H5 版模拟盘 —— **存在，且是完整的交易页**

### 4.1 入口与页面清单

站点根：`https://groupwap.eastmoney.com/group/`（实测 `https://groupwap.eastmoney.com/` 302 → `/group/`）

| 页面 | URL | 状态 |
|---|---|---|
| 模拟组合**买入** | `https://groupwap.eastmoney.com/group/simulation/buy.html?zh=<zjzh>&name=<名称>` | ✅ 200，实测可用 |
| 模拟组合**卖出** | `.../group/simulation/sell.html?zh=...&name=...` | ✅ 200 |
| 模拟组合**撤单** | `.../group/simulation/cancel.html?zh=...&name=...` | ✅ 200 |
| 模拟组合**持仓** | `.../group/simulation/hold.html?zh=...&name=...` | ✅ 200 |
| 模拟组合详情 | `.../group/simulation/detail.html?zh=...` | ✅ 200 |
| 调仓记录 | `.../group/simulation/change.html?zh=...` | ✅ 200 |
| 下单成功页 | `.../group/simulation/success.html?zh=...&name=...` | ✅ 200 |
| 模拟组合榜单 | `.../group/invest/simulation.html` | ✅ 200（导航含「电脑版」跳转） |
| 创建模拟组合 | `.../group/invest/create.html` | ✅ 200（表单：组合名称 / 组合简介 / 公开组合 / 编辑简介 / 保存） |
| 组合说明 | `.../group/invest/introduce.html` | ✅ 200 |
| 实盘组合 | `.../group/reality/index.html?zh=...` 等 | ✅ 200（注意：见 §4.4 的下线传闻） |

首页导航原文：「首页导航 / 首页和榜单 / 组合榜单 / 组合榜单——实盘收益榜 / 组合榜单——模拟短线榜 / 自选组合 / 组合功能介绍 / 创建模拟组合 / 实盘组合 / 实盘首页 / 持仓详情 / 全部调仓 / 组合评论 / 组合回复 / **模拟交易 / 首页 / 持仓详情 / 全部调仓 / 模拟交易——撤单 / 模拟交易——委托成交 / 模拟交易——持仓 / 模拟交易——卖出 / 模拟交易——买入**」

### 4.2 WAP 后端接口（实测抓到的真实请求）

前端 `https://groupwap.eastmoney.com/group/static/script/simulation/buy/buy_1776934691271.js`（`common_1776934691271.js` 里的 `moni()`）：

```js
emconfig.Request.api003({
  url: "apistock/tran/getJson",
  type: "post",
  data: {
    path: "zuheV64/JS.aspx",
    pageUrl: window.location.href,
    urlParm: JSON.stringify(paramArray)
  }
})
```

`api003` 的 base（来自 `vendor_1776934691271.js` 里的 `window.emconfig`）：

```js
default: { api: {
  yuantao:  "https://emzuhelist.eastmoney.com",
  api001:   "https://emdcspzhapi.dfcfs.cn/",
  api003:   "https://emstockdiag.eastmoney.com/",
  searchApi:"https://searchapi.eastmoney.com/",
  pushApi:  "https://push2.eastmoney.com"
}}
```

⇒ **最终端点**：`POST https://emstockdiag.eastmoney.com/apistock/tran/getJson`
表单字段：`path=zuheV64/JS.aspx` & `pageUrl=<当前url>` & `urlParm=<JSON 数组的字符串>`

**实测（Playwright，移动 UA）**：

```
POST https://emstockdiag.eastmoney.com/apistock/tran/getJson
BODY:{"path":"zuheV64/JS.aspx","pageUrl":"https://groupwap.eastmoney.com/group/simulation/buy.html?zh=7521774&name=%E7%94%9F%E7%89%A9%E5%8C%BB%E8%8D%AF",
      "urlParm":"[{\"type\":\"hold\"},{\"recIdx\":0},{\"zh\":\"7521774\"},{\"recCnt\":100},{\"appVer\":\"9001000\"}]"}
RESP: {"result":"0","message":"ok","isList":"1","listSize":"0","startCal":"1","listData":[]}
```

### 4.3 WAP 的 `urlParm` 类型表（源码实测提取）

| 页面 | `urlParm` 数组 |
|---|---|
| 持仓 | `[{"type":"hold"},{"recIdx":0},{"zh":<zjzh>},{"recCnt":100},{"appVer":"9001000"}]` |
| 资金/账户 | `[{"type":"user_infos"},{"infoType":"zuhe_bal_info"},{"zh":<zjzh>},{"appVer":"9001000"}]` |
| **买入** | `[{"type":"add_order"},{"zh":<zjzh>},{"mmbz":0},{"mkt":1或0},{"code":<6位代码>},{"price":<价>},{"vol":<量>},{"appVer":"9002000"},{"utToken":<ut>},{"ctToken":<ct>}]` |
| **卖出** | 同上，但 `{"mmbz":1}` |
| 撤单 | `[{"type":"cancel_order"},{"zh":<zjzh>},{"appVer":"9001000"},{"mmbz":0},{"mkt":0},{"code":<code>},{"price":<price>},{"vol":<vol>},{"orderId":<id>},{"ctToken":<ct>},{"utToken":<ut>}]` |
| 可撤委托 | `[{"type":"orders_valid"},{"recIdx":0},{"zh":<zjzh>},{"recCnt":100},{"appVer":"9001000"},{"ctToken":<ct>},{"utToken":<ut>}]` |
| 最大可买/可卖 | `[{"type":"max_buy"|"max_sell"},{"zh":<zjzh>},{"mkt":<mkt>},{"code":<code>},{"price":<price>},{"appVer":"9002000"},{"ctToken":<ct>},{"utToken":<ut>}]` |
| 委托状态枚举 | `accepted` / `declined` / `unaccepted` / `disposed` |

方向编码：`mmbz` **0 = 买，1 = 卖**；`mkt`：**1 = 沪，0 = 深**（源码 `t.startsWith("6")||t.startsWith("9")?1:0`）。
`appVer`：`9002000` = 交易类，`9001000` = 查询类。

### 4.4 WAP 实测渲染结果（移动 UA）

```
title: 模拟组合买入
errors: (none)
DOM: 买入 | 卖出 | 撤单 | 委托成交 | 持仓
     input#price (placeholder 买入价格) / input (买入数量) / input (请输入金额)
     radio_type x2 (按数量下单 / 按金额下单)
     1/4  1/3  1/2  全仓
     按钮「模拟买入」
     五档盘口、我的持仓 / 当日成交 / 当日委托
未登录时弹窗：「提示 / 您未登录，是否先去登录？ / 取消 / 确定」
```

未登录时 `withUserInfoRun` 会：
```js
l.dialog.confirm("提示", "您未登录，是否先去登录？", function () {
  window.location.replace("https://mpassport2.eastmoney.com/login?backurl=" +
                          encodeURIComponent(window.location.href));
});
```

### 4.5 ⚠️ 一个必须标注的风险：`groupwap` 疑似"部分下线"

`LilianaMajamay/jiarenmens` README（<https://github.com/LilianaMajamay/jiarenmens>，2026-08 变更）：

> **2026-08 重要变更**：东方财富已停用旧 H5 页面（groupwap.eastmoney.com），实盘组合迁移到新接口 `spzhapi.dfcfs.cn/rtV3`。本项目已改为**直连新接口**（签名算法从 APP 的 RN bundle `paramsEncrypt`……）

**但本次实测（2026-11-05）**：`https://groupwap.eastmoney.com/group/simulation/buy.html` 仍返回 200、正常渲染、正常发请求。
⇒ **判断**：「groupwap 全面下线」的说法**不准确**；该说法针对的是**实盘组合**部分。**模拟组合 H5 目前仍在线可用（已实测）**，但属于官方未公告承诺的资产，**存在随时下线风险**。

另注：该仓库还披露了实盘组合的新接口 `spzhapi.dfcfs.cn/rtV3`，签名是 **SM4-CBC + SHA256**（密钥从 APP 的 RN bundle 逆向），需要 APP 会话令牌（会过期）—— 这是**实盘**通道，本项目不涉及。

### 4.6 有没有微信小程序 / 其它 H5？

* `m.eastmoney.com/*` 全部 302 跳转，没有独立模拟盘 H5（实测 `m.eastmoney.com/`、`/mobapp/index.html`、`/combination/`、`/mcombin/`、`/room/`、`h5.eastmoney.com/` 均为 302）。
* 官方帮助中心用的是 `mobapppages.eastmoney.com`（`http://mobapppages.eastmoney.com/helper/Q037.html`），但那是**帮助页**不是交易页。
* **微信小程序：未证实**。唯一间接线索是妙想 Skills 页有 `WxOpenAppItm` 组件与「微信打开 APP」能力（前端 JS 中的 `"打开东方财富App".repeat(...)`），说明官方有微信→APP 的拉起链路，但**未找到「模拟盘小程序」的公开证据**。

---

## 5. Playwright 在这个站点上的具体障碍清单

### 5.1 ✅ 登录：**iframe 弹窗**（Playwright 可处理）

* 登录框是 `exaccount.eastmoney.com` 的 **iframe**（`#loginframe`，360×460），**由页面自动注入**（未登录即弹）。
* Playwright 处理方式：
  ```js
  const frame = page.frames().find(f => f.url().includes('exaccount.eastmoney.com'));
  await frame.fill('#txt_account', '账号');       // name=login_email
  await frame.fill('#txt_pwd', '密码');           // name=login_password
  await frame.click('text=登录');
  ```
* 登录页有两个 Tab：**账号密码登录** / **短信快捷登录**（手机号 + 短信验证码，`#txt_mobile` / `#txt_msg_code` / `#btn_getvcode`）。
* 登录成功 → `loginok()` → `self.location.reload()` → 交易台重新初始化。

### 5.2 ⚠️ 图形验证码：**条件性**触发（实测 DOM 里存在相关字段）

登录 iframe 内实测到的隐藏字段与元素：

| 元素 | 含义 |
|---|---|
| `#hdAccountCaptRtn` / `#hdAccountCaptContextId` | **账号维度图形验证码**的返回值 / 上下文 ID |
| `#hdMobCaptRtn` / `#hdMobCaptContextId` | 手机维度验证码同上 |
| 按钮文本 **「请点击刷新」** | 图形验证码图片（点此刷新） |
| `#__RequestVerificationToken` | ASP.NET MVC antiforgery token（服务端会校验） |
| `hdAllow` / `hdDomains` / `hdRequest` / `hdAccountCaptRtn` | 客户端状态 |

> **结论**：验证码**不是每次都弹**，而是按风控上下文触发（`hdAccountCapt*` 有值时才显示）。策略：Playwright 优先走「人工登录一次 + 复用 storageState」，或做「检测到验证码图片 → 人工介入/OCR → 提交」的兜底。
> 参照：`wmo-v/eastmoneyapi`（实盘）用 **ddddocr** 识别验证码；`xuhanqiu1995/Login-EastMoney` 用 **puppeteer + ttshitu 打码平台**（实盘登录）。**模拟盘登录是否也强制图形验证码，本次未登录成功，标记为未证实。**

### 5.3 ✅ 资金密码弹窗：**不存在**（模拟盘不需要）

* 模拟盘只要求**通行证**登录，不涉及资金/交易密码。
* `bind_phone`（`js/tread/common.js`）里的 `//exaccount.eastmoney.com/Home/BindPhone` iframe **仅在「新建组合」时**出现（要求实名 + 绑定手机），**下单路径不经过它**。
* 佐证：`spo_create_zuhe` 之前会调 `POST /ajax/checkuserstatus`（`{CToken, UToken}`）检查 `IsGubaSuspiciousUser / IsNonRealNameUser / IsNonRealNameNewUser`，仅在**建组合**时要求实名。

### 5.4 ✅ 委托确认二次弹窗：**PC 端没有，WAP 端有**

* **PC 端**（`index.js`）：`#btnOrder` 的 click handler 直接调 `dataevent.加载下单(buysale)` → `newtraed.spo_order(...)` → 成功后 `alertMsg("", "下单成功！", "auto", ...)`。**没有任何二次确认**。
* **WAP 端**（`buy_1776934691271.js`）：`o.dialog.confirm("买入确认", "证券代码：… 委托方式：委托买入 买入价格：… 买入数量：…", ...)` → 确认后才 `add_order`。**需要处理弹窗。**

### 5.5 ✅ iframe / canvas / 会话超时

* **交易台本身没有 iframe**（只有顶部导航和底部的 `footer-1200-iframe.html`），交易 UI 在主文档里。→ 选择器定位很稳定。
* **canvas 图表**（`emcharts.min.js`）只用于 K 线/分时，**与下单无关**。
* **会话超时**：未证实具体时长。但 `ct`/`ut` 是通行证会话令牌；`index.js` 的 `获取用户状态()` 每次刷新页面都会用 `ctToken` 调 `spo_zuhe_preview`，若失效会返回错误。**建议**：Playwright 用 `storage_state` 持久化 cookies，并每笔前用一次只读查询（如 `spo_bal_info`）验证会话。
* **页面刷新频率**：交易台每 5 秒轮询一次数据（`ldatatime`），DOM 会被频繁重绘 → 自动化脚本必须**等待具体响应**（`page.wait_for_response(...)` 匹配 `spo_order`）而不是 sleep。

### 5.6 ⚠️ 反爬/反自动化：**group.eastmoney.com 本体未发现**

我逐个抓取并在**静态 HTML/JS 中**检索以下特征：

| 特征 | group.eastmoney.com/room/ | room/js/index.js | exaccount 登录页 | mpassport2 登录页 | groupwap buy.html | quote.eastmoney.com/center/gridlist.html | push2 API |
|---|---|---|---|---|---|---|---|
| `acw_sc__v2`（阿里云盾） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `__jsl_clearance`（加速乐） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `popwscps` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `_____tmd_____`（瑞数） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `_0x[0-9a-f]{5}`（混淆） | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `navigator.webdriver` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

> **关于 `acw_sc__v2` 的核验结论**：题面猜测 `acw_sc__v2` 是东财经典阿里云盾特征 —— **在 group.eastmoney.com / groupwap / 两个登录页上均未检出**。已知的 `acw_sc__v2` 用法集中在 `push2.eastmoney.com` 等**行情接口**的加签参数里，而非交易台页面本身。（未在本次范围内穷举所有行情端点，标注为**部分证实**。）

**但是**（重要保留意见）：

1. 实测用 Playwright 打开 `http://group.eastmoney.com/room/` 时，网络里出现了
   `GET https://i.eastmoney.com/websitecaptcha/build/popwscpc.js` 与
   `GET https://i.eastmoney.com/websitecaptcha/api/checkuser?callback=wsc_checkuser`
   —— 即**「网站安全弹窗」组件被加载了**（`popwscpc` = 东方财富 websafe captcha）。本次未触发人工验证窗口，但**它确实在运行**。
2. 在**行情/列表页**上，东财的反爬非常激进（已证实，与模拟盘不同域）：
   * <https://github.com/akfamily/akshare/issues/6707> —— 用户实测：「5min 内通过 api 获取到 500 条数据就封 ip」「出现人工校验窗口的 iframe，class=popwscps_d_iframe」「直接上浏览器方案了，selenium、playwright 之类方案任选一个，打开 https://quote.eastmoney.com/center/gridlist.html#hs_a_board 一页一页爬」。
   * <https://github.com/Windy-Sora/EastMoney_Crawler_Fix> —— 「东方财富会静默返回风控页面（验证码、访问频繁提示）」「从 Selenium/Chromedriver 迁移到 **Playwright**，稳定性更好」「每 50 次请求主动重启浏览器」「**700 页之后需换 IP**」。
   * <https://github.com/myhhub/stock/issues/474> —— 「东财是最开放的公司，他是承受不住才会限制爬取数据的」。
   ⇒ **推论（合理但未直接证实）**：模拟盘交易台因为是低频、带登录态的页面，被限流的概率显著低于行情接口；但如果自动化里高频抓行情，需按上述经验做退避。

### 5.7 ✅ Mixed Content（已在 §1.4 详述）—— 这是**唯一实测到会致命**的问题

---

## 6. 官方「妙想」模拟盘 API（`mkapi2.dfcfs.com/finskillshub/api/claw/mockTrading/*`）

### 6.1 文档来源（原始 URL）

| 文件 | URL |
|---|---|
| `mx-stock-simulator.md` | <https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/references/mx-stock-simulator.md>（raw: `https://github.com/flp516/eastmoney-mx-skills-suite-v2/raw/main/references/mx-stock-simulator.md`） |
| `SKILL.md`（含 Key 获取步骤） | <https://github.com/flp516/eastmoney-mx-skills-suite-v2/blob/main/SKILL.md> |
| `mx_moni.py` | <https://github.com/cattomgithub/eastmoney-mx-skills/blob/main/mx-moni/mx_moni.py> |
| `mx-moni/SKILL.md` | <https://github.com/cattomgithub/eastmoney-mx-skills/blob/main/mx-moni/SKILL.md> |
| `Aniu` README | <https://github.com/AnacondaKC/Aniu>（`raw.githubusercontent.com` 在本环境被 DNS 拦截，已改用 GitHub API 取 blob） |
| `mx-trader-bridge` `trader.py` | <https://github.com/27dream/mx-trader-bridge/blob/main/trader.py> |

> ⚠️ `raw.githubusercontent.com` 在本调研环境不可解析（`curl` exit 6），`grep.app`/`searchcode.com` 的代码搜索 API 也被拦截。上面所有 blob 内容均通过 `api.github.com/repos/{owner}/{repo}/git/blobs/{sha}` 或 `cdn.jsdelivr.net/gh/{owner}/{repo}@{branch}/{path}` 取得，**内容已逐字核对**。

### 6.2 请求/响应 Schema（逐字）

**基础信息（`mx-stock-simulator.md` 原文）**

> - **基础 URL**: `https://mkapi2.dfcfs.com/finskillshub`
> - **认证**: Header `apikey: {MX_APIKEY}`
> - **方法**: 全部 `POST`，`Content-Type: application/json`

| 功能 | 接口路径 | Body |
|---|---|---|
| 持仓查询 | `POST /api/claw/mockTrading/positions` | `{}`（`mx_moni.py` 实际传 `{"moneyUnit": 1}`） |
| 买入卖出 | `POST /api/claw/mockTrading/trade` | `{type:"buy"\|"sell", stockCode:"600519", price:1780.00, quantity:100, useMarketPrice:false}` |
| 撤单 | `POST /api/claw/mockTrading/cancel` | `{type:"order", orderId:"...", stockCode:"..."}` 或 `{type:"all"}` |
| 委托查询 | `POST /api/claw/mockTrading/orders` | `{fltOrderDrt:0, fltOrderStatus:0}` |
| 资金查询 | `POST /api/claw/mockTrading/balance` | `{}`（`mx_moni.py` 实际传 `{"moneyUnit": 1}`） |

**持仓响应字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `totalAssets` | Int64 | 总资产（厘，÷1000=元） |
| `availBalance` | Int64 | 可用余额（厘） |
| `totalPosValue` | Int64 | 总持仓市值（厘） |
| `posCount` | Int32 | 持仓股票数量 |
| `totalProfit` | Int64 | 总盈亏（厘） |

`posList[]`：`secCode`、`secMkt`(0=深 1=上)、`secName`、`count`、`availCount`、`value`、`costPrice`(÷10^`costPriceDec`)、`price`(÷10^`priceDec`)、`dayProfit`、`profit`、`profitPct`

**资金响应字段**：`totalAssets`、`availBalance`、`frozenMoney`、`totalPosValue`、`totalPosPct`、`nav`、`oprDays`

**委托状态枚举**：`1`未报 `2`已报 `3`部成 `4`已成 `6`已报待撤 `7`部撤 `8`已撤 `9`废单

**错误码**

| 码 | 含义 |
|---|---|
| 113 | 调用次数达上限 |
| 114 | API 密钥失效 |
| 115 | 未携带密钥 |
| 116 | 密钥不存在 |
| 404 | 未绑定模拟组合 |

**实测（无 Key / 假 Key）**（2026-11-05）

```
POST https://mkapi2.dfcfs.com/finskillshub/api/claw/mockTrading/positions   (无 apikey)
→ {"success":false,"status":115,"code":115,"message":"请求未携带API密钥，请检查请求参数","data":null,"requestId":"7cdc747ead0e450f83462bbc500530f6"}

POST .../mockTrading/trade    (apikey: test)  → {"success":false,"status":114,"code":114,"message":"API密钥不存在或已失效，请确认密钥是否正确",...}
POST .../mockTrading/orders   (apikey: test)  → {"success":false,"status":114,...}
```

**真实成功响应结构**（第三方项目 `27dream/mx-trader-bridge` 的 `trader.py` 注释逐字）：

```python
# 妙想真实响应结构：
#   { "code": "200", "data": { "rc": 0, "rmsg": "", "orderID": "261...", "result": {...} } }
# rc 字段在 data.rc（不是 data.result.rc），data.result 只装 status/interval。
# 顶层 code != "200" 时（如余额不足）data 可能为 null，统一按失败处理。
```
即：**`code=="200"` 表示请求成功；业务成功要看 `data.rc == 0`；委托号字段是 `data.orderID`（大写 D）。**
`mx_moni.py` 的判定逻辑：`result.get('success') or str(result.get('code'))=='200'`。

### 6.3 调用限额（**逐字**，来源：妙想 Skills 页面前端 JS）

来源文件：`https://marketing.dfcfs.com/views/finskillshub/static/js/app-core.jzhp3obw.js`（实测抓取）

| 套餐 | 基础调用次数（原文） |
|---|---|
| 免费版 | 「您当前为免费版套餐，享有基础调用**50**次权益」 |
| 进阶版（`roleCode=MXSKILLSL1YH`） | 「您当前为进阶版套餐，限时享有基础调用**300**次权益」 |
| 旗舰版（`roleCode=MXSKILLSL2YH`） | 「您当前为旗舰版套餐，限时享有基础调用**600**次权益」 |
| 升级页文案 | 「妙想skills普通版 / 限时享**150**次调用」「妙想skills进阶版 / 限时尊享**500**次调用」「妙想skills旗舰版 / 限时尊享**800**次调用」 |
| 休眠账户 | 「由于您近期活跃度较低，账户进入休眠状态，基础调用次数调整为**10次/天**，现已为您自动激活，并恢复基础版调用次数。」 |

限时加赠（原文）：

> 为回馈广大用户长期支持，东方财富官方推出限时积分膨胀活动。活动期间，**普通版用户每日加赠100次调用次数，进阶版用户和旗舰版用户每日加赠200次调用次数**，助力用户获得更充足的资源使用额度。

其它约束（原文）：

> 订阅账号规范:为订阅人专享使用，严禁账号共享。若存在账号共享行为，可能导致订阅权益受限，敬请知悉。
> **严禁滥用APIKey调用**:将套餐API Key用于允许范围之外的调用将被视为违规或滥用，可能会导致订阅被暂停或APIKey被封禁。

Key 领取（原文）：

> API KEY领取：限时免费体验，**每日限量5000名**

Key 卡片上的今日用量字段：`今日调用 {todayUsage}/{dailyLimit} 次`

⇒ **对策略的直接影响**：免费版 50 次/天（+100 加赠）是**全接口合计**的额度。一笔完整决策（查持仓 + 查资金 + 下单 + 查委托）≈ 4 次调用 → 免费版每天只能支撑 **~10–30 笔**。**盘中 5 秒轮询策略完全不可行**；妙想 API 只适合低频（如每日 1–2 次调仓）策略。

### 6.4 Key 获取步骤（逐字）

`flp516/eastmoney-mx-skills-suite-v2/SKILL.md`：

> ## 获取 API Key
> 1. 访问：**https://marketing.dfcfs.com/views/finskillshub/indexyrxc2vtv?mksharest=1773325711118**
> 2. 下载并安装东方财富 APP
> 3. 注册/登录后，在首页搜索 **Skill**，领取 **API KEY**

`cattomgithub/eastmoney-mx-skills/mx-moni/SKILL.md`：

> - 模拟组合账户操作前，用户需在妙想Skills页面（地址：**https://dl.dfcfs.com/m/itc4** ），创建模拟账户后，并绑定模拟组合。

`PLFENG/Aniu` README（Aniu 的 fork，给出端到端实操顺序）：

> 需要大家下载东方财富APP，首页搜索妙想Skills，立即领取。点击APP下方交易，点击上方**模拟**，领取**20万元**模拟资金。回到妙想Skills界面，下滑找到**妙想模拟组合管理skill**，**绑定你的模拟组合**。然后将API Key保存到程序设置界面填入即可。
> 注意妙想的相关技能使用有限额。

`Aniu`（原仓）README：

> 2. 进入「主要设置 → 妙想设置」，填写项目所需的妙想 API 密钥。
> - 妙想及行情服务受其自身额度、稳定性和使用条款约束。

### 6.5 妙想 API 与 APP/网页的模拟组合是同一个吗？—— **是**

妙想 Skills 前端 JS 中：

* 绑定弹窗标题（逐字）：**「请选择已有建沪深模拟组合进行绑定」**（列表列：`组合名称` / `净值` / `选择`）
* 提示（逐字）：**「注：模拟组合skill需绑定模拟组合后使用」**
* 绑定接口：`POST /api/mockTrading/account/bind`，body `{accountId, accountName}`
* 列表：`POST /api/mockTrading/account/list` → 返回 `data[]`，每项含 `id`、`name`、`isValid`
* 查询：`POST /api/mockTrading/account/query` → 返回 `{accountName, accountId}`
* 绑定失败 `status==100102` → 引导「前往炒股大赛」`https://dl.dfcfs.com/m/nhk8`

⇒ 结论：**妙想 API 操作的正是你在东方财富（APP/网页）里创建的那个「沪深模拟组合」**，只是由官方帮你把 API Key 与该组合绑定。这与 §3 的官方文案（web/APP 数据同步）互相印证。

> **未证实**：妙想流程中「点击APP下方交易，点击上方模拟，领取20万元模拟资金」这条线，与普通「模拟组合初始虚拟资金100万元」是否指同一资金池。`27dream/mx-trader-bridge` README 写「东方财富妙想模拟盘 120 万本金练手」，`PLFENG/Aniu` 写「领取20万元模拟资金」—— **三个金额互不一致，均未证实**。若依赖资金余额做风控，务必以 `balance` 接口实测为准。

### 6.6 妙想 API 的其它绑定/账号接口（同一 base，实测）

```
POST https://mkapi2.dfcfs.com/finskillshub/api/mockTrading/account/list
  → {"message":"header中缺少必要的参数","status":400}      # 需要额外 header（大概率是登录态/设备头）
POST https://marketing.dfcfs.com/api/mockTrading/account/list  → 302
POST https://dl.dfcfs.com/api/mockTrading/account/list          → 404
```
⇒ base 是 `https://mkapi2.dfcfs.com/finskillshub`；`/apikey/create`、`/apikey/delete`、`/mykeys` 为同 base 的其它管理接口。

---

## 7. Playwright / Puppeteer 在中国券商网页交易上的既有案例

| 项目 | 技术栈 | 目标 | 关键做法 | URL |
|---|---|---|---|---|
| **`trading-a/ai_ths_moni_trading_mcp`** | **Playwright + CDP**（`connect_over_cdp` 到 `http://127.0.0.1:9222`） | **同花顺网页模拟盘**（MCP 服务） | 「**人工启动浏览器并登录**，交易服务才能下单」；「Playwright 通过 CDP 连接已打开的浏览器，**不需要下载浏览器内核**；**也不存储任何账号凭证，完全依赖人工登录好的会话**」；工具：`query_account_and_positions` / `query_deals` / `query_orders` / `place_order` / `cancel_order`；`config.yaml` 有 `cdp_endpoint`、`refresh_before_tool`、`slow_ms` | <https://github.com/trading-a/ai_ths_moni_trading_mcp>（⭐1，push 2026-08-24）★**与本项目最同构的范式** |
| **`LilianaMajamay/jiarenmens`** | **Playwright**（异步，浏览器池 + 代理池 + SQLite + 断点续传） | 东方财富**实盘组合**榜单（选手/持仓/调仓） | `asyncio.gather` 并行抓 3 类数据；每 50 个选手存检查点；README 披露新接口 `spzhapi.dfcfs.cn/rtV3`（SM4-CBC+SHA256 签名，来自 APP RN bundle 逆向） | <https://github.com/LilianaMajamay/jiarenmens>（⭐18） |
| **`xuhanqiu1995/Login-EastMoney`** | **Puppeteer** + axios + ttshitu 打码平台 | 东财**实盘 web 交易客户端**登录 | "模拟登陆东方财富web交易客户端"；puppeteer 模拟浏览器操作 + 第三方打码 | <https://github.com/xuhanqiu1995/Login-EastMoney>（⭐14） |
| **`wukan1986/mcp_query_table`** | **Playwright** | 同花顺问财 / 通达信 / **东方财富条件选股** | 「1. **不需要解决登录问题** 2. 不需要解决请求构造、响应解析 3. 可以直接获取表格数据，所见即所得 4. 运行速度慢于 requests，但开发效率高」；截获响应解析 JSON | <https://github.com/wukan1986/mcp_query_table> |
| **`finvfamily/finshare`** | **Playwright**（scraper 层） | 东财板块/资金流/财报等数据页 | `PlaywrightEastMoneySource`，注册为 `source_tier="scraper"`，api 层不可用时降级 | <https://github.com/finvfamily/finshare>（⭐765） |
| **`Windy-Sora/EastMoney_Crawler_Fix`** | **Playwright**（从 Selenium 迁移） | 东财股吧爬虫 | 专门处理风控页；每 50 次请求重启浏览器；~700 页后换 IP | <https://github.com/Windy-Sora/EastMoney_Crawler_Fix> |
| **`Cfu4536/ths_simulated_API`** | `requests`（非浏览器） | **同花顺模拟炒股网页版**接口解析 | 直接构造 POST 请求下单/撤单/查持仓/查委托 | <https://github.com/Cfu4536/ths_simulated_API>（⭐9） |
| **`27dream/mx-trader-bridge`** | `requests` | **东方财富妙想模拟盘** | `trader.py` 封装 `mx-moni` API；`rc=0 + 成交轮询双校验`（避免 `code=200` 假成功） | <https://github.com/27dream/mx-trader-bridge>（⭐8） |
| **`riiy/emtl`** / **`zsmatrix62/emtl`** | `requests` + ddddocr | 东财**实盘**自动交易 | 会话持久化 / 多用户隔离 / 过期自动重登 / OCR 验证码 | <https://github.com/riiy/emtl>（⭐80）、<https://github.com/zsmatrix62/emtl> |
| **`joechen2010/stock-api`** | Java + 爬虫 | 东财**实盘**在线交易封装 | `captcha/` 识别 + `RSAUtils` | <https://github.com/joechen2010/stock-api> |
| **`fasiondog/puppet`** / **`noimank/easyths`** / **`skyformat99/ths_trade`** / **`wukan1986/thsauto`** | pywinauto / UIAutomation / uiautomator2 | 同花顺**客户端** GUI 自动化（Windows/Android） | 说明「GUI 自动化」路线的已知痛点：验证码、弹窗、分辨率依赖 | 见各仓 |
| **`akfamily/akshare`** issue #6707 | 讨论 | 东财行情反爬 | 「5min 内 500 条就封 IP」「人工校验窗口 iframe `class=popwscps_d_iframe`」「直接上浏览器方案了，selenium、playwright 任选」 | <https://github.com/akfamily/akshare/issues/6707> |

**关于「playwright + group.eastmoney.com」的精确命中**：**未证实存在**（GitHub 仓库搜索 `group.eastmoney.com` = 0 命中；代码搜索被拦截）。最接近的是 `jiarenmens`（Playwright 爬 group.eastmoney.com 的**实盘组合**榜单），它证明 group.eastmoney.com 在 Playwright 下可正常驱动。

---

## 8. 落地建议（可直接开工的方案）

### 方案 A（首选）：WAP 模拟盘 H5 + Playwright

```js
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  storageState: 'em_state.json',        // 人工登录一次，持久化 ct/ut/uid
});
await ctx.addCookies([/* groupwap.eastmoney.com 的 ct/ut/uid */]);
const page = await ctx.newPage();
await page.goto('https://groupwap.eastmoney.com/group/simulation/buy.html?zh=<zjzh>&name=<name>');
await page.fill('#price', '10.00');
await page.fill('input[placeholder="买入数量"]', '100');
await page.click('text=模拟买入');
await page.click('.aui-dialog .confirm_btn');   // 「买入确认」弹窗
await page.waitForResponse(r => r.url().includes('/apistock/tran/getJson'));
```

优点：纯 HTTPS、无混合内容坑、DOM 现代、URL 直达、可在真机浏览器跑（甚至 `adb` 驱动手机 Chrome）。
风险：官方未承诺长期维护（见 §4.5）。

### 方案 B：PC 模拟盘 + Playwright

* 用 `http://group.eastmoney.com/room/`（或 HTTPS + 路由重写两个 http 脚本）。
* 选择器（实测存在）：`#futcode`（代码）、`#price`（价）、`#codenumber`（量）、`#btnOrder`（买/卖）、`.tab_buy_sale .tab_sale`（切卖出）、`#ulzhlist li[data-zjzh]`（切组合）、`#btnBuild`（新建组合）。
* **单击即下单，无确认弹窗**；用 `page.wait_for_response(r => /oper_tzzh_v2/.test(r.url()) && r.url().includes('spo_order'))` 判断成败，再读 JSON 里的 `result`/`message`。

### 方案 C：官方妙想 API（低频策略）

* 领 Key + 绑定组合 → `apikey` header 直调，**完全无浏览器、无验证码、无限额以外的风控**。
* 唯一硬约束：**日限额**（免费版 50 次基础 + 100 次加赠 = 约 150 次/天）。
* 建议加"rc=0 + 成交轮询"双校验（参考 `mx-trader-bridge`）。

### 通用工程要点

1. **登录态**：优先 `storage_state` 复用（人工登录一次）。自动化登录时处理 `exaccount` iframe + 可能的图形验证码。
2. **不要用固定 sleep**：交易台每 5s 重绘，务必 `wait_for_response` / `wait_for_selector`。
3. **不要高频轮询行情**：东财行情接口有 IP 封禁实证（§5.6）；用 `push2` 的 `ut=b2884a393a59ad64002292a3e90d46a5`，并做指数退避。
4. **合规**：模拟盘不涉及真实资金；仍建议遵守东财 robots/服务条款、不要用脚本绕过验证码批量注册。

---

## 9. 明确的「未证实」清单

| # | 事项 | 状态 |
|---|---|---|
| 1 | GitHub 上是否存在**直接**用 Playwright/Selenium 自动化 `group.eastmoney.com/room/` **下单**的开源项目 | **未证实**（仓库搜索 0 命中；grep.app / searchcode 代码搜索在本环境被拦截） |
| 2 | 模拟盘通行证登录是否**必定**触发图形验证码（`hdAccountCapt*`） | **未证实**（字段存在，但未完成一次真实登录） |
| 3 | 模拟盘登录会话（`ct`/`ut`）的有效期 | **未证实** |
| 4 | 模拟盘交易台运行时是否**会**弹出 `popwscpc` 人工验证窗口 | **未证实**（脚本已加载，未触发） |
| 5 | `acw_sc__v2` 在**东财全部行情端点**上的普遍存在 | **部分证实**（在本次检查的 7 个 URL 上均不存在；行情域未穷举） |
| 6 | 妙想 API 的**实际每日配额**取决于用户套餐/账户状态 | **已证实有分级**（50/300/600 基础 + 100/200 加赠 + 休眠 10 次/天），但**某个具体账户**的当日 `dailyLimit` 未证实 |
| 7 | 妙想「领取 20 万元 / 120 万本金」与普通模拟组合「初始虚拟资金 100 万元」是否同一资金池 | **未证实**（三个数字互相冲突） |
| 8 | 是否存在「模拟盘」微信小程序 | **未证实**（只发现「微信拉起 APP」能力） |
| 9 | `groupwap.eastmoney.com` 是否会整体下线 | **未证实**；README 声称 2026-08 已停用「旧 H5 页面」，但**模拟组合 H5 实测仍在线** |
| 10 | 题面提到的 `stkzs` / `stko` / `stk` / `st` / `PassToken` / `isFS` / `bkjs` 等字段 | **未证实用于模拟盘**；已确认它们属于**实盘**交易接口体系 |
| 11 | WAP 的 `user_infos`/`hold` 等响应体的**完整字段表** | **部分证实**（实测 `zuhe_bal_info` 返回 `csje,khrq,kyye,mktValue,qzh,sdje,userid,ykHold,ykToday,zhye,zjye,zjzh,zzc`；其余 type 未逐个抓取） |
| 12 | `room/index.js` 里 `spo_save_setting` vs `spo_save_settings` 的官方口径 | **未证实**（官方 config 与调用代码自相矛盾） |

---

## 附录 A：关键 URL 清单

**官方站点**
* PC 交易台：<https://group.eastmoney.com/room/>（HTTPS 混合内容坑 → 建议 `http://` 或路由重写）
* PC 站点根：<https://group.eastmoney.com/>
* 创建组合：<https://group.eastmoney.com/CreateCom.html>
* 我的组合：<https://group.eastmoney.com/MyCombin.html>
* 模拟组合榜：<https://group.eastmoney.com/mcombin.html>
* 操盘日志：<https://group.eastmoney.com/OperatLog.html>
* 组合搜索：<https://group.eastmoney.com/CombinSearch.html>
* PC 配置：<https://group.eastmoney.com/JS/common/config.js?v=20250220>
* PC 登录页：<https://group.eastmoney.com/login_agent.html> → <https://exaccount.eastmoney.com/Scripts/Agent/WebLoginAgent.js>
* 通行证登录（iframe）：`https://exaccount.eastmoney.com/Home/Login?request=...`
* WAP 首页：<https://groupwap.eastmoney.com/group/>
* WAP 买入：<https://groupwap.eastmoney.com/group/simulation/buy.html?zh=...&name=...>
* WAP 卖出/撤单/持仓：同目录 `sell.html` / `cancel.html` / `hold.html`
* WAP 创建组合：<https://groupwap.eastmoney.com/group/invest/create.html>
* WAP 组合说明：<https://groupwap.eastmoney.com/group/invest/introduce.html>
* 帮助中心 Q037：<http://mobapppages.eastmoney.com/helper/Q037.html>
* 妙想 Skills：<https://dl.dfcfs.com/m/itc4> · <https://marketing.dfcfs.com/views/finskillshub/indexyrxc2vtv?mksharest=1773325711118>

**接口主机**
* `https://simoper.eastmoney.com/oper_tzzh_v2`（交易）
* `https://simqry2.eastmoney.com/qry_tzzh_v2`（查询）
* `https://emstockdiag.eastmoney.com/apistock/tran/getJson`（WAP 交易，`path=zuheV64/JS.aspx`）
* `https://emzuhelist.eastmoney.com` / `https://emdcspzhapi.dfcfs.cn/rtV1`（榜单类）
* `https://mkapi2.dfcfs.com/finskillshub/api/claw/mockTrading/*`（妙想）
* `https://myfavor.eastmoney.com/v4/webouter/*`（自选股）
* `https://push2.eastmoney.com/api/qt/ulist.np/get`（行情，`ut=b2884a393a59ad64002292a3e90d46a5`）
* `http://pdfm2.eastmoney.com/EM_UBG_PDTI_Fast/api/js`（K 线）
* `https://i.eastmoney.com/websitecaptcha/api/checkuser`（网站安全弹窗探测）

## 附录 B：本次调研的实测环境

* Chrome：系统自带 `/usr/bin/google-chrome`；Playwright（Node）通过 `executablePath` 启动，无需下载内核。
* 抓取：2026-11-05 ~ 2026-11-06（UTC+8）。
* 受限项：`raw.githubusercontent.com` DNS 不可解析；`grep.app` 触发 Vercel 安全检查；`searchcode.com` API 返回 404；GitHub API 有速率限制（部分改用 `api.github.com` blob + jsDelivr CDN 取源）。
