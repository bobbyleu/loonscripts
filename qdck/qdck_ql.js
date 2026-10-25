// 起点Cookie自动推送青龙面板
// 拦截 h5.if.qidian.com 上携带登录 Cookie 的 getlogininfo 请求，捕获完整 Cookie，
// 按 uid 匹配青龙 QDREADER_COOKIE（JSON Map {"uid":"完整cookie"}）并自动更新：同 uid 改写、新 uid 新增、其他账号保留。
// 推送成功后可按开关触发青龙起点签到任务立即执行（PUT /open/crons/run）。
//
// 抓取逻辑与 qdreader.js 主脚本保持一致（已从其源码中提取核实）：
//   - 登录校验：cookie 必须同时含 ywKey 与 ywGuid，否则判定未登录、跳过抓取；
//   - uid 算法：base64解码(QDHeader).split('|')[11]，取不到时回退 cookie 的 uid 字段、再回退响应体 Data.UserId。
//
// 参数通过 Loon 插件「参数面板」设置（导入后在 Loon → 脚本 → 点开本脚本 → 参数 中可见）：
//   CLIENT_ID / CLIENT_SECRET : 青龙面板「系统设置-应用设置-开放授权」密钥（需 envs + crons 权限）
//   QL_URL                   : 青龙面板地址（**无默认值，必须由用户在插件参数填写**，如 https://your-domain.com）
//   PUSH                     : 推送青龙（true=获取到Cookie即推送 / false=仅抓取不推送）
//   RUN_SIGN                 : 推送后触发青龙签到任务（true=推送成功后立即执行签到任务 / false=只更新变量）
//   TASK_KEY                 : 青龙签到任务的匹配关键词（按任务 command 包含该字符串定位，默认 qdreader）
//   ENV_NAME                 : 青龙环境变量名（默认 QDREADER_COOKIE）
//   CF_ACCESS_ID / CF_ACCESS_SECRET : Cloudflare Access 服务令牌（可选，为青龙请求加边缘鉴权）
// 兼容 $persistentStore 兜底。

// ========== 配置区（一般无需改动）==========
var QL_URL = "";   // 默认空：青龙地址必须由用户在 Loon 参数 QL_URL 中填写，脚本不预置任何地址（避免暴露）
var WHITELIST_MODE = false;                   // true=仅白名单内 uid 写入青龙
var UID_WHITELIST = [];                       // 白名单 uid，如 ["123456","789012"]
var PUSH_GAP = 30 * 1000;                     // 同一 uid 两次推送尝试的最小间隔(防高频)：突发多次捕获只推一次，也防失败高频重试
var NOTIFY_FAIL_GAP = 10 * 60 * 1000;         // 「推送失败」通知最小间隔(10min)
var VERSION = "V1.00";
var QL_ENV_NAME = "QDREADER_COOKIE";          // 青龙环境变量名（默认值，可被插件参数 ENV_NAME 覆盖）
var QL_TASK_KEY = "qdreader";                 // 青龙签到任务匹配关键词（默认值，可被插件参数 TASK_KEY 覆盖）
var UID_SPLIT_INDEX = 11;                     // base64(QDHeader).split('|') 中 uid 的下标（与主脚本一致）
var BUSY_TTL = 110 * 1000;                    // 全局单飞锁有效期(ms)：一次完整推送(含复核/触发)可能跨多次网络往返，留足时间
var DEBOUNCE_MS = 4000;                       // 相同Cookie的缓冲窗口(ms)：等待后续是否出现更新 cookie；窗口内无更新则按设置强制推送当前值
var MAX_ROUNDS = 6;                           // 单飞锁续推轮数上限：推送期间其他账号的新捕获会续推，最多 6 轮

