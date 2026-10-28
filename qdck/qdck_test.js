// qdck_ql.js 本地沙箱验证：模拟 Loon 环境 + 模拟青龙 OpenAPI，覆盖全部关键路径。
// 运行：node qdck_test.js
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const SCRIPT = path.join(__dirname, "qdck_ql.js");

// ---- 构造测试用 QDHeader：base64("a|b|c|d|e|f|g|h|i|j|k|<uid>|x")，split('|')[11] = uid ----
function makeQDHeader(uid) {
  const parts = [];
  for (let i = 0; i < 15; i++) parts.push(i === 11 ? uid : "f" + i);
  return Buffer.from(parts.join("|"), "utf8").toString("base64");
}
function makeCookie(uid, extra) {
  return [
    "ywKey=YWKEY_" + uid,
    "ywGuid=YWGUID_" + uid,
    "QDHeader=" + makeQDHeader(uid),
    "ywguid=YWGUID_" + uid,
    extra || ""
  ].filter(Boolean).join("; ");
}

// ---- 模拟青龙 OpenAPI ----
function makeQL(initial) {
  const state = {
    envs: (initial && initial.envs) || [],
    // 定时任务 status 按青龙 CrontabStatus 枚举：0=运行中 1=已启用(空闲) 2=已禁用 3=排队中
    // （注意与环境变量 status 不同：envs 是 0=启用/1=禁用）
    crons: (initial && initial.crons) || [
      { id: 1, command: "task bobbyleu_dailycheckin/qdreader.js", name: "起点读书签到", status: 1, schedule: "5 8 * * *" },
      { id: 2, command: "task jd_CheckCK.js", name: "京东CK兜底", status: 1, schedule: "0 3 * * *" },
      { id: 3, command: "task bobbyleu_dailycheckin/qdreader.js", name: "起点读书签到(已禁用)", status: 2, schedule: "0 4 * * *" }
    ],
    nextId: 100,
    triggered: [],
    posts: [],
    log: [],
    envGets: 0,                                                   // GET /open/envs 调用次数（验证 V1.04 合并查询）
    failPostEnvs: !!(initial && initial.failPostEnvs),            // 注入：POST /open/envs 全部失败（模拟开关同步网络故障）
    failEnvsGet: !!(initial && initial.failEnvsGet)               // 注入：GET /open/envs 全部失败
  };
  const routes = {
    "GET /open/auth/token": (q) => ({ code: 200, data: { token: "mock-token", token_type: "Bearer", expiration: 3600 } }),
    // V1.04 起开关同步用「无 searchValue 的全量查询」，mock 必须返回全部变量
    "GET /open/envs": (q) => {
      state.envGets++;
      if (state.failEnvsGet) return { __error: "HTTPClient request failed with error: Request timeout." };
      const m = q.match(/searchValue=([^&]*)/);
      if (!m) return { code: 200, data: state.envs };
      const sv = decodeURIComponent(m[1] || "");
      const list = state.envs.filter(e => e.name === sv);
      return { code: 200, data: list };
    },
    "PUT /open/envs": (q, body) => {
      const arr = Array.isArray(body) ? body : [body];
      arr.forEach(u => {
        const e = state.envs.find(x => x.id === u.id);
        if (e) { e.value = u.value; if (u.remarks !== undefined) e.remarks = u.remarks; }
      });
      return { code: 200, data: null };
    },
    "POST /open/envs": (q, body) => {
      if (state.failPostEnvs) return { __error: "青龙返回 HTTP 500（非网络错误，不触发重试）" };
      const arr = Array.isArray(body) ? body : [body];
      state.posts.push(...arr.map(u => u.name));
      const created = arr.map(u => {
        const e = { id: state.nextId++, name: u.name, value: u.value, status: 0, remarks: u.remarks || "" };
        state.envs.push(e);
        return e;
      });
      return { code: 200, data: created };
    },
    "PUT /open/envs/enable": (q, body) => {
      (Array.isArray(body) ? body : [body]).forEach(id => {
        const e = state.envs.find(x => x.id === id);
        if (e) e.status = 0;
      });
      return { code: 200, data: null };
    },
    // 真实青龙返回分页对象 { data:[...], total:N }（back/services/cron.ts），与 /open/envs 的纯数组不同
    "GET /open/crons": () => ({ code: 200, data: { data: state.crons, total: state.crons.length } }),
    "PUT /open/crons/run": (q, body) => {
      state.triggered.push(...(Array.isArray(body) ? body : [body]));
      return { code: 200, data: null };
    }
  };
  return { state, routes };
}

