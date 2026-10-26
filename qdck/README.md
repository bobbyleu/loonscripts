# qdck — 起点 Cookie 自动推送青龙面板（Loon 插件）

手机端 Loon 通过 MITM 捕获起点读书 App 的登录 Cookie，**覆盖写入**青龙面板的 `QDREADER_COOKIE` 环境变量：获取到新 Cookie 即整体覆盖，变量永远只保留最新捕获的一个账号（JSON 单键值对 `{"uid":"完整cookie"}`）。推送成功后可按开关立即触发青龙的起点签到任务；最后再按插件设置把 6 个任务开关同步到青龙 `QDREADER_*_ENABLE` 变量（辅助步骤，失败不影响推送与触发）。

与 [jdck](../jdck)（京东 CK 推送）同源设计：单飞锁、最新值优先、失败重试、token 缓存、二次复核、脱敏通知。

## 文件

| 文件 | 说明 |
|---|---|
| `qdck_ql.plugin` | Loon 插件（含参数面板、MITM、抓取钩子） |
| `qdck_ql.js` | 推送脚本（被插件引用） |
| `qdck_test.js` | 本地沙箱测试（模拟 Loon + 青龙 OpenAPI，99 项断言） |

## 一、青龙侧准备（一次性）

1. **部署签到脚本**：把 `qdreader.js`（起点签到主脚本）放到青龙，如 `/ql/scripts/qdreader.js`。
2. **依赖管理 → NodeJs**：安装 `fetch-cookie`（auto-cookie 默认开启，必须）；青龙容器 `node -v` < 18 再加 `node-fetch`。
3. **建环境变量**：新建 `QDREADER_COOKIE`，值先填 `{}` 占位（插件首次推送也会自动新建，但建议先建好）。
4. **建签到任务**：命令 `task qdreader.js`，定时如 `11 2 * * *` 作每日兜底，保持启用。
5. **建应用令牌**：系统设置 → 应用设置 → 添加应用，权限勾选 `envs` + `crons`，保存后复制 **Client ID / Client Secret**。

## 二、Loon 侧使用

1. 导入插件：Loon → 配置 → 插件 → 添加，填入
   `https://raw.githubusercontent.com/bobbyleu/loonscripts/main/qdck/qdck_ql.plugin`
   （或下载本仓库文件后本地导入）。
2. 确保 MITM 证书已安装并信任，`h5.if.qidian.com` 已加入 MITM hostname（插件导入会自动追加）。
3. 点开插件/脚本参数面板，按三组填写：

**第一组 · 青龙凭证**

| 参数 | 说明 |
|---|---|
| `CLIENT_ID` / `CLIENT_SECRET` | 青龙应用密钥（见上） |
| `QL_URL` | 青龙地址，如 `https://ql.your-domain.com`（手机需能访问；Tailscale / cloudflared / 局域网均可） |
| `CF_ACCESS_ID` / `CF_ACCESS_SECRET` | Cloudflare Access 服务令牌（可选，青龙域名在 CF Access 后面时填写） |

**第二组 · 起点任务开关**（每次推送前同步写入青龙同名变量）

| 参数 | 青龙变量 | 默认 |
|---|---|---|
| `ADV_JOB` | `QDREADER_ADV_JOB_ENABLE`（激励任务） | 开 |
| `EXTRA_ADV_JOB` | `QDREADER_EXTRA_ADV_JOB_ENABLE`（每日任务） | 开 |
| `LOTTERY` | `QDREADER_LOTTERY_ENABLE`（每日抽奖） | 开 |
| `WEEKLY_EXCHANGE` | `QDREADER_WEEKLY_EXCHANGE_ENABLE`（每周兑换） | 开 |
| `CHAPTER_CARD` | `QDREADER_CHAPTER_CARD_ENABLE`（章节卡片） | 开 |
| `MESSAGE_BOX` | `QDREADER_MESSAGE_BOX_ENABLE`（大咖荐书） | 关 |

**第三组 · 行为开关**

| 参数 | 说明 |
|---|---|
| `PUSH` | 推送开关：开=获取到 Cookie 即推送并**覆盖**青龙变量（只保留最新账号）；关=仅抓取不推送（也不写青龙、不同步开关） |
| `RUN_SIGN` | 触发开关：开=推送成功后立即执行青龙签到任务；关=只更新变量 |

> Cookie 变量名固定为 `QDREADER_COOKIE`；签到任务按命令含 `qdreader` 自动匹配（如 `task qdreader.js`），均无需配置。

4. 打开起点读书 App（触发一次 `getlogininfo` 请求），查看 Loon 日志确认推送结果。

## 三、工作流程

