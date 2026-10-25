// 京东CK自动推送青龙面板
// 拦截 api.m.jd.com 上携带登录 Cookie 的请求，捕获 pt_key/pt_pin，按 pt_pin 匹配青龙 JD_COOKIE 并自动更新 pt_key。
//


// 参数通过 Loon 插件「参数面板」设置（导入后在 Loon → 脚本 → 点开本脚本 → 参数 中可见）：
//   CLIENT_ID / CLIENT_SECRET : 青龙面板「系统设置-应用设置-开放授权」密钥
//   QL_URL                   : 青龙面板地址（**无默认值，必须由用户在插件参数填写**，如 https://your-domain.com）
//   PUSH                     : 推送青龙（true=获取到CK即推送：不同CK立即推并通知，相同CK也按设置强制推送、同值不重复通知 / false=仅抓取不推送）
//   CF_ACCESS_ID / CF_ACCESS_SECRET : Cloudflare Access 服务令牌（可选，为青龙请求加边缘鉴权）
// 兼容 $persistentStore 兜底。

// ========== 配置区（一般无需改动）==========
var QL_URL = "";   // 默认空：青龙地址必须由用户在 Loon 参数 QL_URL 中填写，脚本不预置任何地址（避免暴露）
var WHITELIST_MODE = false;                   // true=仅白名单内账号写入青龙
var PT_PIN_WHITELIST = [];                    // 白名单 pt_pin，如 ["JD_xxx","JD_yyy"]
var PUSH_GAP = 30 * 1000;                     // 同一 key 两次推送尝试的最小间隔(防高频)：突发多次捕获只推一次，也防失败高频重试
// （NOTIFY_OK_GAP 已移除：不再发送“pt_key未变”心跳通知；开启推送即强制推送）
var NOTIFY_FAIL_GAP = 10 * 60 * 1000;         // 「推送失败」通知最小间隔(10min)
var VERSION = "V1.40";

// ========== 参数解析 ==========
// Loon 3.5.x 的 [Argument] 占位式 argument=[{CLIENT_ID},{...}] 运行期会把 $argument
// 直接传成「原生 JS 对象」{CLIENT_ID:"...", CLIENT_SECRET:"...", PUSH:"...", QL_URL:"..."}，
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
      var names = ["CLIENT_ID", "CLIENT_SECRET", "PUSH", "QL_URL", "CF_ACCESS_ID", "CF_ACCESS_SECRET"];
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
        var names2 = ["CLIENT_ID", "CLIENT_SECRET", "PUSH", "QL_URL", "CF_ACCESS_ID", "CF_ACCESS_SECRET"];
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