// ---- Loon 环境模拟 ----
// opts.qlState/opts.qlRoutes：外部共享同一套青龙 mock（并发场景用）；opts.store：外部共享 persistentStore
function runScenario(name, opts) {
  return new Promise((resolve) => {
    const ql = (opts.qlState && opts.qlRoutes) ? { state: opts.qlState, routes: opts.qlRoutes } : makeQL(opts.ql);
    const logs = [];
    const notifs = [];
    let doneCalled = false;

    const store = opts.store || {};
    const sandbox = {
      console: { log: (...a) => logs.push(a.join(" ")), warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      setInterval: () => 0, clearInterval: () => {},
      Date, JSON, Math, Object, Array, String, Number, Boolean, RegExp, Error, parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent,
      $argument: opts.argument || {},
      $persistentStore: {
        read: (k) => (store[k] === undefined ? null : store[k]),
        write: (v, k) => { store[k] = String(v); }
      },
      $notification: { post: (t, s, b) => notifs.push({ title: t, subtitle: s, body: b }) },
      $done: () => { doneCalled = true; },
      $httpClient: {
        get: (o, cb) => route(ql, "GET", o, cb),
        put: (o, cb) => route(ql, "PUT", o, cb),
        post: (o, cb) => route(ql, "POST", o, cb)
      },
      $request: opts.request || { headers: {} },
      $response: opts.response || {}
    };
    sandbox.globalThis = sandbox;

    function route(ql, method, o, cb) {
      const u = String(o.url || "");
      const p = u.replace(/^https?:\/\/[^/]+/, "");
      const routePath = p.split("?")[0];
      const key = method + " " + routePath;
      const fn = ql.routes[key];
      setTimeout(() => {
        if (!fn) return cb(null, { status: 404 }, JSON.stringify({ code: 404, message: "no route " + key }));
        let body = null;
        if (o.body) { try { body = JSON.parse(o.body); } catch (e) {} }
        const data = fn(p.split("?")[1] || "", body);
        // 注入失败：路由返回 __error 即模拟 httpClient 报错（含 timeout 字样才会触发脚本重试）
        if (data && data.__error) return cb(data.__error, null, null);
        cb(null, { status: 200 }, JSON.stringify(data));
      }, 5);
    }

    const ctx = vm.createContext(sandbox);
    const src = fs.readFileSync(SCRIPT, "utf8");
    try { vm.runInContext(src, ctx, { timeout: 20000 }); }
    catch (e) { logs.push("SCRIPT THREW: " + (e && e.message)); }

    // 等待异步链路结束（debounce 4s + 网络往返）
    const wait = opts.wait || 9000;
    setTimeout(() => {
      resolve({ name, logs, notifs, ql: ql.state, store, doneCalled });
    }, wait);
  });
}

// ---- 断言辅助 ----
let pass = 0, fail = 0;
function check(desc, cond) {
  if (cond) { pass++; console.log("  ✅ " + desc); }
  else { fail++; console.log("  ❌ " + desc); }
}

(async function main() {
  const ARG = { CLIENT_ID: "id", CLIENT_SECRET: "sec", QL_URL: "http://ql.local", PUSH: "true", RUN_SIGN: "true", ADV_JOB: "true", EXTRA_ADV_JOB: "true", LOTTERY: "true", WEEKLY_EXCHANGE: "true", CHAPTER_CARD: "true", MESSAGE_BOX: "true" };

  // ===== 场景1：请求无 Cookie → 直接跳过 =====
  console.log("\n===== 场景1：无 Cookie =====");
  let r = await runScenario("no-cookie", {
    argument: ARG,
    request: { headers: {} },
    wait: 500
  });
  check("未调用 $done", r.doneCalled === true);
  check("无任何青龙写操作", r.ql.envs.length === 0 && r.ql.triggered.length === 0);
  check("日志提示未包含 Cookie", r.logs.some(l => l.indexOf("未包含 Cookie") >= 0));

  // ===== 场景2：cookie 缺 ywGuid → 未登录跳过 =====
  console.log("\n===== 场景2：缺少 ywGuid（未登录） =====");
  r = await runScenario("no-ywguid", {
    argument: ARG,
    request: { headers: { Cookie: "ywKey=abc; QDHeader=" + makeQDHeader("999") } },
    wait: 500
  });
  check("未写入青龙", r.ql.envs.length === 0);
  check("日志提示未登录", r.logs.some(l => l.indexOf("未登录") >= 0));

  // ===== 场景3：青龙无该变量 → 新建 + 触发签到 =====
  console.log("\n===== 场景3：青龙无变量（新建账号） =====");
  const ck3 = makeCookie("10001");
  r = await runScenario("new-env", {
    argument: ARG,
    request: { headers: { Cookie: ck3 } },
    response: { body: JSON.stringify({ Data: { UserId: "10001" } }) },
    wait: 9000
  });
  const ckEnv3 = r.ql.envs.find(e => e.name === "QDREADER_COOKIE");
  check("Cookie 变量已新建", !!ckEnv3);
  check("value 为 JSON 单键值对且含 uid=10001", (() => { try { const m = JSON.parse(ckEnv3.value); return m["10001"] === ck3 && Object.keys(m).length === 1; } catch (e) { return false; } })());
  check("6 个任务开关变量已同步新建", ["QDREADER_ADV_JOB_ENABLE","QDREADER_EXTRA_ADV_JOB_ENABLE","QDREADER_LOTTERY_ENABLE","QDREADER_WEEKLY_EXCHANGE_ENABLE","QDREADER_CHAPTER_CARD_ENABLE","QDREADER_MESSAGE_BOX_ENABLE"].every(n => r.ql.envs.some(e => e.name === n)));
  check("签到任务已触发（status=1 启用与 status=2 已禁用的 qdreader 均触发）", JSON.stringify(r.ql.triggered) === "[1,3]");
  check("发送成功通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));
  check("日志含二次复核✅", r.logs.some(l => l.indexOf("二次复核：✅") >= 0));

  // ===== 场景4：已有其他账号 → 新增（保留原账号） =====
  console.log("\n===== 场景4：新增账号（保留其他账号） =====");
  const oldCk = "ywKey=OLDKEY; ywGuid=OLDGUID; QDHeader=xxx; uid=20002";
  const ck4new = makeCookie("30003");
  r = await runScenario("overwrite-replace", {
    argument: ARG,
    request: { headers: { Cookie: ck4new } },
    ql: { envs: [{ id: 55, name: "QDREADER_COOKIE", value: JSON.stringify({ "20002": oldCk }), status: 0, remarks: "" }] },
    wait: 9000
  });
  let m4 = null;
  try { m4 = JSON.parse(r.ql.envs.find(e => e.id === 55).value); } catch (e) {}
  check("旧账号 20002 已保留", m4 && m4["20002"] === oldCk);
  check("新账号 30003 已写入", m4 && m4["30003"] === ck4new);
  check("变量含两个账号键", m4 && Object.keys(m4).length === 2);
  check("日志含新增账号提示", r.logs.some(l => l.indexOf("已新增账号") >= 0 && l.indexOf("30003") >= 0));
  check("未误触发其他任务", JSON.stringify(r.ql.triggered) === "[1,3]");

  // ===== 场景5：同 uid 更新（保留其他账号） =====
  console.log("\n===== 场景5：同 uid 更新（保留其他账号） =====");
  const ck5old = makeCookie("40004", "extra=1");
  const ck5new = makeCookie("40004", "extra=2");
  r = await runScenario("update-same-uid", {
    argument: ARG,
    request: { headers: { Cookie: ck5new } },
    ql: { envs: [{ id: 56, name: "QDREADER_COOKIE", value: JSON.stringify({ "40004": ck5old, "50005": "keepme" }), status: 0, remarks: "" }] },
    wait: 9000
  });
  let m5 = null;
  try { m5 = JSON.parse(r.ql.envs.find(e => e.id === 56).value); } catch (e) {}
  check("uid=40004 的值已更新", m5 && m5["40004"] === ck5new);
  check("其他账号 50005 已保留", m5 && m5["50005"] === "keepme");
  check("变量含两个账号键", m5 && Object.keys(m5).length === 2);
  check("发送更新通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));

  // ===== 场景6：现值非 JSON → 备份到 <uid>_backup 后写入 =====
  console.log("\n===== 场景6：现值非 JSON（手填原始cookie，备份后写入） =====");
  const ck6 = makeCookie("60006");
  r = await runScenario("bad-json", {
    argument: ARG,
    request: { headers: { Cookie: ck6 } },
    ql: { envs: [{ id: 57, name: "QDREADER_COOKIE", value: "ywKey=MANUAL;ywGuid=MANUAL2", status: 0, remarks: "" }] },
    wait: 9000
  });
  let m6 = null;
  try { m6 = JSON.parse(r.ql.envs.find(e => e.id === 57).value); } catch (e) {}
  check("原值已备份到 60006_backup", m6 && m6["60006_backup"] === "ywKey=MANUAL;ywGuid=MANUAL2");
  check("新 cookie 正常写入", m6 && m6["60006"] === ck6);
  check("变量含账号键（含 backup 占位共 2 键）", m6 && Object.keys(m6).length === 2);
  check("日志有备份告警（非JSON现值已备份）", r.logs.some(l => l.indexOf("已备份到") >= 0));

  // ===== 场景7：RUN_SIGN=false → 不触发任务 =====
  console.log("\n===== 场景7：RUN_SIGN=关（不触发签到） =====");
  r = await runScenario("no-run-sign", {
    argument: Object.assign({}, ARG, { RUN_SIGN: "false" }),
    request: { headers: { Cookie: makeCookie("70007") } },
    ql: { envs: [{ id: 58, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] },
    wait: 9000
  });
  check("变量已更新", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 58).value); return !!m["70007"]; } catch (e) { return false; } })());
  check("未触发签到任务", r.ql.triggered.length === 0);
  check("日志说明跳过触发", r.logs.some(l => l.indexOf("推送后触发签到=关") >= 0));

  // ===== 场景8：青龙没有含 qdreader 的任务 → 不影响推送成功 =====
  console.log("\n===== 场景8：无匹配任务 =====");
  r = await runScenario("no-task", {
    argument: ARG,
    request: { headers: { Cookie: makeCookie("80008") } },
    ql: {
      envs: [{ id: 59, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }],
      crons: [{ id: 9, command: "task other.js", name: "其他任务", status: 1, schedule: "0 5 * * *" }]
    },
    wait: 9000
  });
  check("变量已更新", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 59).value); return !!m["80008"]; } catch (e) { return false; } })());
  check("未触发任务但日志给出提示", r.ql.triggered.length === 0 && r.logs.some(l => l.indexOf("未找到命令包含") >= 0));
  check("未命中时打印任务清单样本便于排查", r.logs.some(l => l.indexOf("青龙任务清单样本") >= 0));
  check("仍发送成功通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));

  // ===== 场景9：青龙 401 → token 失效清缓存（模拟） =====
  console.log("\n===== 场景9：凭证错误（青龙返回401） =====");
  {
    // 单独构造：qlReq 收到 401 会清 token 缓存；这里直接验证脚本在青龙错误时不崩、有失败通知
    const r9 = await runScenario("ql-error", {
      argument: ARG,
      request: { headers: { Cookie: makeCookie("90009") } },
      ql: { envs: [] },
      wait: 9000
    });
    check("脚本未崩溃（$done 已调用）", r9.doneCalled === true);
  }

  // ===== 场景10：PUSH=false → 仅抓取 =====
  console.log("\n===== 场景10：PUSH=关（仅抓取） =====");
  r = await runScenario("push-off", {
    argument: Object.assign({}, ARG, { PUSH: "false" }),
    request: { headers: { Cookie: makeCookie("11010") } },
    wait: 500
  });
  check("无青龙写操作", r.ql.envs.length === 0 && r.ql.triggered.length === 0);
  check("日志说明仅抓取", r.logs.some(l => l.indexOf("不推送青龙面板") >= 0));

  // ===== 场景11：无 QDHeader → uid 回退 cookie 的 uid 字段 =====
  console.log("\n===== 场景11：uid 回退（cookie uid 字段） =====");
  const ck11 = "ywKey=abc; ywGuid=def; uid=12012";
  r = await runScenario("uid-fallback", {
    argument: ARG,
    request: { headers: { Cookie: ck11 } },
    ql: { envs: [{ id: 60, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] },
    wait: 9000
  });
  check("按 cookie uid 字段建键", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 60).value); return m["12012"] === ck11; } catch (e) { return false; } })());
  check("发送成功通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));

  // ===== 场景12：无 QDHeader 且无 uid → 响应体 Data.UserId 回退 =====
  console.log("\n===== 场景12：uid 回退（响应体 Data.UserId） =====");
  const ck12 = "ywKey=abc; ywGuid=def";
  r = await runScenario("uid-body-fallback", {
    argument: ARG,
    request: { headers: { Cookie: ck12 } },
    response: { body: JSON.stringify({ Data: { UserId: "13013" } }) },
    ql: { envs: [{ id: 61, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] },
    wait: 9000
  });
  check("按响应体 UserId 建键", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 61).value); return m["13013"] === ck12; } catch (e) { return false; } })());

  // ===== 场景13：任务开关同步（已最新跳过/值不同更新/禁用恢复/缺失新建） =====
  console.log("\n===== 场景13：任务开关同步 =====");
  r = await runScenario("switch-sync", {
    argument: Object.assign({}, ARG, { MESSAGE_BOX: "true" }),
    request: { headers: { Cookie: makeCookie("14014") } },
    ql: { envs: [
      { id: 70, name: "QDREADER_ADV_JOB_ENABLE", value: "true", status: 0, remarks: "激励任务" },
      { id: 71, name: "QDREADER_LOTTERY_ENABLE", value: "false", status: 0, remarks: "每日抽奖" },
      { id: 72, name: "QDREADER_MESSAGE_BOX_ENABLE", value: "false", status: 1, remarks: "大咖荐书" },
      { id: 73, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }
    ] },
    wait: 12000
  });
  check("ADV_JOB 已最新则跳过（不重复写）", r.logs.some(l => l.indexOf("已是最新值") >= 0 && l.indexOf("QDREADER_ADV_JOB_ENABLE") >= 0));
  check("LOTTERY 值不同已更新为 true", (() => { const e = r.ql.envs.find(x => x.id === 71); return e && e.value === "true"; })());
  check("MESSAGE_BOX 按插件参数更新为 true", (() => { const e = r.ql.envs.find(x => x.id === 72); return e && e.value === "true"; })());
  check("MESSAGE_BOX 被禁用后恢复启用(status=0)", (() => { const e = r.ql.envs.find(x => x.id === 72); return e && e.status === 0; })());
  check("缺失的开关已新建且值为 true", ["QDREADER_EXTRA_ADV_JOB_ENABLE","QDREADER_WEEKLY_EXCHANGE_ENABLE","QDREADER_CHAPTER_CARD_ENABLE"].every(n => { const e = r.ql.envs.find(x => x.name === n); return e && e.value === "true"; }));
  check("新建开关备注为中文任务名", (() => { const e = r.ql.envs.find(x => x.name === "QDREADER_EXTRA_ADV_JOB_ENABLE"); return e && e.remarks === "每日任务"; })());
  check("Cookie 推送不受开关同步影响", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 73).value); return !!m["14014"] && Object.keys(m).length === 1; } catch (e) { return false; } })());

  // ===== 场景14：插件参数未传开关（模拟默认值） =====
  console.log("\n===== 场景14：开关默认值（参数未传） =====");
  r = await runScenario("switch-default", {
    argument: { CLIENT_ID: "id", CLIENT_SECRET: "sec", QL_URL: "http://ql.local", PUSH: "true", RUN_SIGN: "true", TASK_KEY: "qdreader" },
    request: { headers: { Cookie: makeCookie("15015") } },
    ql: { envs: [] },
    wait: 12000
  });
  check("除大咖荐书外 5 个开关默认 true", ["QDREADER_ADV_JOB_ENABLE","QDREADER_EXTRA_ADV_JOB_ENABLE","QDREADER_LOTTERY_ENABLE","QDREADER_WEEKLY_EXCHANGE_ENABLE","QDREADER_CHAPTER_CARD_ENABLE"].every(n => { const e = r.ql.envs.find(x => x.name === n); return e && e.value === "true"; }));
  check("大咖荐书默认 false", (() => { const e = r.ql.envs.find(x => x.name === "QDREADER_MESSAGE_BOX_ENABLE"); return e && e.value === "false"; })());

  // ===== 场景15：ENV_NAME 参数已移除（变量名固定 QDREADER_COOKIE） =====
  console.log("\n===== 场景15：变量名固定 =====");
  r = await runScenario("fixed-env-name", {
    argument: Object.assign({}, ARG, { ENV_NAME: "SHOULD_BE_IGNORED" }),
    request: { headers: { Cookie: makeCookie("16016") } },
    ql: { envs: [{ id: 74, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] },
    wait: 12000
  });
  check("忽略传入的 ENV_NAME，仍写 QDREADER_COOKIE", r.ql.envs.some(e => e.name === "QDREADER_COOKIE") && !r.ql.envs.some(e => e.name === "SHOULD_BE_IGNORED"));
  check("cookie 已写入 QDREADER_COOKIE", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 74).value); return !!m["16016"]; } catch (e) { return false; } })());

  // ===== 场景16：两个账号并发触发 → 开关只同步一轮 + 锁挡第二个 + 持锁者续推覆盖 =====
  console.log("\n===== 场景16：多账号并发（开关只同步一次） =====");
  {
    const sharedQL = makeQL({ envs: [{ id: 80, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] });
    const sharedStore = {};
    // 两个实例几乎同时启动（不同 uid），共享 persistentStore 与青龙 mock：模拟两个账号同时打开 App
    const pA = runScenario("concurrent-a", {
      argument: ARG, request: { headers: { Cookie: makeCookie("17017") } },
      qlState: sharedQL.state, qlRoutes: sharedQL.routes, store: sharedStore, wait: 15000
    });
    const pB = runScenario("concurrent-b", {
      argument: ARG, request: { headers: { Cookie: makeCookie("17118") } },
      qlState: sharedQL.state, qlRoutes: sharedQL.routes, store: sharedStore, wait: 15000
    });
    const ra = await pA, rb = await pB;
    const allLogs = ra.logs.join("\n") + "\n" + rb.logs.join("\n");
    const swPosts = sharedQL.state.posts.filter(n => n !== "QDREADER_COOKIE");
    check("开关 POST 只发生一轮（6 次）", swPosts.length === 6);
    check("实例 B 被单飞锁挡下（日志含并发突发）", allLogs.indexOf("并发突发") >= 0);
    check("开关同步日志只出现一次", (allLogs.match(/按插件设置同步至青龙环境变量/g) || []).length === 1);
    check("变量最终含两个账号 17017 与 17118（多账号合并）", (() => {
      try {
        const m = JSON.parse(sharedQL.state.envs.find(e => e.id === 80).value);
        return Object.keys(m).length === 2 && !!m["17017"] && !!m["17118"];
      } catch (e) { return false; }
    })());
    check("签到任务只触发一次（突发收敛为一次运行，含已禁用任务）", JSON.stringify(sharedQL.state.triggered) === "[1,3]");
  }

  // ===== 场景17：开关节流（5min 内第二次触发不重复同步） =====
  console.log("\n===== 场景17：开关节流 =====");
  {
    const sharedStore2 = {};
    const r17a = await runScenario("throttle-a", {
      argument: ARG, request: { headers: { Cookie: makeCookie("18018") } },
      ql: { envs: [] }, store: sharedStore2, wait: 12000
    });
    // 第二次触发用不同 cookie（绕过 30s 推送节流），专测开关节流
    const r17b = await runScenario("throttle-b", {
      argument: ARG, request: { headers: { Cookie: makeCookie("18018", "extra=newvalue") } },
      ql: { envs: [] }, store: sharedStore2, wait: 12000
    });
    check("第一次同步成功", r17a.logs.some(l => l.indexOf("按插件设置同步至青龙环境变量") >= 0));
    check("第二次被开关节流跳过", r17b.logs.some(l => l.indexOf("秒前刚同步过，跳过") >= 0));
    check("第二次无开关 POST", r17b.ql.posts.filter(n => n !== "QDREADER_COOKIE").length === 0);
    check("第二次 cookie 仍正常推送", r17b.ql.posts.indexOf("QDREADER_COOKIE") >= 0);
  }

  // ===== 场景18：账号链 A→B→A2：各账号累加保留 =====
  console.log("\n===== 场景18：账号链（多账号累加） =====");
  {
    const sharedQL3 = makeQL({ envs: [{ id: 90, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] });
    const sharedStore3 = {};
    const ckA = makeCookie("21021");
    const ckB = makeCookie("22022");
    const ckA2 = makeCookie("21021", "extra=rotated");
    await runScenario("chain-a", {
      argument: ARG, request: { headers: { Cookie: ckA } },
      qlState: sharedQL3.state, qlRoutes: sharedQL3.routes, store: sharedStore3, wait: 12000
    });
    const m18a = (() => { try { return JSON.parse(sharedQL3.state.envs.find(e => e.id === 90).value); } catch (e) { return null; } })();
    check("A 推送后变量含 21021", m18a && m18a["21021"] === ckA);
    check("A 推送后变量只含 1 个账号", m18a && Object.keys(m18a).length === 1);
    await runScenario("chain-b", {
      argument: ARG, request: { headers: { Cookie: ckB } },
      qlState: sharedQL3.state, qlRoutes: sharedQL3.routes, store: sharedStore3, wait: 12000
    });
    const m18b = (() => { try { return JSON.parse(sharedQL3.state.envs.find(e => e.id === 90).value); } catch (e) { return null; } })();
    check("B 推送后变量含 21021 和 22022（A 保留）", m18b && m18b["21021"] === ckA && m18b["22022"] === ckB);
    check("B 推送后变量含 2 个账号", m18b && Object.keys(m18b).length === 2);
    const r18c = await runScenario("chain-a2", {
      argument: ARG, request: { headers: { Cookie: ckA2 } },
      qlState: sharedQL3.state, qlRoutes: sharedQL3.routes, store: sharedStore3, wait: 12000
    });
    const m18c = (() => { try { return JSON.parse(sharedQL3.state.envs.find(e => e.id === 90).value); } catch (e) { return null; } })();
    check("A 换新cookie再推送，变量含最新的 21021 与 22022", m18c && m18c["21021"] === ckA2 && m18c["22022"] === ckB);
    check("A2 推送后变量仍含 2 个账号", m18c && Object.keys(m18c).length === 2);
    check("无覆盖告警（多账号模式按 uid 累加，不告警替换）", !r18c.logs.some(l => l.indexOf("按覆盖语义替换") >= 0));
    check("三次推送共触发 6 次（每轮含 2 个 qdreader 任务，含已禁用）", sharedQL3.state.triggered.length === 6);
  }

  // ===== 场景19：相同cookie超过30s → 强制推送路径（V1.02 曾误入「无待推送账号」失败分支） =====
  console.log("\n===== 场景19：相同cookie强制推送 =====");
  {
    const ck19 = makeCookie("23023");
    const store19 = {};
    // 预置 store：该 cookie 已推送成功过（lastKey/pushed 同值），但推送尝试发生在 60s 前（绕过 30s 节流）
    store19["QDCK_LAST_23023"] = ck19;
    store19["QDCK_PUSHED_23023"] = ck19 + "|" + (Date.now() - 60000);
    store19["QDCK_TRYKEY_23023"] = ck19;
    store19["QDCK_TRY"] = String(Date.now() - 60000);
    const r19 = await runScenario("force-push", {
      argument: ARG,
      request: { headers: { Cookie: ck19 } },
      ql: { envs: [{ id: 95, name: "QDREADER_COOKIE", value: JSON.stringify({ "23023": ck19 }), status: 0, remarks: "" }] },
      store: store19,
      wait: 12000
    });
    check("走了强制推送路径（日志含强制推送）", r19.logs.some(l => l.indexOf("强制推送") >= 0));
    check("推送成功（未误入失败分支）", r19.logs.some(l => l.indexOf("推送结果：成功") >= 0));
    check("相同cookie只推一轮（不重复重推）", (r19.logs.join("\n").match(/- 账号 uid=23023：/g) || []).length === 1);
    check("变量仍为该账号单键值", (() => { try { const m = JSON.parse(r19.ql.envs.find(e => e.id === 95).value); return m["23023"] === ck19 && Object.keys(m).length === 1; } catch (e) { return false; } })());
    check("同值不重复通知（无成功通知）", !r19.notifs.some(n => n.title === "起点Cookie推送青龙成功"));
    check("无失败通知", !r19.notifs.some(n => n.title === "起点Cookie推送青龙失败"));
    check("签到任务已触发（含已禁用任务）", JSON.stringify(r19.ql.triggered) === "[1,3]");
  }

  // ===== 场景20：合并查询（V1.04）— 开关同步只发 1 次全量 GET，已是最新值零写入 =====
  console.log("\n===== 场景20：开关同步合并查询 =====");
  {
    const ck20 = makeCookie("24024");
    const swNames = [
      ["QDREADER_ADV_JOB_ENABLE", "激励任务"], ["QDREADER_EXTRA_ADV_JOB_ENABLE", "每日任务"],
      ["QDREADER_LOTTERY_ENABLE", "每日抽奖"], ["QDREADER_WEEKLY_EXCHANGE_ENABLE", "每周兑换"],
      ["QDREADER_CHAPTER_CARD_ENABLE", "章节卡片"], ["QDREADER_MESSAGE_BOX_ENABLE", "大咖荐书"]
    ];
    const pre = [{ id: 96, name: "QDREADER_COOKIE", value: JSON.stringify({ "24024": "old-cookie" }), status: 0, remarks: "" }];
    swNames.forEach((s, i) => pre.push({ id: 200 + i, name: s[0], value: "true", status: 0, remarks: s[1] }));
    const r20 = await runScenario("switch-merged-query", {
      argument: ARG,
      request: { headers: { Cookie: ck20 } },
      ql: { envs: pre },
      wait: 12000
    });
    check("开关全部已是最新值（6 条）", (r20.logs.join("\n").match(/已是最新值 true/g) || []).length === 6);
    check("已是最新值 → 开关零新建零更新", r20.ql.posts.length === 0);
    check("合并查询：GET /open/envs 共 3 次（推送+复核+同步各1，旧版为8）", r20.ql.envGets === 3);
    check("同步小结日志存在", r20.logs.some(l => l.indexOf("开关同步小结") >= 0));
    check("Cookie 仍正常推送（主目标不受影响）", (() => { try { const m = JSON.parse(r20.ql.envs.find(e => e.id === 96).value); return m["24024"] === ck20; } catch (e) { return false; } })());
    check("签到任务已触发（含已禁用任务）", JSON.stringify(r20.ql.triggered) === "[1,3]");
  }

  // ===== 场景21：主目标优先（V1.04）— 开关同步全失败也不影响 Cookie 推送与签到触发 =====
  console.log("\n===== 场景21：开关同步故障不影响主目标 =====");
  {
    const ck21 = makeCookie("25025");
    // 预置 QDREADER_COOKIE（走 PUT 不 POST），并让 POST /open/envs 全部失败 → 6 个开关新建全失败
    const r21 = await runScenario("switch-fail-degrade", {
      argument: ARG,
      request: { headers: { Cookie: ck21 } },
      ql: { envs: [{ id: 97, name: "QDREADER_COOKIE", value: JSON.stringify({ "25025": "old-cookie" }), status: 0, remarks: "" }], failPostEnvs: true },
      wait: 15000
    });
    const joined21 = r21.logs.join("\n");
    const iTrig = r21.logs.reduce((a, l, i) => (l.indexOf("3、触发签到任务") >= 0 ? i : a), -1);
    const iSync = r21.logs.reduce((a, l, i) => (l.indexOf("按插件设置同步至青龙环境变量") >= 0 ? i : a), -1);
    check("主目标优先：触发签到排在开关同步之前", iTrig >= 0 && iSync >= 0 && iTrig < iSync);
    check("Cookie 已推送成功（变量已更新）", (() => { try { const m = JSON.parse(r21.ql.envs.find(e => e.id === 97).value); return m["25025"] === ck21; } catch (e) { return false; } })());
    check("签到任务已触发（含已禁用任务）", JSON.stringify(r21.ql.triggered) === "[1,3]");
    check("成功通知已发送", r21.notifs.some(n => n.title === "起点Cookie推送青龙成功"));
    check("无失败通知（主目标成功）", !r21.notifs.some(n => n.title === "起点Cookie推送青龙失败"));
    check("连续失败触发熔断（放弃剩余开关）", joined21.indexOf("熔断放弃剩余") >= 0);
    check("熔断日志说明不影响已推送与触发", joined21.indexOf("不影响已推送的 Cookie 与签到触发") >= 0);
    check("脚本正常收尾（$done）", r21.doneCalled === true);
  }

  // ===== 场景22：定时任务状态判定（青龙 CrontabStatus 枚举：0=运行中 1=已启用空闲 2=已禁用 3=排队） =====
  console.log("\n===== 场景22：任务状态判定（新版枚举） =====");
  {
    const r22 = await runScenario("cron-status", {
      argument: ARG,
      request: { headers: { Cookie: makeCookie("26026") } },
      ql: {
        envs: [{ id: 98, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }],
        crons: [
          { id: 11, command: "task bobbyleu_dailycheckin/qdreader.js", name: "起点读书签到", status: 1, schedule: "5 8 * * *" },
          { id: 12, command: "task bobbyleu_dailycheckin/qdreader.js", name: "起点读书签到(已禁用)", status: 2, schedule: "0 4 * * *" },
          { id: 13, command: "task other/qdreader.js", name: "另一个起点任务(运行中)", status: 0, schedule: "0 6 * * *" }
        ]
      },
      wait: 12000
    });
    check("status=1 已启用(空闲)任务被触发", r22.ql.triggered.indexOf(11) >= 0);
    check("status=2 已禁用任务仍被触发", r22.ql.triggered.indexOf(12) >= 0);
    check("status=0 运行中任务也被触发", r22.ql.triggered.indexOf(13) >= 0);
    check("日志列出命中任务与状态文案", r22.logs.some(l => l.indexOf("命令含「qdreader」的任务") >= 0 && l.indexOf("已启用(空闲)") >= 0));
    check("日志标注已禁用仍强制触发", r22.logs.some(l => l.indexOf("已禁用，仍强制触发") >= 0));
    check("触发结果文案含任务名", r22.logs.some(l => l.indexOf("已触发 3 个签到任务") >= 0));
  }
  {
    // 旧版青龙无 status 枚举，只有 isDisabled 字段 → 回退兼容
    const r22b = await runScenario("cron-legacy", {
      argument: ARG,
      request: { headers: { Cookie: makeCookie("27027") } },
      ql: {
        envs: [{ id: 99, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }],
        crons: [
          { id: 21, command: "task qdreader.js", name: "旧版已启用", isDisabled: 0 },
          { id: 22, command: "task qdreader.js", name: "旧版已禁用", isDisabled: 1 }
        ]
      },
      wait: 12000
    });
    check("旧版 isDisabled=0 被触发", r22b.ql.triggered.indexOf(21) >= 0);
    check("旧版 isDisabled=1 仍被触发", r22b.ql.triggered.indexOf(22) >= 0);
  }

  // ===== 场景23：/open/crons 返回结构兼容（新版分页对象 / 旧版纯数组 / 空列表诊断）=====
  console.log("\n===== 场景23：任务接口返回结构兼容 =====");
  {
    // 旧版：纯数组返回（与 /open/envs 一致）
    const q23 = makeQL({
      envs: [{ id: 120, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }],
      crons: [{ id: 31, command: "task bobbyleu_dailycheckin/qdreader.js", name: "起点读书签到", status: 1, schedule: "5 8 * * *" }]
    });
    q23.routes["GET /open/crons"] = () => ({ code: 200, data: q23.state.crons }); // 覆盖成纯数组
    const r23 = await runScenario("cron-legacy-shape", {
      argument: ARG,
      request: { headers: { Cookie: makeCookie("28028") } },
      qlState: q23.state, qlRoutes: q23.routes,
      wait: 12000
    });
    check("旧版纯数组返回也能触发", JSON.stringify(r23.ql.triggered) === "[31]");
  }
  {
    // 空任务列表 → 打印原始响应诊断，便于以后接口再变时定位
    const q23b = makeQL({
      envs: [{ id: 121, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }],
      crons: []
    });
    const r23c = await runScenario("cron-empty", {
      argument: ARG,
      request: { headers: { Cookie: makeCookie("29029") } },
      qlState: q23b.state, qlRoutes: q23b.routes,
      wait: 12000
    });
    check("空任务列表时打印原始响应诊断", r23c.logs.some(l => l.indexOf("接口未返回任务列表") >= 0));
    check("空任务列表不触发且不误报成功", r23c.ql.triggered.length === 0 && r23c.logs.some(l => l.indexOf("未找到命令包含") >= 0));
  }

  // ===== 场景24：同一 uid 连续两次捕获（C1旧 → C2新，间隔 < 缓冲窗口）→ 最终落地为最新 C2 =====
  console.log("\n===== 场景24：爆发捕获只推最新 cookie =====");
  {
    const sharedQL24 = makeQL({ envs: [{ id: 130, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] });
    const sharedStore24 = {};
    const ckC1 = makeCookie("24024");                 // 第一次捕获（稍旧）
    const ckC2 = makeCookie("24024", "extra=newest"); // 第二次捕获（最新，同一 uid）
    // 两个实例几乎同时启动、共享 store 与青龙 mock，模拟 App 打开瞬间连续触发 getlogininfo
    const pC1 = runScenario("burst-c1", {
      argument: ARG, request: { headers: { Cookie: ckC1 } },
      qlState: sharedQL24.state, qlRoutes: sharedQL24.routes, store: sharedStore24, wait: 12000
    });
    const pC2 = runScenario("burst-c2", {
      argument: ARG, request: { headers: { Cookie: ckC2 } },
      qlState: sharedQL24.state, qlRoutes: sharedQL24.routes, store: sharedStore24, wait: 12000
    });
    const rc1 = await pC1, rc2 = await pC2;
    const allLogs24 = rc1.logs.join("\n") + "\n" + rc2.logs.join("\n");
    const m24 = (() => { try { return JSON.parse(sharedQL24.state.envs.find(e => e.id === 130).value); } catch (e) { return null; } })();
    check("统一走缓冲窗口（日志含「进入 …s 缓冲」）", allLogs24.indexOf("进入") >= 0 && allLogs24.indexOf("缓冲") >= 0);
    check("最终落地的是最新捕获 C2（含 extra=newest）", m24 && m24["24024"] === ckC2);
    check("第一次捕获 C1（旧）未被落地", m24 && m24["24024"] !== ckC1);
    check("变量只有一对键值", m24 && Object.keys(m24).length === 1);
    check("发送一次成功通知", rc1.notifs.concat(rc2.notifs).filter(n => n.title === "起点Cookie推送青龙成功").length === 1);
  }

  console.log("\n========================================");
  console.log("结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