```
起点 App 发起 getlogininfo 请求（携带完整 Cookie）
   │
   ▼  Loon http-response 钩子
① 校验登录：cookie 必须同时含 ywKey 与 ywGuid，否则跳过（防止坏 cookie 覆盖好 cookie）
② 计算 uid：base64解码(QDHeader).split('|')[11] → 回退 cookie 的 uid 字段 → 回退响应体 Data.UserId
③ 持锁（单飞锁）→ 读青龙现值：GET /open/envs?searchValue=QDREADER_COOKIE
④ 覆盖写回（单账号语义）：
     任意现值 + 本次 uidB  →  {"uidB":"cookieB"}          （整体覆盖，只留最新账号）
     现值含其他账号                  →  日志告警说明被替换的 uid，仍覆盖
     现值非 JSON（手填过原始 cookie） →  直接覆盖，日志告警，不备份
     变量不存在                      →  POST /open/envs 新建
⑤ 二次复核：重新拉取变量，确认值为 {"uid":"最新 cookie"} 单键值对
⑥ RUN_SIGN=开 → GET /open/crons 找 command 含 qdreader 且已启用的任务
              → PUT /open/crons/run [任务id]  立即执行签到
⑦ 最后（辅助步骤）同步任务开关 QDREADER_*_ENABLE：
     一次 GET /open/envs 拉全量 → 本地匹配 6 个开关名 → 只写真正需要改的项
     （没有则新建并启用，已有则更新 value 与备注，备注=任务名，已是最新则跳过；
       5 分钟节流 / 25 秒时间预算 / 连续 2 次失败即熔断放弃；
       整体失败也不影响上面的 Cookie 推送与签到触发）
```

**主目标优先（V1.04）**：推送 Cookie 与触发签到是主目标，排在**最前面**；任务开关同步是辅助步骤，排在**最后**。
Loon 对脚本有约 60 秒硬上限（超时直接杀掉且不给通知），旧版把开关同步放在推送之前，网络差时同步重试会烧光整段预算，导致 Cookie 没推、签到没触发、青龙面板毫无日志。V1.04 加了脚本全局时间预算（默认先设 45s，V1.08 起改为 2 分钟）用于主动停止请求并收尾；注意当预算 > 60s 时，「优雅收尾」安全网会被 Loon 的 60s 硬上限取代，效果是把 Loon 的全部 60s 都留给发请求（尤其 `PUT /open/crons/run`）。

**多账号/并发安全**：变量虽只保留一个账号，推送仍涉及「查环境-写变量-同步开关-触发任务」多步，脚本用**全局单飞锁**串行化；推送期间其他账号的新捕获会记入最新值，由持锁实例续推（最多 6 轮），**后捕获的覆盖先捕获的**（最新获胜），最终青龙里是最后捕获的账号。多个账号同时触发也只会触发一次签到任务运行（qdreader.js 一次运行覆盖全部账号，单账号即全量）。

## 四、通知与日志

- 推送成功且 cookie 相对上次**有变化** → 通知「起点Cookie推送青龙成功」（cookie 打码）；
- cookie 无变化的强制推送 → 静默刷新，不通知；
- 推送失败 → 通知「起点Cookie推送青龙失败」，限频 10 分钟；
- 青龙隧道（cloudflared）不可达 → 日志明确标注「与脚本无关」，并提示检查家里容器。

## 五、本地测试

```bash
node qdck_test.js   # 99 项断言：跳过/新建/覆盖/更新/告警/开关同步/合并查询/主目标优先/熔断/节流/并发/默认值/回退/强制推送/任务状态判定/接口返回结构兼容/爆发捕获只推最新cookie等
```

## 六、常见问题

