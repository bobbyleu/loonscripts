// 京东CK自动获取与推送青龙面板
// 拦截 api.m.jd.com，捕获 pt_key/pt_pin，按 pt_pin 匹配青龙 JD_COOKIE 并自动更新 pt_key。
//
// ===== 版本变更记录 =====
//   V1.0  改名 + 参数面板([Argument]) + 必要日志；parseArgs 兼容「命名式 key=value」与「占位式逗号列表」
//   V1.1  凭证持久化缓存(argument 优先 + $persistentStore 兜底)；启动日志加 版本/凭证 字段
//   V1.2  根因终局：Loon 3.5.3 把 $argument 传为「原生对象」；parseArgs 兼容 对象/数组/JSON/字符串
//   V1.3  推送超时自动重试(2次) + 推送后二次复核(✅已确认/⚠️未确认) + 超时日志澄清
//   V1.4  启动诊断日志分行显示(不再挤在一行) + 补充本变更记录注释
//   V1.5  修复「京东 App 一次触发多条请求→10个通知」突发刷屏：① 捕获即写 JDCK_SEEN_ 早期去重标记，压制并发突发里重复通知/推送；② 复用 PUSH_GAP 节流冗余推送；③ 「获取ck成功/推送成功」通知加 1 分钟时限兜底（仅真正新 key 且距上次≥1min 才弹）；失败仍按 30s 重试不刷屏
//   V1.6  修复推送必超时(青龙没更新)根因：`timeout` 单位是毫秒、此前误写为 10(=10ms) 几乎必超时 → 改为 10000ms；新增 `node:"DIRECT"` 让脚本发出的青龙请求直连(不经 Loon 代理，公网域名更快更稳)；日志打印目标 host 与出站方式
//   V1.7  错误分类与提醒：青龙返回 HTTP 5xx 且为 Cloudflare Tunnel 错误(530/Error 1033/Tunnel error) 时，明确提示「青龙隧道(cloudflared)不可达，与脚本无关，请检查家里 cloudflared/青龙容器」；推送失败日志按分类区分「隧道/网关故障」与「网络超时可能已成功」两类提示，避免误判为脚本或参数问题
//   V1.8  四点改进：① 日志完整显示 pt_key 与 CLIENT_ID（secret 在 raw 中打码）；② 网络错误重试加间隔(QL_RETRY_DELAY=2s)并日志「⏳ 等待 X 秒后第 N 次重试」，QL_MAX_RETRY 提到 3（最多3次，给瞬断留余地）；③ 推送成功通知改为每次真实成功都弹（不再被1分钟限频吞掉），并补日志；④ 密钥仅由用户在插件参数输入、自动缓存进 $persistentStore，脚本与插件均不预填默认值
//   V1.9  修正 V1.8 误将 CLIENT_SECRET 在日志打码(***)：用户要求密钥明文在日志体现（便于核对），密钥仍仅来自 Loon 参数/持久化、绝不硬编码在脚本/插件文件。改为「参数 raw=」完整输出 + 新增独立「青龙 CLIENT_SECRET=」整行（与 CLIENT_ID 并列）
//   V1.10 修正「有效性判定」误导（方案A，仅改文案、逻辑不动）：脚本只按 pt_key 字符串是否变化做去重，并不向京东校验 CK 是否真有效。把心跳通知中「仍有效」改为「pt_key未变化（脚本未校验京东侧有效性）」，消除误导
//   V1.11 ① QL_URL 改为由 Loon 参数设置（参数QL_URL优先 + $persistentStore 兜底，默认留空、由用户自行填写，彻底移除预置地址）；② [Script] 的 script-path 改为指向 GitHub 公开 raw，Loon 自动拉取更新，无需手动粘贴脚本
//   V1.12 ① 移除 QL_URL 默认值（插件参数留空、强制用户填写青龙地址，彻底去除文件内敏感地址）；② 推送改为「强制推送」：开启「推送青龙」即对每次捕获尝试推送（去除“同值永久跳过”去重，仅保留 30s 同key节流防突发）；③ 「未变化是否通知」重构为「pt_key获取通知」：开启=获取到pt_key即时通知（同key 1分钟限频防刷屏），关闭=半小时内只通知一次；④ 日志新增「pt_key是否发生变化 / 上次pt_key」；⑤ 插件 desc/author/开关说明同步更新
//   V1.13 日志可读性增强（重试次数3/间隔2s保持不变）：① qlReq 重试/失败日志加「请求用途标签」（取token/查环境/更新pt_key/新建/启用/复核查询），一眼看清是哪一步在重试；② 推送成功日志与通知补充具体动作（已更新/已新建/已追加 env id），成功时不再丢失细节；③ 失败日志同样带步骤标签；④ 推送入口标注「含二次复核」、复核结果加「复核：」前缀，进度与结果更清晰
//   V1.14 日志分组重构（重试3次/2s不变）：① 三段式分组日志「① 获取参数设置 / ② 获取CK / ③ 推送到青龙面板」，一眼看清进度；② 移除冗余的「青龙 CLIENT_ID/SECRET/URL」逐行解析输出（raw 已含完整凭证明文，足以核对），改以一行紧凑「设置摘要」呈现关键开关与地址；③ 把「pt_key是否发生变化」判断移至「② 获取CK」步骤内（紧随 pt_key 之后），不再与设置诊断混在一行；④ 推送入口去掉「（含二次复核）」括号，二次复核作为 ③ 末尾独立子步骤「二次复核：✅/⚠️」清晰呈现
//   V1.15 日志形式再优化（重试3次/2s不变）：① 大步骤改用「1、2、3、」编号、子步骤用「- 」项目符号，层级更清晰；② 删除冗余的「参数 raw=」整行（设置摘要已清晰呈现开关/地址/凭证来源，不再重复输出完整参数）；③「② 获取CK」改名「2、获取CK」，子项改为「- 获取成功，pt_key为：xxx」「- 与上次相同/不同」；④「③ 推送到青龙面板」改名「3、推送到青龙面板」，各分支与成功/失败/二次复核均改为「- 」子项
//   V1.16 细节打磨（重试3次/2s不变）：① 插件「最低Loon版本」字段改名为「版本」（#!版本=V1.16），作者字段改名「仓库」（#!仓库=仓库链接）；②「2、获取CK」将 pt_pin 合并进 pt_key 同一行，并把「获取成功」与「上次」均统一以「pt_key为：」表述；③「获取ck成功（即时通知）」等日志行从运行日志移除（避免刷屏），但 Loon 通知(notify)保留不变
//   V1.17 插件元数据改用 Loon 标准字段以在详情页真实显示（重试3次/2s不变）：① 移除 Loon 不识别的自定义 `#!版本`/`#!仓库`（自定义字段被 Loon 忽略，故详情页看不到）；② 仓库链接改用标准 `#!homepage`（详情页可点击跳转）；③ 版本号以 `#!tag`（如 V1.17）徽标 + `#!desc` 内「当前版本 V1.17」双处呈现；④ 新增 `#!author = bobbyleu`
//   V1.18 版本号单独成行显示（重试3次/2s不变）：Loon 无专用“版本”字段，新增官方用于承载版本号、且按原样显示的 `#!date = V1.18`，使其像“主页/作者”一样在详情页独立成行；desc 去掉版本句子（版本改由 date 行呈现）；tag 仅保留分类