// 青龙地址：参数 QL_URL 优先 + $persistentStore 兜底 + 默认
var _argUrl = getArg("QL_URL", "");
QL_URL = _argUrl ? _argUrl : (sGet("JDCK_URL") || QL_URL);
if (QL_URL) {
  if (!/^https?:\/\//i.test(QL_URL)) QL_URL = "https://" + QL_URL; // 用户可能只填域名，补默认 https
  QL_URL = QL_URL.replace(/\/+$/, "");                             // 去尾部斜杠，避免拼出 //open/envs
}
if (_argUrl) sSet("JDCK_URL", QL_URL);

// Cloudflare Access 服务令牌（Service Auth）：给所有青龙请求加 CF-Access-* 头，
// 即便隧道域名泄露，无令牌请求在 Cloudflare 边缘即被拒。通过插件参数 CF_ACCESS_ID / CF_ACCESS_SECRET 输入。
var _argAccessId = getArg("CF_ACCESS_ID", "");
var _argAccessSec = getArg("CF_ACCESS_SECRET", "");
var _aidFromArg = !!(_argAccessId && !/^\{.*\}$/.test(_argAccessId));
var _asecFromArg = !!(_argAccessSec && !/^\{.*\}$/.test(_argAccessSec));
var QL_ACCESS_ID = _aidFromArg ? _argAccessId : sGet("JDCK_CFID");
var QL_ACCESS_SECRET = _asecFromArg ? _argAccessSec : sGet("JDCK_CFSEC");
if (_aidFromArg) sSet("JDCK_CFID", _argAccessId);
if (_asecFromArg) sSet("JDCK_CFSEC", _argAccessSec);

var ENABLE_PUSH = parseBool(getArg("PUSH", "true"), true);

// ========== 持久化键 ==========
// JDCK_LAST_<pin>：每个 pt_pin 上次已推送的 pt_key 值，作为「是否变化/去重」基准。
var K_TRY = "JDCK_TRY";         // 上次推送尝试时间(节流)
function lastKeyStore(pin) { return "JDCK_LAST_" + pin; }
function getLastKey(pin) { return sGet(lastKeyStore(pin)); }
function setLastKey(pin, key) { sSet(lastKeyStore(pin), key); }
var K_FAIL_NOTIFY = "JDCK_FAILNOTIFY"; // 上次「推送失败」通知时间
var K_TRYKEY = "JDCK_TRYKEY_";         // 上次尝试推送的 key（前缀，拼接 pt_pin）
var K_PUSHED = "JDCK_PUSHED_";         // 上次成功推送的 key|时间戳（前缀，拼接 pt_pin）：相同CK强制推送时去重，避免刚推过又重复往返
function getPushed(pin) { var v = sGet(K_PUSHED + pin); var i = v.indexOf("|"); return i < 0 ? { key: "", t: 0 } : { key: v.slice(0, i), t: Number(v.slice(i + 1) || "0") }; }
function setPushed(pin, key) { sSet(K_PUSHED + pin, key + "|" + Date.now()); }
var K_CAP = "JDCK_CAP_";               // 最新捕获的 pt_key（每次捕获都写，供单飞锁补推最新值）
function getCap(pin) { return sGet(K_CAP + pin); }
function setCap(pin, key) { sSet(K_CAP + pin, key); }
var K_BUSY = "JDCK_BUSY_";             // 单飞锁：推送进行中标记(存开始时间戳)，避免同 pin 并发重复推送
function getBusy(pin) { return Number(sGet(K_BUSY + pin) || "0"); }
function setBusy(pin) { sSet(K_BUSY + pin, String(Date.now())); }
function clearBusy(pin) { sSet(K_BUSY + pin, "0"); }
var BUSY_TTL = 55 * 1000;             // 单飞锁有效期(ms)，略小于脚本超时(60s)，超时自动失效防死锁
var DEBOUNCE_MS = 4000;                // 相同CK的缓冲窗口(ms)：京东App打开稳定触发多次捕获，等待后续是否出现更新 key；窗口内无更新则按设置强制推送当前值（相同CK也推，同值不重复通知）

// ========== 工具 ==========
function clip(s, n) { s = (s === undefined || s === null) ? "" : String(s); return s.length > n ? s.slice(0, n) + "…" : s; }
function maskKey(s) { s = (s === undefined || s === null) ? "" : String(s); return s.length <= 8 ? "****" : s.slice(0, 4) + "…" + s.slice(-4); } // 通知里脱敏 pt_key，避免明文外泄到 Bark 等渠道
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
var QL_HTTP_TIMEOUT = 15000; // 单次 httpClient 超时（毫秒）。此前 10s 在直连 Cloudflare 边缘抖动时易超时，放宽到 15s 吸收抖动
var QL_MAX_RETRY = 3;        // 网络错误最多尝试次数（含首次）。给瞬断/隧道抖动留余地：最多 3 次、2 次延迟重试
var QL_RETRY_DELAY = 2000;   // 网络错误重试前的等待(毫秒)。立即连重试常撞上同一瞬断，等待 2s 让连接恢复再试
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
      log(_lab + "推送失败：网络错误 " + clip(es, 200));
      return cb("网络错误: " + es);
    }
  var status = (resp && resp.status) ? resp.status : ((resp && resp.statusCode) ? resp.statusCode : "?");
  if (status === 401) clearCachedToken(); // token 失效(如密钥变更)：立即清缓存，下次取新 token
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

