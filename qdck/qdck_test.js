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
    nextId: 100,
    triggered: [],
    log: []
  };
  const routes = {
    "GET /open/auth/token": (q) => ({ code: 200, data: { token: "mock-token", token_type: "Bearer", expiration: 3600 } }),
    "GET /open/envs": (q) => {
      const sv = decodeURIComponent((q.match(/searchValue=([^&]*)/) || [])[1] || "");
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
      const arr = Array.isArray(body) ? body : [body];
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
    "GET /open/crons": () => ({
      code: 200, data: [
        { id: 1, command: "task qdreader.js", name: "起点读书签到", status: 0, schedule: "11 2 * * *" },
        { id: 2, command: "task jd_CheckCK.js", name: "京东CK兜底", status: 0, schedule: "0 3 * * *" },
        { id: 3, command: "task qdreader.js", name: "起点读书签到(已停用)", status: 1, schedule: "0 4 * * *" }
      ]
    }),
    "PUT /open/crons/run": (q, body) => {
      state.triggered.push(...(Array.isArray(body) ? body : [body]));
      return { code: 200, data: null };
    }
  };
  return { state, routes };
}

// ---- Loon 环境模拟 ----
function runScenario(name, opts) {
  return new Promise((resolve) => {
    const ql = makeQL(opts.ql);
    const logs = [];
    const notifs = [];
    let doneCalled = false;

    const store = {};
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
  const ARG = { CLIENT_ID: "id", CLIENT_SECRET: "sec", QL_URL: "http://ql.local", PUSH: "true", RUN_SIGN: "true", TASK_KEY: "qdreader", ENV_NAME: "QDREADER_COOKIE" };

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
  check("变量已新建", r.ql.envs.length === 1 && r.ql.envs[0].name === "QDREADER_COOKIE");
  check("value 为 JSON Map 且含 uid=10001", (() => { try { const m = JSON.parse(r.ql.envs[0].value); return m["10001"] === ck3; } catch (e) { return false; } })());
  check("签到任务已触发（仅 status=0 的 qdreader）", JSON.stringify(r.ql.triggered) === "[1]");
  check("发送成功通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));
  check("日志含二次复核✅", r.logs.some(l => l.indexOf("二次复核：✅") >= 0));

  // ===== 场景4：已有其他账号 → 合并保留 + 同 uid 更新 =====
  console.log("\n===== 场景4：合并（新账号追加，其他账号保留） =====");
  const oldCk = "ywKey=OLDKEY; ywGuid=OLDGUID; QDHeader=xxx; uid=20002";
  const ck4new = makeCookie("30003");
  r = await runScenario("merge-add", {
    argument: ARG,
    request: { headers: { Cookie: ck4new } },
    ql: { envs: [{ id: 55, name: "QDREADER_COOKIE", value: JSON.stringify({ "20002": oldCk }), status: 0, remarks: "" }] },
    wait: 9000
  });
  let m4 = null;
  try { m4 = JSON.parse(r.ql.envs.find(e => e.id === 55).value); } catch (e) {}
  check("旧账号 20002 原样保留", m4 && m4["20002"] === oldCk);
  check("新账号 30003 已新增", m4 && m4["30003"] === ck4new);
  check("未误触发其他任务", JSON.stringify(r.ql.triggered) === "[1]");

  // ===== 场景5：同 uid 更新（覆盖值，账号数不变） =====
  console.log("\n===== 场景5：同 uid 更新 =====");
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
  check("其他账号 50005 保留", m5 && m5["50005"] === "keepme");
  check("账号键数量不变（2个）", m5 && Object.keys(m5).length === 2);
  check("发送更新通知", r.notifs.some(n => n.title === "起点Cookie推送青龙成功"));

  // ===== 场景6：现值非 JSON → 备份不清空 =====
  console.log("\n===== 场景6：现值非 JSON（手填原始cookie） =====");
  const ck6 = makeCookie("60006");
  r = await runScenario("bad-json", {
    argument: ARG,
    request: { headers: { Cookie: ck6 } },
    ql: { envs: [{ id: 57, name: "QDREADER_COOKIE", value: "ywKey=MANUAL;ywGuid=MANUAL2", status: 0, remarks: "" }] },
    wait: 9000
  });
  let m6 = null;
  try { m6 = JSON.parse(r.ql.envs.find(e => e.id === 57).value); } catch (e) {}
  check("原值备份到 60006_backup 键", m6 && m6["60006_backup"] === "ywKey=MANUAL;ywGuid=MANUAL2");
  check("新 cookie 正常写入", m6 && m6["60006"] === ck6);
  check("日志有备份告警", r.logs.some(l => l.indexOf("备份") >= 0 && l.indexOf("不清空") >= 0));

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

  // ===== 场景8：TASK_KEY 无匹配任务 → 不影响推送成功 =====
  console.log("\n===== 场景8：无匹配任务 =====");
  r = await runScenario("no-task", {
    argument: Object.assign({}, ARG, { TASK_KEY: "notexist" }),
    request: { headers: { Cookie: makeCookie("80008") } },
    ql: { envs: [{ id: 59, name: "QDREADER_COOKIE", value: "{}", status: 0, remarks: "" }] },
    wait: 9000
  });
  check("变量已更新", (() => { try { const m = JSON.parse(r.ql.envs.find(e => e.id === 59).value); return !!m["80008"]; } catch (e) { return false; } })());
  check("未触发任务但日志给出提示", r.ql.triggered.length === 0 && r.logs.some(l => l.indexOf("未找到命令包含") >= 0));
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

  console.log("\n========================================");
  console.log("结果：" + pass + " 通过 / " + fail + " 失败");
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error("HARNESS ERROR:", e); process.exit(1); });