//


// 参数通过 Loon 插件「参数面板」设置（导入后在 Loon → 脚本 → 点开本脚本 → 参数 中可见）：
//   CLIENT_ID / CLIENT_SECRET : 青龙「系统设置-应用设置-开放授权」密钥
//   QL_URL                   : 青龙面板地址（**无默认值，必须由用户在插件参数填写**，如 https://your-domain.com）
//   PUSH                     : 强制推送青龙（true=每次捕获都推送 / false=仅抓取不推送）
//   NOTIFY_UNCHANGED         : pt_key 获取通知开关（true=即时通知 / false=半小时内只通知一次；插件参数名仍为 NOTIFY_UNCHANGED）
// 兼容 $persistentStore 兜底。

// ========== 配置区（一般无需改动）==========
var QL_URL = "";   // 默认空：青龙地址必须由用户在 Loon 参数 QL_URL 中填写，脚本不预置任何地址（避免暴露）
var WHITELIST_MODE = false;                   // true=仅白名单内账号写入青龙
var PT_PIN_WHITELIST = [];                    // 白名单 pt_pin，如 ["JD_xxx","JD_yyy"]
var CAPTURE_ONCE = true;                      // true=同一账号(pt_pin)推送成功后按 pt_key 值去重
var PUSH_GAP = 30 * 1000;                     // 同一 key 推送失败后的最小重试间隔(防高频)
// （NOTIFY_OK_GAP 已移除：不再发送“pt_key未变”心跳通知；开启推送即强制推送）
var NOTIFY_FAIL_GAP = 10 * 60 * 1000;         // 「推送失败」通知最小间隔(10min)
var NOTIFY_NEW_GAP = 1 * 60 * 1000;            // 「pt_key获取通知」开启时：同一 key 1 分钟内只弹一次（防并发突发刷屏）
var GET_NOTIFY_GAP = 30 * 60 * 1000;           // 「pt_key获取通知」关闭时：半小时内只通知一次
var VERSION = "V1.18";