// 青龙 open API token 缓存：复用同一 token，省去热路径(尤其二次复核)重复的 token 握手往返，
// 降低直连 Cloudflare 边缘抖动时的超时概率。遇 401 立即清缓存重取。
var K_TOK = "JDCK_TOK";         // 缓存的 token
var K_TOKEXP = "JDCK_TOKEXP";   // token 过期时间戳(ms)
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

// 单飞锁 + 最新值优先：同一 pin 同一时刻只由一个实例真正推送；
// 并发期间新捕获到的(可能更新的) key 通过 setCap 记录，推送完成后若发现 cap 又变化则继续补推最新值，
// 最多 5 轮，确保最终写进青龙的是“最后看到的 key”，既不会因去重丢新 key，也不会被旧 key 反序覆盖。
function pushLatest(pin, cb) {
  var _busy = getBusy(pin);
  if (_busy && Date.now() - _busy < BUSY_TTL) {
    // 已有同 pin 实例在推送，本次只更新最新 key（已在 run 顶部 setCap），交由持锁实例补推
    return cb(false, "并发突发：已由其他实例推送最新值", true, null);
  }
  setBusy(pin);
  var rounds = 0;
  var lastOkKey = null;
  function step() {
    rounds++;
    var target = getCap(pin);
    if (!target) { clearBusy(pin); return cb(false, "无待推送 key", false, null); }
    pushCK(pin, target, function (ok, msg) {
      if (ok) { setLastKey(pin, target); lastOkKey = target; }
      var newest = getCap(pin);
      if (newest && newest !== target && rounds < 5) { step(); return; }
      clearBusy(pin);
      cb(ok, msg, false, lastOkKey);
    });
  }
  step();
}

// 通知策略（避免多次触发刷屏）：
//  - 推送成功且 CK 相对推送前已变化 → 发一条「CK获取并推送青龙成功」（pt_key 打码）；
//  - CK 未变化的强制推送（设置=开）→ 静默落地，不通知；
//  - 推送失败 → 「ck推送青龙失败」限频 10min。

// 推送结果回调：成功/失败的统一处理（含二次复核、失败限频通知）
// preLast：本次推送前的「上次已推送 key」基准；仅当实际落地的 key 与它不同（=真的换了 CK）才发成功通知，
// 相同 CK 的强制推送只静默刷新青龙，避免每次开 App 都通知。
function onPushed(pin, ptKey, ok2, msg, skip, pushedKey, preLast) {
  if (skip) { log("- 并发突发：已由其他实例推送最新值，本次跳过。"); log("- 通知：未发送（由持锁实例负责推送与通知）。"); log(""); finish(); return; }
  if (ok2) {
    var _pk = pushedKey || ptKey;   // 实际落地到青龙的 key（并发补推时可能是比本次捕获更新的 key）
    setLastKey(pin, _pk);
    setPushed(pin, _pk);
    log("- 推送结果：成功（" + msg + "）");
    var _isNewCK = !preLast || _pk !== preLast;   // 相对推送前基准：是否真的换了 CK
    if (_isNewCK) {
      log("- 通知：已发送「CK获取并推送青龙成功」（pt_key 已打码）。");
      notify("CK获取并推送青龙成功", "pt_pin: " + pin, "CK获取成功，已推送青龙 | " + msg + " | pt_key: " + maskKey(_pk));
    } else {
      log("- 已按设置强制推送刷新青龙；通知：未发送（青龙已为该 CK，同值不重复提醒，避免刷屏）。");
    }
    // 二次复核：重新拉取青龙确认最新 pt_key 已落地，消除“日志失败但青龙已更新”的歧义
    getToken("复核取token", function (e, tok) {
      if (e) { log("- 二次复核：取 token 失败（" + e + "），无法确认；以青龙侧实际为准。"); log(""); return finish(); }
      verifyCK(tok, pin, _pk, function (vf, vm) {
        log("- 二次复核：" + (vf ? "✅ " + vm : "⚠️ " + vm));
        log("");
        finish();
      });
    });
  } else {
    var _isCF = /\[CF_TUNNEL\]/.test(msg);
    log("- 推送结果：失败（" + msg + "）");
    if (_isCF) {
      log("- 分类：青龙隧道/网关故障（与脚本无关）。CK 未送达青龙；隧道恢复后脚本会自动重试，无需改脚本。");
    } else {
      log("- 提示：网络超时可能是“请求已到达青龙并处理、响应未返回”，青龙侧可能已更新；本账号下次触发会自动重试。");
    }
    // 「推送失败」通知限频(10min)，持续失败时也不会刷屏
    var lastFail = Number(sGet(K_FAIL_NOTIFY) || "0");
    if (Date.now() - lastFail >= NOTIFY_FAIL_GAP) {
      sSet(K_FAIL_NOTIFY, String(Date.now()));
      log("- 通知：已发送「ck推送青龙失败」（限频10min）。");
      notify("ck推送青龙失败", "pt_pin: " + pin, _isCF ? "青龙隧道不可达(与脚本无关)" : msg);
    } else {
      log("- 通知：未发送（「推送失败」通知处于 10min 限频期内，避免刷屏）。");
    }
    log("");
    finish();
  }
}

