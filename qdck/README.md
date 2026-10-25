# qdck — 起点 Cookie 自动推送青龙面板（Loon 插件）

手机端 Loon 通过 MITM 捕获起点读书 App 的登录 Cookie，按 uid 合并写入青龙面板的 `QDREADER_COOKIE` 环境变量（同 uid 改写、新 uid 新增、其他账号原样保留），推送前按插件设置把 6 个任务开关同步到青龙 `QDREADER_*_ENABLE` 变量，推送成功后可按开关立即触发青龙的起点签到任务。

与 [jdck](../jdck)（京东 CK 推送）同源设计：单飞锁、最新值优先、失败重试、token 缓存、二次复核、脱敏通知。

## 文件

| 文件 | 说明 |
|---|---|
| `qdck_ql.plugin` | Loon 插件（含参数面板、MITM、抓取钩子） |
| `qdck_ql.js` | 推送脚本（被插件引用） |
| `qdck_test.js` | 本地沙箱测试（模拟 Loon + 青龙 OpenAPI，44 项断言） |

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
3. 点开插件/脚本参数面板，填写：

| 参数 | 说明 |
|---|---|
| `CLIENT_ID` / `CLIENT_SECRET` | 青龙应用密钥（见上） |
| `QL_URL` | 青龙地址，如 `https://ql.your-domain.com`（手机需能访问；Tailscale / cloudflared / 局域网均可） |
| `PUSH` | 推送开关：开=获取到 Cookie 即推送；关=仅抓取不推送（为关时不写青龙，也不同步开关） |
| `RUN_SIGN` | 触发开关：开=推送成功后立即执行青龙签到任务；关=只更新变量 |
| `TASK_KEY` | 签到任务匹配关键词，按青龙任务 **command** 包含该字符串定位，默认 `qdreader` |
| `ADV_JOB` / `EXTRA_ADV_JOB` / `LOTTERY` / `WEEKLY_EXCHANGE` / `CHAPTER_CARD` / `MESSAGE_BOX` | 任务开关（激励任务 / 每日任务 / 每日抽奖 / 每周兑换 / 章节卡片 / 大咖荐书），除大咖荐书外默认开；每次推送前同步写入青龙 `QDREADER_*_ENABLE` 变量 |
| `CF_ACCESS_ID` / `CF_ACCESS_SECRET` | Cloudflare Access 服务令牌（可选，青龙域名在 CF Access 后面时填写） |

> Cookie 变量名固定为 `QDREADER_COOKIE`，无需配置。

4. 打开起点读书 App（触发一次 `getlogininfo` 请求），查看 Loon 日志确认推送结果。

## 三、工作流程

```
起点 App 发起 getlogininfo 请求（携带完整 Cookie）
   │
   ▼  Loon http-response 钩子
① 校验登录：cookie 必须同时含 ywKey 与 ywGuid，否则跳过（防止坏 cookie 覆盖好 cookie）
② 计算 uid：base64解码(QDHeader).split('|')[11] → 回退 cookie 的 uid 字段 → 回退响应体 Data.UserId
③ 同步任务开关：按插件设置写入青龙 QDREADER_*_ENABLE（没有则新建并启用，已有则更新 value 与备注，备注=任务名，已是最新则跳过）
④ 读青龙现值：GET /open/envs?searchValue=QDREADER_COOKIE
⑤ 合并写回：
     现值 {"uidA":"cookieA"} + 本次 uidB  →  {"uidA":"cookieA","uidB":"cookieB"}
     现值 {"uidA":"cookieA"} + 本次 uidA  →  {"uidA":"新cookie"}        （同 uid 改写）
     现值非 JSON（手填过原始 cookie）      →  原值备份到 <uid>_backup 键，不清空
     变量不存在                            →  POST /open/envs 新建
⑥ 二次复核：重新拉取变量，确认 map[uid] === 最新 cookie
⑦ RUN_SIGN=开 → GET /open/crons 找 command 含 TASK_KEY 且已启用的任务
              → PUT /open/crons/run [任务id]  立即执行签到
```

**多账号安全**：`QDREADER_COOKIE` 是多账号共享的 JSON Map，推送是全局「读-改-写」，脚本用**全局单飞锁**串行化推送；推送期间其他账号的新捕获会记入最新值，由持锁实例续推（最多 6 轮），保证不丢新值、不被旧值反序覆盖。

## 四、通知与日志

- 推送成功且 cookie 相对上次**有变化** → 通知「起点Cookie推送青龙成功」（cookie 打码）；
- cookie 无变化的强制推送 → 静默刷新，不通知；
- 推送失败 → 通知「起点Cookie推送青龙失败」，限频 10 分钟；
- 青龙隧道（cloudflared）不可达 → 日志明确标注「与脚本无关」，并提示检查家里容器。

## 五、本地测试

```bash
node qdck_test.js   # 44 项断言：跳过/新建/合并/更新/备份/开关同步/默认值/回退等
```

## 六、常见问题

- **日志提示「未找到命令包含 qdreader 的任务」**：青龙任务命令里需含 `qdreader`（如 `task qdreader.js`）；若你的任务名不同，改插件参数 `TASK_KEY`。
- **推送成功但签到没跑**：确认 `RUN_SIGN` 开关为开，且青龙任务状态是「启用」（`status=0`，已停用的任务不会触发）。
- **青龙里所有任务都提示「开关未开启，跳过」**：本插件每次推送前会按参数面板同步 6 个 `QDREADER_*_ENABLE` 变量（没有则新建、已有则更新）；确认插件参数里对应开关为开，并查看 Loon 日志中「任务开关」小节的 ✅/⚠️ 行。
- **开关变量在青龙被手动改过**：下次推送时插件会按自己的设置覆盖回去；想长期改行为请改插件参数，不要在青龙侧手改（会被同步覆盖）。
- **青龙变量被手填过原始 cookie**：脚本会自动备份到 `<uid>_backup` 键并告警，不会清空；确认无误后可手动删除该备份键。
- **与旧版起点插件（qdreader.loon.plugin）同时启用**：两个插件钩同一个 URL 都会执行，可能出现双签到/重复通知；建议停用旧插件的抓取重写和本地 cron，签到统一由青龙执行。

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