// ========== 参数解析 ==========
// Loon 3.5.x 的 [Argument] 占位式 argument=[{CLIENT_ID},{...}] 运行期会把 $argument
// 直接传成「原生 JS 对象」{CLIENT_ID:"...", CLIENT_SECRET:"...", PUSH:"...", NOTIFY_UNCHANGED:"..."}，
// 也可能传成「数组」或「JSON 字符串」。本函数同时兼容这几种 + 手动命名式(CLIENT_ID=x&...)。
var _ARGS = null;
function parseArgs() {
  if (_ARGS) return _ARGS;
  var map = {};
  var a = (typeof $argument !== "undefined") ? $argument : "";

  // 把「对象 / 数组 / JSON 字符串」吸收进 map
  function absorb(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      var names = ["CLIENT_ID", "CLIENT_SECRET", "PUSH", "NOTIFY_UNCHANGED"];
      o.forEach(function (v, idx) {
        if (names[idx] && v !== undefined && v !== null) map[names[idx]] = String(v).trim();
      });
    } else {
      for (var k in o) {
        if (Object.prototype.hasOwnProperty.call(o, k)) {
          var v = o[k];
          if (v !== undefined && v !== null) map[k] = (typeof v === "object") ? JSON.stringify(v) : String(v).trim();
        }
      }
    }
  }

  if (a && typeof a === "object") {
    absorb(a);                                  // Loon 3.5.x：直接传原生对象
  } else if (typeof a === "string") {
    var s = a.trim();
    if (s.charAt(0) === "{" && s.indexOf(":") >= 0) {
      try { absorb(JSON.parse(s)); } catch (e) {} // JSON 字符串形式
    } else {
      s = s.replace(/^\[/, "").replace(/\]$/, ""); // 去外层方括号
      if (s && s.indexOf("=") >= 0 && !/^\s*\[?\{/.test(s)) {
        // 命名式 CLIENT_ID=x&CLIENT_SECRET=y
        s.split(/[&\n;]/).forEach(function (p) {
          var i = p.indexOf("=");
          if (i > 0) {
            var k = p.slice(0, i).trim();
            var v = p.slice(i + 1).trim();
            if (/^\{.*\}$/.test(v)) return; // 未替换的占位符，忽略
            try { v = decodeURIComponent(v); } catch (e) {}
            map[k] = v;
          }
        });
      } else if (s) {
        // 逗号占位式 id,secret,true,false
        var names2 = ["CLIENT_ID", "CLIENT_SECRET", "PUSH", "NOTIFY_UNCHANGED"];
        s.split(",").forEach(function (v, idx) {
          v = v.trim();
          if (/^\{.*\}$/.test(v)) return; // 未替换的占位符，跳过
          if (names2[idx]) map[names2[idx]] = v;
        });
      }
    }
  }
  _ARGS = map; return map;
}
function getArg(name, def) {
  var m = parseArgs();
  var v = (m[name] !== undefined && m[name] !== "") ? m[name] : def;
  return v;
}
function parseBool(v, def) {
  if (v === undefined || v === null || v === "") return def;
  v = String(v).toLowerCase().trim();
  return v === "true" || v === "on" || v === "1" || v === "yes";
}
function sGet(k) { try { return $persistentStore.read(k) || ""; } catch (e) { return ""; } }
function sSet(k, v) { try { $persistentStore.write(String(v), k); } catch (e) {} }

// ========== 凭证加载（持久化优先 + 参数覆盖 + 自动缓存）==========
// 设计：青龙密钥一旦成功从参数解析，立即写入 $persistentStore；
// 之后即使 Loon 参数替换偶发失效，脚本仍可用缓存的密钥，避免反复“凭证未配置”。
var _argId = getArg("CLIENT_ID", "");
var _argSec = getArg("CLIENT_SECRET", "");
var _idFromArg = !!(_argId && !/^\{.*\}$/.test(_argId));
var _secFromArg = !!(_argSec && !/^\{.*\}$/.test(_argSec));

var QL_CLIENT_ID = _idFromArg ? _argId : sGet("JDCK_CLID");
var QL_CLIENT_SECRET = _secFromArg ? _argSec : sGet("JDCK_CLSEC");

if (_idFromArg) sSet("JDCK_CLID", _argId);
if (_secFromArg) sSet("JDCK_CLSEC", _argSec);

var _credSrc = (_idFromArg || _secFromArg) ? "argument" : ((QL_CLIENT_ID && QL_CLIENT_SECRET) ? "persistent" : "空");

// 青龙地址：参数 QL_URL 优先 + $persistentStore 兜底 + 默认
var _argUrl = getArg("QL_URL", "");
QL_URL = _argUrl ? _argUrl : (sGet("JDCK_URL") || QL_URL);
if (_argUrl) sSet("JDCK_URL", _argUrl);

var ENABLE_PUSH = parseBool(getArg("PUSH", "true"), true);
var NOTIFY_GET = parseBool(getArg("NOTIFY_UNCHANGED", "false"), false); // 插件参数名仍为 NOTIFY_UNCHANGED；语义：获取到pt_key后的通知策略（true=即时通知 / false=30分钟仅一次）

// ========== 持久化键 ==========
// 按 pt_key 值去重：记录每个 pt_pin 上次已推送的 pt_key 值，
// 仅当值真变化(轮换/重登)才重新推送；pt_key 稳定时彻底静默，过期重登后自动续上。
var K_TRY = "JDCK_TRY";         // 上次推送尝试时间(节流)
function lastKeyStore(pin) { return "JDCK_LAST_" + pin; }
function getLastKey(pin) { return sGet(lastKeyStore(pin)); }
function setLastKey(pin, key) { sSet(lastKeyStore(pin), key); }
var K_SEEN = "JDCK_SEEN_";           // 早期去重：上次“已见”的 pt_key（捕获即写，压制并发突发）
function getSeen(pin) { return sGet(K_SEEN + pin); }
function setSeen(pin, key) { sSet(K_SEEN + pin, key); }
var K_NOTIFY = "JDCK_NOTIFY_";       // 上次「获取ck成功」通知时间（1min 时限兜底）
var K_NOTIFY_KEY = "JDCK_NOTIFYKEY_"; // 上次「获取ck成功」通知的 pt_key 值（仅同值才限频）
var K_NOTIFY_OK = "JDCK_NOTIFYOK_";  // 上次「推送成功」通知时间（1min 时限兜底）
var K_NOTIFY_OK_KEY = "JDCK_NOTIFYOKKEY_"; // 上次「推送成功」通知的 pt_key 值（仅同值才限频）
var K_FAIL_NOTIFY = "JDCK_FAILNOTIFY"; // 上次「推送失败」通知时间
var K_BEAT = "JDCK_BEAT";             // 上次「pt_key未变」心跳通知时间
var K_TRYKEY = "JDCK_TRYKEY_";         // 上次尝试推送的 key（前缀，拼接 pt_pin）

// ========== 工具 ==========
function clip(s, n) { s = (s === undefined || s === null) ? "" : String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
function hostOf(u) { var m = String(u || "").match(/^https?:\/\/([^\/?#]+)/); return m ? m[1] : String(u || ""); }
function log(m) { try { console.log("[JDCK " + VERSION + "] " + m); } catch (e) {} }
function notify(t, s, b) { try { $notification.post(t || "", s || "", b || ""); } catch (e) {} }
function finish() { try { $done({}); } catch (e) {} }
function gH(h, n) {
  if (!h) return "";
  n = String(n).toLowerCase();
  for (var k in h) { if (String(k).toLowerCase() === n) { var v = h[k]; return (v === undefined || v === null) ? "" : String(v); } }
  return "";
}
function dPin(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

// 识别青龙网关/隧道类故障（Cloudflare Tunnel 等），给出明确“与脚本无关”的人话提示
function classifyQLFailure(status, rawData) {
  var s = String(rawData || "");
  var isCF = /cloudflare|error[-\s]?1033|tunnel error|530/i.test(s);
  if (isCF) {
    return "⚠️ 青龙隧道(cloudflared)不可达：Cloudflare 返回 " + status + "（Error 1033 等），通常是家里 cloudflared/青龙服务离线或与 Cloudflare 的 QUIC 连接断开，与脚本无关。请检查家里 RK.Panther-X2 的 cloudflared/qinglong 容器是否在线（docker ps / docker logs cloudflared）。";
  }
  return "";
}

// ========== 青龙请求 ==========
// 网络错误（超时/断连）自动重试，解决“青龙其实已更新、但响应超时导致误报失败”的歧义。
var QL_HTTP_TIMEOUT = 10000; // 单次 httpClient 超时（毫秒；Loon 单位为 ms）。此前误写为 10(=10ms) 几乎必超时，此为根因
var QL_MAX_RETRY = 3;        // 网络错误最多尝试次数（含首次）。给瞬断/隧道抖动留余地：最多 3 次、2 次延迟重试
var QL_RETRY_DELAY = 2000;   // 网络错误重试前的等待(毫秒)。立即连重试常撞上同一瞬断，等待 2s 让连接恢复再试
var QL_HTTP_NODE = "DIRECT"; // 出站节点：DIRECT=直连(不经 Loon 代理)。青龙为公网域名时直连最快最稳；若你的网络必须走某节点才能访问，改成该节点名
function qlReq(method, path, body, token, cb, _attempt, _label) {
  _attempt = _attempt || 1;
  var _lab = _label ? ("[" + _label + "] ") : "";
  var h = { "Content-Type": "application/json", "Accept": "application/json" };
  if (token) h["Authorization"] = "Bearer " + token;
  var opt = { url: QL_URL + path, headers: h, timeout: QL_HTTP_TIMEOUT, node: QL_HTTP_NODE };
  if (body !== undefined && body !== null) {
    var bodyStr = JSON.stringify(body);
    if (bodyStr) opt.body = bodyStr;
  }

  var fn = $httpClient.get;
  if (method === "PUT") fn = $httpClient.put;
  else if (method === "POST") fn = $httpClient.post;

  fn(opt, function (err, resp, data) {
    if (err) {
      var es = String(err);
      var netErr = /timeout|request failed|network|connection|ECONN|reset|refused|could not|unreachable/i.test(es);
      if (netErr && _attempt < QL_MAX_RETRY) {
        var _waitSec = (QL_RETRY_DELAY / 1000);
        log("⏳ " + _lab + "网络错误（第" + _attempt + "次），等待 " + _waitSec + " 秒后进行第 " + (_attempt + 1) + " 次重试：" + clip(es, 100));
        var _doRetry = function () { qlReq(method, path, body, token, cb, _attempt + 1, _label); };
        // 等待 QL_RETRY_DELAY 后再重试，让瞬断/隧道抖动恢复；环境无 setTimeout 则立即重试
        if (typeof setTimeout === "function") setTimeout(_doRetry, QL_RETRY_DELAY);
        else _doRetry();
        return;
      }
      log(_lab + "推送失败：网络错误 " + clip(es, 200));
      return cb("网络错误: " + es);
    }
    var status = (resp && resp.status) ? resp.status : ((resp && resp.statusCode) ? resp.statusCode : "?");
    var j;
    try { j = JSON.parse(data); }
    catch (e) { log(_lab + "推送失败：响应非JSON HTTP " + status + " " + clip(String(data), 200)); return cb("响应非JSON (HTTP " + status + ")"); }
    if (!j || j.code !== 200) {
      var c = (j && j.code !== undefined) ? j.code : "undefined";
      var msg = (j && j.message !== undefined) ? (typeof j.message === "string" ? j.message : JSON.stringify(j.message)) : "";
      var cls = classifyQLFailure(status, data);
      var tag = cls ? " [CF_TUNNEL]" : "";
      log(_lab + "推送失败：青龙 HTTP " + status + " code=" + c + " message=" + msg + " " + clip(String(data), 200) + (cls ? ("\n  " + cls) : ""));
      return cb("青龙错误 HTTP " + status + " code=" + c + " message=" + msg + tag);
    }
    cb(null, j.data);
  });
}

function getToken(label, cb) {
  var p = "/open/auth/token?client_id=" + encodeURIComponent(QL_CLIENT_ID) + "&client_secret=" + encodeURIComponent(QL_CLIENT_SECRET);
  qlReq("GET", p, null, null, function (e, d) {
    if (e) return cb(e);
    if (!d || !d.token) return cb("token为空");
    cb(null, d.token);
  }, 1, label || "取token");
}

function getEnvs(label, t, cb) {
  qlReq("GET", "/open/envs?searchValue=JD_COOKIE&t=" + Date.now(), null, t, function (e, d) {
    if (e) return cb(e);
    cb(null, d && d.length ? d : []);
  }, 1, label || "查环境");
}

// 推送后二次复核：重新拉取青龙 JD_COOKIE，确认最新 pt_key 确实已落地。
// 直接回应“日志报失败、但青龙显示已更新”的歧义——给出确定的 ✅/⚠️ 结论。
function verifyCK(t, pin, key, cb) {
  getEnvs("复核查询", t, function (e, envs) {
    if (e) return cb(false, "复核查询失败: " + e);
    var found = false;
    for (var i = 0; i < envs.length; i++) {
      var env = envs[i];
      if (env && env.name === "JD_COOKIE") {
        var v = String(env.value || "");
        if (v.indexOf("pt_key=" + key) >= 0 && v.indexOf("pt_pin=" + encodeURIComponent(pin)) >= 0) { found = true; break; }
      }
    }
    cb(found, found ? "已确认青龙 JD_COOKIE 含最新 pt_key" : "复核未发现最新 pt_key（可能写入未生效或值未变化）");
  });
}

/* PUT /open/envs 发送「单个对象」；个别版本若被拒则回退数组形式重试一次 */
function updEnv(label, t, id, val, rm, cb) {
  var obj = { id: id, name: "JD_COOKIE", value: val, remarks: rm || "" };
  var _lab = label || "更新pt_key";
  qlReq("PUT", "/open/envs", obj, t, function (e) {
    if (!e) return cb(null);
    if (/Validation failed|code=undefined/i.test(String(e))) {
      return qlReq("PUT", "/open/envs", [obj], t, function (e2) {
        if (e2) return cb(e2);
        cb(null);
      }, 1, _lab);
    }
    cb(e);
  }, 1, _lab);
}

function newEnv(label, t, val, cb) {
  qlReq("POST", "/open/envs", [{ name: "JD_COOKIE", value: val, remarks: "Loon自动添加" }], t, function (e, d) {
    if (e) return cb(e, null);
    var nid = (d && d[0]) ? d[0].id : null;
    cb(null, nid);
  }, 1, label || "新建环境");
}

function enableEnv(label, t, id) {
  qlReq("PUT", "/open/envs/enable", [id], t, function (e) { if (e) log("[" + (label || "启用环境") + "] 启用失败 " + e); }, 1, label || "启用环境");
}

function setKey(seg, key) {
  if (/pt_key=[^;]*/.test(seg)) return seg.replace(/pt_key=[^;]*/, function () { return "pt_key=" + key; });
  return "pt_key=" + key + ";" + seg;
}

function pushCK(pin, key, cb) {
  getToken("取token", function (e, tok) {
    if (e) return cb(false, "token失败: " + e);
    getEnvs("查环境", tok, function (e2, envs) {
      if (e2) return cb(false, "查询失败: " + e2);
      var jd = [];
      for (var i = 0; i < envs.length; i++) { if (envs[i] && envs[i].name === "JD_COOKIE") jd.push(envs[i]); }

      if (jd.length === 0) {
        var nv = "pt_key=" + key + ";pt_pin=" + encodeURIComponent(pin) + ";";
        return newEnv("新建环境", tok, nv, function (e3, nid) {
          if (e3) return cb(false, "新建失败: " + e3);
          if (nid) enableEnv("启用环境", tok, nid);
          cb(true, "已新建 JD_COOKIE");
        });
      }

      for (var k = 0; k < jd.length; k++) {
        var env = jd[k];
        var segs = String(env.value || "").split("&");
        for (var s = 0; s < segs.length; s++) {
          var m = segs[s].match(/pt_pin=([^;\s]+)/);
          if (m && dPin(m[1]) === pin) {
            segs[s] = setKey(segs[s], key);
            var nv2 = segs.join("&");
            var id = env.id, st = env.status, rm = env.remarks;
            return updEnv("更新pt_key", tok, id, nv2, rm, function (e4) {
              if (e4) return cb(false, "更新失败: " + e4);
              if (st !== undefined && st !== null && st !== 0) enableEnv("启用环境", tok, id);
              cb(true, "已更新 pt_key (env id=" + id + ")");
            });
          }
        }
      }

      var tgt = jd[0];
      var base = String(tgt.value || "").replace(/&+$/, "");
      var add = (base ? "&" : "") + "pt_key=" + key + ";pt_pin=" + encodeURIComponent(pin) + ";";
      var tid = tgt.id, tst = tgt.status, trm = tgt.remarks;
      updEnv("更新pt_key", tok, tid, base + add, trm, function (e5) {
        if (e5) return cb(false, "追加失败: " + e5);
        if (tst !== undefined && tst !== null && tst !== 0) enableEnv("启用环境", tok, tid);
        cb(true, "已作为新账号追加");
      });
    });
  });
}

// 获取到 pt_key 后的通知策略（由「pt_key获取通知」开关控制）
//   开启 → 即时通知：同一 pt_key 在 1 分钟内只弹一次，避免京东 App 一次触发多条请求导致刷屏
//   关闭 → 半小时内只通知一次
function maybeNotifyGet(pin, key) {
  if (NOTIFY_GET) {
    var _last = Number(sGet(K_NOTIFY + pin) || "0");
    var _lastKey = sGet(K_NOTIFY_KEY + pin);
    if (_lastKey === key && Date.now() - _last < NOTIFY_NEW_GAP) {
      // 同 key 1 分钟内已通知过，跳过（不重复弹窗、也不打日志）
    } else {
      sSet(K_NOTIFY + pin, String(Date.now()));
      sSet(K_NOTIFY_KEY + pin, key);
      notify("获取ck成功", "pt_pin: " + pin, "pt_key: " + key);
    }
  } else {
    var _last2 = Number(sGet(K_NOTIFY + pin) || "0");
    if (Date.now() - _last2 >= GET_NOTIFY_GAP) {
      sSet(K_NOTIFY + pin, String(Date.now()));
      notify("获取ck成功", "pt_pin: " + pin, "pt_key: " + key);
    }
    // 30 分钟限频未到时静默跳过（不打日志）
  }
}

function run() {
  var req = (typeof $request !== "undefined" && $request) ? $request : {};
  var headers = req.headers || {};
  var cookie = gH(headers, "Cookie");
  if (!cookie) { finish(); return; }
  var mk = cookie.match(/pt_key=([^;\s]+)/);
  var mp = cookie.match(/pt_pin=([^;\s]+)/);
  if (!mk || !mp) { finish(); return; }

  var ptKey = mk[1];
  var ptPin = dPin(mp[1]);

  // 比对 pt_key 的值：仅用于日志展示「是否发生变化」，不再据此跳过推送（开启「推送青龙」即强制推送）
  var _stored = getLastKey(ptPin);
  var _changed = !!(ptKey && _stored !== ptKey);

  // 每次执行输出必要日志，便于确认脚本在跑、参数解析是否正确（分行显示，避免挤在一起）
  var _raw;
  if (typeof $argument === "object" && $argument) {
    try { _raw = "Object:" + JSON.stringify($argument); } catch (e) { _raw = "[object]"; }
  } else if (typeof $argument === "string") {
    _raw = $argument;
  } else {
    _raw = "(空)";
  }
  log("运行 | 版本=" + VERSION);
  // —— 1、获取参数设置 ——
  log("1、获取参数设置");
  log("  推送青龙=" + (ENABLE_PUSH ? "开(强制)" : "关") + " | pt_key获取通知=" + (NOTIFY_GET ? "开" : "关(30min仅一次)") + " | 青龙地址=" + (QL_URL || "(未填写!)") + " | 凭证来源=" + _credSrc);
  // 占位符未替换检测：仅在异常时打印 raw（正常情况不再重复输出完整参数/密钥）
  if (_raw.indexOf("{CLIENT_ID}") >= 0 || _raw.indexOf("{PUSH}") >= 0 || _raw.indexOf("{QL_URL}") >= 0) {
    log("  ⚠️ 参数未被 Loon 替换（仍含 {CLIENT_ID}/{PUSH}/{QL_URL} 等占位符），很可能运行的是旧的脚本条目。请在 Loon 删除旧的「京东CK」脚本、重新导入 jdck_ql.plugin。");
  }

  // —— 2、获取CK ——
  log("2、获取CK");
  log("  - 获取成功，pt_key为：" + ptKey + " | pt_pin：" + ptPin);
  log("  - 上次pt_key为：" + (_stored || "(无)") + (_changed ? "（与上次不同）" : "（与上次相同）"));

  // （已移除“pt_key未变化”心跳分支：开启「推送青龙」即对每次捕获强制推送，不再因同值而跳过）

  // 获取到 pt_key 的通知：由「pt_key获取通知」开关控制（开启=即时通知，关闭=30分钟仅一次）
  maybeNotifyGet(ptPin, ptKey);

  // 推送节流：同 key 在 PUSH_GAP(30s) 内只尝试一次（压突发刷屏，也防失败高频重试）
  // 注意：仅是短时节流，并非「同值永久跳过」——开启「推送青龙」即强制推送，每次捕获都会尝试（受 30s 限频保护）。
  var _lastTryKey = sGet(K_TRYKEY + ptPin);
  var _lastTryT = Number(sGet(K_TRY) || "0");
  if (_lastTryKey === ptKey && Date.now() - _lastTryT < PUSH_GAP) {
    log("3、推送到青龙面板");
    log("  - 推送节流（同key " + (PUSH_GAP / 1000) + "秒内已尝试，跳过本次；限频后仍将强制推送）。");
    finish(); return;
  }
  sSet(K_TRYKEY + ptPin, ptKey);
  sSet(K_TRY, String(Date.now()));

  if (!ENABLE_PUSH) {
    log("3、推送到青龙面板");
    log("  - 根据设置「推送青龙=关」，仅抓取 CK 不推送青龙。");
    finish(); return;
  }

  if (WHITELIST_MODE) {
    var ok = false;
    for (var i = 0; i < PT_PIN_WHITELIST.length; i++) {
      if (PT_PIN_WHITELIST[i] && dPin(String(PT_PIN_WHITELIST[i])) === ptPin) { ok = true; break; }
    }
    if (!ok) { setLastKey(ptPin, ptKey); log("3、推送到青龙面板"); log("  - pt_pin 不在白名单，跳过推送。"); finish(); return; }
  }

  if (!QL_CLIENT_ID || !QL_CLIENT_SECRET) {
    log("3、推送到青龙面板");
    log("  - 青龙凭证未配置，已终止推送。请在 Loon 参数填写 CLIENT_ID / CLIENT_SECRET");
    notify("京东Cookie未推送", "凭证未配置", "Loon脚本参数中填入 CLIENT_ID/CLIENT_SECRET");
    finish(); return;
  }

  if (!QL_URL) {
    log("3、推送到青龙面板");
    log("  - 青龙地址(QL_URL)未填写，已终止推送。请在插件参数填写 QL_URL");
    notify("京东Cookie未推送", "青龙地址未配置", "Loon插件参数中填入 QL_URL");
    finish(); return;
  }

  log("3、推送到青龙面板");
  log("  - 开始推送（目标=" + hostOf(QL_URL) + " | 出站=" + QL_HTTP_NODE + "）");
  pushCK(ptPin, ptKey, function (ok2, msg) {
    if (ok2) {
      setLastKey(ptPin, ptKey);
      log("  - 推送结果：成功（" + msg + "）");
      log("  - 已发送「ck推送青龙成功」通知。");
      notify("ck推送青龙成功", "pt_pin: " + ptPin, msg + " | pt_key: " + ptKey);
      // 二次复核：重新拉取青龙确认最新 pt_key 已落地，消除“日志失败但青龙已更新”的歧义
      getToken("复核取token", function (e, tok) {
        if (e) { log("  - 二次复核：取 token 失败（" + e + "），无法确认；以青龙侧实际为准。"); return finish(); }
        verifyCK(tok, ptPin, ptKey, function (vf, vm) {
          log("  - 二次复核：" + (vf ? "✅ " + vm : "⚠️ " + vm));
          finish();
        });
      });
    } else {
      var _isCF = /\[CF_TUNNEL\]/.test(msg);
      log("  - 推送结果：失败（" + msg + "）");
      if (_isCF) {
        log("  - 分类：青龙隧道/网关故障（与脚本无关）。CK 未送达青龙；隧道恢复后脚本会自动重试，无需改脚本。");
      } else {
        log("  - 提示：网络超时可能是“请求已到达青龙并处理、响应未返回”，青龙侧可能已更新；本账号下次触发会自动重试。");
      }
      // 「推送失败」通知限频(10min)，持续失败时也不会刷屏
      var lastFail = Number(sGet(K_FAIL_NOTIFY) || "0");
      if (Date.now() - lastFail >= NOTIFY_FAIL_GAP) {
        sSet(K_FAIL_NOTIFY, String(Date.now()));
        log("  - 已发送「ck推送青龙失败」通知(限频10min)。");
        notify("ck推送青龙失败", "pt_pin: " + ptPin, _isCF ? "青龙隧道不可达(与脚本无关)" : msg);
      }
      finish();
    }
  });
}

try { run(); } catch (e) {
  try { var m = (e && e.message) ? e.message : String(e); log("脚本异常：" + (e && e.stack ? e.stack : m)); } catch (e2) {}
}