// 推送决策（推送=开时的两种情况；推送=关的两种情况在 run() 内直接提示不推送）：
//  不同CK → 立即推送（并通知）；
//  相同CK → 先进入缓冲窗口等待后续捕获：窗口内出现更新 key 则改推最新值（按不同CK处理），
//           窗口内无更新则按设置强制推送当前值（相同CK也推；同值不重复通知，30s 内刚推过则跳过）。
function decidePush(pin, ptKey) {
  var cap = getCap(pin);
  if (!cap) { finish(); return; }
  var changed = (cap !== getLastKey(pin));
  if (changed) {
    log("- 获取到不同京东CK，根据设置开始推送青龙面板……");
    var _pre = getLastKey(pin);
    pushLatest(pin, function (ok2, msg, skip, pk) { onPushed(pin, ptKey, ok2, msg, skip, pk, _pre); });
  } else {
    log("- 获取到相同京东CK，进入 " + (DEBOUNCE_MS / 1000) + "s 缓冲：等待后续捕获，若出现更新 key 则改推最新值，避免把刷新前的旧 key 推上去。");
    setTimeout(function () {
      var cap2 = getCap(pin);
      var changed2 = !!(cap2 && cap2 !== getLastKey(pin));
      var _pre2 = getLastKey(pin);
      if (changed2) {
        log("- 缓冲期内出现更新 key：获取到不同京东CK，根据设置开始推送青龙面板……");
        pushLatest(pin, function (ok2, msg, skip, pk) { onPushed(pin, ptKey, ok2, msg, skip, pk, _pre2); });
      } else {
        // 窗口内无更新：相同CK按设置强制推送；若该 key 刚推送成功过(PUSH_GAP 内)则无需重复往返
        var _pd = getPushed(pin);
        if (cap2 && _pd.key === cap2 && Date.now() - _pd.t < PUSH_GAP) {
          log("- 获取到相同京东CK，" + (PUSH_GAP / 1000) + " 秒内已推送成功，无需重复推送。");
          log("- 通知：未发送（该 CK 刚推送成功过，无变化）。");
          log("");
          finish();
          return;
        }
        log("- 获取到相同京东CK，根据设置开始推送青龙面板……（强制推送）");
        pushLatest(pin, function (ok2, msg, skip, pk) { onPushed(pin, ptKey, ok2, msg, skip, pk, _pre2); });
      }
    }, DEBOUNCE_MS);
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

  // 每次捕获都记录“最新看到的 pt_key”，供单飞锁在并发期间补推最新值（确保最终落地的是最新 key，不会被旧 key 反序覆盖）
  setCap(ptPin, ptKey);

  // 比对 pt_key 的值：与 decidePush 同源，以「最新捕获值」为准，仅用于日志展示
  var _stored = getLastKey(ptPin);
  var _capNow = getCap(ptPin);
  var _changed = !!(_capNow && _stored !== _capNow);

  // 首行空行 + 当前版本
  log("");
  log("当前版本：" + VERSION);
  log("");

  // 1、获取CK
  log("1、开始获取CK。");
  log("- CK值：pt_key=" + ptKey + ",pt_pin=" + ptPin + "。");
  log("");

  // （已移除「每次捕获」的「获取ck成功」通知：改为仅在推送成功且CK变化/推送失败时通知，避免多次触发刷屏）

  // 先判开关：推送青龙=关 → 仅抓取，不进入任何推送/限流逻辑（避免误报“限流”，也不污染节流计时）
  if (!ENABLE_PUSH) {
    log("2、推送CK至青龙面板。");
    log("- " + (_changed ? "获取到不同京东CK" : "获取到相同京东CK") + "，根据设置不推送青龙面板。");
    log("- 通知：未发送（设置「推送青龙=关」，仅抓取不推送）。");
    log("");
    finish(); return;
  }

  // 推送节流：同 key 在 PUSH_GAP(30s) 内只尝试一次（压突发刷屏，也防失败高频重试）
  // 仅在真正推送时才做限频，且节流计时只在此时写入（开启「推送青龙」即对每次捕获推送，受 30s 限频保护）
  var _lastTryKey = sGet(K_TRYKEY + ptPin);
  var _lastTryT = Number(sGet(K_TRY) || "0");
  if (_lastTryKey === ptKey && Date.now() - _lastTryT < PUSH_GAP) {
    log("2、推送CK至青龙面板。");
    log("- 获取到相同京东CK，" + (PUSH_GAP / 1000) + " 秒内已推送/尝试过，本次跳过（值不变，无需重复推送）。");
    log("- 通知：未发送（同 key 节流期内已处理，无变化）。");
    log("");
    finish(); return;
  }
  sSet(K_TRYKEY + ptPin, ptKey);
  sSet(K_TRY, String(Date.now()));

  if (WHITELIST_MODE) {
    var ok = false;
    for (var i = 0; i < PT_PIN_WHITELIST.length; i++) {
      if (PT_PIN_WHITELIST[i] && dPin(String(PT_PIN_WHITELIST[i])) === ptPin) { ok = true; break; }
    }
    if (!ok) { setLastKey(ptPin, ptKey); log("2、推送CK至青龙面板。"); log("- pt_pin 不在白名单，跳过推送。"); log("- 通知：未发送（pt_pin 不在白名单）。"); log(""); finish(); return; }
  }

  if (!QL_CLIENT_ID || !QL_CLIENT_SECRET) {
    log("2、推送CK至青龙面板。");
    log("- 青龙凭证未配置，已终止推送。请在 Loon 参数填写 CLIENT_ID / CLIENT_SECRET");
    notify("京东Cookie未推送", "凭证未配置", "Loon脚本参数中填入 CLIENT_ID/CLIENT_SECRET");
    log("- 通知：已发送「京东Cookie未推送」。");
    log("");
    finish(); return;
  }

  if (!QL_URL) {
    log("2、推送CK至青龙面板。");
    log("- 青龙地址(QL_URL)未填写，已终止推送。请在插件参数填写 QL_URL");
    notify("京东Cookie未推送", "青龙地址未配置", "Loon插件参数中填入 QL_URL");
    log("- 通知：已发送「京东Cookie未推送」。");
    log("");
    finish(); return;
  }

  log("2、推送CK至青龙面板。");
  log("- 目标=" + hostOf(QL_URL) + " | 出站=" + QL_HTTP_NODE + (QL_ACCESS_ID ? " | CloudflareAccess=开" : " | CloudflareAccess=关"));
  decidePush(ptPin, ptKey);
  return;
}

try { run(); } catch (e) {
  try { var m = (e && e.message) ? e.message : String(e); log("脚本异常：" + (e && e.stack ? e.stack : m)); } catch (e2) {}
  finish(); // 确保 $done 触发，避免异常时干等到脚本 60s 超时
}