- **日志提示「未找到命令包含 qdreader 的任务」**：先看日志里「命令含「qdreader」的任务」那一行——它会列出命中的任务及其状态；已禁用的任务会标注「（已禁用，仍强制触发）」并照常触发（无需到面板启用）。若这行和「青龙任务清单样本」都没出现，说明接口根本没返回任务列表，日志会打印「接口未返回任务列表（原始响应前 200 字符）」，把这段发出来即可定位（V1.06 已兼容青龙新版的分页返回 `{data:[...],total:N}`，见下条）。
- **青龙接口返回结构（V1.06 修正）**：`GET /open/crons` 返回的是**分页对象** `{ data: [...], total: N }`（源码 `back/services/cron.ts` 返回 `Promise<{data:Crontab[];total:number}>`），而 `GET /open/envs` 返回的是**纯数组**。旧版本把 crons 当纯数组解析 → 列表恒为空 → 误报「未找到任务」。V1.06 加了 `toList()` 统一解包，两种结构都兼容。
- **任务状态判定（V1.05 修正，V1.07 放开）**：青龙定时任务 status 是枚举 `0=运行中 / 1=已启用(空闲) / 2=已禁用 / 3=排队中`，面板上显示「启用」的任务是 **status=1**。旧版本（≤V1.04）误把 `status===0` 当启用，导致启用的任务被当成不匹配跳过（那时 0 其实是「正在运行中」）。V1.05 改为「只排除 status=2 已禁用」，V1.07 进一步改为**「不论状态一律触发，包括 status=2 已禁用」**——手动触发应凌驾于定时调度开关之上，青龙 `run` 接口按 id 直接执行命令、不受 status 影响，故禁用任务也能跑且保持「已禁用」状态不变。
- **推送成功但签到没跑**：确认 `RUN_SIGN` 开关为开，且青龙任务状态是「启用」（`status=0`，已停用的任务不会触发）。
- **青龙面板看不到签到运行日志**：先看 Loon 日志里有没有 `3、触发签到任务` 这一节。没有 = 触发没发出去（推送链路在前面就断了）；有 = 任务已入队，日志在青龙「定时任务 → 起点读书签到 → 日志」里，且 `PUT /open/crons/run` 只入队、不返回结果。V1.04 起触发排在最前、开关同步排最后，不会再被同步拖累。
- **两次触发后日志出现网络超时重试**：V1.04 起开关同步移到推送之后并带 5 分钟节流 + 25 秒预算 + 连续失败熔断，请求数也从最多 13 次降到 1 次读 + 少量写；同一账号 30 秒内重复触发会被推送节流直接跳过。若仍大面积超时，是手机到青龙的链路问题（cloudflared 是否在线、手机网络直连 Cloudflare 是否被限速），与脚本无关。
- **脚本日志停在「网络错误…重试」就没有下文了**：旧版（≤V1.03）会被 Loon 的 ~60 秒上限杀掉，此时既没推送也没通知。V1.04 有全局 45 秒预算，到点主动收尾并发出通知；若仍断更请升级插件。
- **改了插件开关但青龙变量没变**：开关同步有 5 分钟节流（成功后计时），最快 5 分钟内生效；同步失败不记节流，下次触发重试。
- **青龙里所有任务都提示「开关未开启，跳过」**：本插件每次推送后会按参数面板同步 6 个 `QDREADER_*_ENABLE` 变量（没有则新建、已有则更新）；确认插件参数里对应开关为开，并查看 Loon 日志中「任务开关」小节的 ✅/⚠️ 行与「开关同步小结」。若同步被熔断（网络差），开关会在下次触发时补同步。
- **开关变量在青龙被手动改过**：下次推送时插件会按自己的设置覆盖回去；想长期改行为请改插件参数，不要在青龙侧手改（会被同步覆盖）。
- **青龙变量被手填过原始 cookie**：按覆盖语义直接替换为最新捕获的账号，日志会告警说明被替换掉的内容（不备份）；想长期保留某个值请自行记录，插件每次推送都会覆盖。
- **青龙里想跑多个账号**：本插件（Loon 自动推送）只保留最新捕获的一个账号；如需多账号，可在青龙侧手动把 `QDREADER_COOKIE` 写成多键值 JSON（qdreader.js 支持），但下次插件推送会被覆盖回单账号。
- **与旧版起点插件（qdreader.loon.plugin）同时启用**：两个插件钩同一个 URL 都会执行，可能出现双签到/重复通知；建议停用旧插件的抓取重写和本地 cron，签到统一由青龙执行。
- **「第一次推送的不是最新 cookie」**：App 打开/刷新时 `getlogininfo` 常连续触发多次，第一次的可能不是最新登录态。V1.10 起 `decidePush` 不再「不同 cookie 立即推」，而是统一先等 `DEBOUNCE_MS`(4s) 缓冲窗口，窗口末再读最新捕获再推送，保证推出的是这轮最后一次捕获的 cookie（最新获胜）。代价：每次推送多等约 4s。

## 七、青龙 OpenAPI 备忘

| 用途 | 方法与路径 |
|---|---|
| 取 token | `GET /open/auth/token?client_id=&client_secret=` |
| 查变量 | `GET /open/envs?searchValue=<变量名>` |
| 更新变量 | `PUT /open/envs`（body 单个对象 `{id,name,value,remarks}`） |
| 新建变量 | `POST /open/envs`（body 数组 `[{name,value}]`） |
| 启用变量 | `PUT /open/envs/enable`（body `[id]`） |
| 查任务 | `GET /open/crons` |
| **执行任务** | **`PUT /open/crons/run`（body 是 ID 数组 `[123]`，注意是 PUT 不是 POST）** |