// ========== 参数解析 ==========
// Loon 3.5.x 的 [Argument] 占位式 argument=[{CLIENT_ID},{...}] 运行期会把 $argument
// 直接传成「原生 JS 对象」，也可能传成「数组」或「JSON 字符串」。本函数同时兼容这几种 + 手动命名式(CLIENT_ID=x&...)。
var _ARGS = null;
function parseArgs() {
  if (_ARGS) return _ARGS;
  var map = {};
  var a = (typeof $argument !== "undefined") ? $argument : "";

  // 把「对象 / 数组 / JSON 字符串」吸收进 map
  function absorb(o) {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) {
      var names = ["CLIENT_ID", "CLIENT_SECRET", "QL_URL", "PUSH", "RUN_SIGN", "TASK_KEY", "ENV_NAME", "CF_ACCESS_ID", "CF_ACCESS_SECRET"];
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
        // 逗号占位式 id,secret,url,true,true,qdreader,QDREADER_COOKIE
        var names2 = ["CLIENT_ID", "CLIENT_SECRET", "QL_URL", "PUSH", "RUN_SIGN", "TASK_KEY", "ENV_NAME", "CF_ACCESS_ID", "CF_ACCESS_SECRET"];
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

var QL_CLIENT_ID = _idFromArg ? _argId : sGet("QDCK_CLID");
var QL_CLIENT_SECRET = _secFromArg ? _argSec : sGet("QDCK_CLSEC");

if (_idFromArg) sSet("QDCK_CLID", _argId);
if (_secFromArg) sSet("QDCK_CLSEC", _argSec);

// 青龙地址：参数 QL_URL 优先 + $persistentStore 兜底 + 默认
var _argUrl = getArg("QL_URL", "");
QL_URL = _argUrl ? _argUrl : (sGet("QDCK_URL") || QL_URL);
if (QL_URL) {
  if (!/^https?:\/\//i.test(QL_URL)) QL_URL = "https://" + QL_URL; // 用户可能只填域名，补默认 https
  QL_URL = QL_URL.replace(/\/+$/, "");                             // 去尾部斜杠，避免拼出 //open/envs
}
if (_argUrl) sSet("QDCK_URL", QL_URL);

// 变量名 / 任务关键词：参数优先，缺省用内置默认
var _argEnv = getArg("ENV_NAME", "");
QL_ENV_NAME = _argEnv ? _argEnv : (sGet("QDCK_ENVNAME") || QL_ENV_NAME);
if (_argEnv) sSet("QDCK_ENVNAME", _argEnv);
var _argTaskKey = getArg("TASK_KEY", "");
QL_TASK_KEY = _argTaskKey ? _argTaskKey : (sGet("QDCK_TASKKEY") || QL_TASK_KEY);
if (_argTaskKey) sSet("QDCK_TASKKEY", _argTaskKey);

// Cloudflare Access 服务令牌（Service Auth）：给所有青龙请求加 CF-Access-* 头，
// 即便隧道域名泄露，无令牌请求在 Cloudflare 边缘即被拒。通过插件参数 CF_ACCESS_ID / CF_ACCESS_SECRET 输入。
var _argAccessId = getArg("CF_ACCESS_ID", "");
var _argAccessSec = getArg("CF_ACCESS_SECRET", "");
var _aidFromArg = !!(_argAccessId && !/^\{.*\}$/.test(_argAccessId));
var _asecFromArg = !!(_argAccessSec && !/^\{.*\}$/.test(_argAccessSec));
var QL_ACCESS_ID = _aidFromArg ? _argAccessId : sGet("QDCK_CFID");
var QL_ACCESS_SECRET = _asecFromArg ? _argAccessSec : sGet("QDCK_CFSEC");
if (_aidFromArg) sSet("QDCK_CFID", _argAccessId);
if (_asecFromArg) sSet("QDCK_CFSEC", _argAccessSec);

var ENABLE_PUSH = parseBool(getArg("PUSH", "true"), true);
var ENABLE_RUN_SIGN = parseBool(getArg("RUN_SIGN", "true"), true);

// ========== 持久化键 ==========
// QDCK_LAST_<uid>：每个 uid 上次已推送的 cookie 值，作为「是否变化/去重」基准。
var K_TRY = "QDCK_TRY";         // 上次推送尝试时间(节流)
function lastKeyStore(uid) { return "QDCK_LAST_" + uid; }
function getLastKey(uid) { return sGet(lastKeyStore(uid)); }
function setLastKey(uid, key) { sSet(lastKeyStore(uid), key); }
var K_FAIL_NOTIFY = "QDCK_FAILNOTIFY"; // 上次「推送失败」通知时间
var K_TRYKEY = "QDCK_TRYKEY_";         // 上次尝试推送的 cookie（前缀，拼接 uid）
var K_PUSHED = "QDCK_PUSHED_";         // 上次成功推送的 cookie|时间戳（前缀，拼接 uid）：相同Cookie强制推送时去重，避免刚推过又重复往返
function getPushed(uid) { var v = sGet(K_PUSHED + uid); var i = v.indexOf("|"); return i < 0 ? { key: "", t: 0 } : { key: v.slice(0, i), t: Number(v.slice(i + 1) || "0") }; }
function setPushed(uid, key) { sSet(K_PUSHED + uid, key + "|" + Date.now()); }
var K_CAP = "QDCK_CAP_";               // 最新捕获的 cookie（每次捕获都写，供单飞锁补推最新值）
function getCap(uid) { return sGet(K_CAP + uid); }
function setCap(uid, key) { sSet(K_CAP + uid, key); }
var K_UIDS = "QDCK_UIDS";              // 已知 uid 注册表（逗号分隔）：供单飞锁扫描其他账号的待推送项
function listUids() { var v = sGet(K_UIDS); return v ? v.split(",").filter(function (x) { return !!x; }) : []; }
function registerUid(uid) {
  var uids = listUids();
  if (uids.indexOf(uid) < 0) { uids.push(uid); sSet(K_UIDS, uids.join(",")); }
}
var K_BUSY = "QDCK_BUSY";              // 全局单飞锁：推送进行中标记(存开始时间戳)。
// 说明：QDREADER_COOKIE 是多账号共享的 JSON Map，推送是「读-改-写」全局操作，
// 因此用全局锁（而非按 uid 的锁）串行化，避免两个账号的交错写互相覆盖。

// ========== 工具 ==========
function clip(s, n) { s = (s === undefined || s === null) ? "" : String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
function maskCookie(s) { s = (s === undefined || s === null) ? "" : String(s); return s.length <= 14 ? "****" : s.slice(0, 10) + "…" + s.slice(-6); } // 通知/日志里脱敏 cookie，避免明文外泄到 Bark 等渠道
function hostOf(u) { var m = String(u || "").match(/^https?:\/\/([^\/?#]+)/); return m ? m[1] : String(u || ""); }
function log(m) { try { console.log(m); } catch (e) {} }
function notify(t, s, b) { try { $notification.post(t || "", s || "", b || ""); } catch (e) {} }
function finish() { try { $done({}); } catch (e) {} }
function gH(h, n) {
  if (!h) return "";
  n = String(n).toLowerCase();
  for (var k in h) { if (String(k).toLowerCase() === n) { var v = h[k]; return (v === undefined || v === null) ? "" : String(v); } }
  return "";
}

// 识别青龙网关/隧道类故障（Cloudflare Tunnel 等），给出明确“与脚本无关”的人话提示
function classifyQLFailure(status, rawData) {
  var s = String(rawData || "");
  var isCF = /cloudflare|error[-\s]?1033|tunnel error|530/i.test(s);
  if (isCF) {
    return "⚠️ 青龙隧道(cloudflared)不可达：Cloudflare 返回 " + status + "（Error 1033 等），通常是家里 cloudflared/青龙服务离线或与 Cloudflare 的 QUIC 连接断开，与脚本无关。请检查家里 RK.Panther-X2 的 cloudflared/qinglong 容器是否在线（docker ps / docker logs cloudflared）。";
  }
  return "";
}

// ========== base64 解码（不依赖 atob/Buffer，Loon JSC 兼容性更稳）==========
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64ToBytes(s) {
  s = String(s || "").replace(/[^A-Za-z0-9+/=]/g, "").replace(/=+$/, "");
  var out = [];
  var buffer = 0, bits = 0;
  for (var i = 0; i < s.length; i++) {
    var v = B64_CHARS.indexOf(s[i]);
    if (v < 0) continue;
    buffer = (buffer << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return out;
}
// 字节数组 → UTF-8 字符串（手写解码，避免依赖 escape/TextDecoder）
function utf8FromBytes(bytes) {
  var out = "";
  var i = 0;
  while (i < bytes.length) {
    var b = bytes[i];
    if (b < 0x80) { out += String.fromCharCode(b); i += 1; }
    else if (b >= 0xc0 && b < 0xe0) { out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)); i += 2; }
    else if (b >= 0xe0 && b < 0xf0) { out += String.fromCharCode(((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)); i += 3; }
    else if (b >= 0xf0) { // 4 字节序列：用代理对
      var cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
      i += 4;
    }
    else { i += 1; } // 续字节孤立出现，跳过
  }
  return out;
}
function b64decode(s) { return utf8FromBytes(b64ToBytes(s)); }

// ========== Cookie 解析 ==========
// Cookie 字符串 → {key: value}（保留原始大小写键，读取时大小写不敏感）
function parseCookie(cookie) {
  var map = {};
  String(cookie || "").split(";").forEach(function (seg) {
    var i = seg.indexOf("=");
    if (i <= 0) return;
    var k = seg.slice(0, i).trim();
    var v = seg.slice(i + 1).trim();
    if (k) map[k] = v;
  });
  return map;
}
function cookieGet(map, name) {
  name = String(name).toLowerCase();
  for (var k in map) {
    if (Object.prototype.hasOwnProperty.call(map, k) && String(k).toLowerCase() === name) return map[k];
  }
  return "";
}

// 登录校验：cookie 必须同时含 ywKey 与 ywGuid（与主脚本一致，缺一即未登录）
function hasLogin(cmap) {
  var k = cookieGet(cmap, "ywKey") || cookieGet(cmap, "ywkey") || cookieGet(cmap, "sessionyw");
  var g = cookieGet(cmap, "ywGuid") || cookieGet(cmap, "ywguid");
  return !!(k && g);
}

// uid 计算：base64(QDHeader).split('|')[11] → cookie uid 字段 → 响应体 Data.UserId
function computeUid(cmap, respBody) {
  var qdh = cookieGet(cmap, "QDHeader") || cookieGet(cmap, "qdheader");
  if (qdh) {
    try {
      var parts = b64decode(qdh).split("|");
      var u = String(parts[UID_SPLIT_INDEX] === undefined ? "" : parts[UID_SPLIT_INDEX]).replace(/^\s+|\s+$/g, "");
      if (u) return u;
    } catch (e) {}
  }
  var fromCookie = cookieGet(cmap, "uid");
  if (fromCookie) return String(fromCookie).replace(/^\s+|\s+$/g, "");
  if (respBody) {
    try {
      var j = JSON.parse(respBody);
      var d = j && (j.Data || j.data);
      var id = d && (d.UserId || d.userId || d.uid);
      if (id) return String(id).replace(/^\s+|\s+$/g, "");
    } catch (e) {}
  }
  return "";
}

// ========== 青龙请求 ==========
// 网络错误（超时/断连）自动重试，解决“青龙其实已更新、但响应超时导致误报失败”的歧义。
var QL_HTTP_TIMEOUT = 15000; // 单次 httpClient 超时（毫秒）。直连 Cloudflare 边缘抖动时 10s 易超时，放宽到 15s 吸收抖动
var QL_MAX_RETRY = 3;        // 网络错误最多尝试次数（含首次）
var QL_RETRY_DELAY = 2000;   // 网络错误重试前的等待(毫秒)
var QL_HTTP_NODE = "DIRECT"; // 出站节点：DIRECT=直连(不经 Loon 代理)。青龙为公网域名时直连最快最稳；若你的网络必须走某节点才能访问，改成该节点名
function qlReq(method, path, body, token, cb, _attempt, _label) {
  _attempt = _attempt || 1;
  var _lab = _label ? ("[" + _label + "] ") : "";
  var h = { "Content-Type": "application/json", "Accept": "application/json" };
  if (token) h["Authorization"] = "Bearer " + token;
  // Cloudflare Access 服务令牌：所有青龙请求统一带上，隧道域名即便泄露也无令牌即被边缘拒绝
  if (QL_ACCESS_ID) h["CF-Access-Client-Id"] = QL_ACCESS_ID;
  if (QL_ACCESS_SECRET) h["CF-Access-Client-Secret"] = QL_ACCESS_SECRET;
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
      log(_lab + "请求失败：网络错误 " + clip(es, 200));
      return cb("网络错误: " + es);
    }
    var status = (resp && resp.status) ? resp.status : ((resp && resp.statusCode) ? resp.statusCode : "?");
    if (status === 401) clearCachedToken(); // token 失效(如密钥变更)：立即清缓存，下次取新 token
    var j;
    try { j = JSON.parse(data); }
    catch (e) { log(_lab + "请求失败：响应非JSON HTTP " + status + " " + clip(String(data), 200)); return cb("响应非JSON (HTTP " + status + ")"); }
    if (!j || j.code !== 200) {
      var c = (j && j.code !== undefined) ? j.code : "undefined";
      var msg = (j && j.message !== undefined) ? (typeof j.message === "string" ? j.message : JSON.stringify(j.message)) : "";
      var cls = classifyQLFailure(status, data);
      var tag = cls ? " [CF_TUNNEL]" : "";
      log(_lab + "请求失败：青龙 HTTP " + status + " code=" + c + " message=" + msg + " " + clip(String(data), 200) + (cls ? ("\n  " + cls) : ""));
      return cb("青龙错误 HTTP " + status + " code=" + c + " message=" + msg + tag);
    }
    cb(null, j.data);
  });
}

// 青龙 open API token 缓存：复用同一 token，省去热路径(尤其二次复核)重复的 token 握手往返，
// 降低直连 Cloudflare 边缘抖动时的超时概率。遇 401 立即清缓存重取。
var K_TOK = "QDCK_TOK";         // 缓存的 token
var K_TOKEXP = "QDCK_TOKEXP";   // token 过期时间戳(ms)
var TOK_TTL = 6 * 60 * 60 * 1000; // 缓存有效期(6h)
function getCachedToken() { var t = sGet(K_TOK); var exp = Number(sGet(K_TOKEXP) || "0"); return (t && Date.now() < exp) ? t : ""; }
function setCachedToken(t) { sSet(K_TOK, t); sSet(K_TOKEXP, String(Date.now() + TOK_TTL)); }
function clearCachedToken() { sSet(K_TOK, ""); sSet(K_TOKEXP, "0"); }

function getToken(label, cb) {
  var cached = getCachedToken();
  if (cached) return cb(null, cached);       // 命中缓存：零往返
  var p = "/open/auth/token?client_id=" + encodeURIComponent(QL_CLIENT_ID) + "&client_secret=" + encodeURIComponent(QL_CLIENT_SECRET);
  qlReq("GET", p, null, null, function (e, d) {
    if (e) return cb(e);
    if (!d || !d.token) return cb("token为空");
    setCachedToken(d.token);
    cb(null, d.token);
  }, 1, label || "取token");
}

function getEnvs(label, t, cb) {
  qlReq("GET", "/open/envs?searchValue=" + encodeURIComponent(QL_ENV_NAME) + "&t=" + Date.now(), null, t, function (e, d) {
    if (e) return cb(e);
    cb(null, d && d.length ? d : []);
  }, 1, label || "查环境");
}

// 推送后二次复核：重新拉取青龙变量，确认最新 cookie 确实已落地（map[uid] === cookie）。
// 直接回应“日志报失败、但青龙显示已更新”的歧义——给出确定的 ✅/⚠️ 结论。
function verifyCookie(t, uid, cookie, cb) {
  getEnvs("复核查询", t, function (e, envs) {
    if (e) return cb(false, "复核查询失败: " + e);
    for (var i = 0; i < envs.length; i++) {
      var env = envs[i];
      if (env && env.name === QL_ENV_NAME) {
        var map = null;
        try { map = JSON.parse(String(env.value || "")); } catch (e2) {}
        if (map && typeof map === "object" && map[uid] === cookie) return cb(true, "已确认青龙 " + QL_ENV_NAME + " 中 uid=" + uid + " 为最新 cookie");
        return cb(false, "复核未发现最新 cookie（可能写入未生效或值未变化）");
      }
    }
    cb(false, "复核未找到变量 " + QL_ENV_NAME);
  });
}

/* PUT /open/envs 发送「单个对象」；个别版本若被拒则回退数组形式重试一次 */
function updEnv(label, t, id, val, rm, cb) {
  var obj = { id: id, name: QL_ENV_NAME, value: val, remarks: rm || "" };
  var _lab = label || "更新变量";
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
  qlReq("POST", "/open/envs", [{ name: QL_ENV_NAME, value: val, remarks: "Loon自动添加" }], t, function (e, d) {
    if (e) return cb(e, null);
    var nid = (d && d[0]) ? d[0].id : null;
    cb(null, nid);
  }, 1, label || "新建环境");
}

function enableEnv(label, t, id) {
  qlReq("PUT", "/open/envs/enable", [id], t, function (e) { if (e) log("[" + (label || "启用环境") + "] 启用失败 " + e); }, 1, label || "启用环境");
}

// ========== 合并推送 ==========
// 读现值 → 合并（同 uid 覆盖 / 新 uid 新增 / 其他账号原样保留）→ 写回。
// 变量不存在时新建；现值不是 JSON 时原值备份到 <uid>_backup 键并告警，绝不清空（避免丢其他账号）。
function pushCookie(uid, cookie, cb) {
  getToken("取token", function (e, tok) {
    if (e) return cb(false, "token失败: " + e);
    getEnvs("查环境", tok, function (e2, envs) {
      if (e2) return cb(false, "查询失败: " + e2);
      var tgt = null;
      for (var i = 0; i < envs.length; i++) { if (envs[i] && envs[i].name === QL_ENV_NAME) { tgt = envs[i]; break; } }

      if (!tgt) {
        // 青龙还没有该变量：新建，value 即 {"<uid>":"cookie"}
        var init = {};
        init[uid] = cookie;
        var nv = JSON.stringify(init);
        return newEnv("新建环境", tok, nv, function (e3, nid) {
          if (e3) return cb(false, "新建失败: " + e3);
          if (nid) enableEnv("启用环境", tok, nid);
          cb(true, "已新建 " + QL_ENV_NAME + " 并写入账号");
        });
      }

      var raw = String(tgt.value || "");
      var map = {};
      var badValue = false;
      try {
        map = JSON.parse(raw);
        if (!map || typeof map !== "object" || Array.isArray(map)) { map = {}; badValue = true; }
      } catch (e4) { map = {}; badValue = true; }
      if (badValue) {
        log("⚠️ 青龙 " + QL_ENV_NAME + " 现值不是 JSON Map（可能是手填的原始 cookie），已原值备份到键 " + uid + "_backup，不清空。");
        if (raw) map[uid + "_backup"] = raw;
      }

      var isNew = !Object.prototype.hasOwnProperty.call(map, uid);
      map[uid] = cookie;
      var nv2 = JSON.stringify(map);
      var tid = tgt.id, tst = tgt.status, trm = tgt.remarks;
      updEnv("更新变量", tok, tid, nv2, trm, function (e5) {
        if (e5) return cb(false, "更新失败: " + e5);
        if (tst !== undefined && tst !== null && tst !== 0) enableEnv("启用环境", tok, tid);
        cb(true, (isNew ? "新增账号" : "更新账号") + " uid=" + uid + "（共 " + Object.keys(map).length + " 个键）");
      });
    });
  });
}

// ========== 触发青龙签到任务 ==========
// PUT /open/crons/run，body 是任务 ID 数组（注意是 PUT 不是 POST）。
// 按 command 包含 TASK_KEY 且 status=0（已启用）定位任务，比按任务名称可靠。
function triggerTask(t, cb) {
  qlReq("GET", "/open/crons?t=" + Date.now(), null, t, function (e, d) {
    if (e) return cb(false, "查询任务失败: " + e);
    var list = Array.isArray(d) ? d : [];
    var ids = [];
    var names = [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var cmd = String((c && c.command) || "");
      if (cmd && cmd.toLowerCase().indexOf(QL_TASK_KEY.toLowerCase()) >= 0 && c.status === 0) {
        ids.push(c.id);
        names.push(c.name || cmd);
      }
    }
    if (!ids.length) return cb(false, "未找到命令包含「" + QL_TASK_KEY + "」且已启用的任务（请检查青龙任务命令或 TASK_KEY 参数）");
    qlReq("PUT", "/open/crons/run", ids, t, function (e2) {
      if (e2) return cb(false, "触发失败: " + e2);
      cb(true, "已触发 " + ids.length + " 个签到任务：" + names.join("、"));
    }, 1, "触发签到");
  }, 1, "查任务");
}

// ========== 单飞锁 + 最新值优先 ==========
// QDREADER_COOKIE 是多账号共享变量，推送是全局「读-改-写」：
//  - 全局锁保证同一时刻只有一个实例在推送，避免两个账号交错写互相覆盖；
//  - 推送期间新捕获的 cookie 记入 K_CAP_<uid>，持锁实例每轮结束后扫描注册表，
//    把其他账号“已捕获但未推送”的项续推上去，最多 MAX_ROUNDS 轮；
//  - 最终写进青龙的是每个账号“最后看到的 cookie”，不会丢新值也不会被旧值反序覆盖。
function getBusy() { return Number(sGet(K_BUSY) || "0"); }
function setBusy() { sSet(K_BUSY, String(Date.now())); }
function clearBusy() { sSet(K_BUSY, "0"); }

// 扫描注册表，返回下一个待推送的 {uid, cookie}（优先触发账号，其次其他账号）
function pickNextPending(preferUid) {
  var uids = listUids();
  if (preferUid) {
    var cap = getCap(preferUid);
    if (cap && cap !== getLastKey(preferUid)) return { uid: preferUid, cookie: cap };
  }
  for (var i = 0; i < uids.length; i++) {
    var u = uids[i];
    var c2 = getCap(u);
    if (c2 && c2 !== getLastKey(u)) return { uid: u, cookie: c2 };
  }
  return null;
}

// 推送闭环：串行推送所有待推送账号 → 二次复核 → 按开关触发签到任务 → 通知。
// cb(ok, msg, skip, pushedCookie)：pushedCookie 为触发账号实际落地的 cookie。
function pushLatest(uid, cb) {
  var _busy = getBusy();
  if (_busy && Date.now() - _busy < BUSY_TTL) {
    // 已有实例在推送，本次只更新最新 cookie（已在 run 顶部 setCap），交由持锁实例续推
    return cb(false, "并发突发：已有推送在进行，最新值已记录，将由持锁实例续推", true, null);
  }
  setBusy();
  var rounds = 0;
  var anyOk = false, pushedCookie = null, lastMsg = "";
  function step() {
    rounds++;
    var t = pickNextPending(uid);
    if (!t) {
      clearBusy();
      return cb(anyOk, lastMsg || "无待推送账号", false, pushedCookie);
    }
    pushCookie(t.uid, t.cookie, function (ok, msg) {
      if (ok) {
        setLastKey(t.uid, t.cookie);
        anyOk = true; lastMsg = msg;
        if (t.uid === uid) pushedCookie = t.cookie;
        log("- 账号 uid=" + t.uid + "：" + msg);
      } else {
        lastMsg = msg;
        log("- 账号 uid=" + t.uid + " 推送失败：" + msg);
      }
      var next = pickNextPending(uid);
      if (next && rounds < MAX_ROUNDS) { step(); return; }
      clearBusy();
      cb(anyOk, lastMsg, false, pushedCookie);
    });
  }
  step();
}

// 通知策略（避免多次触发刷屏）：
//  - 推送成功且 cookie 相对推送前已变化 → 发一条「起点Cookie推送青龙成功」（cookie 打码）；
//  - cookie 未变化的强制推送（设置=开）→ 静默落地，不通知；
//  - 推送失败 → 「起点Cookie推送青龙失败」限频 10min。

// 推送结果回调：成功/失败的统一处理（含触发签到、二次复核、失败限频通知）
// preLast：本次推送前的「上次已推送 cookie」基准；仅当实际落地的 cookie 与它不同（=真的换了 cookie）才发成功通知。
function onPushed(uid, cookie, ok2, msg, skip, pushedCookie, preLast) {
  if (skip) { log("- 并发突发：已由其他实例推送最新值，本次跳过。"); log("- 通知：未发送（由持锁实例负责推送与通知）。"); log(""); finish(); return; }
  if (ok2) {
    var _ck = pushedCookie || cookie;   // 实际落地到青龙的 cookie（并发续推时可能是比本次捕获更新的 cookie）
    setLastKey(uid, _ck);
    setPushed(uid, _ck);
    log("- 推送结果：成功（" + msg + "）");
    var _isNewCK = !preLast || _ck !== preLast;   // 相对推送前基准：是否真的换了 cookie
    if (_isNewCK) {
      log("- 通知：已发送「起点Cookie推送青龙成功」（cookie 已打码）。");
      notify("起点Cookie推送青龙成功", "uid: " + uid, "Cookie已推送青龙 | " + msg + " | cookie: " + maskCookie(_ck));
    } else {
      log("- 已按设置强制推送刷新青龙；通知：未发送（青龙已为该 cookie，同值不重复提醒，避免刷屏）。");
    }
    // 二次复核：重新拉取青龙确认最新 cookie 已落地，消除“日志失败但青龙已更新”的歧义
    getToken("复核取token", function (e, tok) {
      if (e) { log("- 二次复核：取 token 失败（" + e + "），无法确认；以青龙侧实际为准。"); log(""); return finish(); }
      verifyCookie(tok, uid, _ck, function (vf, vm) {
        log("- 二次复核：" + (vf ? "✅ " + vm : "⚠️ " + vm));
        log("");
        // 推送后触发签到任务（开关）
        if (!ENABLE_RUN_SIGN) {
          log("3、触发签到任务。");
          log("- 设置「推送后触发签到=关」，跳过触发；青龙自有定时任务会按 cron 执行。");
          log("");
          finish();
          return;
        }
        log("3、触发签到任务。");
        triggerTask(tok, function (tok3, msg3) {
          if (tok3) {
            log("- " + msg3);
            log("- 通知：未发送（触发结果为日志可见信息，避免刷屏）。");
          } else {
            log("- 触发失败：" + msg3 + "（不影响变量更新，青龙定时任务仍会执行签到）");
          }
          log("");
          finish();
        });
      });
    });
  } else {
    var _isCF = /\[CF_TUNNEL\]/.test(msg);
    log("- 推送结果：失败（" + msg + "）");
    if (_isCF) {
      log("- 分类：青龙隧道/网关故障（与脚本无关）。Cookie 未送达青龙；隧道恢复后脚本会自动重试，无需改脚本。");
    } else {
      log("- 提示：网络超时可能是“请求已到达青龙并处理、响应未返回”，青龙侧可能已更新；本账号下次触发会自动重试。");
    }
    // 「推送失败」通知限频(10min)，持续失败时也不会刷屏
    var lastFail = Number(sGet(K_FAIL_NOTIFY) || "0");
    if (Date.now() - lastFail >= NOTIFY_FAIL_GAP) {
      sSet(K_FAIL_NOTIFY, String(Date.now()));
      log("- 通知：已发送「起点Cookie推送青龙失败」（限频10min）。");
      notify("起点Cookie推送青龙失败", "uid: " + uid, _isCF ? "青龙隧道不可达(与脚本无关)" : msg);
    } else {
      log("- 通知：未发送（「推送失败」通知处于 10min 限频期内，避免刷屏）。");
    }
    log("");
    finish();
  }
}

// 推送决策（推送=开时的两种情况；推送=关的两种情况在 run() 内直接提示不推送）：
//  不同cookie → 立即推送（并通知）；
//  相同cookie → 先进入缓冲窗口等待后续捕获：窗口内出现更新 cookie 则改推最新值，
//              窗口内无更新则按设置强制推送当前值（相同cookie也推；同值不重复通知，30s 内刚推过则跳过）。
function decidePush(uid, cookie) {
  var cap = getCap(uid);
  if (!cap) { finish(); return; }
  var changed = (cap !== getLastKey(uid));
  if (changed) {
    log("- 获取到不同起点Cookie，根据设置开始推送青龙面板……");
    var _pre = getLastKey(uid);
    pushLatest(uid, function (ok2, msg, skip, pk) { onPushed(uid, cookie, ok2, msg, skip, pk, _pre); });
  } else {
    log("- 获取到相同起点Cookie，进入 " + (DEBOUNCE_MS / 1000) + "s 缓冲：等待后续捕获，若出现更新 cookie 则改推最新值，避免把刷新前的旧 cookie 推上去。");
    setTimeout(function () {
      var cap2 = getCap(uid);
      var changed2 = !!(cap2 && cap2 !== getLastKey(uid));
      var _pre2 = getLastKey(uid);
      if (changed2) {
        log("- 缓冲期内出现更新 cookie：获取到不同起点Cookie，根据设置开始推送青龙面板……");
        pushLatest(uid, function (ok2, msg, skip, pk) { onPushed(uid, cookie, ok2, msg, skip, pk, _pre2); });
      } else {
        // 窗口内无更新：相同cookie按设置强制推送；若该 cookie 刚推送成功过(PUSH_GAP 内)则无需重复往返
        var _pd = getPushed(uid);
        if (cap2 && _pd.key === cap2 && Date.now() - _pd.t < PUSH_GAP) {
          log("- 获取到相同起点Cookie，" + (PUSH_GAP / 1000) + " 秒内已推送成功，无需重复推送。");
          log("- 通知：未发送（该 cookie 刚推送成功过，无变化）。");
          log("");
          finish();
          return;
        }
        log("- 获取到相同起点Cookie，根据设置开始推送青龙面板……（强制推送）");
        pushLatest(uid, function (ok2, msg, skip, pk) { onPushed(uid, cookie, ok2, msg, skip, pk, _pre2); });
      }
    }, DEBOUNCE_MS);
  }
}

function run() {
  var req = (typeof $request !== "undefined" && $request) ? $request : {};
  var resp = (typeof $response !== "undefined" && $response) ? $response : {};

  var headers = req.headers || {};
  var cookie = gH(headers, "Cookie");
  if (!cookie) { log("- 请求中未包含 Cookie，跳过。"); finish(); return; }

  var cmap = parseCookie(cookie);

  // 登录校验：必须同时含 ywKey 与 ywGuid（与主脚本一致）
  if (!hasLogin(cmap)) {
    log("- 用户未登录（cookie 缺少 ywKey 或 ywGuid），跳过抓取。");
    finish();
    return;
  }

  // uid：base64(QDHeader).split('|')[11] → cookie uid 字段 → 响应体 Data.UserId
  var respBody = "";
  try { respBody = resp.body || ""; } catch (e) {}
  var uid = computeUid(cmap, respBody);
  if (!uid) {
    log("- 无法识别账号（QDHeader 解析失败且无 uid 字段），跳过抓取。");
    finish();
    return;
  }

  registerUid(uid);

  // 每次捕获都记录“最新看到的 cookie”，供单飞锁在并发期间补推最新值
  setCap(uid, cookie);

  var _stored = getLastKey(uid);
  var _capNow = getCap(uid);
  var _changed = !!(_capNow && _stored !== _capNow);

  // 首行空行 + 当前版本
  log("");
  log("当前版本：" + VERSION);
  log("");

  // 1、获取Cookie
  log("1、开始获取Cookie。");
  log("- uid：" + uid + "，cookie：" + maskCookie(cookie) + "。");
  log("");

  // 先判开关：推送青龙=关 → 仅抓取，不进入任何推送/限流逻辑（避免误报“限流”，也不污染节流计时）
  if (!ENABLE_PUSH) {
    log("2、推送Cookie至青龙面板。");
    log("- " + (_changed ? "获取到不同起点Cookie" : "获取到相同起点Cookie") + "，根据设置不推送青龙面板。");
    log("- 通知：未发送（设置「推送青龙=关」，仅抓取不推送）。");
    log("");
    finish(); return;
  }

  // 推送节流：同 cookie 在 PUSH_GAP(30s) 内只尝试一次（压突发刷屏，也防失败高频重试）
  // 仅在真正推送时才做限频，且节流计时只在此时写入（开启「推送青龙」即对每次捕获推送，受 30s 限频保护）
  var _lastTryKey = sGet(K_TRYKEY + uid);
  var _lastTryT = Number(sGet(K_TRY) || "0");
  if (_lastTryKey === cookie && Date.now() - _lastTryT < PUSH_GAP) {
    log("2、推送Cookie至青龙面板。");
    log("- 获取到相同起点Cookie，" + (PUSH_GAP / 1000) + " 秒内已推送/尝试过，本次跳过（值不变，无需重复推送）。");
    log("- 通知：未发送（同 cookie 节流期内已处理，无变化）。");
    log("");
    finish(); return;
  }
  sSet(K_TRYKEY + uid, cookie);
  sSet(K_TRY, String(Date.now()));

  if (WHITELIST_MODE) {
    var ok = false;
    for (var i = 0; i < UID_WHITELIST.length; i++) {
      if (UID_WHITELIST[i] && String(UID_WHITELIST[i]) === uid) { ok = true; break; }
    }
    if (!ok) { setLastKey(uid, cookie); log("2、推送Cookie至青龙面板。"); log("- uid 不在白名单，跳过推送。"); log("- 通知：未发送（uid 不在白名单）。"); log(""); finish(); return; }
  }

  if (!QL_CLIENT_ID || !QL_CLIENT_SECRET) {
    log("2、推送Cookie至青龙面板。");
    log("- 青龙凭证未配置，已终止推送。请在 Loon 参数填写 CLIENT_ID / CLIENT_SECRET");
    notify("起点Cookie未推送", "凭证未配置", "Loon脚本参数中填入 CLIENT_ID/CLIENT_SECRET");
    log("- 通知：已发送「起点Cookie未推送」。");
    log("");
    finish(); return;
  }

  if (!QL_URL) {
    log("2、推送Cookie至青龙面板。");
    log("- 青龙地址(QL_URL)未填写，已终止推送。请在插件参数填写 QL_URL");
    notify("起点Cookie未推送", "青龙地址未配置", "Loon插件参数中填入 QL_URL");
    log("- 通知：已发送「起点Cookie未推送」。");
    log("");
    finish(); return;
  }

  log("2、推送Cookie至青龙面板。");
  log("- 目标=" + hostOf(QL_URL) + " | 变量=" + QL_ENV_NAME + " | 触发签到=" + (ENABLE_RUN_SIGN ? "开" : "关") + " | 出站=" + QL_HTTP_NODE + (QL_ACCESS_ID ? " | CloudflareAccess=开" : " | CloudflareAccess=关"));
  decidePush(uid, cookie);
  return;
}

try { run(); } catch (e) {
  try { var m = (e && e.message) ? e.message : String(e); log("脚本异常：" + (e && e.stack ? e.stack : m)); } catch (e2) {}
  finish(); // 确保 $done 触发，避免异常时干等到脚本 60s 超时
}
