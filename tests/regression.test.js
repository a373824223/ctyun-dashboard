#!/usr/bin/env node
'use strict';

/**
 * ============================================================================
 * 结构性回归测试网 (Regression Net) —— ctyun-dashboard
 * ============================================================================
 * 目的：让"修好 A 却弄坏 B"在机械层面变成不可能。
 *
 * 背景：本项目历史上"签到 / 1 小时挂机 / AI 对话"三类问题反复复发，根因不是某一处
 * 写错，而是四类结构性缺陷被反复重新引入：
 *   暗线 A：开关语义分散读取（keepaliveEnabled / taskEnabled / autoSign / cloudHang 相互渗透）
 *   暗线 B：无客户端在场证据就盲目重连（45 秒顶人 → 被官方客户端踢下线）
 *   暗线 C：用固定时间窗"猜"异步结果（打卡认领窗口结束即当成功）
 *   暗线 D：丢弃错误证据（catch(e){} 静默吞掉 fetch failed / 数据读取失败）
 *
 * 本文件把这些结构性约束固化为可执行断言：任何人再次写出上述模式，`npm test` 立刻变红。
 *
 * 断言分两类：
 *   1) 静态结构断言 —— 直接读源码文本，断言"危险模式不存在 / 安全模式存在"；
 *   2) 行为断言 —— 从 server.js 抽取权威开关解析函数 resolveTaskEnabled 后真实调用，
 *      验证语义正确（尤其是 sign -> autoSign 的字段映射，见 #43）。
 *
 * 零依赖，直接 `node tests/regression.test.js`。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = process.env.CTYUN_TEST_ROOT
  ? path.resolve(process.env.CTYUN_TEST_ROOT)
  : path.resolve(__dirname, '..');
// 统一换行符为 LF：源码在 Windows 下是 CRLF，若不正则化，所有跨行正则（如 finally 块、
// 代码块抽取）都会因 \r 静默失配 —— 这是测试网自身最容易踩的坑。
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/**
 * 剥离行注释（保留 URL 里的 `//`）。
 *
 * 【测试自身缺陷修复 2026-09-23】凡是"扫描源码里有没有某个调用"的断言，都必须先剥注释：
 * 注释是散文，不是代码。曾出现 `// ... Node fetch(undici) 的默认超时是 ...` 被
 * `/(?<![\w$])fetch\s*\(/` 误判为"裸露的 fetch 调用"，导致测试网误报（第二次踩同类坑：
 * 第一次是把注释里的写法当成生产代码，见组 7 指纹扫描的同类经验）。
 * 本文件不含块注释；URL 的 `//` 前面紧邻 ':'，据此区分。
 */
const stripLineComments = (code) =>
  code
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      if (idx === -1) return line;
      if (idx > 0 && line[idx - 1] === ':') return line; // http:// 等 URL，保留
      return line.slice(0, idx);
    })
    .join('\n');

const server = read('server.js');
const scheduler = read('app/tasks/scheduler.js');
const native = read('app/tasks/native_tasks.js');

let passed = 0;
let failed = 0;
const lines = [];

function group(title) {
  lines.push(`\n${title}`);
}

function test(name, fn) {
  try {
    const r = fn();
    // 【2026-09-26 新增护栏】禁止把 async 断言注册到 test()。
    // test() 是同步的、不会 await：async 测试的断言失败会变成"未处理的 Promise"，
    // 跑出来既没有 FAIL 行（**静默漏检**），又会让变异验证判 BROKEN。
    // 本条自身就是这么被变异验证抓出来的（M87）。async 一律用 testAsync()。
    if (r && typeof r.then === 'function') {
      if (typeof r.catch === 'function') r.catch(() => {}); // 防止稍后冒泡成未处理拒绝
      throw new Error('async 断言必须用 testAsync() 注册：test() 不会 await，断言会静默失效');
    }
    passed++;
    lines.push(`  ok    ${name}`);
  } catch (e) {
    failed++;
    const msg = String(e && e.message ? e.message : e).split('\n').join('\n        ');
    lines.push(`  FAIL  ${name}`);
    lines.push(`        ${msg}`);
  }
}

/**
 * 异步断言登记。
 *
 * 【2026-09-23 补强】原测试网只能跑同步断言，于是"启动流程里的运行期 ReferenceError /
 * 未被 await 的 Promise 卡死"这类**必须真实执行才能暴露**的缺陷完全无法覆盖 ——
 * 组 13 记录的"移动云保活静默停摆"事故正是这样漏出去的（静态断言只看到符号存在，
 * 而 ReferenceError 只会在默认参数求值时炸）。
 * 登记后的断言在本文件末尾按序 await 执行，再统一出汇总。
 */
const asyncTests = [];
function testAsync(name, fn) {
  asyncTests.push({ name, fn });
}

/** 断言源码中不存在某模式（去掉注释后再匹配，避免注释里的反例说明误报）
 *  顺序很关键：必须先剥行注释，再剥块注释。
 *  因为源码里存在 `app/tasks/` 后跟星号的这种写法，它写在行注释中，却包含块注释的起始符号。
 *  若先剥块注释，就会从该起始符号一路吞到很远处的下一个块注释结束符，连带删掉真实代码。 */
/**
 * 去除 JS 源码中的注释 —— **字符串感知**版本。
 *
 * 【2026-09-23 修正】旧实现用裸正则直接删注释，存在一个会"吃掉真实代码"的缺陷：
 *   源文件里 HTTP 头的 Accept 占位值（形如 星号+斜杠+星号）中的 "斜杠+星号"
 *   会被当成块注释开头，正则一路吞到下一个 "星号+斜杠"，
 *   把中间**真正的运行时代码**（含日志语句）一并删掉。
 *   实测它曾吞掉 cag_boot.js 中一条 warning 日志字符串（约 2300 字符区间），
 *   导致"降级必须留证"这类断言对真实代码视而不见 —— 假阳性/假阴性都会出现。
 *
 * 因此改为状态机扫描：只在**字符串/模板字面量之外**识别并剔除注释。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code'; // code | line | block | sq | dq | tpl
  while (i < n) {
    const c = src[i];
    const c2 = src.slice(i, i + 2);
    if (state === 'code') {
      if (c2 === '//') { state = 'line'; i += 2; continue; }
      if (c2 === '/*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'sq'; out += c; i++; continue; }
      if (c === '"') { state = 'dq'; out += c; i++; continue; }
      if (c === '`') { state = 'tpl'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c2 === '*/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c; // 保留换行，维持行号大致对齐
      i++; continue;
    }
    // 字符串/模板内部：保留内容，仅处理转义与结束引号
    if (c === '\\') { out += c2; i += 2; continue; }
    if (state === 'sq' && c === "'") { state = 'code'; out += c; i++; continue; }
    if (state === 'dq' && c === '"') { state = 'code'; out += c; i++; continue; }
    if (state === 'tpl' && c === '`') { state = 'code'; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

const serverCode = stripComments(server);
const schedulerCode = stripComments(scheduler);
const nativeCode = stripComments(native);

// ============================================================================
// 组 1 · 暗线 A：开关语义必须只有单一权威入口
// ============================================================================
group('组 1 · 开关语义单一入口（暗线 A）');

test('server.js 定义 TASK_FEATURE_KEY 且把 sign 映射到 autoSign（#43 字段漂移）', () => {
  assert.ok(/TASK_FEATURE_KEY/.test(serverCode), '未找到 TASK_FEATURE_KEY');
  assert.ok(
    /TASK_FEATURE_KEY\s*=\s*\{[^}]*sign:\s*'autoSign'[^}]*\}/.test(serverCode),
    "TASK_FEATURE_KEY 必须包含 sign: 'autoSign'，否则账号级打卡开关读取到 undefined 而失效"
  );
});

test('server.js 暴露 resolveTask 统一入口', () => {
  assert.ok(/resolveTask\s*\(\s*taskType/.test(serverCode), '缺少 CtYunClient.resolveTask');
  assert.ok(/function\s+resolveTaskEnabled\s*\(/.test(serverCode), '缺少 resolveTaskEnabled');
});

test('server.js 不得再出现挂机/保活执行闸门的原始字段直读', () => {
  const bad = [
    /if\s*\(\s*d\.keepaliveEnabled\s*===\s*false\s*\)\s*continue/,
    /if\s*\(\s*\w+\.taskEnabled\s*===\s*false\s*\)\s*continue/,
  ];
  for (const re of bad) {
    assert.ok(!re.test(serverCode), `检测到原始字段直读闸门：${re}`);
  }
});

test('scheduler.js 不得就地读取 acc.features 的任务开关', () => {
  const bad = [
    /acc\.features\?\.autoSign\s*!==\s*false/,
    /acc\.features\?\.aiChat\s*!==\s*false/,
    /acc\.features\?\.cloudHang\s*!==\s*false/,
    /acc\.features\?\.keepAlive\s*!==\s*false/,
    /\bf\.autoSign\s*!==\s*false/,
    /\bf\.aiChat\s*!==\s*false/,
    /\bf\.cloudHang\s*!==\s*false/,
  ];
  for (const re of bad) {
    assert.ok(!re.test(schedulerCode), `调度器仍在直读开关字段：${re}`);
  }
});

test('scheduler.js 提供 taskGate 统一入口，且兜底映射与 server.js 一致（sign -> autoSign）', () => {
  assert.ok(/taskGate\s*\(/.test(schedulerCode), '缺少 scheduler.taskGate');
  assert.ok(
    /taskType\s*===\s*'sign'\s*\?\s*'autoSign'\s*:\s*taskType/.test(schedulerCode),
    'scheduler.taskGate 兜底映射必须 sign -> autoSign'
  );
});

// ============================================================================
// 组 2 · 暗线 B：不得在无证据情况下重连 / 顶人
// ============================================================================
group('组 2 · 挂机不得盲重连（暗线 B）');

test('server.js 存在 "Unverified Channel Close" 证据缺失标记', () => {
  assert.ok(
    /Unverified Channel Close/.test(server),
    '缺少"通道关闭但无客户端在场证据"的显式标记，退化为 unknow 重连'
  );
});

test('server.js 的挂机中断判定必须返回 unverified 分支（不对称判定）', () => {
  assert.ok(/diagnoseHangInterruption/.test(serverCode), '缺少 diagnoseHangInterruption');
  assert.ok(/unverified/.test(serverCode), '缺少 unverified 判定结果');
});

test('server.js 存在重连预算上限字段（防止无限重连顶人）', () => {
  assert.ok(/hangReconnectCount/.test(serverCode), '缺少 hangReconnectCount 重连预算');
  assert.ok(/hangUnverifiedStreak/.test(serverCode), '缺少 hangUnverifiedStreak 退避计数');
});

// ============================================================================
// 组 3 · 暗线 C：打卡不得用固定窗口"猜"成功
// ============================================================================
group('组 3 · 打卡判定必须以官方确认（暗线 C）');

test('server.js 提供跨分钟复检机制 scheduleSignVerify / isSignTaskDone', () => {
  assert.ok(/scheduleSignVerify/.test(serverCode), '缺少 scheduleSignVerify');
  assert.ok(/isSignTaskDone/.test(serverCode), '缺少 isSignTaskDone');
});

test('native_tasks.js 打卡存在 pendingVerify 待确认态', () => {
  assert.ok(/pendingVerify/.test(nativeCode), '缺少 pendingVerify 待官方确认态');
});

test('native_tasks.js 所有"待确认"返回必须同时显式声明 isCompleted:false', () => {
  const returns = nativeCode.match(/return\s*\{[^}]*pendingVerify\s*:\s*true[^}]*\}/g) || [];
  assert.ok(returns.length > 0, '未找到任何"待官方确认 (pendingVerify: true)"的返回语句');
  for (const r of returns) {
    assert.ok(
      /isCompleted\s*:\s*false/.test(r),
      `"待确认"返回未显式声明 isCompleted:false，存在被解读为成功的风险：${r}`
    );
  }
});

test('native_tasks.js 不得出现"未确认却报成功"的返回（pendingVerify 与 isCompleted:true 并存）', () => {
  const returns = nativeCode.match(/return\s*\{[^}]*\}/g) || [];
  const bad = returns.filter(r => /pendingVerify\s*:\s*true/.test(r) && /isCompleted\s*:\s*true/.test(r));
  assert.strictEqual(
    bad.length, 0,
    `发现 ${bad.length} 处"待官方确认"与"已完成"同时上报的返回值（互斥语义被破坏）：\n${bad.join('\n')}`
  );
});

test('native_tasks.js 硬编码 isCompleted: true 的返回点须恰好 3 处（新增即需显式确认）', () => {
  const hits = nativeCode.match(/isCompleted\s*:\s*true/g) || [];
  assert.strictEqual(
    hits.length,
    3,
    `硬编码 isCompleted: true 出现 ${hits.length} 次，预期 3 次` +
      `（① 官方已完成前置校验 ② 官方已确认达成 ③ 移动云无需挂机）。` +
      `若确为新增的合法确认分支，请同步更新本断言，避免"虚报成功"被静默引入。`
  );
});

// ============================================================================
// 组 4 · 暗线 D：不得丢弃错误证据
// ============================================================================
group('组 4 · 错误证据不得被吞掉（暗线 D）');

test('server.js refreshOfficialTasks 返回可区分可信度的结果 { ok }', () => {
  assert.ok(
    /refreshOfficialTasks\s*\(/.test(serverCode),
    '缺少 refreshOfficialTasks'
  );
  assert.ok(
    /async\s+refreshOfficialTasks\s*\([^)]*\)\s*\{[\s\S]{0,6000}?ok:\s*false/.test(serverCode),
    'refreshOfficialTasks 未返回 { ok: false, reason }，调用方无法区分"未达成"与"没取到数据"'
  );
});

test('native_tasks.js 网络请求必须带主动超时（#35 串行队列卡死）', () => {
  assert.ok(/netFetch/.test(nativeCode), '缺少 netFetch 统一请求封装');
  assert.ok(
    /signal\s*=\s*AbortSignal\.timeout\s*\(/.test(nativeCode),
    'netFetch 未把 AbortSignal.timeout 赋给 signal（仅有 typeof 守卫不算真正的主动超时）'
  );
  assert.ok(
    /fetch\s*\([^)]*signal\s*\?\s*\{[^}]*signal\s*\}\s*:\s*options\s*\)/.test(nativeCode),
    'signal 没有被传入 fetch 请求，超时设置不会真正生效，AI 对话仍可能永久挂起'
  );
});

// ============================================================================
// 组 5 · 调度器不得静默死锁（#32）与虚报（#34）
// ============================================================================
group('组 5 · 调度器健壮性（#32 / #34）');

test('scheduler.js runAllAccounts 必须用 try/finally 复位 isRunning', () => {
  assert.ok(
    /async\s+runAllAccounts\s*\([\s\S]*?\}\s*finally\s*\{\s*this\.isRunning\s*=\s*false;\s*\}/.test(schedulerCode),
    'isRunning 未在 finally 中复位：任一步骤抛错将导致调度器永久死锁'
  );
});

test('scheduler.js 不得存在 "已达成/已达成" 死代码虚报', () => {
  assert.ok(
    !/['"]已达成['"]\s*:\s*['"]已达成['"]/.test(schedulerCode),
    "存在 `? '已达成' : '已达成'` 死代码：无论结果如何都上报已达成"
  );
});

// ============================================================================
// 组 6 · 行为断言：真实执行权威开关解析函数
// ============================================================================
group('组 6 · resolveTaskEnabled 行为验证（抽取源码真实执行）');

function loadResolveTaskEnabled() {
  const m = server.match(/const TASK_CN_NAME[\s\S]*?\n\}\n/);
  assert.ok(m, '无法从 server.js 抽取 resolveTaskEnabled 代码块');
  const code = m[0];
  assert.ok(/function\s+resolveTaskEnabled/.test(code), '抽取到的代码块不含 resolveTaskEnabled');
  // eslint-disable-next-line no-new-func
  return new Function(`${code}\nreturn { resolveTaskEnabled, TASK_FEATURE_KEY };`)();
}

let resolveTaskEnabled = null;
try {
  resolveTaskEnabled = loadResolveTaskEnabled().resolveTaskEnabled;
  lines.push('  ok    成功抽取并加载 resolveTaskEnabled');
  passed++;
} catch (e) {
  failed++;
  lines.push(`  FAIL  抽取 resolveTaskEnabled 失败: ${e.message}`);
}

if (typeof resolveTaskEnabled === 'function') {
  const acc = (features, extra = {}) => ({ enabled: true, features, ...extra });

  test('打卡：账号级 autoSign=false 必须判定为关闭（#43 核心回归）', () => {
    const r = resolveTaskEnabled(acc({ keepAlive: true, autoSign: false }), null, 'sign');
    assert.strictEqual(r.enabled, false, '账号级打卡开关被忽略 —— 关掉开关任务仍会跑');
  });

  test('打卡：脏字段 features.sign=false 不得影响判定（证明读的是 autoSign）', () => {
    const r = resolveTaskEnabled(acc({ sign: false }), null, 'sign');
    assert.strictEqual(r.enabled, true, '读取了错误的字段名 sign');
  });

  test('打卡：default 开启', () => {
    assert.strictEqual(resolveTaskEnabled(acc({}), null, 'sign').enabled, true);
  });

  test('挂机：保活关闭不得影响挂机任务执行（脱钩验证）', () => {
    const r = resolveTaskEnabled(acc({ keepAlive: false, cloudHang: true }), { taskEnabled: true }, 'cloudHang');
    assert.strictEqual(r.enabled, true, '保活开关错误地影响了任务执行');
  });

  test('挂机：cloudHang=false 关闭', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ cloudHang: false }), null, 'cloudHang').enabled, false);
  });

  test('挂机：单机 taskEnabled=false 关闭', () => {
    assert.strictEqual(
      resolveTaskEnabled(acc({ cloudHang: true }), { taskEnabled: false }, 'cloudHang').enabled,
      false
    );
  });

  test('保活：账号级 keepAlive=false 关闭（不会被任务开关救回）', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ keepAlive: false }), { taskEnabled: true }, 'keepAlive').enabled, false);
  });

  test('保活：单机 keepaliveEnabled=false 关闭', () => {
    assert.strictEqual(
      resolveTaskEnabled(acc({ keepAlive: true }), { keepaliveEnabled: false }, 'keepAlive').enabled,
      false
    );
  });

  test('账号停用：一律关闭', () => {
    assert.strictEqual(resolveTaskEnabled({ enabled: false, features: {} }, null, 'sign').enabled, false);
  });

  test('AI 对话：aiChat=false 关闭', () => {
    assert.strictEqual(resolveTaskEnabled(acc({ aiChat: false }), null, 'aiChat').enabled, false);
  });
}

// ============================================================================
// 组 7 · 移动云开机必须走"干净通道"（2026-09-23 修订：禁手段，不禁功能）
// ============================================================================
// 口径：
//   放行：官方通道（CAG HTTPS 的 cs_connectDesktop.action 系、SCG 的 CEM 接口）、
//         账号自身 firm-auth 凭据、动态获取的 RSA 公钥、保留证书校验。
//   拦截：伪造客户端身份（cdpsdk-server-*）、硬编码第三方客户端 ID / RSA 公钥、
//         关闭证书校验，以及任何**未被红线扫描覆盖的新文件**（见下方目录级护栏）。
//
// ⚠️ 这是一道"防脏手段"的红线，不是"防功能"的红线。请勿删除本组 ——
//    它拦的是伪造与关校验，不是拦你要的开机能力。
group('组 7 · 移动云开机必须走干净通道（禁伪造身份 / 关证书 类指纹）');

// 扫描生产源码中的"脏手段"指纹（沙箱内缺失的文件自动跳过）
const BOOT_SCAN_FILES = [
  'server.js',
  'app/tasks/scheduler.js',
  'app/tasks/native_tasks.js',
  'app/ydpc/ydpc_client.js',
  'app/ydpc/soho_client.js',
  'app/ydpc/cag_boot.js',
  'app/ydpc/zte_cag_raw.js',
  'app/ydpc/zte_cag_tls.js',
  // 【2026-09-26】SCG 通道是**第二个**数据面实现，与 cag_boot 同属"移动云开机/保活相关文件"。
  // 该通道同时用到 CEM 客户端 ID 与 RSA 公钥（见下方豁免），必须一并扫 ——
  // 否则"抄协议格式"很容易顺手把来源不明的第三方身份也带进来而无人拦。
  'app/ydpc/scg_keepalive.js',
  'app/static/app.js',
];

// app/ydpc 下与开机/保活链路无关、且各自有独立 TLS 口径的文件（豁免纳入扫描名单）
const YDPC_SCAN_EXEMPT = new Set([
  'app/ydpc/cag_client.js',
  'app/ydpc/mqtt_client.js',
  'app/ydpc/product_route.js',
]);

test('app/ydpc 下不得出现未纳入红线扫描的 .js 文件（新文件的复活路径必须被覆盖）', () => {
  const dir = path.join(ROOT, 'app/ydpc');
  const present = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => `app/ydpc/${f}`);
  const missing = present.filter((f) => !BOOT_SCAN_FILES.includes(f) && !YDPC_SCAN_EXEMPT.has(f));
  assert.deepStrictEqual(
    missing,
    [],
    `以下文件既未纳入红线扫描、也不在豁免清单：${missing.join(', ')}。` +
      `新增开机/保活相关文件必须加入 BOOT_SCAN_FILES，否则视为未审查代码。`
  );
});

// 一旦出现即代表"伪造身份 / 硬编码凭据 / 关证书"被重新引入的指纹
// 【2026-09-26 修订】sc-user-5e38ece5 与 sdk2 RSA 公钥经用户批准在 app/ydpc/scg_keepalive.js
//   的 CEM 控制面（保活路径）中合法使用 —— 真机四轮探针实证 firm-auth 的 scAuthCode 只是
//   OAuth ext-grant 令牌，不经 CEM（OAuth → getConnectInfo）边缘对任何输入一律静默丢包。
//   这两个指纹因此对 scg_keepalive.js **豁免**，对其余文件仍然全面禁止（此类手段
//   不得扩散到别处）。
const BOOT_FINGERPRINTS = [
  {
    re: /sc-user-5e38ece5/,
    why: '硬编码的第三方 SC 客户端 ID（伪造官方身份）',
    except: ['app/ydpc/scg_keepalive.js']
  },
  {
    re: /SC_RSA_PK_SDK2/,
    why: '硬编码的第三方 SC RSA 公钥',
    except: ['app/ydpc/scg_keepalive.js']
  },
  { re: /scBootVm\s*\(/, why: 'SC 直连开机函数' },
  { re: /scRsaEncryptVmId/, why: 'SC 专用 VMID 加密函数' },
  { re: /cdpsdk-server/, why: '伪造的官方 SC 客户端身份串' },
  { re: /rejectUnauthorized\s*:\s*false/, why: '关闭 TLS 证书校验（脏手段）' },
];

test('生产源码不得出现"伪造身份 / 硬编码第三方凭据 / 关证书"指纹', () => {
  const hits = [];
  for (const f of BOOT_SCAN_FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) continue;
    const code = stripComments(fs.readFileSync(abs, 'utf8'));
    for (const { re, why, except } of BOOT_FINGERPRINTS) {
      // 例外：server.js 的 rejectUnauthorized 两处均在天翼云路径上
      //   · 2162 行附近：天翼云 WebRTC 的 wss 连接选项
      //   · 3402 行附近：天翼云网页端代理透传的 https.request 选项
      // 与移动云开机无关，故仅在"移动云开机相关文件"上检查关证书项。
      if (re.source.includes('rejectUnauthorized') && f === 'server.js') continue;
      // 例外：CEM 控制面材料（client_id / sdk2 公钥）已获用户批准仅限 scg_keepalive.js
      if (Array.isArray(except) && except.includes(f)) continue;
      const m = code.match(re);
      if (m) hits.push(`${f}  ←  ${why}  ${JSON.stringify(m[0])}`);
    }
  }
  assert.strictEqual(
    hits.length,
    0,
    '检测到移动云开机的脏手段残留（应改用 CAG 通道 + 真实凭据 + 保留证书校验）：\n        ' +
      hits.join('\n        ')
  );
});

test('cag_boot 实现必须：证书校验受控降级 + 公钥动态获取 + 不硬编码凭据', () => {
  const abs = path.join(ROOT, 'app/ydpc/cag_boot.js');
  if (!fs.existsSync(abs)) return; // 未启用开机能力时跳过
  const code = stripComments(fs.readFileSync(abs, 'utf8'));

  // ── 证书校验策略（2026-09-23 据真机实测放宽为"受控降级"）──────────────────
  // 实测：CAG 服务端只下发叶证书、无中间 CA → UNABLE_TO_VERIFY_LEAF_SIGNATURE。
  // 同一端点(8899)的 ZTEC 保活走裸 TCP，不经 TLS ⇒ 该端点本非为严格校验设计。
  // 因此允许**仅在证书链缺陷情形**下降级，但必须同时满足四个硬条件：
  //   ① 存在证书链错误码白名单（不得笼统 catch）
  //   ② 降级前必须留证（有警告日志，记录 host + 错误码）
  //   ③ 不得出现"无条件关闭校验"的写法
  //   ④ 仍保留 CERT_NONE 禁令
  assert.ok(
    !/CERT_NONE/.test(code),
    'cag_boot 使用了 CERT_NONE —— 证书校验不可被完全绕过'
  );

  // ① 必须有明确的证书链错误码白名单
  assert.ok(
    /CERT_CHAIN_ERROR_CODES/.test(code) && /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(code),
    'cag_boot 的证书校验降级缺少"证书链错误码白名单"' +
      ' —— 不得笼统捕获所有 TLS 错误后放行'
  );

  // ② 降级必须留证：需要有"证书链验证失败/降级重试"的告警日志
  assert.ok(
    /TLS 证书链验证失败/.test(code) && /降级重试/.test(code),
    'cag_boot 的证书校验降级未留证 —— 每次降级必须打 warning 日志（host + 错误码）'
  );

  // ③ 不得无条件关闭校验：
  //    允许 `rejectUnauthorized = false` 出现在受控分支中，
  //    但必须是由 allowInsecure 这类显式开关驱动，且同一函数内存在严格路径分支。
  const hasAssignFalse = /rejectUnauthorized\s*=\s*false/.test(code);
  if (hasAssignFalse) {
    assert.ok(
      /if\s*\(\s*allowInsecure\s*\)/.test(code),
      'cag_boot 的 rejectUnauthorized=false 未受显式开关（allowInsecure）约束' +
        ' —— 必须保证默认走严格校验路径'
    );
    assert.ok(
      /allowInsecure\s*=\s*false|attempt\s*\(\s*false/.test(code),
      'cag_boot 未见到"严格校验先行"的入口调用 —— 必须默认严格、例外降级'
    );
  }
  // 对象字面量式的无条件关闭仍属违规
  assert.ok(
    !/\{\s*[^}]*rejectUnauthorized\s*:\s*false[^}]*\}/.test(code) ||
      /if\s*\(\s*allowInsecure\s*\)/.test(code),
    'cag_boot 疑似在请求选项中无条件写死 rejectUnauthorized:false'
  );

  assert.ok(
    /cs_sysConfig\.action|sysConfig/.test(code),
    'cag_boot 未通过 cs_sysConfig 动态获取 RSA 公钥，可能退化为硬编码公钥'
  );
  // 关键判定：不得内嵌"带 PEM 头 + 大段 base64 主体"的**完整**公钥字面量。
  // 仅出现 'BEGIN PUBLIC KEY' 字样是允许的 —— 构造 PEM 头的函数必须包含它，
  // 那属于格式封装，不是硬编码公钥本体。
  const embeddedKey = /-----BEGIN[^-]{0,30}PUBLIC KEY-----[\s\S]{100,}-----END/.test(code);
  assert.ok(
    !embeddedKey,
    'cag_boot 内嵌了完整 RSA 公钥字面量（含 PEM 头与 base64 主体）' +
      ' —— 公钥必须从 cs_sysConfig 动态获取'
  );
  assert.ok(
    /getFirmAuth|firmAuth/.test(code),
    'cag_boot 未使用账号自身的 firm-auth 凭据'
  );
});

test('ydpc_client 的开机调用点必须走 cag_boot，而不是 SC 直连', () => {
  const code = stripComments(read('app/ydpc/ydpc_client.js'));
  // 注意：官方 rebootVm 的字符串里含 "bootVm" 子串，会误报，先剔除 rebootVm 再检查
  const noReboot = code.replace(/rebootVm/g, '');
  if (/bootVm\s*\(/.test(noReboot) || /cagBootVm\s*\(/.test(code)) {
    assert.ok(
      /require\s*\(\s*['"][^'"]*cag_boot['"]\s*\)/.test(code),
      'ydpc_client 出现了开机调用点，但未引入 cag_boot 模块 —— 开机必须走 CAG 干净通道'
    );
  }
});

test('scheduler 的移动云开机（若有）必须走 cag_boot', () => {
  const code = stripComments(read('app/tasks/scheduler.js'));
  if (/\bcagBootVm\s*\(/.test(code)) {
    assert.ok(
      /require\s*\(\s*['"][^'"]*cag_boot['"]\s*\)/.test(code),
      'scheduler 出现开机调用点，但未引入 cag_boot 模块'
    );
  }
  assert.ok(!/bootYdpcVmUnified/.test(code), 'scheduler 重新出现 bootYdpcVmUnified 脏入口');
});

// ============================================================================
// 组 8 · ZTE CSAP 加密链路（2026-09-23 补齐协议后新增）
// ----------------------------------------------------------------------------
//   背景：`1000100 用户会话已失效` 的根因是"业务参数放进了 body 而非 query string"，
//   不是平台封禁。补齐了以下几类判据：
//     · 参数全在 query string，body 只发**加密空串**
//     · 恢复 `RspSecurity=1` + 实现 ZTE_Security_Params 的 AES-256-CBC 解密
//     · connectStr 的 AES-128-ECB 二次解密
//     · getToken 的密码用 AES-ECB→Base64→`+`→`%2B` 编码
//
//   本组不只是"形状检查"——直接加载真实模块并**跑加解密往返**，
//   确保算法没写反、填充没写错、密钥没用错。任一环节回归都会变红。
// ============================================================================
group('组 8 · ZTE CSAP 加密链路（参数进 query + 加解密可用）');

const cagBoot = require(path.join(ROOT, 'app/ydpc/cag_boot.js'));

test('ZTE_TRIPLE_KEY：三把对称密钥长度正确（AES-256-CBC / AES-128-ECB）', () => {
  assert.strictEqual(Buffer.byteLength(cagBoot.ZTE_UAS_KEY, 'utf8'), 32, 'UasKey 必须是 32 字节（AES-256）');
  assert.strictEqual(Buffer.byteLength(cagBoot.ZTE_UAS_IV, 'utf8'), 16, 'UasIv 必须是 16 字节');
  assert.strictEqual(Buffer.byteLength(cagBoot.ZTE_CSAP_ID, 'utf8'), 16, 'csapId 必须是 16 字节（AES-128）');
});

test('请求体加密：AES-256-CBC → 大写 hex，且解密可还原（往返一致）', () => {
  const body = { ostype: 10, clienttype: 5, hardware: 25, nettype: 2 };
  const enc = cagBoot.zteEncryptBody(body);
  // 输出必须是**大写** hex（服务端按大写解析）
  assert.ok(/^[0-9A-F]+$/.test(enc), '加密 body 必须是纯大写 hex，实际：' + enc.slice(0, 40));
  assert.strictEqual(enc.length % 32, 0, 'AES block 对齐：hex 长度必须是 32 的整数倍');
  // 反向解密必须还原出**按 key 排序**的 JSON（对应 Python sort_keys=True）
  const back = cagBoot.zteDecryptSecurityParams(enc);
  assert.deepStrictEqual(back, body, 'body 加解密往返必须一致');
});

test('加密空串：ZTE 要求无 body 参数的 action 也发一个非空的加密体', () => {
  const enc = cagBoot.zteEncryptEmptyBody();
  assert.ok(enc && enc.length > 0, '加密空串不得为空 —— 空 body 会被网关判定为未加密');
  assert.ok(/^[0-9A-F]+$/.test(enc), '加密空串必须是大写 hex');
  assert.strictEqual(enc, cagBoot.zteEncryptBody(''), '加密空串应与"加密空字符串"一致');
});

test('stableStringify：字段按字典序排序（顺序错则服务端解不出）', () => {
  const a = cagBoot.stableStringify({ b: 2, a: 1, c: 3 });
  const b = cagBoot.stableStringify({ c: 3, a: 1, b: 2 });
  assert.strictEqual(a, b, '不同键序必须产出同一字符串');
  assert.strictEqual(a, '{"a":1,"b":2,"c":3}', '必须按 key 字典序排序');
});

test('getToken 密码编码：AES-128-ECB → Base64 → 加号转 %2B', () => {
  const enc = cagBoot.zteCsapEncryptQueryValue('p@ssw0rd!');
  assert.ok(enc && enc.length > 0, '密码编码结果不得为空');
  assert.ok(!enc.includes('+'), 'base64 的 "+" 必须已替换为 %2B（否则会被 query 解析成空格）');
  // 必须是合法 base64（去掉 %2B 还原后）
  assert.ok(/^[A-Za-z0-9+/%=]+$/.test(enc), '编码结果必须是 base64 字符集');
  // 同一输入必须稳定（ECB，无 IV）
  assert.strictEqual(enc, cagBoot.zteCsapEncryptQueryValue('p@ssw0rd!'), 'ECB 模式同输入必须同输出');
  // 不同输入必须不同（证明真的加密了，不是透传）
  assert.notStrictEqual(enc, cagBoot.zteCsapEncryptQueryValue('p@ssw0rd?'), '不同密码必须产出不同密文');
});

test('connectStr 解码：AES-128-ECB 解密 → URL decode → 命令行参数解析', () => {
  // 造一个"命令行文本 → URL 转义 → AES-128-ECB 加密 → 大写 hex"的密文，
  // 验证 zteDecodeConnectStr + parseConnectCommand 能还原出参数。
  const cmd = '-k ABCDEFGH --hv6 2409:8c70::25c --proxy-sport 60065 --pv6 5100';
  const key = Buffer.from(cagBoot.ZTE_CSAP_ID, 'utf8');
  const cipher = require('crypto').createCipheriv('aes-128-ecb', key, null);
  const hex = Buffer.concat([
    cipher.update(Buffer.from(encodeURIComponent(cmd), 'utf8')),
    cipher.final()
  ]).toString('hex');

  const decoded = cagBoot.zteDecodeConnectStr(hex);
  assert.strictEqual(decoded, cmd, 'connectStr 解密后必须还原出原始命令行');
  const parsed = cagBoot.parseConnectCommand(decoded);
  assert.strictEqual(parsed.sessionKey, 'ABCDEFGH', '必须解出 -k session-key');
  assert.strictEqual(parsed.spicePort, '60065', '必须解出 --proxy-sport');
  assert.strictEqual(parsed.kcpDestPort, '5100', '必须解出 --pv6');
});

test('响应解密：ZTE_Security_Params（AES-256-CBC）→ 明文 JSON 对象', () => {
  const plain = { result: '0', accessToken: 'tok_123', mesg: 'ok' };
  const sealed = JSON.stringify({ ZTE_Security_Params: cagBoot.zteEncryptBody(plain) });
  const decoded = cagBoot.decodeCagResponse(sealed);
  assert.strictEqual(decoded.decrypted, true, 'ZTE_Security_Params 必须被识别并解密');
  assert.strictEqual(decoded.json.accessToken, 'tok_123', '解密后必须能取到 accessToken');
  assert.strictEqual(decoded.json.result, '0', '解密后必须能取到 result');
});

test('响应解密：明文 JSON 原样通过（兼容不带封装的部署）', () => {
  const decoded = cagBoot.decodeCagResponse(JSON.stringify({ result: '0', rsapub: 'N = AB\nE = 010001' }));
  assert.strictEqual(decoded.decrypted, false, '明文响应不应被标记为已解密');
  assert.strictEqual(decoded.json.result, '0', '明文响应字段必须可读');
});

test('startDesktop 请求：业务参数必须在 query string，不得塞进 body', () => {
  const q = cagBoot.buildConnectDesktopQuery({
    vmId: '41220471',
    vmUserName: 'muyicn',
    accessToken: 'tok_abc',
    identity: { hostName: 'h', mac: 'aa-bb', clientIp: '10.0.0.2', snCode: 'SN1' },
    desktop: { uuid: 'uuid-1', userId: 7, groupId: -1, poolId: 0, connectionType: 0, desktopType: 1 }
  });
  // 1000100 的根因就是参数没进 query —— 这里强制它在
  for (const must of ['accessToken=', 'uuid=', 'vmid=', 'assignRelationtoString=', 'version=', 'RspSecurity=1']) {
    assert.ok(q.includes(must), `startDesktop 的 query 必须包含 ${must}（1000100 的根因就是参数没进 query）`);
  }
  // 参数不得以 body 形式出现
  const body = cagBoot.buildConnectDesktopBody({
    vmId: '41220471', vmUserName: 'muyicn', encryptedPassword: 'x', hostName: 'h', clientIp: 'i'
  });
  assert.ok(!('RspSecurity' in body.body), 'body 中不得出现 RspSecurity（它属于 query）');
});

test('async_query 请求：必须带 accessToken / vmid / RspSecurity 进 query', () => {
  const q = cagBoot.buildAsyncQuery({ vmId: '41220471', accessToken: 'tok_abc' });
  for (const must of ['accessToken=tok_abc', 'vmid=41220471', 'RspSecurity=1']) {
    assert.ok(q.includes(must), `async_query 的 query 必须包含 ${must}`);
  }
});

test('RSA 公钥：ZTE 裸参数（N = hex / E = hex）必须能构造出可用 PEM', () => {
  // 用一对已知 RSA 参数验证 JWK 构造路径没坏
  const { generateKeyPairSync } = require('crypto');
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' });
  const hexOf = (b64) => Buffer.from(b64, 'base64url').toString('hex').toUpperCase();
  const raw = `N = ${hexOf(jwk.n)}\nE = ${hexOf(jwk.e)}`;
  const pem = cagBoot.normalizeRsaPublicKeyPem(raw);
  assert.ok(pem && pem.includes('BEGIN PUBLIC KEY'), 'ZTE 裸参数必须能规整为 PEM');
  // 用该 PEM 实际加密一次，证明公钥可用且填充正确
  const enc = cagBoot.rsaPkcs1Encrypt('secret', pem);
  assert.ok(enc && enc.length > 0, 'PKCS#1 v1.5 加密必须成功');
  assert.strictEqual(Buffer.from(enc, 'base64').length, 256, '2048-bit 密钥的密文必须是 256 字节');
});

test('令牌失效码 1000100 必须被登记为可重试', () => {
  assert.ok(
    cagBoot.CSAP_TOKEN_RETRY_CODES.has('1000100'),
    '1000100 必须登记为可重试 —— 官方归类为 tokenRetry，不是死局'
  );
});

// ============================================================================
// 组 9 · 移动云保活不因"时长耗尽"而熔断（运行中的机器仍要保活）
// ----------------------------------------------------------------------------
//   历史：20 小时限时套餐耗尽后，旧代码用 `isLimitedExpired` 同时卡住了两件事——
//   ① 自动开机（正确：耗尽就不该再拉起）  ② 保活（错误：运行中的机器也不保了）。
//   用户 2026-09-23 明确要求：时长耗尽只熔断"开机/拉起"，不熔断"对运行中机器的保活"。
//   即：在运行中 && 保活开关开 => 即便 20 小时到期，也照常 SOHO 心跳 + CAG 握手。
//
//   断言口径（源码形状级，防再次耦合回去）：
//   - 自动开机闸门必须**仍含** isLimitedExpired（耗尽不拉起，这是对的）；
//   - SOHO 心跳 / CAG 握手两道保活闸门必须**不含** isLimitedExpired（只看 !isVmOff）。
// ============================================================================
group('组 9 · 移动云保活不因"时长耗尽"而熔断（运行中机器仍保活）');

const ydpcCode = stripComments(read('app/ydpc/ydpc_client.js'));

test('自动开机闸门仍须受 isLimitedExpired 约束（耗尽不拉起，方向不可反）', () => {
  // 【2026-09-28】武装判定抽取为 _autoBootArmed 单一入口后闸门形状更新为
  // `isVmOff && this._autoBootArmed(vm) && !isLimitedExpired` —— 护栏强度不变。
  assert.ok(
    /if\s*\(\s*isVmOff\s*&&\s*this\._autoBootArmed\(vm\)\s*&&\s*!isLimitedExpired\s*\)/.test(ydpcCode),
    '自动开机守护必须仍然以 !isLimitedExpired 为闸门 —— 时长耗尽绝不自动拉起'
  );
});

test('控制面保活（SOHO 心跳 + CAG 握手）闸门不得再受 isLimitedExpired 约束（运行中即保活）', () => {
  // 【2026-09-23 合并】SOHO 心跳与 CAG 握手共用一个 controlPlaneKeepalive 开关，出现两处闸门。
  // 【2026-09-23 重构】开关可能先被抽成局部常量（如 `const cpOn = ...controlPlaneKeepalive !== false`）
  // 再用于闸门，因此两种形状都要能识别。护栏强度不变：**定义与每一处闸门的谓词**都不得含
  // isLimitedExpired，且闸门必须至少出现两次（证明同一开关确实统管 SOHO 与 CAG 两个动作）。
  const predicates = [];
  let gateCount = 0;

  // 形状 1：闸门内联开关
  const inlineRe = /if\s*\(\s*this\.account\.features\?\.controlPlaneKeepalive\s*!==\s*false\s*&&\s*([^)]+)\)/g;
  let m;
  while ((m = inlineRe.exec(ydpcCode)) !== null) {
    gateCount++;
    predicates.push(m[1]);
  }

  // 形状 2：开关先落成局部常量，再作为闸门首条件
  const constRe = /const\s+(\w+)\s*=\s*this\.account\.features\?\.controlPlaneKeepalive\s*!==\s*false\s*;/g;
  const constNames = [];
  while ((m = constRe.exec(ydpcCode)) !== null) constNames.push(m[1]);

  for (const name of constNames) {
    const def = ydpcCode.match(new RegExp(`const\\s+${name}\\s*=\\s*[^;]+;`));
    assert.ok(def, `未找到 ${name} 的定义`);
    assert.ok(
      !/isLimitedExpired/.test(def[0]),
      `${name} 的定义不得含 isLimitedExpired —— 运行中机器即使时长耗尽也应保活`
    );
    const gateRe = new RegExp(`if\\s*\\(\\s*${name}\\s*&&\\s*([^)]+)\\)`, 'g');
    let g;
    while ((g = gateRe.exec(ydpcCode)) !== null) {
      gateCount++;
      predicates.push(g[1]);
    }
  }

  assert.ok(gateCount > 0, '未找到控制面保活（controlPlaneKeepalive）闸门（内联或局部常量两种形状都不匹配）');
  for (const p of predicates) {
    assert.ok(
      !/isLimitedExpired/.test(p),
      '控制面保活闸门不得再含 isLimitedExpired —— 运行中机器即使时长耗尽也应保活'
    );
  }
  // 闸门必须出现两次（SOHO 心跳 + CAG 握手各一），证明合并开关同时统管两个动作
  assert.ok(gateCount >= 2, `controlPlaneKeepalive 闸门应至少出现 2 次（SOHO + CAG），实际 ${gateCount}`);
});

test('MQTT 保活不得再因时长耗尽而整体关闭（只剩关机/开关闸门）', () => {
  // ensureMqttConnection 的 allOffOrDisabled 谓词只应保留 isVmOff 与 keepaliveEnabled
  const m = ydpcCode.match(/const allOffOrDisabled[\s\S]*?vms\.every\([\s\S]*?\{\s*([\s\S]*?)\s*\}\);/);
  assert.ok(m, '未找到 MQTT 的 allOffOrDisabled 谓词');
  assert.ok(
    !/isLimitedExpired/.test(m[1]),
    'MQTT 谓词不得再含 isLimitedExpired —— 时长耗尽不应关闭对运行中机器的 MQTT 保活'
  );
});

// ============================================================================
// 组 10 · 数据面保活不得在「时长耗尽」机器上无限循环
// ----------------------------------------------------------------------------
//   背景：时长耗尽的机器，网关拒绝下发 connectStr（cs_startDesktop 返回
//   "当前计费周期时长已用完"），数据面保活永远建立不起来。旧实现没检查这一点，
//   导致数据面任务进入「30s 重试 → 报错 → 30s 重试」的无限循环刷屏。
//   用户 2026-09-23 明确指出：到期机器不该循环报错，应停止，等运行中再开。
//
//   正确语义：时长耗尽 → 不做数据面（改走控制面保活，见组 9）；遇耗尽错误 → 停止任务。
// ============================================================================
group('组 10 · 数据面保活不得在时长耗尽机器上无限循环');

test('数据面调度必须排除时长耗尽的机器（耗尽则网关拒绝 connectStr）', () => {
  const m = ydpcCode.match(
    /const wantOn = this\.account\.features\?\.dataPlaneKeepalive[\s\S]*?;/
  );
  assert.ok(m, '未找到数据面调度的 wantOn 判定');
  assert.ok(
    /isVmLimitedExpired/.test(m[0]),
    '数据面调度 wantOn 必须含 isVmLimitedExpired —— 时长耗尽机器拿不到 connectStr，不应数据面保活'
  );
});

test('数据面任务遇时长耗尽错误必须停止（不得 30s 无限重试）', () => {
  // catch 里必须存在"if (exhausted) { ... break; }"分支，且"30s 后重试"只留给非耗尽错误
  const exhaustedBreak = /if\s*\(\s*exhausted\s*\)[\s\S]*?break;/.test(ydpcCode);
  assert.ok(
    exhaustedBreak,
    '数据面任务的 catch 必须在时长耗尽错误时 break —— 不得无限 30s 重试刷屏'
  );
  assert.ok(
    /耗尽，数据面保活无法建立/.test(ydpcCode),
    '耗尽停止时必须有明确日志说明（改由控制面保活接管）'
  );
});

test('时长恢复时应清除耗尽标记（避免 _durationExhausted 永久卡住）', () => {
  assert.ok(
    /remainHours > 0\)[\s\S]{0,120}?vm\._durationExhausted = false/.test(ydpcCode),
    'refreshVms 必须在时长恢复（remainHours>0）时清除 _durationExhausted'
  );
  assert.ok(
    /vm\._durationExhausted = false[\s\S]{0,120}?vm\._hasWarnedExhausted = false/.test(ydpcCode),
    '时长恢复时也必须复位 _hasWarnedExhausted —— 否则"时长已用完"提示从此再也不会出现'
  );
});

// 【2026-09-24 真实故障 · 用户可见】"已关机（未开启自动开机守护），本次不自动拉起"
// 这条提示**每分钟刷一条**（实测单日 8 次/台，间隔稳定 60~61 秒）。
//
// 机理：该提示本身**有**去重标记 `_hasNotifiedOff`，闸门也写对了；问题出在
// `refreshVms` 的差量合并（Diff-Merge）**逐字段列举**要保留的本机状态
// （keepaliveEnabled / lastKeepAliveAt / autoBootEnabled / vendor* / _lastAutoBootAt …），
// 而 `_hasNotifiedOff` / `_hasNotifiedBooting` / `_hasWarnedExhausted` 三个去重标记
// **不在名单里** → 每次刷新重建 vm 对象后标记被清空 → 下一轮保活又满足闸门 → 重复打印。
//
// 修法：按 `_` 前缀**泛化**保留（约定：`_` 前缀 = 本系统自用运行时状态，不来自接口响应），
// 从机制上杜绝"新增一个本机状态字段又忘了加进白名单"。
// 与组 13 同源：**"白名单漏列字段"是静默缺陷的通用形态**，必须机制化消除而非逐次补漏。
test('refreshVms 差异合并必须泛化保留 `_` 前缀的本机运行时状态', () => {
  const merge = ydpcCode.match(/const oldVmsMap = new Map\([\s\S]*?\n {6}\}/);
  assert.ok(merge, '未找到 refreshVms 的差量合并块');

  const body = merge[0];
  assert.ok(
    /for\s*\(\s*const\s+k\s+of\s+Object\.keys\(old\)\s*\)[\s\S]{0,200}?k\.startsWith\('_'\)[\s\S]{0,120}?vm\[k\]\s*=\s*old\[k\]/.test(body),
    '合并块必须按 `_` 前缀泛化保留本机状态 —— 逐字段列举一旦漏项（如 _hasNotifiedOff），' +
    '去重标记就会被每次刷新清空，提示退化成每轮刷屏'
  );

  // 泛化保留必须排在"时长恢复复位"之前，否则会把刚清掉的 _durationExhausted 又还原回来
  const iGeneric = body.search(/k\.startsWith\('_'\)/);
  const iReset = body.search(/vm\._durationExhausted = false/);
  assert.ok(
    iGeneric >= 0 && iReset > iGeneric,
    '泛化保留必须先于 remainHours>0 的复位，否则复位结果会被覆盖（耗尽标记永久卡住）'
  );

  // 去重闸门本身必须还在：提示只能是"状态变化时一次"，不能一辈子只提示一次
  assert.ok(
    /if\s*\(isVmOff\s*&&\s*!vm\._hasNotifiedOff\)/.test(ydpcCode),
    '关机提示必须以 _hasNotifiedOff 为闸门（同一次关机期间只提示一次）'
  );
  assert.ok(
    /if\s*\(!isVmOff\)[\s\S]{0,200}?vm\._hasNotifiedOff = false/.test(ydpcCode),
    '机器恢复运行中时必须复位 _hasNotifiedOff —— 否则再次关机将永远不再提示（丢证据）'
  );
});

// ============================================================================
// 组 11 · 保活"有效性"必须可观测：日志落盘 + 独立核验告警
// ----------------------------------------------------------------------------
//   背景（2026-09-23 ZTE样本主号事件）：永久版云电脑自行关机，但事后**无从复盘**——
//   运行日志只存在内存数组里，服务一重启就全丢；同时系统没有任何自动机制能发现
//   "保活其实没生效"：数据面 `hb_recv > 0` 只证明管道通（zte_cag_raw.js 的 onData
//   连内容都不校验），唯一可信判据是**独立查询到的电源状态**。
//
//   本组固化三条结构性约束：
//   ① 日志必须落盘，且**落盘先于折叠**（磁盘留原始流水，折叠只作 UI 优化）；
//   ② "运行中 → 已关机"必须变成显式告警（高亮日志 + 推送通知），不得只是悄悄改状态；
//   ③ 保活效果核验必须**自动**挂进保活循环，且不得把"本就该关机"的机器算作失败。
// ============================================================================
group('组 11 · 保活有效性可观测（日志落盘 + 独立核验告警）');

const persistLogCode = read('app/persist_log.js');

test('appendLog 必须"落盘先于折叠"（磁盘保原始流水，折叠只作 UI 优化）', () => {
  const m = server.match(/function appendLog\([\s\S]*?\n\}/);
  assert.ok(m, '未找到 appendLog 函数');
  const body = m[0];
  const iP = body.indexOf('logPersister.append(entry)');
  const iI = body.indexOf('ingestLogEntry(entry)');
  assert.ok(iP >= 0, 'appendLog 必须调用 logPersister.append(entry) 落盘');
  assert.ok(iI >= 0, 'appendLog 必须调用 ingestLogEntry(entry) 入内存');
  assert.ok(iP < iI, '落盘必须先于折叠 —— 否则被折叠掉的原始流水将永久丢失，无法事后取证');
});

test('日志落盘器必须被初始化，且启动时从磁盘回灌历史', () => {
  assert.ok(/logPersister\.init\(\)/.test(server), '必须调用 logPersister.init()');
  assert.ok(/function bootstrapLogsFromDisk\(/.test(server), '必须实现 bootstrapLogsFromDisk');
  const li = server.indexOf('server.listen(');
  const bi = server.indexOf('= bootstrapLogsFromDisk()');
  assert.ok(li >= 0 && bi > li, '启动时必须回灌历史日志，否则重启后控制台空白、故障无法复盘');
});

test('日志必须按日期滚动且有保留上限（不得无限增长）', () => {
  assert.ok(/retentionDays/.test(persistLogCode), '落盘器必须有保留天数');
  assert.ok(/prune\(\)/.test(persistLogCode) && /unlinkSync/.test(persistLogCode), '必须有超期清理（prune + unlinkSync）');
  assert.ok(/beijingDateString/.test(persistLogCode), '文件名必须按北京日期切分');
});

test('落盘失败必须降级为仅内存，不得让磁盘问题拖垮主流程', () => {
  assert.ok(
    /catch[\s\S]{0,240}this\.enabled = false/.test(persistLogCode),
    '落盘异常必须把 enabled 置 false 降级，而不是把异常抛进主流程'
  );
});

test('"运行中 → 已关机"必须变成显式告警（不能只是悄悄改状态）', () => {
  assert.ok(/detectKeepAliveFailure\s*\(/.test(ydpcCode), 'ydpc_client 必须实现 detectKeepAliveFailure');
  assert.ok(/this\.detectKeepAliveFailure\(vms, accName\)/.test(ydpcCode), 'refreshVms 必须调用失效检测');
  assert.ok(
    /wasOff === false && isOff && expectedRunning/.test(ydpcCode),
    '失效告警必须以「运行中→已关机」转移为触发条件（独立电源状态），不得靠保活自证'
  );
  assert.ok(/isYdpcVmOff\(vm\)/.test(ydpcCode), '必须使用 isYdpcVmOff 判定电源状态');
});

test('失效告警必须推送通知，且不得把"本就该关机"的机器算作失败', () => {
  const m = ydpcCode.match(/detectKeepAliveFailure\(vms, accName\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 detectKeepAliveFailure 实现');
  assert.ok(/this\.sendNotification\(/.test(m[0]), '失效告警必须推送通知（不能只写日志）');
  assert.ok(
    /keepaliveEnabled !== false && !this\.isVmLimitedExpired\(vm\)/.test(m[0]),
    'expectedRunning 必须排除保活关闭 / 时长耗尽的机器，否则会永久误报'
  );
});

test('保活效果核验必须自动挂进保活循环（不是只挂手动 API）', () => {
  assert.ok(/startEffectWatchdog\s*\(/.test(ydpcCode), 'ydpc_client 必须实现 startEffectWatchdog');
  const m = ydpcCode.match(/startKeepAliveWorker\(\) \{[\s\S]*?\n\s*const TICK_INTERVAL_MS/);
  assert.ok(m, '未找到 startKeepAliveWorker 起始段');
  assert.ok(/this\.startEffectWatchdog\(\)/.test(m[0]), '保活循环启动时必须自动挂上效果核验看门狗');
  assert.ok(
    /clearTimeout\(this\._effectWatchTimer\)/.test(ydpcCode),
    '停保活时必须清掉核验定时器（否则停保活后仍在打接口）'
  );
});

test('独立核验的判定范围必须只看"预期应在运行"的机器', () => {
  const m = ydpcCode.match(/const expectedIds = new Set\([\s\S]*?\);/);
  assert.ok(m, '未找到独立核验的 expectedIds 过滤');
  assert.ok(
    /isVmLimitedExpired/.test(m[0]) && /keepaliveEnabled !== false/.test(m[0]),
    '核验范围必须排除时长耗尽 / 保活关闭的机器，否则正常账号也会永远核验红灯'
  );
  assert.ok(/lastSnap\.total > 0/.test(ydpcCode), '空范围不得被判为"通过"（避免空集真值）');
});

test('折叠路径不得残留已被重构掉的 inferredPlatform 变量（会直接 ReferenceError）', () => {
  const body = stripComments(server);
  assert.ok(
    !/inferredPlatform/.test(body),
    'appendLog 重构后平台归属由 buildLogEntry 统一推断（inferLogPlatform），' +
    '折叠分支若残留 inferredPlatform 会在运行时 ReferenceError'
  );
  const m = body.match(/function appendLog\([\s\S]*?\n\}/);
  assert.ok(m && /logPersister\.append\(entry\)/.test(m[0]), 'appendLog 必须落盘');
});

test('落盘器行为验证：写入 → 回灌 → 保留清理', () => {
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctyun-log-'));
  try {
    const { LogPersister } = require(path.join(ROOT, 'app', 'persist_log.js'));
    const p = new LogPersister({ dir: tmp, retentionDays: 7 });
    assert.strictEqual(p.init(), true, '落盘器初始化应成功');
    assert.ok(fs.existsSync(tmp), '日志目录应被创建');

    for (let i = 1; i <= 5; i++) {
      const ok = p.append({
        id: 'x' + i, timestamp: '2026-09-23 10:00:0' + i, source: 'Test',
        message: 'm' + i, level: 'info', accountName: '', platform: 'ctyun', repeatCount: 1
      });
      assert.strictEqual(ok, true, `第 ${i} 条应写入成功`);
    }
    const back = p.loadRecent(10);
    assert.strictEqual(back.length, 5, `应回灌出 5 条，实际 ${back.length}`);
    assert.strictEqual(back[0].message, 'm1', '回灌顺序必须为时间升序');
    assert.strictEqual(back[4].message, 'm5', '最后一条应为最新');
    assert.strictEqual(p.loadRecent(2).length, 2, 'loadRecent 必须遵守 maxLines 上限');
    assert.ok(p.currentFile().includes('dashboard-'), 'currentFile 必须落在约定命名上');

    // 保留策略：塞一个超期文件，prune 必须删掉它
    const stale = path.join(tmp, 'dashboard-2020-01-01.jsonl');
    fs.writeFileSync(stale, '{"message":"stale"}\n', 'utf8');
    p.prune();
    assert.strictEqual(fs.existsSync(stale), false, '超期日志文件必须被清理');
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败忽略 */ }
  }
});

// ============================================================================
// 组 12 · 移动云多机状态必须"按主机维度"呈现
// ----------------------------------------------------------------------------
// 用户实测症状：移动云账号卡片上「当前动作」长期定格在「保活巡检待命中」。
//
// 两个独立的结构性根因（本组逐条守住）：
//   ① 该文案是**账号级**的 —— 一个账号下多台云电脑（如ZTE样本主号下 2 台）状态可以完全
//      不同（一台运行中在巡检、一台已关机），单行文案在结构上就表达不了；
//   ② 它只在"全部关机"分支里被写过 —— 机器正常运行时永不刷新，于是永远停在初始值。
//
// 因此本组要求：
//   - 后端必须提供**只读、按主机**的状态视图 describeVmKeepAlive(vm)（现算倒计时）；
//   - 后端必须按 userServiceId 记录每台主机最近动作（vmActions，仅内存、不落盘）；
//   - 账号级摘要必须**在运行态也刷新**，不得退回固定文案；
//   - server.js 必须把视图逐台下发；前端移动云卡片必须逐台渲染，
//     **不得回退成账号级单行**，同时**天翼云侧一个字节都不许被改动**。
// ============================================================================
group('组 12 · 移动云多机状态必须按主机维度呈现');

// app.js 参与断言；沙箱缺失时置空串，让相关断言给出明确失败信息而不是整脚本崩溃
let appJs = '';
try { appJs = read('app/static/app.js'); } catch (e) { appJs = ''; }

/** 从 ydpc_client.js 抽取纯函数式方法 + isYdpcVmOff，装配成可真实调用的原型对象 */
function loadYdpcHarness() {
  const isOffSrc = ydpcCode.match(/function isYdpcVmOff\(vm\) \{[\s\S]*?\n\}/);
  assert.ok(isOffSrc, '无法抽取 isYdpcVmOff');
  const names = ['describeVmKeepAlive', 'buildYdpcSummaryText', 'isVmLimitedExpired', '_autoBootArmed'];
  const parts = names.map((n) => {
    const m = ydpcCode.match(new RegExp(`${n}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}`));
    assert.ok(m, `无法从 ydpc_client.js 抽取 ${n}`);
    return m[0];
  });
  const src = `${isOffSrc[0]}
class Harness {
${parts.map((p) => '  ' + p.split('\n').join('\n  ')).join('\n')}
}
return Harness.prototype;`;
  // eslint-disable-next-line no-new-func
  return new Function(src)();
}

/**
 * 状态视图的行为调用上下文。
 * isVmLimitedExpired 直接注入**源码里的真实实现**（不写 mock）—— mock 会掩盖真实判定逻辑，
 * 让"时长耗尽"这类分支的断言变成自证（本组第一版就是这么被护栏抓出来的）。
 */
function makeViewCtx(proto, overrides = {}) {
  return {
    account: {
      keepaliveInterval: 600,
      features: {
        keepAlive: true, controlPlaneKeepalive: true, mqttKeepAlive: true,
        dataPlaneKeepalive: true, autoBoot: false, ...(overrides.features || {})
      }
    },
    metrics: { vmActions: overrides.vmActions || {} },
    isVmLimitedExpired: proto.isVmLimitedExpired,
    // 【2026-09-28】守护武装判定同样注入源码真实实现（describeVmKeepAlive 内部会调用它）
    _autoBootArmed: proto._autoBootArmed,
    isDataPlaneActive() { return overrides.dataPlaneActive === true; }
  };
}

test('ydpc_client 必须提供"按主机维度"的状态视图 describeVmKeepAlive', () => {
  assert.ok(
    /describeVmKeepAlive\s*\(\s*vm\s*\)/.test(ydpcCode),
    '必须实现 describeVmKeepAlive(vm)：多机状态差异只能逐台描述，账号级单行在结构上表达不了'
  );
  assert.ok(/_recordVmAction\s*\(/.test(ydpcCode), '必须实现/调用 _recordVmAction 记录单机最近动作');
  assert.ok(/vmActions/.test(ydpcCode), '必须有以 userServiceId 为键的单机动作表');
});

test('按主机视图必须只读：不得落盘、不得打日志、不得发通知（它每次序列化都会跑）', () => {
  const m = ydpcCode.match(/describeVmKeepAlive\(vm\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 describeVmKeepAlive 实现');
  assert.ok(
    !/saveConfig|appendLog|sendNotification|_recordVmAction/.test(m[0]),
    'describeVmKeepAlive 必须是纯推导（只读）—— 它会被 /api/accounts 反复调用，带副作用会刷盘/刷日志'
  );
});

test('单机动作表只应存内存，不得写进账号配置', () => {
  const m = ydpcCode.match(/_recordVmAction\(usid[^)]*\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 _recordVmAction 实现');
  assert.ok(/this\.metrics\.vmActions/.test(m[0]), '_recordVmAction 必须写入 metrics.vmActions');
  assert.ok(
    !/saveConfig|this\.account\./.test(m[0]),
    '_recordVmAction 不得碰账号配置：临时文案写进 config.json 会在重启后变成过期假象'
  );
});

test('【根因】账号级摘要必须在"机器仍在运行"时也刷新（否则永远停在「保活巡检待命中」）', () => {
  assert.ok(/buildYdpcSummaryText\(\)/.test(ydpcCode), '必须实现账号级摘要 buildYdpcSummaryText()');
  const branch = ydpcCode.match(/if \(!anyRunning\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,200}?buildYdpcSummaryText\(\)/);
  assert.ok(
    branch,
    'refreshVms 原先只在「全部关机」时写 lastHeartbeatResult，机器运行时永不刷新 → ' +
    '界面永远显示「保活巡检待命中」。必须在 else（仍有机在运行）分支里也刷新账号级摘要'
  );
  const calls = (ydpcCode.match(/=\s*this\.buildYdpcSummaryText\(\)/g) || []).length;
  assert.ok(calls >= 2, `账号级摘要应在 refreshVms 与巡检循环两处刷新，实际 ${calls} 处`);
});

test('行为：同一账号下两台状态不同的主机，必须得到不同的「当前动作」文案', () => {
  const proto = loadYdpcHarness();
  const now = Date.now();

  const ctxA = makeViewCtx(proto, { vmActions: { 1001: { text: '✅ 保活巡检完成 · SOHO 心跳 + CAG 握手', level: 'ok', at: now } } });
  const a = proto.describeVmKeepAlive.call(ctxA, {
    userServiceId: '1001', vmName: '西安A', vmStatus: '运行中', vmStatusCode: 1,
    keepaliveEnabled: true, lastKeepAliveAt: now - 60 * 1000
  });

  const ctxB = makeViewCtx(proto);
  const b = proto.describeVmKeepAlive.call(ctxB, {
    userServiceId: '1002', vmName: '西安B', vmStatus: '已关机', vmStatusCode: 23,
    keepaliveEnabled: true, remainText: '♾️ 永久'
  });

  assert.strictEqual(a.running, true, 'A 应被判定为运行中');
  assert.strictEqual(b.running, false, 'B 应被判定为已关机');
  assert.strictEqual(a.tone, 'ok', `A 的正常保活基调应为 ok，实际 ${a.tone}`);
  assert.strictEqual(b.tone, 'off', `B 的已关机基调应为 off，实际 ${b.tone}`);
  assert.ok(a.lastActionText.includes('SOHO 心跳'), 'A 必须带出该机最近一次实际动作');
  assert.ok(a.nextDueAt > now, 'A 的"距下次巡检"必须由单机时间戳 + 单机周期推算');
  assert.notStrictEqual(
    a.actionText, b.actionText,
    '两台状态不同的主机给出了同一个「当前动作」—— 这正是本次要修的问题'
  );
});

test('行为：单机保活关闭 / 时长耗尽 / 数据面在场 必须给出各自的状态（不得都落到默认值）', () => {
  const proto = loadYdpcHarness();
  const now = Date.now();
  const runningVm = (extra = {}) => ({
    userServiceId: '9', vmName: 'X', vmStatus: '运行中', vmStatusCode: 1,
    keepaliveEnabled: true, remainText: '♾️ 永久', lastKeepAliveAt: now - 60 * 1000, ...extra
  });

  const off = proto.describeVmKeepAlive.call(makeViewCtx(proto), runningVm({ keepaliveEnabled: false }));
  assert.strictEqual(off.tone, 'off', '单机保活关闭应为 off 基调');
  assert.ok(off.actionText.includes('单机保活已关闭'), `实际: ${off.actionText}`);

  const exhausted = proto.describeVmKeepAlive.call(makeViewCtx(proto), {
    userServiceId: '9', vmName: 'X', vmStatus: '已关机', vmStatusCode: 23,
    keepaliveEnabled: true, durationMode: 'limited', remainHours: 0, remainText: '⏱️ 0小时'
  });
  assert.strictEqual(exhausted.tone, 'warn', '时长耗尽应为 warn 基调（不是普通的已关机）');
  assert.ok(exhausted.actionText.includes('时长耗尽'), `实际: ${exhausted.actionText}`);

  const dp = proto.describeVmKeepAlive.call(makeViewCtx(proto, { dataPlaneActive: true }), runningVm());
  assert.ok(dp.actionText.includes('数据面'), `数据面在场时当前动作应体现数据面，实际: ${dp.actionText}`);

  // 反证：把 isVmLimitedExpired 换回"只认 _durationExhausted"的粗 mock 时，
  // 上面的耗尽用例就会退化 —— 固定住这一点，防止后人把真实实现又换成 mock
  const looseMock = {
    ...makeViewCtx(proto),
    isVmLimitedExpired: (vm) => vm._durationExhausted === true
  };
  const loose = proto.describeVmKeepAlive.call(looseMock, {
    userServiceId: '9', vmName: 'X', vmStatus: '已关机', vmStatusCode: 23,
    keepaliveEnabled: true, durationMode: 'limited', remainHours: 0, remainText: '⏱️ 0小时'
  });
  assert.notStrictEqual(
    loose.tone, 'warn',
    '时长耗尽判定必须来自源码真实实现：换回粗 mock 后该用例不再能证明任何事'
  );
});

test('行为：账号级摘要必须反映"几台运行中 / 几台已关机 / 几台关闭保活"（不得退回固定文案）', () => {
  const proto = loadYdpcHarness();
  const text = proto.buildYdpcSummaryText.call({
    account: {
      vms: [
        { userServiceId: '1', vmStatus: '运行中', vmStatusCode: 1, keepaliveEnabled: true },
        { userServiceId: '2', vmStatus: '已关机', vmStatusCode: 23, keepaliveEnabled: true },
        { userServiceId: '3', vmStatus: '运行中', vmStatusCode: 1, keepaliveEnabled: false }
      ]
    }
  });
  assert.ok(text.includes('1 台运行中'), `摘要必须写出运行中台数，实际: ${text}`);
  assert.ok(text.includes('1 台已关机'), `摘要必须写出已关机台数，实际: ${text}`);
  assert.ok(text.includes('1 台单机保活关闭'), `摘要必须写出关闭保活的台数，实际: ${text}`);
});

test('server.js 必须逐台下发 keepAliveView，且单机视图计算失败不得打挂整个接口', () => {
  assert.ok(/keepAliveView/.test(server), 'server.js 必须在序列化时给每台移动云主机挂上 keepAliveView');
  assert.ok(
    /client\.describeVmKeepAlive\(vm\)/.test(server),
    '状态视图必须由 client（Node 侧状态所有者）现算，不得在前端猜'
  );
  assert.ok(
    /catch \(e\) \{ keepAliveView = null; \}/.test(server),
    '单机视图计算异常必须静默降级为 null —— 否则一台机器算错就让 /api/accounts 整体 500'
  );
});

test('前端必须按主机渲染移动云「当前动作」，且消费后端下发的视图', () => {
  assert.ok(/function buildYdpcVmMonitorHtml\(/.test(appJs), '必须实现 buildYdpcVmMonitorHtml(acc)');
  assert.ok(/vm\.keepAliveView/.test(appJs), '前端必须消费后端下发的 vm.keepAliveView，不得自行臆造状态');
  assert.ok(
    /id="acc-vm-actions-\$\{acc\.id\}"/.test(appJs),
    '移动云卡片必须有逐台渲染容器 acc-vm-actions'
  );
  assert.ok(
    /acc-vm-actions-\$\{acc\.id\}/.test(appJs) && /vmActionsEl\.innerHTML = buildYdpcVmMonitorHtml\(acc\)/.test(appJs),
    '5 秒轮询的原地更新必须刷新 acc-vm-actions 容器（否则多机状态只在整卡重绘时更新）'
  );
});

test('移动云不得回退成账号级单行动作；天翼云侧必须保持原样', () => {
  const c = (appJs.match(/acc-hb-text-/g) || []).length;
  assert.strictEqual(
    c, 2,
    `acc-hb-text 只应存在于天翼云（卡片渲染 + 原地更新各 1 处），实际 ${c} 处。` +
    '移动云若回退成账号级单行，多机状态差异将再次无法表达'
  );
  assert.ok(/acc-host-\$\{acc\.id\}/.test(appJs), '天翼云「目标设备」行必须保留（本次改动不得触碰天翼侧）');
  assert.ok(/acc-success-count-\$\{acc\.id\}/.test(appJs), '天翼云「当日成功轮次」必须保留');
  assert.ok(/targetDeviceDisplay/.test(appJs), '天翼云多机目标设备展示必须保留');
});

test('移动爱家 ZTEC 监视行不得再显示运行状态徽章（与「名下云主机」重复）', () => {
  const yStart = appJs.indexOf('function buildYdpcVmMonitorHtml(');
  const yEnd = appJs.indexOf('// 📡 移动公众：分层保活状态渲染');
  assert.ok(yStart > -1 && yEnd > yStart, '无法定位移动爱家逐台渲染器（结构已变，请同步本断言）');
  const yMon = appJs.slice(yStart, yEnd);
  assert.ok(
    !/运行中' : '已关机/.test(yMon),
    'ZTEC 握手与心跳监视行不得再渲染「运行中 / 已关机」徽章 —— 用户 2026-09-24：与「名下云主机」列表重复'
  );
  assert.ok(
    /运行中' : '已关机/.test(appJs),
    '「名下云主机」列表仍必须保留运行状态徽章（删的只是监视行那一处，不是全部）'
  );
});

// ============================================================================
// 组 13 · 保活循环"必须真的跑起来"（启动崩溃 + 网络无超时导致的静默停摆）
// ----------------------------------------------------------------------------
// 2026-09-23 实测事故（用户现象："移动云心跳保活日志一条都没有"）：
//
//   `EFFECT_VERIFY_INTERVAL_MS` 等三个常量**只被引用、从未定义**，却用作
//   `startEffectWatchdog()` 的默认参数值 → 无参调用即抛 ReferenceError。
//   而它的调用点在 `startKeepAliveWorker()` 里、打完"看门狗已启动"日志并把
//   `workerRunning` 置为 true **之后**、`setTimeout(runCycle, 2000)` **之前**：
//     ① 保活循环从未被排程 → 该账号下所有主机彻底不保活；
//     ② `if (this.workerRunning) return;` 守卫让每 5 秒的 /api/accounts 轮询也无法自愈；
//     ③ 只剩一条"看门狗已启动"日志，其余全静默 —— 与实测日志逐字吻合。
//
// 本组同时守住第二类同源缺陷：`soho_client.js` 出网请求零超时。保活循环把
// `await refreshVms()` 串在每轮开头，refreshVms 内部可能串行发 4~5 个 SOHO 请求，
// 一次"连上但不回包"的抖动就能让整账号静默停摆 20~30 分钟。
//
// 关键教训：这类缺陷**静态断言看不见**（符号存在、语法正确），必须真实执行启动流程。
// 因此本组含行为断言（组 13 也是引入 tests/regression.test.js 异步断言能力的起因）。
// ============================================================================
group('组 13 · 保活循环必须真的跑起来（启动崩溃 + 网络无超时）');

let sohoCode = '';
try { sohoCode = read('app/ydpc/soho_client.js'); } catch (e) { sohoCode = ''; }

test('核验看门狗的节拍常量必须被真正定义（只引用不定义 = 启动即 ReferenceError）', () => {
  for (const n of ['EFFECT_VERIFY_INTERVAL_MS', 'EFFECT_VERIFY_FIRST_DELAY_MS', 'EFFECT_VERIFY_SAMPLE_SEC']) {
    assert.ok(
      new RegExp(`const\\s+${n}\\s*=`).test(ydpcCode),
      `${n} 被引用但从未定义 —— startEffectWatchdog() 默认参数求值会抛 ReferenceError，` +
      '把 startKeepAliveWorker() 打断在"日志已打、循环未排程"的僵尸状态'
    );
  }
  // 注：更一般的守卫是下方的行为断言（真实执行启动流程），它能抓到任意同类的运行期错误。
});

test('附加能力（核验看门狗）失败不得拖垮保活主循环，且启动失败必须复位 workerRunning', () => {
  const m = ydpcCode.match(/startKeepAliveWorker\(\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 startKeepAliveWorker 实现');
  assert.ok(
    /try \{[\s\S]{0,160}?this\.startEffectWatchdog\(\)[\s\S]{0,260}?\} catch \(e\) \{/.test(m[0]),
    'startEffectWatchdog() 必须被 try/catch 兜住 —— 它是附加能力，坏掉绝不能让主保活循环启动失败'
  );
  assert.ok(
    /\} catch \(err\) \{[\s\S]{0,700}?this\.workerRunning = false;/.test(m[0]),
    '启动流程抛错时必须复位 workerRunning，否则 `if (this.workerRunning) return;` 守卫会让该账号永久无法再启动保活'
  );
});

test('soho_client 所有出网请求必须带主动超时（超时封装之外不得出现裸 fetch）', () => {
  const helper = sohoCode.match(/async function fetchWithTimeout\([\s\S]*?\n\}/);
  assert.ok(helper, '未找到 fetchWithTimeout 实现 —— SOHO 请求必须统一走带超时的封装');
  assert.ok(
    /AbortSignal\.timeout\(/.test(helper[0]),
    'fetchWithTimeout 必须用 AbortSignal.timeout 兜底；裸 fetch 的默认超时是 5 分钟，足以让保活静默停摆'
  );
  // 剥离注释后再扫（注释里的 "Node fetch(undici)" 会被正则误判为裸调用——测试自身缺陷，已修）。
  const outside = stripLineComments(sohoCode.split(helper[0]).join('\n'));
  const bare = outside.match(/[^a-zA-Z0-9_$]fetch\s*\(/g) || [];
  assert.strictEqual(
    bare.length, 0,
    `soho_client 在超时封装之外仍有 ${bare.length} 处裸 fetch —— 一次"连上但不回包"的抖动` +
    '就能让该账号下所有主机的保活静默停摆 20~30 分钟（无错误、无日志、lastKeepAliveAt 冻结）'
  );
  assert.ok(
    /module\.exports = \{[\s\S]*?fetchWithTimeout[\s\S]*?\};/.test(sohoCode),
    'fetchWithTimeout 必须导出，便于测试与跨模块复用'
  );
});

testAsync('行为：startKeepAliveWorker() 必须真的把保活循环排上（不得抛错后静默卡死）', async () => {
  const { YdpcClient } = require(path.join(ROOT, 'app', 'ydpc', 'ydpc_client.js'));
  const account = {
    id: 'regression-probe', platform: 'ydpc', name: '回归探针', user: 'probe',
    keepaliveInterval: 600,
    features: {
      keepAlive: true, controlPlaneKeepalive: true, mqttKeepAlive: true,
      dataPlaneKeepalive: true, autoBoot: false
    },
    vms: [{ userServiceId: '1', vmName: 'A', vmStatus: '运行中', vmStatusCode: 1 }]
  };
  const logs = [];
  const client = new YdpcClient(account, {
    appendLog: (src, msg) => { logs.push(`${src}:${msg}`); },
    sendNotification: () => {},
    saveConfig: () => {}
  });

  let threw = null;
  try {
    client.startKeepAliveWorker();
  } catch (e) {
    threw = e;
  }

  try {
    assert.strictEqual(
      threw, null,
      `启动保活看门狗抛错：${threw && threw.message} —— 这会让整个账号的保活静默停摆`
    );
    assert.strictEqual(client.workerRunning, true, 'workerRunning 必须为 true');
    assert.ok(
      client.loopTimer,
      '保活循环必须被排程（loopTimer 为空 = runCycle 从未排上，保活完全不工作）'
    );
    assert.ok(client._effectWatchTimer, '保活效果核验看门狗也应被排程');
    assert.ok(
      logs.some((l) => l.includes('看门狗已启动')),
      '应留下"看门狗已启动"日志（否则用户无从判断保活是否真的在跑）'
    );
  } finally {
    client.stopKeepAliveWorker();
  }
});

testAsync('行为：fetchWithTimeout 对"连上但不回包"的服务端必须在超时内抛错且可诊断', async () => {
  const http = require('http');
  const { fetchWithTimeout } = require(path.join(ROOT, 'app', 'ydpc', 'soho_client.js'));

  // 本地故意不响应的服务端：模拟"TCP 连上了但网关不回包"
  const server = http.createServer(() => { /* 故意不响应 */ });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/never-responds`;

  const started = Date.now();
  let err = null;
  // 用 Promise.race 给断言本身加硬上限：若"主动超时"被移除，被断言对象会一直挂着，
  // 绝不能让整个测试网跟着挂住（否则变异验证会卡到 undici 默认的 300s）。
  const outcome = await Promise.race([
    fetchWithTimeout(url, { method: 'GET' }, 300).then(
      () => 'RESOLVED',
      (e) => { err = e; return 'REJECTED'; }
    ),
    new Promise((resolve) => setTimeout(() => resolve('HARD_TIMEOUT'), 5000))
  ]);
  const elapsed = Date.now() - started;

  try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) { /* 忽略 */ }
  try { server.close(); } catch (e) { /* 忽略 */ }

  assert.strictEqual(
    outcome, 'REJECTED',
    `5 秒内仍未抛错（实际 ${elapsed}ms）—— 说明主动超时没有生效，` +
    '保活循环会被这类"连上但不回包"的请求静默挂死'
  );
  assert.ok(elapsed < 3000, `必须在超时窗口内返回，实际耗时 ${elapsed}ms`);
  assert.strictEqual(err.code, 'SOHO_TIMEOUT', '超时错误必须带 SOHO_TIMEOUT code，便于与业务错误区分');
  assert.ok(
    /超时/.test(err.message) && /never-responds/.test(err.message),
    `超时错误必须可诊断（含超时值与 URL），实际: ${err.message}`
  );
});

// ============================================================================
// 组 14 · 移动公众（ecloud）侧车：凭据外置（方案 B） + 三平台保活不重叠
// ============================================================================
// 背景：2026-09-24 用户拍板四项 —— 协议常量走方案 B（外置）、L3 默认先关闭、
// 网络保持 bridge、P0 改名立即执行；并要求「三个平台的保活机制不要重叠，各自独立，
// 日志也独立」。
//
// 本组把其中**可机制化**的部分固化为断言（不靠人自觉）：
//   ① 协议凭据绝不许回流源码（Public 仓库红线 / 方案 B）；
//   ② 凭据缺失必须**报错**，不许静默降级 —— 静默降级＝"看似正常的失败"，
//      正是本项目历史最忌讳的失败模式；
//   ③ ecloud 保活不得复用移动爱家 / 天翼云的保活实现（用户明令：机制不重叠）；
//   ④ 侧车进程退出绝不许静默（对应方案书风险 R6）；
//   ⑤ 侧车 stdout 只承载 IPC 报文，日志必须走 stderr。
// 另含一条行为断言：真实拉起侧车跑通 IPC（CI 环境必须执行；本机无 Python 时响亮跳过）。
// ============================================================================
group('组 14 · 移动公众侧车：凭据外置 + 三平台保活不重叠');

let ecloudEngineCode = '';
try { ecloudEngineCode = read('app/ecloud/ecloud_engine.js'); } catch (e) { ecloudEngineCode = ''; }
let ecloudConfigPy = '';
try { ecloudConfigPy = read('app/ecloud_engine/config.py'); } catch (e) { ecloudConfigPy = ''; }
let ecloudSidecarPy = '';
try { ecloudSidecarPy = read('app/ecloud_engine/sidecar.py'); } catch (e) { ecloudSidecarPy = ''; }
let gitignoreCode = '';
try { gitignoreCode = read('.gitignore'); } catch (e) { gitignoreCode = ''; }

test('侧车桥接层必须存在且导出完整接口', () => {
  // 注意：本断言**不得**读 tests/ 下的文件 —— 变异验证的沙箱刻意不复制 tests/
  // （mutation_check.js 的 IGNORE_DIRS），读它会 ENOENT 崩溃，把整轮变异验证拖成假 PASS。
  // 「已登记进语法闸门」由 tests/syntax_check.js 的自检负责。
  assert.ok(ecloudEngineCode.length > 500, 'app/ecloud/ecloud_engine.js 缺失或过短');
  for (const sym of ['EcloudEngine', 'EngineState', 'resolvePython']) {
    assert.ok(
      new RegExp(`\\b${sym}\\b`).test(ecloudEngineCode),
      `ecloud_engine.js 必须提供 ${sym}`
    );
  }
  assert.ok(/module\.exports\s*=/.test(ecloudEngineCode), 'ecloud_engine.js 必须导出模块');
});

test('签名常量红线：config.py 本身不得出现字面值（值只许待在专用数据文件里）', () => {
  assert.ok(ecloudConfigPy, 'app/ecloud_engine/config.py 缺失');
  assert.ok(
    !/ACCESS_KEY\s*=\s*["'][0-9a-f]{32}["']/i.test(ecloudConfigPy),
    'ACCESS_KEY 字面值被写回 config.py —— 值只能来自环境变量 / 覆盖文件 / 内置常量文件'
  );
  assert.ok(
    !/SECRET_KEY\s*=\s*["'][0-9a-f]{32}["']/i.test(ecloudConfigPy),
    'SECRET_KEY 字面值被写回 config.py —— 值只能来自环境变量 / 覆盖文件 / 内置常量文件'
  );
  assert.ok(
    !/-----BEGIN [A-Z ]*KEY-----[\s\S]{0,200}?\nM[A-Za-z0-9+/]{40,}/.test(ecloudConfigPy),
    'RSA 密钥实体（PEM 主体）出现在 config.py —— 值只能来自专用数据文件'
  );
});

test('签名常量：内置公开值必须齐备、可被覆盖，且缺失即报错（不许静默降级）', () => {
  assert.ok(/def _load_credentials\(/.test(ecloudConfigPy), '缺少凭据加载器');
  assert.ok(/ECLOUD_ACCESS_KEY/.test(ecloudConfigPy), '必须支持环境变量注入凭据');
  assert.ok(/ECLOUD_CRED_FILE/.test(ecloudConfigPy), '必须支持 ECLOUD_CRED_FILE 指向的覆盖文件');
  assert.ok(/public_credentials\.json/.test(ecloudConfigPy), '必须回落到内置公开常量文件');
  assert.ok(/class CredentialMissing/.test(ecloudConfigPy), '必须定义 CredentialMissing');
  assert.ok(
    /raise CredentialMissing\(/.test(ecloudConfigPy),
    '所有来源都取不到时必须抛错 —— 静默降级会让整条保活链在"看似正常"下失败'
  );

  // 内置公开常量文件：必须存在、可解析、四字段齐全（开箱即用的前提）
  const bundledPath = path.join(ROOT, 'app/ecloud_engine/public_credentials.json');
  assert.ok(fs.existsSync(bundledPath), 'app/ecloud_engine/public_credentials.json 缺失 —— 镜像将无法开箱即用');
  const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
  for (const k of ['accessKey', 'secretKey', 'rsaPublicPem', 'rsaPrivatePem']) {
    assert.ok(bundled[k] && String(bundled[k]).trim(), `内置公开常量缺字段 ${k}`);
  }
  // 该文件必须随仓库/镜像分发：任何忽略规则都不得把它挡掉
  assert.ok(
    !/public_credentials/.test(gitignoreCode),
    'public_credentials.json 被 .gitignore 命中 —— 内置常量会随仓库一起丢失'
  );
  assert.ok(
    !/public_credentials/.test(read('.dockerignore')),
    'public_credentials.json 被 .dockerignore 命中 —— 镜像会缺内置常量'
  );
});

test('Public 红线：凭据文件与 Python 缓存必须被 .gitignore', () => {
  assert.ok(/app\/ecloud_engine\/credentials\.json/.test(gitignoreCode), 'credentials.json 未加入 .gitignore');
  assert.ok(/__pycache__/.test(gitignoreCode), '__pycache__ 未加入 .gitignore');
});

test('三平台保活不重叠：ecloud 桥接层不得复用 ydpc / 天翼云保活实现', () => {
  assert.ok(ecloudEngineCode, 'ecloud 桥接层缺失');
  assert.ok(
    !/require\([^)]*ydpc[^)]*\)/.test(ecloudEngineCode),
    'ecloud 保活不得复用移动爱家的 ydpc 实现（用户明令：三平台机制不重叠）'
  );
  assert.ok(
    !/require\([^)]*(ctyun_encryption|soho_client|cag_boot|zte_cag_raw|zte_cag_tls|mqtt_client)[^)]*\)/.test(ecloudEngineCode),
    'ecloud 保活不得复用天翼云 / 移动爱家的保活实现'
  );
  assert.ok(
    !/require\([^)]*server\.js[^)]*\)/.test(ecloudEngineCode),
    'ecloud 桥接层不得反向依赖 server.js（避免宿主与侧车互相缠绕）'
  );
});

test('ecloud 日志必须带 platform 标签（与另两平台日志流分开）', () => {
  assert.ok(
    /platform:\s*'ecloud'/.test(ecloudEngineCode),
    "ecloud 侧车日志必须标记 platform: 'ecloud'，否则会与天翼云/移动爱家日志混流"
  );
});

test('侧车 stdout 只承载 IPC：日志必须走 stderr，不得 print 到 stdout', () => {
  assert.ok(ecloudSidecarPy, 'app/ecloud_engine/sidecar.py 缺失');
  assert.ok(/stream=sys\.stderr/.test(ecloudSidecarPy), '日志必须输出到 stderr，否则污染 JSON-Lines IPC');
  assert.ok(
    !/(?<![\w.])print\(/.test(ecloudSidecarPy),
    'sidecar 不得直接 print() 到 stdout —— 只许通过 _emit() 写 IPC 报文'
  );
});

test('侧车退出绝不静默（方案书 R6）：在途请求必须失败并留"引擎离线"证据', () => {
  assert.ok(/platform: 'ecloud', msg: `协议引擎已离线/.test(ecloudEngineCode.replace(/\n\s*/g, ' ')) ||
           /协议引擎已离线/.test(ecloudEngineCode), '侧车退出必须留下"引擎离线"日志');
  assert.ok(/_failAllPending\(/.test(ecloudEngineCode), '退出/崩溃时在途请求必须立刻失败，不得挂起或假装成功');
  assert.ok(/isOffline\(\)/.test(ecloudEngineCode), '必须对外暴露"引擎离线"状态，供 UI 如实显示');
});

testAsync('侧车可被真实拉起并跑通 IPC（无凭据时报"未就绪"而非崩溃）', async () => {
  const { spawnSync } = require('child_process');
  const { EcloudEngine } = require(path.join(ROOT, 'app/ecloud/ecloud_engine.js'));

  const candidates = [process.env.ECLOUD_PYTHON, 'python3', 'python'].filter(Boolean);
  let py = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0) { py = c; break; }
  }
  if (!py) {
    // 本机无 Python 时跳过（但必须响亮说明）；CI 环境装有 Python，必须真正执行本断言。
    console.log('        (跳过：本机无可用 Python —— 侧车行为断言未执行，CI 必须执行)');
    return;
  }

  const logs = [];
  const eng = new EcloudEngine({
    pythonPath: py,
    onLog: (e) => logs.push(e),
    onStderr: () => {},
    requestTimeoutMs: 20000,
  });
  try {
    const h = await eng.start();
    assert.ok(h && h.engine === 'ecloud', 'health 必须返回 engine=ecloud');
    assert.ok(Number.isInteger(h.protocolVersion) && h.protocolVersion >= 2,
      `IPC 协议版本必须 >= 2（v2 起新增 session.restore / session.relogin 生命周期 op，实际 ${h.protocolVersion}）`);
    assert.ok(eng.isReady(), 'start() 返回后引擎必须处于 ready');

    // 未知 op 必须得到结构化失败，且不能让侧车退出
    let gotStructuredError = false;
    try {
      await eng.request('no.such.op');
    } catch (e) {
      gotStructuredError = /未知 op/.test(e.message);
    }
    assert.ok(gotStructuredError, '未知 op 必须返回结构化错误');
    assert.ok(eng.isReady(), '单个请求失败绝不能让侧车退出（否则一个坏请求就会停掉整平台保活）');

    // 无凭据时：必须明确报告原因，绝不静默
    if (h.credentials !== 'loaded') {
      const reason = `${h.credentialError || ''} ${h.importError || ''}`;
      assert.ok(
        /CredentialMissing|凭据缺失/.test(reason),
        `凭据未就绪时未给出明确原因（实际: ${reason.trim() || '(空)'}）`
      );
      assert.ok(
        logs.some((l) => /凭据未就绪|内核导入失败/.test(l.msg || '')),
        '凭据问题必须上报为日志事件，不得静默'
      );
    }
  } finally {
    await eng.stop();
  }
  assert.ok(eng.isOffline(), 'stop() 之后必须进入离线态');
  assert.ok(
    /协议引擎离线/.test((await eng.health().then(() => 'x').catch((e) => e.message))),
    '离线后请求必须被拒绝，而不是挂起'
  );
});

testAsync('签约常量内置：覆盖文件缺失时，侧车必须靠内置公开常量正常加载（开箱即用）', async () => {
  const { spawnSync } = require('child_process');
  const { EcloudEngine } = require(path.join(ROOT, 'app/ecloud/ecloud_engine.js'));

  const candidates = [process.env.ECLOUD_PYTHON, 'python3', 'python'].filter(Boolean);
  let py = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0) { py = c; break; }
  }
  if (!py) {
    console.log('        (跳过：本机无可用 Python —— 该行为断言未执行，CI 必须执行)');
    return;
  }

  // 场景复现：全新部署、用户没放任何覆盖文件（ECLOUD_CRED_FILE 指向不存在的路径）
  const missingPath = path.join(ROOT, 'data', 'no_such_credentials.json');
  const eng = new EcloudEngine({
    pythonPath: py,
    env: { ECLOUD_CRED_FILE: missingPath },
    onLog: () => {},
    onStderr: () => {},
    requestTimeoutMs: 20000,
  });
  try {
    const h = await eng.start();
    assert.strictEqual(
      h.credentials, 'loaded',
      `覆盖文件缺失时必须回落到内置公开常量（public_credentials.json）并加载成功，` +
        `实际 credentials=${h.credentials}，原因: ${(h.credentialError || h.importError || '(空)').slice(0, 200)}` +
        `（本机如提示缺 Python 包，请 pip install -r app/ecloud_engine/requirements.txt）`
    );
  } finally {
    await eng.stop();
  }
});

test('行为：环境变量必须是最优先来源（内置常量不得反过来覆盖用户的显式注入）', () => {
  const { spawnSync } = require('child_process');
  const ENGINE_DIR = path.join(ROOT, 'app/ecloud_engine');
  const candidates = [process.env.ECLOUD_PYTHON, 'python3', 'python'].filter(Boolean);
  let py = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0) { py = c; break; }
  }
  if (!py) {
    console.log('        (跳过：本机无可用 Python —— 该行为断言未执行，CI 必须执行)');
    return;
  }

  // 用哨兵值验证优先级：ECLOUD_CRED_FILE 指向不存在的路径 + 环境变量给出哨兵
  const sentinelAk = 'SENTINEL_ACCESS_KEY_000000000000';
  const sentinelSk = 'SENTINEL_SECRET_KEY_000000000000';
  const r = spawnSync(
    py,
    ['-c', 'import config, json; print(json.dumps({"ak": config.ACCESS_KEY, "sk": config.SECRET_KEY}))'],
    {
      cwd: ENGINE_DIR,
      encoding: 'utf8',
      env: {
        ...process.env,
        ECLOUD_CRED_FILE: path.join(ROOT, 'data', 'no_such_credentials.json'),
        ECLOUD_ACCESS_KEY: sentinelAk,
        ECLOUD_SECRET_KEY: sentinelSk,
      },
    }
  );
  assert.strictEqual(r.status, 0, `哨兵进程必须成功（stderr: ${(r.stderr || '').slice(0, 200)}）`);
  const got = JSON.parse((r.stdout || '').trim().split('\n').pop());
  assert.strictEqual(got.ak, sentinelAk, '环境变量 ECLOUD_ACCESS_KEY 必须覆盖内置常量');
  assert.strictEqual(got.sk, sentinelSk, '环境变量 ECLOUD_SECRET_KEY 必须覆盖内置常量');
});

// ============================================================================
// 组 15 · 移动公众（ecloud）接入主程序：三平台隔离 + 独立日志 + 分层开关
// ----------------------------------------------------------------------------
// 对应 2026-09-24 用户四条硬约束里"可机制化"的部分：
//   ① 移动爱家 / 移动公众 / 天翼云 的保活代码机制**不要重叠**，日志也各自独立；
//   ④ 保活机制必须**完整**融合（不允许只留一个空壳接口）；
//   ③ 登录 UI 区分（结构侧由组 16 守前端）。
//
// 本组比组 14 更进一步：不再只做"源码里有没有这句话"的静态断言，而是**真实 require
// server.js 并调用权威入口**（resolveTaskEnabled / inferLogPlatform /
// buildEcloudDefaultFeatures），因为"长得像但语义错了"只有行为断言才拦得住。
// ============================================================================
group('组 15 · 移动公众接入主程序：三平台隔离 + 独立日志 + 分层开关');

let _pureHelpers = null;
function helpers() {
  // 刻意**不 require server.js**：变异沙箱按设计不复制 node_modules（也刻意不含 tests/），
  // require 会因缺 `ws` 直接崩在加载期 —— 那就变成"脚本崩溃"而不是"断言变红"，
  // 违背变异验证的判据（只认断言失败）。这里沿用组 6 的做法：抽源码 + 真实执行。
  if (_pureHelpers) return _pureHelpers;
  const mSwitch = server.match(/const TASK_CN_NAME[\s\S]*?\n\}\n/);
  assert.ok(mSwitch, '无法从 server.js 抽取开关权威表与 resolveTaskEnabled');
  assert.ok(/function\s+resolveTaskEnabled/.test(mSwitch[0]), '抽取块不含 resolveTaskEnabled');
  const mFeat = server.match(/function buildEcloudDefaultFeatures\(\)[\s\S]*?\n\}\n/);
  assert.ok(mFeat, '无法从 server.js 抽取 buildEcloudDefaultFeatures');
  const mInf = server.match(/function inferLogPlatform[\s\S]*?\n\}\n/);
  assert.ok(mInf, '无法从 server.js 抽取 inferLogPlatform');
  // eslint-disable-next-line no-new-func
  _pureHelpers = new Function(
    `${mSwitch[0]}\n${mFeat[0]}\n${mInf[0]}\nconst ECLOUD_LOG_SOURCE = 'ECLOUD';\n` +
    'return { resolveTaskEnabled, TASK_FEATURE_KEY, TASK_CN_NAME, ECLOUD_KEEPALIVE_TASKS, buildEcloudDefaultFeatures, inferLogPlatform };'
  )();
  return _pureHelpers;
}

test('三平台日志必须严格分流：ECLOUD / SOHO·CAG / 天翼云 三流互不串台', () => {
  const { inferLogPlatform } = helpers();
  assert.strictEqual(inferLogPlatform('ECLOUD', 'ecloud'), 'ecloud', 'ECLOUD 必须归入 ecloud 流');
  assert.strictEqual(inferLogPlatform('SOHO', 'ydpc'), 'ydpc', 'SOHO 必须归入移动爱家流');
  assert.strictEqual(inferLogPlatform('CAG', 'ydpc'), 'ydpc');
  assert.strictEqual(inferLogPlatform('CSAP', 'ydpc'), 'ydpc');
  assert.strictEqual(inferLogPlatform('KeepAlive', 'ctyun'), 'ctyun', '天翼云保活必须归入 ctyun 流');
  assert.strictEqual(inferLogPlatform('Sign', 'ctyun'), 'ctyun');
  // 三流两两不同 —— 这才叫"日志各自独立"
  const a = inferLogPlatform('ECLOUD');
  const b = inferLogPlatform('SOHO');
  const c = inferLogPlatform('KeepAlive');
  assert.strictEqual(new Set([a, b, c]).size, 3, `三平台日志流必须互不相同，实际 ${a}/${b}/${c}`);
});

test('L1/L2 默认开启（【2026-09-26 用户拍板】L3 占位层已整层删除，不再有第三层）', () => {
  const f = helpers().buildEcloudDefaultFeatures();
  assert.strictEqual(f.ecloudL1AccountKeep, true, 'L1 账号态保活默认开启');
  assert.strictEqual(f.ecloudL2DesktopReg, true, 'L2 桌面登记保活默认开启');
  assert.strictEqual(f.keepAlive, true, '账号级保活总开关默认开启');
  assert.strictEqual(f.autoEnter, false, '新账号必须由用户主动开启自动进入');
  assert.strictEqual(
    'ecloudL3SpiceHeart' in f, false,
    'L3 字段必须从默认值里消失 —— 未实现的占位层不得再以任何形式暴露'
  );
});

test('移动公众账号级自动进入开关：兼容旧单机设置，关闭后阻止调度', () => {
  const { isAutoEnterEnabled } = require(path.join(ROOT, 'app/ecloud/ecloud_client.js'));
  const desktop = { realEnterEnabled: true };
  assert.strictEqual(isAutoEnterEnabled({ features: {}, desktops: [desktop] }), true, '旧账号已开启的单机任务应继续运行');
  assert.strictEqual(isAutoEnterEnabled({ features: { autoEnter: false }, desktops: [desktop] }), false, '账号级关闭必须阻止单机自动进入');
  assert.strictEqual(isAutoEnterEnabled({ features: { autoEnter: true }, desktops: [desktop] }), true);
  assert.strictEqual(isAutoEnterEnabled({ features: { autoEnter: false }, desktops: [] }), false);

  const clientSource = read('app/ecloud/ecloud_client.js');
  const serverSource = read('server.js');
  const uiSource = read('app/static/app.js');
  assert.ok(/if \(isAutoEnterEnabled\(this\.account\) && !isConnectionBusy\(\)\)/.test(clientSource), '调度必须读取账号总开关');
  assert.ok(/enableAllEcloudAutoEnter[\s\S]*?originCompanyCode === 'CMSSZTE'[\s\S]*?realEnterEnabled = true/.test(serverSource), '账号级开启须为兼容云电脑开启单机任务');
  assert.ok(/toggleFeature\('\$\{acc\.id\}', 'autoEnter', this\.checked\)/.test(uiSource), '分层开关区须接入账号级自动进入');
});

test('行为：分层开关判定必须走权威入口，且语义正确（含"保活类不得被 taskEnabled 污染"）', () => {
  const { resolveTaskEnabled, buildEcloudDefaultFeatures } = helpers();
  const acc = { id: 'ec_t', platform: 'ecloud', enabled: true, features: buildEcloudDefaultFeatures() };

  assert.strictEqual(resolveTaskEnabled(acc, null, 'ecloudL1AccountKeep').enabled, true);
  assert.strictEqual(resolveTaskEnabled(acc, null, 'ecloudL2DesktopReg').enabled, true);
  // 【2026-09-26 用户拍板】L3 占位层已删除 —— 权威入口的三张表（中文名 / 字段映射 / 保活集合）
  // 里都必须彻底消失（对未知任务类型的通用放行是既有行为，不在此特判）。
  assert.ok(
    !/ecloudL3SpiceHeart/.test(stripLineComments(read('server.js'))),
    'L3 已删除 —— server.js 不得再出现任何 ecloudL3SpiceHeart 痕迹'
  );

  // 单机独立保活关闭 → 三层保活都应被拦下
  assert.strictEqual(
    resolveTaskEnabled(acc, { keepaliveEnabled: false }, 'ecloudL2DesktopReg').enabled, false,
    '单机【独立保活】关闭后 L2 必须停止'
  );
  // 账号级关 L1 → 拦下且给出可读原因
  const acc2 = { ...acc, features: { ...acc.features, ecloudL1AccountKeep: false } };
  const r2 = resolveTaskEnabled(acc2, null, 'ecloudL1AccountKeep');
  assert.strictEqual(r2.enabled, false);
  assert.ok(/L1 账号态保活/.test(r2.reason), `关闭原因必须点名是哪一层，实际: ${r2.reason}`);

  // 🔴 三层属【保活类】：单机 taskEnabled 与它无关。混用会让"关掉任务开关"误停保活。
  assert.strictEqual(
    resolveTaskEnabled(acc, { taskEnabled: false }, 'ecloudL2DesktopReg').enabled, true,
    'ecloud 三层是保活类：单机 taskEnabled 不得影响它'
  );
  // 账号停用 → 一律不等
  assert.strictEqual(resolveTaskEnabled({ ...acc, enabled: false }, null, 'ecloudL2DesktopReg').enabled, false);
});

test('三平台保活实现不得互相 require（机制不重叠的结构保证）', () => {
  const ecloud = stripLineComments(read('app/ecloud/ecloud_client.js'));
  assert.ok(
    !/require\([^)]*(ydpc_client|soho_client|cag_client|cag_boot|zte_cag_raw|zte_cag_tls|mqtt_client|ctyun_encryption)[^)]*\)/.test(ecloud),
    '移动公众客户端不得复用移动爱家 / 天翼云的保活实现'
  );
  assert.ok(
    !/require\([^)]*server\.js[^)]*\)/.test(ecloud),
    '移动公众客户端不得反向依赖 server.js（避免宿主与平台实现互相缠绕）'
  );
  const ydpc = stripLineComments(read('app/ydpc/ydpc_client.js'));
  assert.ok(
    !/require\([^)]*ecloud[^)]*\)/.test(ydpc),
    '移动爱家客户端不得反向复用移动公众的保活实现'
  );
});

test('三态红线：ecloud 客户端必须原样保留 ok=null，且该分支内绝不请求重登（防短信轰炸）', () => {
  const ecloud = read('app/ecloud/ecloud_client.js');
  assert.ok(/ok === null/.test(ecloud), '必须显式处理 ok===null（全端点失败但非 token 错误）');
  assert.ok(
    /ok === null/.test(ecloud) && /不重登|绝不重登|不得重登/.test(ecloud),
    '必须在源码里留下"ok=null 不重登"的依据（这是短信轰炸事故的直接教训）'
  );
  // 把 ok===null 分支切出来（到 L2 方法注释为止），断言里面没有重登动作
  const afterNull = ecloud.split('ok === null')[1] || '';
  const nullBranch = afterNull.split('/** L2')[0] || '';
  assert.ok(/relogged: false/.test(nullBranch), 'ok=null 分支必须明确回报"未重登": ' + nullBranch.slice(0, 200));
  assert.ok(
    !/session\.relogin/.test(nullBranch),
    'ok=null 分支内不得请求重登 —— 每轮全失败就重登会造成高频密码登录 → 短信轰炸'
  );
  // 重登的两条必要前提：只在 ok===false 分支、且侧车侧有冷却期
  const sidecar = read('app/ecloud_engine/sidecar.py');
  assert.ok(/RELOGIN_COOLDOWN_SEC/.test(sidecar), '重登必须带冷却期');
  assert.ok(/skipped": "cooldown"|skipped.*cooldown/.test(sidecar), '冷却期拦截必须显式回报，不得静默跳过');
});

test('保活机制必须"完整融合"：L1/L2 必须真的调用探针实现，不得是空壳接口', () => {
  const sidecar = read('app/ecloud_engine/sidecar.py');
  for (const op of ['health', 'login.begin', 'login.sms', 'session.restore', 'session.relogin',
                    'desktop.list', 'desktop.power', 'keepalive.l1', 'keepalive.l2', 'logout']) {    assert.ok(
      new RegExp(`"${op.replace(/\./g, '\\.')}"\\s*:`).test(sidecar),
      `侧车必须注册 op ${op}（保活机制完整融合的前提）`
    );
  }
  assert.ok(
    /keepalive_mod\.keepalive_probe\(/.test(sidecar),
    'L1 必须真正调用 keepalive_probe（三态判定），不得自己写一个假探针'
  );
  assert.ok(
    /DesktopSession\(/.test(sidecar) && /keepalive_once\(/.test(sidecar),
    'L2 必须真正调用 desktopUptime（desktop_once），不得空壳'
  );
  // Node 侧同样必须真的把请求送到侧车
  const ecloud = read('app/ecloud/ecloud_client.js');
  assert.ok(/engine\.keepaliveL1\(/.test(ecloud) && /engine\.keepaliveL2\(/.test(ecloud),
    'Node 客户端必须真正下发 L1/L2 请求，不得只保留方法名');
});

test('静态：L2 静默会话信号（updateSessionStatus + pushConnectEventData）—— 默认执行 / 无 UI / 无日志', () => {
  // 【2026-09-27 用户要求】把两个会话侧信号融入大众版 L2：「自动默认就执行，UI不显示，日志不显示」。
  // 真机探针已确认两者被服务端接受（响应 "ok"）；machineConnect 需要真实会话 ticket
  //（仅真实连接握手产生，抓包才能拿到）——故用无票的 updateSessionStatus 承载同一语义。
  const ds = stripLineComments(read('app/ecloud_engine/desktop_session.py'));
  const sidecarDs = stripLineComments(read('app/ecloud_engine/sidecar.py'));
  // ① 两个静默信号存在，且被 keepalive_once 无条件附带调用
  assert.ok(/def renew_session_status\(/.test(ds) && /def report_connect_event\(/.test(ds),
    '两个静默会话信号方法必须存在');
  assert.ok(/UPDATE_SESSION_STATUS/.test(ds) && /PUSH_CONNECT_EVENT/.test(ds),
    '必须真正调用 updateSessionStatus 与 pushConnectEventData（不得只留方法名）');
  assert.ok(
    /for signal in \(self\.renew_session_status, self\.report_connect_event\):/.test(ds),
    'keepalive_once 必须默认附带两个信号（用户要求"自动默认就执行"）'
  );
  // ② 静默纪律：两个方法体内不得出现日志调用（用户要求"日志不显示"）
  for (const fn of ['renew_session_status', 'report_connect_event']) {
    const start = ds.indexOf(`def ${fn}(`);
    const end = ds.indexOf('\n    def ', start + 1);
    const body = ds.slice(start, end > start ? end : start + 1600);
    assert.ok(start > -1, `未找到 ${fn}（结构已变，请同步本断言）`);
    assert.ok(!/log\./.test(body), `${fn} 内不得写日志（两个信号全程静默）`);
  }
  // ③ 失败纪律：每个信号独立 try/except，绝不外抛、绝不影响 keepalive_once 返回值
  assert.ok(
    /for signal in \(self\.renew_session_status, self\.report_connect_event\):[\s\S]{0,120}except Exception:[\s\S]{0,40}pass/.test(ds),
    '信号失败必须被吞掉（绝不影响 report_uptime 的判定结果）'
  );
  // ④ loginUid 跨轮稳定（sidecar 按账号会话持久化）
  assert.ok(
    /s\["loginUid"\] = str\(uuid\.uuid4\(\)\)/.test(sidecarDs),
    'sidecar 必须持久化 loginUid（跨轮稳定，服务端据此识别同一登录会话）'
  );
  // ⑤ UI 零暴露：L2 的 IPC 返回契约保持不变（ok/uptime/error/tokenExpired），
  //    侧车不得把这两个信号的方法名/结果带进响应（用户要求"UI不显示"）
  const l2Start = sidecarDs.indexOf('def op_keepalive_l2');
  const l2End = sidecarDs.indexOf('\ndef ', l2Start + 1);
  const l2Body = sidecarDs.slice(l2Start, l2End > l2Start ? l2End : l2Start + 1800);
  assert.ok(l2Start > -1 && /"ok": bool\(alive\)/.test(l2Body), '未找到 L2 op（结构已变，请同步本断言）');
  assert.ok(
    !/renew_session_status|report_connect_event/.test(l2Body),
    '侧车不得把静默信号暴露给 UI/IPC（用户要求"UI不显示"）'
  );
});

test('静态：accessToken 主动续期（平台 TTL≈30 分钟，提前 25 分钟静默刷新，401 不再出现）', () => {
  // 【2026-09-27 用户报障核查】真机统计 111 次 401 中 92 次间隔精确 30.5 分钟（均值 32.7），
  // 规律自 09-24 起就存在 ⇒ 平台 accessToken 有效期约 30 分钟，旧实现为"401 后才被动重登"。
  // 现改为提前续期：密码登录频率不变（仍约 30 分钟一次），但 401 与告警从此消失。
  const ecloud = stripLineComments(read('app/ecloud/ecloud_client.js'));
  const sidecarDs = stripLineComments(read('app/ecloud_engine/sidecar.py'));
  // ① 周期必须提前于 ~30 分钟 TTL（晚于过期则形同虚设）
  assert.ok(/25 \* 60 \* 1000/.test(ecloud), '续期周期必须是 25 分钟（提前于 ~30 分钟的平台 TTL）');
  // ② 主动续期判定与调用都必须存在
  assert.ok(
    /Date\.now\(\) - this\._lastTokenRefreshAt >= ECLOUD_TOKEN_REFRESH_MS/.test(ecloud),
    'runCycle 必须按 ECLOUD_TOKEN_REFRESH_MS 判定是否到点续期'
  );
  assert.ok(/凭证已按周期静默续期/.test(ecloud), '续期成功必须有一条语义准确的日志（"静默续期"而非"重登"）');
  // ③ 失败必须回落（绝不阻断巡检）
  assert.ok(/凭证周期续期失败（将回落为 401 触发重登）/.test(ecloud), '续期失败必须回落为 401 触发重登路径');
  // ④ 冷却期必须被尊重（防短信轰炸）
  assert.ok(/rr && rr\.skipped === 'cooldown'/.test(ecloud), '续期必须尊重侧车重登冷却期（20 分钟）');
  // ⑤ 恢复/登录/L1 重登/L2 重登成功后都必须推进时间戳，否则会在刚刷新后又触发续期
  const stamps = (ecloud.match(/_lastTokenRefreshAt = Date\.now\(\)/g) || []).length;
  assert.ok(stamps >= 4, `恢复/登录/L1 重登/L2 重登成功都必须推进时间戳（实际 ${stamps} 处）`);
  // ⑥ 主动续期走 quiet：抑制侧车的"重登成功"文案（没有 401 却出现"重登"会误导排查）
  assert.ok(/quiet: true/.test(ecloud), '主动续期必须带 quiet:true');
  assert.ok(
    /if not params\.get\("quiet"\):/.test(sidecarDs) && /重登成功，token 已刷新/.test(sidecarDs),
    '侧车必须支持 quiet 参数（quiet 时抑制"重登成功"日志；被动路径文案不变）'
  );
});

testAsync('行为：恢复旧令牌按真实签发时间续期，401 只重登一次并重试操作', async () => {
  const { EcloudClient } = require(path.join(ROOT, 'app/ecloud/ecloud_client.js'));
  const client = new EcloudClient(
    { id: 'ec_token_test', platform: 'ecloud', user: 'test', password: 'test', desktops: [] },
    { appendLog: () => {}, saveConfig: () => {} }
  );
  const issuedAt = Math.floor((Date.now() - 30 * 60 * 1000) / 1000);
  let relogins = 0;
  let valid = false;
  client.startEngine = async () => ({});
  client.engine = {
    request: async (op) => {
      if (op === 'session.restore') return { restored: true, tokenIssuedAt: issuedAt };
      if (op === 'session.relogin') {
        relogins++;
        await new Promise(resolve => setTimeout(resolve, 10));
        valid = true;
        return { relogged: true };
      }
      throw new Error(`未知操作: ${op}`);
    },
  };
  await client.ensureSession();
  assert.ok(Math.abs(client._lastTokenRefreshAt - issuedAt * 1000) < 1000,
    '恢复会话不得把旧令牌的签发时间改成当前时间');
  const action = async () => {
    if (!valid) throw new Error('EcloudError: [401] token失效');
    return '成功';
  };
  assert.deepStrictEqual(await Promise.all([
    client._withTokenRecovery(action), client._withTokenRecovery(action),
  ]), ['成功', '成功']);
  assert.strictEqual(relogins, 1, '并发 401 只能发起一次密码重登');
});

test('静态：移动公众开机能力接线（sidecar op → 引擎 → 客户端 → API → UI，受理≠生效的诚实口径）', () => {
  // 【2026-09-28】开机能力正式接入：平台官方 operate 通道（available=开机，asar 客户端同款语义）。
  // 此前服务端对该平台返回 501「暂不支持电源控制」——那正是页面"不具备开机能力"的来源，必须消失。
  const sidecarDs = stripLineComments(read('app/ecloud_engine/sidecar.py'));
  const engineJs = stripLineComments(read('app/ecloud/ecloud_engine.js'));
  const ecloudJs = stripLineComments(read('app/ecloud/ecloud_client.js'));
  const serverJs = stripLineComments(read('server.js'));
  // ① sidecar：op 函数 + 注册 + operate 白名单
  assert.ok(/def op_desktop_power\(/.test(sidecarDs), '侧车必须实现 op_desktop_power');
  assert.ok(/"desktop\.power": op_desktop_power,/.test(sidecarDs), 'op 必须注册进 dispatch 表');
  assert.ok(
    /_POWER_OPERATE_CN = \{"available": "开机", "shutdown": "关机", "restart": "重启"\}/.test(sidecarDs),
    'operate 必须收敛到白名单（available=开机；后端不认识 startup/powerOn）'
  );
  // ② 引擎桥接
  assert.ok(/desktopPower\(sessionId, p\)/.test(engineJs), '引擎桥接必须有 desktopPower');
  // ③ 客户端：走平台通道 + 诚实措辞（受理≠生效）+ 记录动作
  assert.ok(/async powerDesktop\(instanceId, operate = 'available'\)/.test(ecloudJs), '客户端必须有 powerDesktop');
  assert.ok(/平台已受理/.test(ecloudJs) && /受理 ≠ 已开机/.test(ecloudJs), '客户端必须写明"受理≠已开机"');
  assert.ok(/this\.engine\.desktopPower\(/.test(ecloudJs), '客户端必须真正调用引擎桥接');
  // ④ 服务端：501 旧拒绝必须消失，动作映射存在
  assert.ok(!/暂不支持电源控制/.test(serverJs), '旧的 501「暂不支持电源控制」必须删除（能力已接入）');
  assert.ok(
    /poweron: 'available', boot: 'available'/.test(serverJs) && /client\.powerDesktop\(targetInstance, operate\)/.test(serverJs),
    '服务端必须把 poweron 映射为 operate=available 并调用客户端'
  );
  // ⑤ UI：名下云主机列表的「🖥️ 开机」按钮必须真实可点并接线；状态徽章必须用合成判定
  assert.ok(/async function bootEcloudDesktop\(/.test(appJs), '前端必须有 bootEcloudDesktop');
  assert.ok(
    /id="pill-boot-\$\{acc\.id\}-\$\{escapeHtml\(iid\)\}"[\s\S]{0,400}bootEcloudDesktop\('\$\{acc\.id\}'/.test(appJs),
    '「名下云主机」列表必须有真实可点的开机按钮（不再有"开机: 暂不支持"占位）'
  );
  assert.ok(
    !/开机: 暂不支持/.test(appJs),
    '禁用占位「开机: 暂不支持」必须删除（能力已接入，占位是过时且误导的）'
  );
  assert.ok(
    /\(view && view\.powerOnHint\) \?/.test(appJs),
    '开机按钮 title 必须透出平台自己的开机提示（powerOnHint），而不是笼统文案'
  );
  assert.ok(/\/power\/poweron/.test(appJs), 'bootEcloudDesktop 必须走既有 power 端点（服务端按平台分流）');
  // ⑥ 开关机判定必须是合成口径（view.powerState/powerEvidence），不得退回单一平台信号
  assert.ok(
    /const powerState = String\(\(view && view\.powerState\) \|\| d\.powerState \|\| ''\)\.toLowerCase\(\)/.test(appJs),
    '状态徽章必须使用合成判定 powerState（探测 > 操作表 > 平台状态）'
  );
  assert.ok(/view\.powerEvidence/.test(appJs), '徽章 title 必须如实标注判定依据（powerEvidence）');
});

// ============================================================================
// 组 33 · 「30 天内免登录」会话语义（2026-09-28 用户要求）
// ----------------------------------------------------------------------------
// 现状缺陷：会话表是纯内存 Map，容器一重启全部丢失 —— 用户勾了"30 天免登录"也白搭。
// 语义契约（用户原话）：「勾选后登录不管容器重启还是关闭页面什么原因，只有点退出才要重新登录。」
//   勾选 ⇒ 服务端会话说盘（30 天）+ 浏览器 localStorage
//   未勾选 ⇒ 仅内存会话 + 浏览器 sessionStorage（关闭浏览器即失效）
//   登出 ⇒ **显式吊销服务端会话**（含磁盘记录），否则重启后旧 token 复活 = "退不掉"
// ============================================================================
test('行为：30 天免登录 —— 勾选会话说盘且重启可恢复；未勾选绝不落盘；登出即吊销且重启不复活', () => {
  const { AuthManager, hashPassword } = require(path.join(ROOT, 'app/auth_manager.js'));
  const admin = { id: 'u_admin', username: 'admin', passwordHash: hashPassword('admin123'), role: 'admin', maxQuota: 999 };
  let storeData = null;
  const mkStore = () => ({ load: () => storeData, save: (o) => { storeData = o; } });
  const mkCfg = () => ({
    config: { users: [JSON.parse(JSON.stringify(admin))], settings: {}, accounts: [] },
    saveConfig: () => {},
  });

  const a1 = new AuthManager({ ...mkCfg(), sessionStore: mkStore() });
  const r1 = a1.login('admin', 'admin123', true);
  assert.ok(r1.success, '登录必须成功');
  assert.ok(storeData && storeData[r1.token], '勾选免登录 ⇒ 会话必须落盘');
  const r2 = a1.login('admin', 'admin123', false);
  assert.ok(!(storeData && storeData[r2.token]), '未勾选 ⇒ 绝不能落盘（公共电脑不得被持久化）');

  // 模拟"容器重启"：同一块磁盘、全新实例
  const a2 = new AuthManager({ ...mkCfg(), sessionStore: mkStore() });
  assert.ok(a2.verifySession(r1.token), '重启后免登录会话必须仍然有效（这就是"勾选后只有退出才失效"）');
  assert.strictEqual(a2.verifySession(r2.token), null, '未勾选会话重启后必须失效（内存会话不持久）');

  // 登出吊销 ⇒ 重启也不得复活
  a2.destroySession(r1.token);
  const a3 = new AuthManager({ ...mkCfg(), sessionStore: mkStore() });
  assert.strictEqual(a3.verifySession(r1.token), null, '登出后即使重启，旧 token 也绝不允许复活');

  // 过期会话不得恢复（30 天窗口到期）—— 必须查"恢复时就未进会话表"，
  // 只查 verifySession 是测不出的（过期项即使被载入也会在 verify 处被拒，等于放行该变异）
  storeData = { deadbeef: { userId: 'u_admin', username: 'admin', expiresAt: Date.now() - 1000 } };
  const a4 = new AuthManager({ ...mkCfg(), sessionStore: mkStore() });
  assert.ok(!a4.sessions.has('deadbeef'), '过期会话不得被恢复进会话表');
  assert.strictEqual(a4.verifySession('deadbeef'), null, '过期会话不得可验证');
});

test('静态：免登录全链路接线（服务端 sessionStore/remember/logout + 前端勾选与双存储分流）', () => {
  const serverJs = read('server.js');
  const appJs2 = read('app/static/app.js');
  const html = read('app/static/index.html');
  const authJs = read('app/auth_manager.js');
  // ① 服务端：注入存储 + 登录透传 remember + 登出路由吊销
  assert.ok(/sessionStore: authSessionStore/.test(serverJs), 'AuthManager 必须注入磁盘会话存储');
  assert.ok(/authSessionStore = \{/.test(serverJs) && /auth_sessions\.json/.test(serverJs), '存储必须落在 data/auth_sessions.json');
  assert.ok(
    /authManager\.login\(body\.username, body\.password, remember\)/.test(serverJs),
    '登录端点必须把 remember 透传给 AuthManager'
  );
  assert.ok(
    /pathname === '\/api\/auth\/logout'/.test(serverJs) && /authManager\.destroySession\(session\.token\)/.test(serverJs),
    '必须有登出端点并显式吊销服务端会话（否则重启后"退不掉"）'
  );
  // ② AuthManager：恢复/落盘/销毁 三件套 + 只落 remember 会话
  assert.ok(/restoreSessions\(\) \{/.test(authJs) && /this\.restoreSessions\(\);/.test(authJs), '构造时必须恢复磁盘会话');
  assert.ok(/if \(!s\.remember\) continue;/.test(authJs), '只有 remember 会话允许落盘');
  assert.ok(/destroySession\(token\) \{/.test(authJs), '必须有 destroySession');
  // ③ 前端：勾选框 + remember 透传 + 双存储分流 + 登出清双存储并吊销
  assert.ok(/id="auth-remember"/.test(html) && /30 天内免登录/.test(html), '登录框必须有"30 天内免登录"勾选项');
  assert.ok(/JSON\.stringify\(\{ username, password, remember \}\)/.test(appJs2), '提交必须带上 remember');
  assert.ok(
    /localStorage\.setItem\("ctyun_auth_token", data\.token\);\n\s*sessionStorage\.removeItem\("ctyun_auth_token"\);/.test(appJs2),
    '勾选 ⇒ localStorage 并清掉 sessionStorage'
  );
  assert.ok(
    /sessionStorage\.setItem\("ctyun_auth_token", data\.token\);\n\s*localStorage\.removeItem\("ctyun_auth_token"\);/.test(appJs2),
    '未勾选 ⇒ sessionStorage 并清掉 localStorage'
  );
  assert.ok(
    /fetch\("\/api\/auth\/logout"/.test(appJs2) && /sessionStorage\.removeItem\("ctyun_auth_token"\)/.test(appJs2),
    '登出必须吊销服务端会话并清空两个存储'
  );
});

// ============================================================================
// 组 34 · 移动公众「🛡️ 自动开机守护」（2026-09-28 用户要求）
// ----------------------------------------------------------------------------
// 用户原话：「如果实在做不到避免强制关机的，要做到自动开机」。
// 背景：平台存在约 48 小时强制关机策略（真机实证两次），HTTP 层保活无法阻止 —— 拦不住就自动恢复。
// 设计沿用移动爱家：账号级 features.autoBoot + 单机 autoBootEnabled 双开关 + 同机 10 分钟冷却
//   + 合成判定门禁（_effectivePowerState 只对"确定关机"下发，绝不向运行中的机器盲开）。
// ============================================================================
test('行为：开关机合成判定 _effectivePowerState（探测证据 > 平台操作表 > 平台状态）', () => {
  // eslint-disable-next-line global-require
  const { EcloudClient } = require(path.join(ROOT, 'app/ecloud/ecloud_client.js'));
  const client = new EcloudClient(
    { id: 'ec_unit', platform: 'ecloud', name: '单元测试', features: {} },
    {
      appendLog: () => {}, sendNotification: () => {}, saveConfig: () => {},
      resolveTaskEnabled: () => ({ enabled: true, reason: '' }),
    }
  );
  const now = Date.now();
  // 平台状态直通
  assert.strictEqual(client._effectivePowerState({ powerState: 'on' }).state, 'on');
  assert.strictEqual(client._effectivePowerState({ powerState: 'off' }).state, 'off');
  // 探测证据优先：平台说 on，但刚 NO_UPTIME ⇒ off
  const offByProbe = client._effectivePowerState({ powerState: 'on', _l2NoUptime: true, _l2At: now });
  assert.strictEqual(offByProbe.state, 'off');
  assert.ok(/探测/.test(offByProbe.evidence), '判定必须标注依据来源');
  // 证据过期（>15 分钟）⇒ 回落平台状态（避免一次瞬时探测永久钉死判定）
  assert.strictEqual(
    client._effectivePowerState({ powerState: 'on', _l2NoUptime: true, _l2At: now - 16 * 60 * 1000 }).state, 'on'
  );
  // 平台未知 + 操作表可开机 ⇒ off
  assert.strictEqual(client._effectivePowerState({ powerState: 'unknown', powerOnEnable: true }).state, 'off');
  // 全未知 ⇒ unknown（绝不猜成 off 或 on）
  assert.strictEqual(client._effectivePowerState({}).state, 'unknown');
});

test('静态：自动开机守护接线（账号级/单机双开关 + 冷却 + 合成门禁 + UI 双开关）', () => {
  const ecloud = stripLineComments(read('app/ecloud/ecloud_client.js'));
  // 后端守护块四要素
  assert.ok(
    /ECLOUD_AUTOBOOT_COOLDOWN_MS = 10 \* 60 \* 1000/.test(ecloud),
    '同机 10 分钟冷却常量必须存在'
  );
  assert.ok(
    /this\.account\.features\?\.autoBoot !== false/.test(ecloud),
    '账号级开关必须是"默认开启"口径（!== false；2026-09-28 用户拍板）'
  );
  assert.ok(
    /if \(d\.autoBootEnabled === false\) continue;/.test(ecloud),
    '单机开关必须是"默认开启、显式关闭才跳过"口径（=== false）'
  );
  assert.ok(
    /const st = this\._effectivePowerState\(d\);[\s\S]{0,80}if \(st\.state !== 'off'\) continue;/.test(ecloud),
    '必须用合成判定门禁：只对"确定关机"下发，绝不盲开'
  );
  assert.ok(/await this\.powerDesktop\(d\.instanceId, 'available'\)/.test(ecloud), '守护必须真正调用开机');
  assert.ok(/ECLOUD_AUTOBOOT_COOLDOWN_MS\) continue;/.test(ecloud), '冷却必须真正生效');
  // 视图与守护共用同一判定入口（杜绝两套判定漂移）
  assert.ok(
    /const eff = this\._effectivePowerState\(desktop\);/.test(ecloud),
    'describeDesktopKeepAlive 必须复用 _effectivePowerState（单一判定入口）'
  );
  // 账号默认开关值：新建账号必须显式 autoBoot: true（ecloud）
  assert.ok(
    /ecloudL2DesktopReg: true,[\s\S]{0,200}autoBoot: true/.test(read('server.js')),
    'buildEcloudDefaultFeatures 必须显式 autoBoot: true'
  );
  // UI：分层开关区（账号级）+ 名下列表（单机）
  assert.ok(
    /toggleFeature\('\$\{acc\.id\}', 'autoBoot', this\.checked\)/.test(appJs),
    '分层自动化保活开关区必须有账号级「自动开机守护」开关'
  );
  assert.ok(/🛡️ 自动开机守护<\/span>/.test(appJs), '账号级守护文案必须是「🛡️ 自动开机守护」（无括号后缀）');
  assert.ok(!/自动开机守护（强制关机后自动拉起）/.test(appJs), '标签里的「（强制关机后自动拉起）」必须删除（用户要求）');
  // 移动公众：守护开关必须在分层区**最前面**（先于「账号级保活总开关」）
  {
    const ecStart = appJs.indexOf('分层自动化保活开关');
    const ecEnd = appJs.indexOf('account-card', ecStart) > -1 ? appJs.indexOf('account-card', ecStart) : appJs.length;
    const seg = appJs.slice(ecStart, ecStart + 4000);
    const iGuard = seg.indexOf('🛡️ 自动开机守护');
    const iMaster = seg.indexOf('⚡ 账号级保活总开关');
    assert.ok(iGuard > -1 && iMaster > -1 && iGuard < iMaster, '移动公众的守护开关必须排在「账号级保活总开关」之前（最前面）');
  }
  // 【2026-09-28 修复】移动公众开关区**不得**引用移动爱家的 _ydpcVendors：该变量只在爱家分支内
  // 声明（块级 const），在公众分支求值即 ReferenceError → 整张账号卡片渲染中断（用户界面白块）。
  // 公众口径是一刀切默认开（与 ecloud_client 的 !== false 同源），不存在底座分叉。
  {
    const ecStart = appJs.indexOf('分层自动化保活开关');
    const ecClose = appJs.indexOf('</details>', ecStart);
    const ecSeg = appJs
      .slice(ecStart, ecClose > -1 ? ecClose : ecStart + 4000)
      // 只看代码：注释里提到该标识符（如"本区不得引用…"）不算违规
      .replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/_ydpcVendors/.test(ecSeg), '移动公众开关区不得引用 _ydpcVendors（渲染作用域隔离）');
    assert.ok(
      /\$\{f\.autoBoot !== false \? 'checked' : ''\}/.test(ecSeg),
      '移动公众守护 checkbox 必须一刀切默认开（与 ecloud_client 的 !== false 同口径）'
    );
  }
  assert.ok(
    /<input type="checkbox" \$\{f\.autoBoot !== false \? 'checked' : ''\} onchange="toggleFeature\('\$\{acc\.id\}', 'autoBoot', this\.checked\)">/.test(appJs),
    '账号级守护 checkbox 必须默认勾选（f.autoBoot !== false）'
  );
  assert.ok(
    /pill-autoboot-\$\{acc\.id\}-\$\{escapeHtml\(iid\)\}/.test(appJs) && /'autoBootEnabled'/.test(appJs),
    '「名下云主机」列表必须有单机守护胶囊并接线 autoBootEnabled'
  );
  assert.ok(
    /🛡️守护: \$\{d\.autoBootEnabled !== false \? '开' : '关'\}/.test(appJs),
    '单机守护胶囊文案必须按"默认开"口径如实反映状态'
  );
  // 移动爱家（ydpc）：默认口径按底座分叉（含 SCG 的账号默认开；纯 ZTE 保持默认关）
  const ydpcJs = stripLineComments(read('app/ydpc/ydpc_client.js'));
  assert.ok(
    /if \(isVmOff && this\._autoBootArmed\(vm\) && !isLimitedExpired\)/.test(ydpcJs),
    'ydpc 守护武装判定必须走 _autoBootArmed 单一入口'
  );
  assert.ok(
    /accFlag === undefined[\s\S]{0,80}\.some\(isScg\)/.test(ydpcJs),
    'ydpc 账号级默认：含 SCG 机器 ⇒ 默认开（纯 ZTE ⇒ 默认关）'
  );
  assert.ok(
    /vmFlag === undefined \? isScg\(vm\) : vmFlag !== false/.test(ydpcJs),
    'ydpc 单机默认按底座分叉：SCG 默认开 / ZTE 默认关，显式值优先'
  );
  assert.ok(
    /_ydpcVendors\.includes\('SCG'\)/.test(appJs) && /_isScgVm\(vm\)/.test(appJs),
    '前端守护默认口径必须与后端同源（含 SCG 账号默认勾选 / 单机按 _isScgVm 分叉）'
  );
  // 【2026-09-28 修复】抽取 _autoBootArmed 时的伴生红线：不得残留悬空的开关局部量，
  // 且"未武装原因"必须从同一入口派生 —— 否则关机分支会抛 ReferenceError 中断整账号巡检。
  assert.ok(
    !/accAutoBootOn|vmAutoBootOn/.test(ydpcJs),
    'ydpc 不得残留悬空变量 accAutoBootOn/vmAutoBootOn（判据唯一入口的伴生红线）'
  );
  assert.ok(
    /const why = this\._autoBootArmed\(vm\) \? '当前套餐时长受限' : '未开启自动开机守护';/.test(ydpcJs),
    '未武装原因必须由 _autoBootArmed 单入口派生，禁止复制第二份开关判据'
  );
});

test('会话契约：顶层 sessionId 必须被回填进 params（历史缺陷：桥接发顶层、op 读 params → 会话永远找不到）', () => {
  const sidecar = read('app/ecloud_engine/sidecar.py');
  assert.ok(
    /params\["sessionId"\]\s*=\s*req\.get\("sessionId"\)/.test(sidecar),
    'main() 必须把顶层 sessionId 回填进 params —— 否则所有会话内 op 都会报"会话不存在"'
  );
  const ecloudEngine = read('app/ecloud/ecloud_engine.js');
  assert.ok(
    /const payload = \{ id, op, sessionId, params \}/.test(ecloudEngine),
    '桥接层必须把 sessionId 放在报文顶层（与 sidecar 文档一致）'
  );
});

test('scheduler 必须把 ecloud 与"天翼云任务链"隔离，且保活开关走 taskGate', () => {
  const sc = stripLineComments(read('app/tasks/scheduler.js'));
  // 每一处"能力隔离"都必须显式考虑 ecloud：达成度巡检、补跑自检、挂机、积分兑换、
  // 以及 ecloud 自己的独立分支 —— 少一处，移动公众账号就会被当成天翼云账号误跑。
  const refs = (sc.match(/platform\s*[!=]==\s*'ecloud'/g) || []).length;
  assert.ok(
    refs >= 5,
    `scheduler 必须在每一处能力隔离点都排除 ecloud（达成度/补跑/挂机/兑换/独立分支），实际仅 ${refs} 处`
  );
  assert.ok(
    /taskGate\(acc, 'cloudHang'\) && acc\.platform !== 'ydpc' && acc\.platform !== 'ecloud'/.test(sc),
    '【1 小时挂机】必须显式排除 ecloud'
  );
  assert.ok(
    /autoRedeem && acc\.platform !== 'ydpc' && acc\.platform !== 'ecloud'/.test(sc),
    '【积分兑换】必须显式排除 ecloud（移动公众无积分体系）'
  );
  assert.ok(
    /taskGate\(acc, 'keepAlive', client\)/.test(sc),
    'ecloud 分支的保活开关必须走 taskGate 统一入口'
  );
});

test('移动公众电源控制：能力已接入（operate 官方通道），且成功口径只报"受理"绝不伪装已开机', () => {
  // 【2026-09-28 修订】原断言要求"未实现必须 501 拒绝"——能力已通过平台官方 operate 通道
  // 真实接入（真机验证可受理），旧 501 分支已删除。现改为锁住两条新红线：
  //   ① 绝不能再用"未实现"拒绝（页面不得再显示"不具备开机能力"）；
  //   ② 成功的措辞只允许"平台已受理"——受理 ≠ 已开机，不得伪装生效。
  assert.ok(
    !/暂不支持电源控制/.test(server) && !/未实现该能力/.test(server),
    '旧的"暂不支持/未实现"拒绝必须删除（开机能力已接入）'
  );
  const idx = server.indexOf("client.powerDesktop(targetInstance, operate)");
  assert.ok(idx > -1, 'ecloud 电源分支必须真正调用 client.powerDesktop');
  const seg = server.slice(Math.max(0, idx - 900), idx + 300);
  assert.ok(/poweron: 'available'/.test(seg), 'poweron 必须映射为平台认得的 operate=available');
  assert.ok(!/success: false/.test(seg), '不得在能力已接入的分支上预置"必然失败"的返回');
});

test('两段式登录的待定会话必须有 TTL 清理（否则侧车进程与登录态会无限堆积）', () => {
  assert.ok(/ECLOUD_PENDING_TTL_MS/.test(server), '待定登录必须有 TTL 常量');
  assert.ok(/pendingEcloudLogins\.delete\(/.test(server), '过期或完成后必须从待定表移除');
  assert.ok(/client\.stop\(/.test(server), '过期的待定会话必须停掉其侧车，避免僵尸进程');
});

testAsync('行为：顶层 sessionId 必须真正送达侧车（IPC 契约自证）', async () => {
  const { spawnSync } = require('child_process');
  const { EcloudEngine } = require(path.join(ROOT, 'app/ecloud/ecloud_engine.js'));

  const candidates = [process.env.ECLOUD_PYTHON, 'python3', 'python'].filter(Boolean);
  let py = null;
  for (const c of candidates) {
    const r = spawnSync(c, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0) { py = c; break; }
  }
  if (!py) {
    console.log('        (跳过：本机无可用 Python —— IPC 契约行为断言未执行，CI 必须执行)');
    return;
  }

  const eng = new EcloudEngine({ pythonPath: py, onLog: () => {}, onStderr: () => {}, requestTimeoutMs: 20000 });
  try {
    await eng.start();
    const h = await eng.request('health', {}, 'sess-contract-probe');
    assert.strictEqual(
      h.sessionId, 'sess-contract-probe',
      `顶层 sessionId 未送达侧车（实际: ${JSON.stringify(h.sessionId)}）—— 这会让所有会话内 op 报"会话不存在"`
    );
    // 未登记的会话必须被明确拒绝，而不是默默返回空数据。
    // 注意：无凭据环境下 _require_ready() 会先于会话查找报"内核不可用"——两者都算
    // "明确拒绝"，因此这里接受任一可诊断原因，但**绝不接受静默成功**。
    let rejectMsg = '';
    try {
      await eng.request('keepalive.l1', {}, 'sess-not-logged-in');
    } catch (e) { rejectMsg = e.message; }
    assert.ok(rejectMsg, '未登录会话必须被明确拒绝（不得静默返回"成功"）');
    assert.ok(
      /会话不存在|未登录|侧车内核不可用/.test(rejectMsg),
      `拒绝原因必须可诊断，实际: ${rejectMsg}`
    );
  } finally {
    await eng.stop();
  }
});

// ============================================================================
// 组 16 · 移动公众前端融合：三平台渲染/日志/登录 UI 互不重叠
// ----------------------------------------------------------------------------
// 背景（用户 2026-09-24 明令）：移动爱家、移动公众、天翼云电脑三者「保活代码机制不要重叠，
// 各是各的，日志也是」，且「移动公众的页面可以参考移动爱家的卡片」「登录 UI 也要区分开来」。
//
// 本组守的是**前端那一侧**的隔离：卡片可以长得像，但渲染函数、字段主键（instanceId）、
// 日志平台流、登录面板必须各自独立 —— 否则一旦有人为了"省事"把移动公众的卡片改成调用
// buildYdpcVmMonitorHtml()，移动爱家的状态语义（运行/关机、userServiceId）就会污染移动公众，
// 而这种污染在界面上**不会报错**，只会静默展示错误状态。
// ============================================================================
group('组 16 · 移动公众前端融合：三平台渲染/日志/登录 UI 互不重叠');

let indexHtml = '';
try { indexHtml = read('app/static/index.html'); } catch (e) { indexHtml = ''; }

test('移动公众必须有**独立**的卡片渲染函数（不得复用移动爱家的渲染器）', () => {
  assert.ok(
    /function buildEcloudDesktopMonitorHtml\(acc\)/.test(appJs),
    '必须实现移动公众专属的 buildEcloudDesktopMonitorHtml(acc)'
  );
  // 【2026-09-24 用户要求】卡片上的「L1/L2/L3 分层总览条」已移除，分层结论改由**日志流**承载
  // （见 ecloud_client.js 的 _logLayerSummary）。因此这里不再要求 buildEcloudLayerStripHtml 存在，
  // 改为断言"分层结论确实落到了日志"，真正的红线在下方专门的一条测试里。
  assert.ok(
    /const ECLOUD_TONE_COLORS\s*=/.test(appJs),
    '移动公众必须有独立的色调表 ECLOUD_TONE_COLORS（不得共用 YDPC_TONE_COLORS）'
  );
  assert.ok(
    /function formatEcloudRemainText\(/.test(appJs),
    '移动公众必须有独立的剩余时间格式化（不得共用 formatYdpcRemainText）'
  );
});

test('分层结论（L1/L2）必须落到日志流（用户 2026-09-24：卡片只留逐台状态）', () => {
  const ecloud = read('app/ecloud/ecloud_client.js');
  // 真实缺陷（用户报障）：原先只有 L1/L2 的**失败 / 重登**路径才 _log，成功路径完全静默，
  // 于是实时控制台里"移动公众"只剩登录记录 —— 用户据此误判"保活根本没在跑"。
  assert.ok(
    /this\._log\([^)]*L1 账号态探针通过/.test(ecloud),
    'L1 成功路径必须写日志（否则日志流里只剩登录记录，看不出保活是否在跑）'
  );
  assert.ok(
    /L2 桌面登记成功/.test(ecloud),
    'L2 成功路径必须写日志'
  );
  assert.ok(
    /_logLayerSummary\(\)\s*\{/.test(ecloud),
    '必须有 _logLayerSummary() 把 L1/L2 两层结论汇总成一条日志'
  );
  assert.ok(
    /this\._logLayerSummary\(\)/.test(ecloud),
    '_logLayerSummary() 必须被调用，否则等于没写'
  );
  // 两层都必须出现在同一条日志里（用户要的正是卡片上那两行信息）
  const idx = ecloud.indexOf('_logLayerSummary() {');
  assert.ok(idx > -1, '无法定位 _logLayerSummary（源码结构已变，请同步本断言）');
  const body = ecloud.slice(idx, idx + 1500);
  for (const must of ['L1 账号态', 'L2 桌面登记']) {
    assert.ok(body.includes(must), `分层日志必须包含「${must}」（卡片已不再展示，日志是唯一出口）`);
  }
  assert.ok(
    !body.includes('L3'),
    '【2026-09-26 用户拍板】L3 占位层已删除 —— 分层日志里不得再出现 L3 字样'
  );
  assert.ok(
    /if \(acted\) this\._logLayerSummary\(\)/.test(ecloud),
    '自动巡检必须只在"本轮确实执行过巡检"时才写分层日志（20s 一次的 tick 不得刷屏）'
  );
});

test('移动公众卡片按用户要求做减法：不得再长出分层总览条与侧车徽章', () => {
  // 这一条是把用户 2026-09-24 的删减决定"焊死"，防止后续重构又把这些元素塞回卡片。
  assert.ok(
    !/buildEcloudLayerStripHtml/.test(appJs),
    '已删除：卡片刻意不再渲染 L1/L2/L3 分层总览条（分层明细改由日志流承载）'
  );
  assert.ok(
    !/acc-ec-layers-/.test(appJs),
    '已删除：分层总览条的容器元素 acc-ec-layers-* 不得复活'
  );
  assert.ok(
    !/engineBadge/.test(appJs),
    '已删除：账号名旁的「侧车 ready」小徽章不得复活（侧车离线改由日志流如实反映）'
  );
  assert.ok(
    !/独立侧车/.test(appJs),
    '已删除：云电脑条目里的「独立侧车」徽章不得复活'
  );
  assert.ok(
    !/分层保活监视（独立协议侧车）/.test(appJs),
    '已删除：卡片标题里的「（独立协议侧车）」字样不得复活'
  );
});

test('移动公众的专属渲染器体内不得引用移动爱家的任何符号（YDPC_* / buildYdpc*）', () => {
  // 覆盖移动公众那一整段辅助函数 + 逐台渲染器（formatEcloudRemainText → buildEcloudDesktopMonitorHtml）
  const start = appJs.indexOf('function formatEcloudRemainText(');
  const end = appJs.indexOf('// 构造单个账号卡片 DOM 节点');
  assert.ok(start > -1 && end > start, '无法定位移动公众渲染函数（源码结构已变，请同步本断言）');
  const body = appJs.slice(start, end);
  const leaks = [];
  for (const sym of ['YDPC_TONE_COLORS', 'YDPC_TONE_DOTS', 'buildYdpcVmMonitorHtml', 'formatYdpcRemainText', 'describeVmKeepAlive']) {
    if (body.includes(sym)) leaks.push(sym);
  }
  assert.strictEqual(
    leaks.length, 0,
    `移动公众渲染器引用了移动爱家的符号 [${leaks.join(', ')}] —— 三平台机制不得重叠`
  );
});

test('移动公众账号卡片分支必须走自己的渲染器（不得调用 buildYdpcVmMonitorHtml）', () => {
  const start = appJs.indexOf('// 📡 移动公众云电脑专属卡片呈现');
  const end = appJs.indexOf('// 📱 移动云电脑专属卡片呈现');
  assert.ok(start > -1 && end > start, '无法定位移动公众卡片分支（源码结构已变，请同步本断言）');
  const branch = appJs.slice(start, end);
  assert.ok(
    branch.includes('buildEcloudDesktopMonitorHtml(acc)'),
    '移动公众卡片必须使用自己的逐台渲染器'
  );
  assert.ok(
    !branch.includes('buildYdpcVmMonitorHtml'),
    '移动公众卡片不得调用移动爱家的 buildYdpcVmMonitorHtml（会把 userServiceId 语义带入 instanceId 场景）'
  );
  assert.ok(
    !branch.includes('userServiceId'),
    '移动公众卡片不得出现 userServiceId —— 该平台单机主键是 instanceId（两平台主键必须各自独立）'
  );
});

test('移动公众单机开关必须按 instanceId 定位（与移动爱家的 userServiceId 各自独立）', () => {
  const hits = (appJs.match(/String\(d\.instanceId\)\s*===\s*String\(vmKey\)/g) || []).length;
  assert.ok(
    hits >= 2,
    `单机开关与周期调整都必须按 instanceId 定位（toggleVmFeature + changeVmInterval），实际命中 ${hits} 处`
  );
  assert.ok(
    /acc\.desktops\.find\(d => String\(d\.instanceId\) === String\(vmKey\)\)/.test(appJs),
    '必须存在 ecloud 专用的 desktops 定位分支'
  );
});

test('日志平台筛选必须对移动公众做绝对隔离（三平台日志各自成流）', () => {
  assert.ok(
    /activePlatformFilter === 'ecloud' && item\.platform !== 'ecloud'/.test(appJs),
    '移动公众日志筛选必须是"绝对隔离"（只显示 platform=ecloud），不得放宽为排除其他平台'
  );
  assert.ok(
    /item\.source === 'ECLOUD'/.test(appJs),
    '移动公众日志源 ECLOUD 必须被归入「心跳保活」业务分类（与 SOHO/CAG 并列但不共用）'
  );
  assert.ok(
    /id="tab-platform-ecloud"/.test(indexHtml),
    '日志面板必须有移动公众的平台筛选按钮'
  );
});

test('平台视图 Tab 必须按"实际出现的平台"显隐（三平台并存，不得写死两平台）', () => {
  assert.ok(
    /function getPresentPlatforms\(\)/.test(appJs),
    '必须有 getPresentPlatforms() 统一判断当前出现哪些平台'
  );
  assert.ok(
    /presentPlatforms\.size >= 2/.test(appJs),
    '平台视图 Tab 的显隐必须以"平台数 >= 2"为准，不得写死 hasCtyun && hasYdpc'
  );
  assert.ok(
    /const tabBtnMap = \{ ctyun: 'view-tab-ctyun', ydpc: 'view-tab-ydpc', ecloud: 'view-tab-ecloud' \}/.test(appJs),
    '三个平台 tab 必须逐个按 presence 显隐（避免出现点了没内容的空 Tab）'
  );
  assert.ok(/id="view-tab-ecloud"/.test(indexHtml), '必须有移动公众的视图切换 Tab');
});

test('登录 UI 必须与另两平台区分：移动公众走「账号+密码 → 短信验证」两段式', () => {
  assert.ok(/id="panel-add-ecloud"/.test(indexHtml), '添加账号模态框必须有独立的移动公众面板');
  assert.ok(/id="platform-tab-ecloud"/.test(indexHtml), '添加账号模态框必须有移动公众平台页签');
  assert.ok(
    /async function saveEcloudAccount\(\)/.test(appJs) && /async function submitEcloudSmsCode\(\)/.test(appJs),
    '必须实现 saveEcloudAccount（第一段）与 submitEcloudSmsCode（第二段）'
  );
  assert.ok(/\/api\/accounts\/ecloud\/add/.test(appJs), '第一段必须调用 /api/accounts/ecloud/add');
  assert.ok(/\/api\/accounts\/ecloud\/login/.test(appJs), '第二段必须调用 /api/accounts/ecloud/login');
  assert.ok(/id="ecloud-sms-group"/.test(indexHtml) && /id="ecloud-sms-code"/.test(indexHtml),
    '必须有独立的短信验证码输入区');

  // 独立性的机械证明：移动公众面板内**不得**出现天翼云扫码/图形验证码、移动爱家验证码控件
  const pStart = indexHtml.indexOf('id="panel-add-ecloud"');
  const pEnd = indexHtml.indexOf('id="sms-modal"');
  assert.ok(pStart > -1 && pEnd > pStart, '无法定位移动公众面板（结构已变，请同步本断言）');
  const panel = indexHtml.slice(pStart, pEnd);
  const forbidden = ['qrcode', 'acc-captcha', 'challenge-id', 'ydpc-captcha', 'random-code'];
  const found = forbidden.filter(f => panel.includes(f));
  assert.strictEqual(
    found.length, 0,
    `移动公众面板内出现了其他平台的登录控件 [${found.join(', ')}] —— 登录 UI 必须区分开来`
  );
  assert.ok(
    !/登录方式切换 Tab/.test(panel),
    '移动公众面板不得复用天翼云的"扫码/密码"登录方式切换 Tab'
  );
});

test('L3 占位层已整层删除（2026-09-26 用户拍板）：UI 不得再有 L3 开关，诚实性口径不变', () => {
  // 【2026-09-26】L3 从未实现，用户要求从 UI 到底层全部删除 —— 此前"开关旁标注未实现"的
  // 断言随之作废，反向改为**禁止复活**：
  assert.ok(
    !/ecloudL3SpiceHeart/.test(appJs),
    'L3 开关（ecloudL3SpiceHeart）已删除 —— 前端不得复活任何 L3 控件'
  );
  assert.ok(
    !/L3 SPICE 心跳/.test(appJs),
    'L3 UI 文案已删除 —— 不得复活"未实现·默认关"开关'
  );
  // 【2026-09-24 用户要求】卡片底部的「诚实性说明」框已删除 —— 诚实性口径**前移到日志流**：
  // ecloud_client.js 的分层日志每轮都会附带「L1/L2 是 HTTP 层探针，成功不代表云电脑不会被关机」。
  // 因此这里拆成两条，**红线一条都不许少**：
  assert.ok(
    !/诚实性说明/.test(appJs),
    '卡片上的诚实性说明框已按用户要求删除，不得复活（口径改由日志流承载）'
  );
  assert.ok(
    /成功不代表云电脑不会被关机|探针成功不等于云电脑不会被关机/.test(read('app/ecloud/ecloud_client.js')),
    '诚实性口径必须仍存在于日志流中（分层日志需附「探针 ≠ 不会被关机」）—— 不许随卡片一起消失'
  );
  // 反向约束：移动公众卡片不得出现笼统的"已保活/保活成功"结论
  const cStart = appJs.indexOf('// 📡 移动公众云电脑专属卡片呈现');
  const cEnd = appJs.indexOf('// 📱 移动云电脑专属卡片呈现');
  const branch = appJs.slice(cStart, cEnd);
  assert.ok(
    !/已保活|保活成功|保证不被关机|已完成保活/.test(branch),
    '移动公众卡片不得出现"已保活/保活成功"等未经证实的结论（HTTP 层没有会话心跳能力）'
  );
});

test('移动公众 UI 一致性（用户 2026-09-24 第二轮）：头像不搞特殊 / 动作色同爱家 / 监视行不带启用与厂商徽章', () => {
  // ① 头像：不再单独覆写品牌色（三平台统一走 .account-avatar 默认浅色）
  assert.ok(
    !/ECLOUD_ACCENT/.test(appJs),
    '移动公众头像不得再为「搞特殊」单独保留品牌色常量（用户 2026-09-24：头像要跟另两平台一致）'
  );
  const cStart = appJs.indexOf('// 📡 移动公众云电脑专属卡片呈现');
  const cEnd = appJs.indexOf('// 📱 移动云电脑专属卡片呈现');
  assert.ok(cStart > -1 && cEnd > cStart, '无法定位移动公众卡片分支（结构已变，请同步本断言）');
  const ecBranch = appJs.slice(cStart, cEnd);
  assert.ok(
    !/account-avatar[^>]*style="/.test(ecBranch),
    '移动公众头像不得内联覆写 style（否则与另两平台头像颜色不一致）'
  );

  // ② 逐台监视行做减法：不得再出现「参与保活 / 未参与」与厂商徽章 CMSSZTE
  const mStart = appJs.indexOf('function buildEcloudDesktopMonitorHtml(');
  const mEnd = appJs.indexOf('// 构造单个账号卡片 DOM 节点');
  assert.ok(mStart > -1 && mEnd > mStart, '无法定位移动公众逐台渲染器（结构已变，请同步本断言）');
  const mon = appJs.slice(mStart, mEnd);
  // 注意：不能笼统地扫 `未参与` —— 第 719 行的"当前动作"降级文案 `'未参与巡检'` 是**要保留**的
  // （用户第 3 条正是要求这行"当前动作"文字与移动爱家同色）。故只扫被删掉的两枚徽章字面量。
  assert.ok(
    !/参与保活/.test(mon),
    '逐台监视行不得再渲染「参与保活」徽章（用户 2026-09-24 要求删除，该信息在「名下云主机」列表里已有）'
  );
  assert.ok(
    !/'未参与'/.test(mon),
    '逐台监视行不得再渲染「未参与」徽章（保留 `未参与巡检` 的当前动作文案，但不许它变回独立徽章）'
  );
  assert.ok(
    !/originCompanyCode/.test(mon),
    '逐台监视行不得再渲染厂商徽章 CMSSZTE（用户 2026-09-24 要求删除）'
  );

  // ③ 厂商徽章在「名下云主机」列表保留，且色板与移动爱家的中兴 ZTE 一致
  assert.ok(
    /background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;[^`]*\$\{escapeHtml\(d\.originCompanyCode\)\}/.test(appJs),
    '厂商徽章必须保留在「名下云主机」列表，且色板与移动爱家的中兴 ZTE 一致（#f0fdf4 / #166534 / #bbf7d0）'
  );

  // ④ 「当前动作」文字色必须与移动爱家同色（两平台各持独立色调表，但**同名色调取值必须一致**）
  // 只比 ok 一条不够 —— 用户的原话是"当前动作颜色一样"，而"当前动作"会落到 idle/warn/off/error
  // 等任一 tone 上。因此这里把两张表都解析出来，逐 key 比对（移动公众多出的 unknown 是它独有语义，豁免）。
  const parseTones = (name) => {
    const m = appJs.match(new RegExp(`const ${name}\\s*=\\s*\\{([\\s\\S]*?)\\};`));
    assert.ok(m, `无法解析 ${name}（结构已变，请同步本断言）`);
    const map = {};
    const re = /(\w+)\s*:\s*'(#[0-9a-fA-F]{3,8})'/g;
    let hit;
    while ((hit = re.exec(m[1])) !== null) map[hit[1]] = hit[2].toLowerCase();
    return map;
  };
  const ecTones = parseTones('ECLOUD_TONE_COLORS');
  const ydTones = parseTones('YDPC_TONE_COLORS');
  const sharedTones = Object.keys(ydTones).filter((k) => k in ecTones);
  assert.ok(sharedTones.length >= 5, '两平台色调表的同名 key 至少应有 5 个（ok/idle/warn/off/error）');
  const toneDiff = sharedTones.filter((k) => ecTones[k] !== ydTones[k]);
  assert.strictEqual(
    toneDiff.length, 0,
    `移动公众「当前动作」配色必须与移动爱家逐 tone 一致（用户 2026-09-24：不要搞特殊），不一致项：${
      toneDiff.map((k) => `${k} ${ecTones[k]} vs ${ydTones[k]}`).join('; ')}`
  );

  // ⑤ 登录面板「保存移动公众账号」按钮：不得再内联覆写底色（应与另两平台一样走 .btn-primary）
  assert.ok(
    /id="btn-save-account-ecloud"[^>]*style="display: none;"/.test(indexHtml),
    '「保存移动公众账号」按钮的 style 应只剩 display:none（与保存天翼云/移动爱家账号一致）'
  );
  assert.ok(
    !/id="btn-save-account-ecloud"[^>]*#0369a1/.test(indexHtml),
    '「保存移动公众账号」按钮不得再内联覆写品牌色（用户 2026-09-24：要与移动爱家统一）'
  );
});

// ============================================================================
// 组 17 · 移动公众短信登录必须"真的发码"（不得只让界面喊人输验证码）
// ----------------------------------------------------------------------------
// 真实缺陷（2026-09-24 用户报障）：need_* 分支只 registerPendingEcloudLogin 就返回
// needVerification，**从头到尾没有任何一步调用发码接口**；而前端却硬编码写着
// 「已向 138****1234 发送短信验证码」。用户于是永远收不到码 —— 属"假成功"，
// 且比直接报错更难排查（界面看起来一切正常）。
// 实测依据：服务端不会因为密码登录要求二次验证就替客户端发码，
// 官方客户端是在拿到 mobile 后**自己再打一次**发码接口。
// ============================================================================
group('组 17 · 移动公众短信登录必须真正发码（不得只提示不发）');

test('侧车必须注册 login.sendSms op 且实现了 handler', () => {
  const sidecar = read('app/ecloud_engine/sidecar.py');
  assert.ok(
    /"login\.sendSms"\s*:\s*op_login_send_sms\s*,/.test(sidecar),
    '侧车 _OPS 必须注册 login.sendSms → op_login_send_sms（否则发码无从发起）'
  );
  assert.ok(
    /def op_login_send_sms\(/.test(sidecar),
    '侧车必须实现 op_login_send_sms'
  );
});

test('侧车发码必须按分支走正确的接口与 codeType（否则真网 30002004）', () => {
  const sidecar = read('app/ecloud_engine/sidecar.py');
  const start = sidecar.indexOf('def op_login_send_sms(');
  const end = sidecar.indexOf('def op_desktop_list(', start);
  assert.ok(start > -1 && end > start, '必须能定位 op_login_send_sms 函数体');
  const body = sidecar.slice(start, end);

  assert.ok(
    /branch\s*==\s*login_mod\.LoginResult\.NEED_TWO_FACTOR[\s\S]{0,200}send_two_factor_sms\(/.test(body),
    'need_two_factor 分支必须走专用发码接口 send_two_factor_sms(/login/special/getSecondauthSms)'
  );
  assert.ok(
    /branch\s*==\s*login_mod\.LoginResult\.NEED_DEVICE_TRUST[\s\S]{0,220}code_type\s*=\s*"trust"/.test(body),
    'need_device_trust 分支必须 codeType="trust"（官方 certificaty 口径，用 login 会 30002004）'
  );
  assert.ok(
    /branch\s*==\s*login_mod\.LoginResult\.NEED_ENHANCED_SMS[\s\S]{0,220}code_type\s*=\s*"login"/.test(body),
    'need_enhanced_sms 分支必须 codeType="login"'
  );
  // 手机号不得明文进日志
  assert.ok(
    /_mask_mobile\(/.test(sidecar),
    '侧车必须对手机号脱敏（日志里不得出现完整号码）'
  );
});

test('短信分支名必须与 login.LoginResult 常量一致（不得自造短名 —— 历史缺陷：need_device_trust 对不上）', () => {
  const sidecar = read('app/ecloud_engine/sidecar.py');
  const loginPy = read('app/ecloud_engine/login.py');

  // 1) login.py 必须定义这几个真值（本测试的前提）
  for (const v of ['need_device_trust', 'need_two_factor', 'need_enhanced_sms', 'need_4a']) {
    assert.ok(loginPy.includes(`"${v}"`), `login.py 必须定义状态值 ${v}`);
  }

  // 2) 侧车不得再用自造短名做分支判定 —— 这正是用户报障的根因
  //    （login.begin 返回 need_device_trust，侧车却只认 "trust" ⇒ 未知的短信分支）
  for (const bad of ['branch == "trust"', 'branch == "twoFactor"', 'branch == "enhanced"']) {
    assert.ok(
      !sidecar.includes(bad),
      `侧车不得用自造分支名判定（${bad}）—— 必须比对 login_mod.LoginResult.*，否则真网报"未知的短信分支"`
    );
  }

  // 3) 两个短信 op（login.sms / login.sendSms）各 3 个分支 ⇒ 共 ≥6 处常量比对
  const uses = (sidecar.match(/branch\s*==\s*login_mod\.LoginResult\./g) || []).length;
  assert.ok(uses >= 6, `侧车两个短信 op 应有 ≥6 处分支常量比对，实测 ${uses}`);

  // 4) 平台侧尚未开放的 4A 必须被显式拒绝并说明，而不是落到"未知分支"
  assert.ok(
    /LoginResult\.NEED_4A[\s\S]{0,160}暂未实现/.test(sidecar),
    'need_4a 分支必须显式拒绝并说明尚未开放（不得静默降级或假装已发码）'
  );
});

test('桥接层必须暴露 loginSendSms 包装（Node ↔ 侧车契约）', () => {
  const engine = read('app/ecloud/ecloud_engine.js');
  assert.ok(
    /loginSendSms\(sessionId,\s*p\)\s*\{[\s\S]{0,120}'login\.sendSms'/.test(engine),
    'ecloud_engine.js 必须把 login.sendSms 包装成 loginSendSms(sessionId, p)'
  );
});

test('客户端 loginSendSms 未获确认必须抛错，绝不返回"假成功"', () => {
  const client = read('app/ecloud/ecloud_client.js');
  const start = client.indexOf('async loginSendSms(');
  assert.ok(start > -1, 'ecloud_client.js 必须实现 loginSendSms');
  const body = client.slice(start, start + 1400);
  assert.ok(
    /!\s*r\s*\|\|\s*!\s*r\.sent[\s\S]{0,160}throw/.test(body),
    'loginSendSms 必须在侧车未确认 sent 时抛错（不得 return 一个看起来成功的对象）'
  );
});

test('server.js 在 need_* 分支必须真正调用发码，不得只登记 pending 就返回', () => {
  const start = server.indexOf('if (INTERACTIVE_BRANCHES.has(status)) {');
  assert.ok(start > -1, '必须能定位 need_* 分支');
  const end = server.indexOf('jsonResponse(res, {', start);
  assert.ok(end > start, 'need_* 分支内必须有 jsonResponse');
  const block = server.slice(start, end);
  assert.ok(
    /await\s+draftClient\.loginSendSms\(/.test(block),
    'need_* 分支在返回 needVerification 之前**必须**调用 loginSendSms —— 漏掉它 = 界面让人输验证码但手机永远收不到'
  );
});

test('needVerification 响应必须带 smsSent/smsError 如实字段', () => {
  const start = server.indexOf('if (INTERACTIVE_BRANCHES.has(status)) {');
  const block = server.slice(start, start + 3000);
  assert.ok(/smsSent\b/.test(block), '响应必须回传 smsSent（前端据此决定说什么话）');
  assert.ok(/smsError\b/.test(block), '响应必须回传 smsError（发码失败要说清原因）');
  assert.ok(
    /catch\s*\([\s\S]{0,200}appendLog\(ECLOUD_LOG_SOURCE[\s\S]{0,200}短信验证码下发失败/.test(block),
    '发码失败必须落独立日志（不得静默吞掉）'
  );
});

test('前端提示必须按 smsSent 分支，不得无条件宣称"已发送"', () => {
  const appJs = read('app/static/app.js');
  const start = appJs.indexOf('function showEcloudSmsGroup(');
  assert.ok(start > -1, '必须能定位 showEcloudSmsGroup');
  const body = appJs.slice(start, start + 1600);
  assert.ok(
    /info\.smsSent\s*===\s*false/.test(body),
    'showEcloudSmsGroup 必须显式处理 smsSent === false（发码失败要如实说"未发送成功"）'
  );
  assert.ok(
    /验证码未发送成功/.test(body),
    '发码失败必须给出明确文案，不得复用"已下发"的措辞'
  );
});

test('重新发送验证码：必须存在专用路由且复用 pending 会话（不重走密码登录）', () => {
  const idx = server.indexOf("pathname === '/api/accounts/ecloud/resend'");
  assert.ok(idx > -1, '必须提供 /api/accounts/ecloud/resend —— 否则用户只能删号重加，而重加会再走密码登录、撞上 10 分钟 3 次限流');
  const block = server.slice(idx, idx + 1600);
  assert.ok(
    /entry\.client\.loginSendSms\(entry\.branch, mobile\)/.test(block),
    '重发必须走 pending 里已有的客户端会话'
  );
  assert.ok(
    !/loginInteractive\(/.test(block),
    '重发不得再走一次交互式密码登录（否则就是限流陷阱）'
  );
  const appJs = read('app/static/app.js');
  assert.ok(
    /async function resendEcloudSmsCode\(/.test(appJs) && /\/api\/accounts\/ecloud\/resend/.test(appJs),
    '前端必须提供"重新发送"入口并指向 resend 路由'
  );
  const html = read('app/static/index.html');
  assert.ok(
    /id="btn-ecloud-sms-resend"/.test(html) && /resendEcloudSmsCode\(\)/.test(html),
    '短信面板必须有「重新发送」按钮'
  );
});

// ============================================================================
// 组 18 · 卡片监视板块折叠化 + 折叠日志顺序 + 日志默认栏（用户 2026-09-24 第三轮）
// ----------------------------------------------------------------------------
// 三条用户原话：
//   ① 移动爱家「ZTEC 握手与心跳监视」与移动公众「保活监视」两个板块的
//      「保活在线」logo 删掉，改为点击收起/展开；
//      （移动公众标题原为「移动公众 保活监视 · 分层明细见日志」，2026-09-25 第七轮按用户要求
//        精简为「移动公众 保活监视」—— 见本组末尾的反向断言。）
//   ② progress 类日志被折叠后，"自动滚到底部却看不到那条被更新的记录" —— 应把它移到最下面，按时间顺序；
//   ③ 实时控制台日志默认显示的是分栏目，应该「全部」在前、然后「心跳保活」、「任务」在最后。
// ============================================================================
group('组 18 · 卡片监视板块折叠化 / 折叠日志按时间顺序 / 日志默认栏');

test('两个监视板块必须可折叠，且账号级「保活在线」徽章不得复活', () => {
  // ① 徽章：只扫**真实标记**（DOM id / 渲染字符串），不扫散文注释 —— 见 skill 教训 6b
  assert.ok(
    !/id="acc-status-badge/.test(appJs),
    '账号级「保活在线」徽章元素必须删除（用户 2026-09-24 第三轮：删掉保活在线 logo）'
  );
  assert.ok(
    !/getElementById\(`acc-status-badge/.test(appJs),
    '增量刷新里对已删徽章的就地覆写逻辑必须一并移除（否则是死代码，且暗示徽章还在）'
  );
  assert.ok(
    !/<span class="badge badge-online">保活在线<\/span>/.test(appJs),
    '卡片不得再渲染「保活在线」徽章标记'
  );

  // ② 折叠化：两个板块各自成为 details，且带按账号持久化的 key
  const blocks = [
    ['ec-monitor', '移动公众 保活监视', 'acc-ec-mon-actions-'],
    ['yd-monitor', '移动爱家 ZTEC 握手与心跳监视', 'acc-vm-actions-'],
  ];
  for (const [key, title, anchor] of blocks) {
    assert.ok(
      new RegExp(`isDetailsOpen\\(acc\\.id, '${key}'\\)`).test(appJs),
      `「${title}」板块必须以 details 折叠，并用 isDetailsOpen(acc.id, '${key}') 恢复折叠状态`
    );
    assert.ok(
      new RegExp(`saveDetailsState\\('\\$\\{acc\\.id\\}', '${key}', this\\.open\\)`).test(appJs),
      `「${title}」板块必须持久化折叠状态（key=${key}）`
    );
    assert.ok(appJs.includes(title), `折叠后的标题必须仍为「${title}」（不得顺手改文案）`);
    assert.ok(appJs.includes(anchor), `「${title}」板块的内容容器 ${anchor} 必须保留（折叠≠删除内容）`);
  }

  // 【2026-09-25 第七轮】移动公众标题必须**恰好**是「📡 移动公众 保活监视」。
  // 上面那句 includes(title) 太宽（带上旧后缀也照样通过），这里补"紧接 </span>"的精确结尾断言。
  // 反向断言走 stripComments：本文件/源码里"说明这行改过什么"的注释必然含旧后缀，
  // 不剥注释就会自己把自己判红（回归网教训 6/6b 的第三次复现）。
  const appCode = stripComments(appJs);
  assert.ok(
    /📡 移动公众 保活监视<\/span>/.test(appCode),
    '移动公众监视板块标题必须恰好以「📡 移动公众 保活监视」结尾（紧接 </span>）'
  );
  assert.ok(
    !/保活监视 · 分层明细见日志/.test(appCode),
    '「· 分层明细见日志」后缀必须删除（用户 2026-09-25：只留「移动公众 保活监视」）'
  );

  // ③ 折叠提示语与卡片内另两个折叠盒保持一致
  const hintCount = (appJs.match(/点击收起\/展开/g) || []).length;
  assert.ok(hintCount >= 4, `折叠提示语「点击收起/展开」应至少有 4 处（含本次新增 2 处），现 ${hintCount} 处`);
});

test('折叠日志更新后必须移到底部（按时间顺序，最新在最后）', () => {
  // ① 后端：progress 折叠分支必须把该条目移到 logs 末尾
  const anchor = 'prev.repeatCount = (prev.repeatCount || 1) + 1;';
  const pIdx = server.indexOf(anchor);
  assert.ok(pIdx > -1, '无法定位 progress 折叠分支（结构已变，请同步本断言）');
  const foldBlock = server.slice(pIdx, pIdx + 600);
  // 注：查表重构后局部变量由 i 改为 at（at = logs.indexOf(prev)）。
  // 这里只锁"必须 splice + push 移到末尾"这一行为，不锁变量名 —— 变量名是重构自由。
  assert.ok(
    /if \((?:i|at|logger\.index) !== logs\.length - 1\) \{\s*logs\.splice\((?:i|at), 1\);\s*logs\.push\(prev\);\s*\}/.test(foldBlock),
    '后端折叠后必须把该条目移到 logs 末尾 —— 它的时间戳已推进到"现在"，留在原索引会造成时间倒挂'
  );

  // ② 前端：折叠更新路径（现为 upsertLogList / upsertLogLine 单一幂等路径）
  //    必须把内存项与 DOM 行一并移到末尾。
  //    2026-09-25 第六轮：旧 isUpdate 分支已删除，改为 upsert 统一路径，断言随之迁移。
  const ulIdx = appJs.indexOf('function upsertLogList(list, item) {');
  assert.ok(ulIdx > -1, '无法定位前端 upsertLogList（结构已变，请同步本断言）');
  const listBlock = appJs.slice(ulIdx, ulIdx + 800);
  assert.ok(
    /list\.splice\(idx, 1\);\s*list\.push\(item\);/.test(listBlock),
    '前端折叠时必须把数组项移到末尾（否则整表重绘会把它排回旧位置 —— 用户看到的正是这一幕）'
  );

  const uIdx = appJs.indexOf('function upsertLogLine(logBox, item) {');
  assert.ok(uIdx > -1, '无法定位前端 upsertLogLine（结构已变，请同步本断言）');
  const updBlock = appJs.slice(uIdx, uIdx + 2400);
  assert.ok(
    /logBox\.appendChild\(existing\);/.test(updBlock),
    '前端折叠时必须把 DOM 行移动到列表末尾（appendChild 对已存在节点是移动而非复制）'
  );
});

test('实时控制台事件筛选：顺序 全部→心跳保活→任务，且默认选中全部', () => {
  const iAll = indexHtml.indexOf('id="tab-all"');
  const iHb = indexHtml.indexOf('id="tab-heartbeat"');
  const iTask = indexHtml.indexOf('id="tab-tasks"');
  assert.ok(iAll > -1 && iHb > -1 && iTask > -1, '三个事件筛选按钮必须都存在');
  assert.ok(
    iAll < iHb && iHb < iTask,
    '事件筛选按钮顺序必须为 全部 → 心跳保活 → 任务（用户 2026-09-24 第三轮）'
  );
  assert.ok(
    /class="btn btn-sm btn-primary" id="tab-all"/.test(indexHtml),
    '「全部」必须是默认高亮项（默认不得显示分栏目）'
  );
  assert.ok(
    !/class="btn btn-sm btn-primary" id="tab-tasks"/.test(indexHtml),
    '「任务」不得再是默认项'
  );
  assert.ok(
    !/class="btn btn-sm btn-primary" id="tab-heartbeat"/.test(indexHtml),
    '「心跳保活」不得是默认项（默认只允许「全部」）'
  );
  assert.ok(
    /let activeLogFilter = 'all';/.test(appJs),
    "activeLogFilter 的默认值必须为 'all' —— 否则首屏仍按「任务」分栏过滤"
  );
});

// ============================================================================
// 组 19 · 卡片「当前动作」后的文字字号必须与标签一致（用户 2026-09-24 第四轮）
// ----------------------------------------------------------------------------
// 用户原话：「不管是移动爱家还是移动公众，怎么卡片中的当前动作后面的字变这么大看，
//            调整下，大小恢复成跟"当前动作"一样大，颜色不用变」
// 根因（外部事实源=浏览器字号继承规则）：值 <span> 未声明 font-size ⇒ 继承 .account-card
// 正文的 14px，而「当前动作:」标签写死 11.5px。天翼云卡片外层另有 font-size:12px 兜底，
// 所以那一张只差 0.5px、肉眼难以察觉 —— 这也解释了用户为什么只提了另两个平台。
// ============================================================================
group('组 19 · 卡片「当前动作」文字字号与「当前动作」标签一致');

test('三平台「当前动作」后的动作文字必须显式 11.5px，不得继承卡片正文放大的字号', () => {
  // 取 marker 所在 <span> 的完整开始标签
  const openTagEndingAt = (src, marker) => {
    const i = src.indexOf(marker);
    if (i < 0) return null;
    const start = src.lastIndexOf('<span', i);
    const end = src.indexOf('>', i);
    return (start < 0 || end < 0) ? null : src.slice(start, end + 1);
  };
  const sizeOf = (tag) => {
    const m = /font-size:\s*([\d.]+)px/.exec(tag || '');
    return m ? parseFloat(m[1]) : null;
  };

  const cases = [
    ['移动爱家（ydpc）', 'title="${escapeHtml(view.actionText || \'\')}"'],
    ['移动公众（ecloud）', 'title="${escapeHtml(actionText)}"'],
    ['天翼云（ctyun）', 'id="acc-hb-text-'],
  ];
  for (const [name, marker] of cases) {
    const tag = openTagEndingAt(appJs, marker);
    assert.ok(tag, `${name} 卡片定位不到「当前动作」的动作文字 span（结构已变，请同步本断言）`);
    assert.ok(
      sizeOf(tag) === 11.5,
      `${name} 卡片「当前动作」后的动作文字必须显式 font-size: 11.5px（与标签同号）。`
      + '不声明就会继承卡片正文的 14px —— 用户看到的就是「字变这么大」。实测开始标签: '
      + tag.replace(/title="[^"]*"/, 'title="…"')
    );
  }

  // 对照项：移动公众正常/降级两支都保留标签，共四处，防止只改动作文字字号。
  const labelHits = appJs.match(
    /<span style="flex-shrink: 0; font-size: 11\.5px; color: #64748b;">当前动作:<\/span>/g
  ) || [];
  assert.ok(
    labelHits.length === 4,
    `三平台的「当前动作:」标签都必须保持 11.5px，现匹配到 ${labelHits.length} 处`
  );
});

// ============================================================================
// 组 20 · 例行日志折叠必须"跨干扰项收敛"（用户 2026-09-25 第五轮）
// ----------------------------------------------------------------------------
// 用户原话 ①：「移动公众的这个保活日志，是不是也应该加个重复标记，重复太多次了」
// 用户原话 ②：「移动爱家这个日志也还是很重复 … progress hb_sent= 后面的不管咋变化，
//              都属于同一种类型，不用重复日志，显示最新的，然后后面 x 几就行」
//
// 真机回放证据（把 data/logs 的 2 万多条**真实**日志按原顺序喂进真的 ingestLogEntry）：
//   ① 第五轮根因：旧实现「遇到同 source 的非同类日志就中断向前搜索」，progress 被正常日志
//      打断一次就新起一条 ⇒ 同源同账号的 progress 一度 21 条（x89 / x49 / x41 …）。
//   ② 第六轮根因：改成"向前扫 300 条窗口"后**仍会溢出** —— 一轮巡检里多账号 progress/心跳
//      能插入上千条日志，窗口外的上一条就找不到 ⇒ 另起一条从 x1 重算。
//      回放里「分层巡检结果」裂成 x190 + x37 两条，正是这个原因。
//   ⇒ 现在改为按折叠键查 routineFoldIndex（O(1) 命中），窗口大小不再影响正确性。
// 而用户看到的"x3353、x3354 … 铺一屏"另有其因：前端把服务端**每次重连都会重发**的
// 最近 80 条历史无条件 append，每条都带着"当时那一刻"的 xN 快照（见组 21）。
// 所以本组用**行为断言**（真跑折叠函数），而不是扫源码字面量。
// ============================================================================
group('组 20 · 例行日志折叠：跨干扰项收敛为一条 + xN，且不依赖扫描窗口');

/** 按大括号配平，从任意源码文本里抽出整个函数体（跨行正则不可靠，见文件头 CRLF 说明） */
function extractFunctionFrom(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > -1, `无法定位函数 ${name}（结构已变，请同步本断言）`);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  assert.fail(`${name} 的大括号不平衡，无法抽取`);
}

/** 抽出 server.js 里的顶层 const（用于拿到例行日志模式表与扫描窗口常量） */
function extractServerConst(name) {
  const re = new RegExp('(?:const|let)\\s+' + name + '\\s*=[\\s\\S]*?;');
  const m = server.match(re);
  assert.ok(m, `无法从 server.js 抽取常量 ${name}`);
  return m[0];
}

/** 造一套"真 ingestLogEntry + 独立内存数组/折叠索引"的沙箱（每个场景一套，互不污染） */
function makeFoldHarness() {
  const code = [
    extractFunctionFrom(server, 'normalizeRoutineDigits'),
    extractServerConst('ROUTINE_MESSAGE_PATTERNS'),
    extractFunctionFrom(server, 'routineFoldKey'),
    extractServerConst('routineFoldIndex'),
    extractFunctionFrom(server, 'routineFoldIndexKey'),
    extractFunctionFrom(server, 'isHeartbeatOrRoutine'),
    extractFunctionFrom(server, 'ingestLogEntry'),
  ].join('\n');

  const logs = [];
  const sseClients = new Set();
  let tick = 0;
  const clock = () => {
    const n = tick++;
    return `2026-09-25 00:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'logs', 'sseClients', 'canUserSeeLog', 'getBeijingTimeString',
    `${code}\nreturn { ingestLogEntry, routineFoldIndex };`
  )(logs, sseClients, () => true, clock);

  return {
    logs,
    routineFoldIndex: api.routineFoldIndex,
    ingest: (source, accountName, message, level = 'info') =>
      api.ingestLogEntry({
        id: `log_${logs.length + 1}_${tick}`,
        timestamp: clock(),
        source, message, level, accountName,
        platform: 'ydpc', repeatCount: 1,
      }),
    find: (needle) => logs.filter((l) => String(l.message).includes(needle)),
  };
}

test('行为：progress 心跳夹在其它同源/他源日志之间，也必须收敛为 1 条（锁死"一长串 xN"）', () => {
  const h = makeFoldHarness();
  const progress = (k) =>
    `[ZTE样本主号] progress hb_sent=${100 + k * 10} hb_recv=${400 + k * 10} data=2 left=${900 - k * 10}s`;
  for (let k = 0; k < 5; k++) {
    h.ingest('CAGRAW', 'ZTE样本主号', progress(k));                     // 例行心跳指标
    h.ingest('CAGRAW', 'ZTE样本主号', '[ZTE样本主号] 💓 SOHO 心跳保持成功');  // **同源**干扰项
    h.ingest('SOHO', 'ZTE样本主号', '[ZTE样本主号] 隧道建立完成');            // **他源**干扰项
  }

  const prog = h.find('progress hb_sent=');
  assert.strictEqual(
    prog.length, 1,
    `progress 必须收敛成 1 条，实际 ${prog.length} 条 —— 又回到了"x11、x12、x13 一长串"的老样子`
  );
  assert.strictEqual(prog[0].repeatCount, 5, `xN 必须累计全部 5 次，实际 x${prog[0].repeatCount}`);
  assert.ok(
    prog[0].message.includes('hb_sent=140'),
    '折叠后必须显示**最新**一条的文本（用户原话：显示最新的，然后后面 x 几就行）'
  );

  const hb = h.find('SOHO 心跳保持成功');
  assert.strictEqual(hb.length, 1, '同源心跳干扰项自身也应折叠为 1 条');
  assert.strictEqual(hb[0].repeatCount, 5, '干扰项的 xN 也必须正常累计');
  assert.ok(!hb[0].message.includes('progress'), '不同类的例行日志之间绝不允许互相折叠');
});

test('行为：移动公众「L1 探针 / L2 登记 / 分层巡检」这类只有数字在变的日志必须收敛 + xN', () => {
  const h = makeFoldHarness();
  const acc = '公众样本账号';
  for (let k = 1; k <= 4; k++) {
    h.ingest('ECLOUD', acc, `[${acc}] L1 账号态探针通过（HTTP 层探针 ≠ 云电脑不会被关机）`);
    h.ingest('ECLOUD', acc,
      `[${acc}] 📊 分层巡检结果 · L1 账号态: 🟢 通过（累计 ${k} 次） · L2 桌面登记: 累计 ${k} 台成功`
      + ' · 说明: L1/L2 是 HTTP 层探针，成功不代表云电脑不会被关机');
    h.ingest('ECLOUD', acc, `[我的电脑] L2 桌面登记成功 · 在线时长 33小时${k}分1秒`);
    h.ingest('System', acc, '[系统] 与保活无关的事件');  // 干扰项
  }

  const probe = h.find('账号态探针通过');
  const layers = h.find('分层巡检结果');
  const reg = h.find('桌面登记成功');
  assert.strictEqual(probe.length, 1, `L1 探针应折叠为 1 条，实际 ${probe.length} 条（用户报障的正是这一幕）`);
  assert.strictEqual(layers.length, 1, `分层巡检结果应折叠为 1 条，实际 ${layers.length} 条`);
  assert.strictEqual(reg.length, 1, `L2 桌面登记应折叠为 1 条，实际 ${reg.length} 条`);
  assert.strictEqual(probe[0].repeatCount, 4, `L1 探针应为 x4，实际 x${probe[0].repeatCount}`);
  assert.strictEqual(layers[0].repeatCount, 4, `分层巡检应为 x4，实际 x${layers[0].repeatCount}`);
  assert.ok(layers[0].message.includes('累计 4 次'), '必须显示最新一轮的数字，而不是第一轮的');
});

test('行为：同类例行日志之间插入上千条无关日志，仍必须折成同一条（锁死"窗口溢出就另起一条"）', () => {
  const h = makeFoldHarness();
  const acc = 'ZTE样本主号';
  const progress = (k) => `[${acc}] progress hb_sent=${k * 10} hb_recv=${300 + k} data=1 left=${900 - k}s`;

  // 真机上一轮巡检里多账号心跳能插入上千条日志；这里每轮灌 400 条噪音，把旧的"向前扫 300 条"窗口撑爆
  for (let round = 1; round <= 3; round++) {
    h.ingest('CAGRAW', acc, progress(round));
    for (let n = 0; n < 400; n++) {
      h.ingest('SOHO', `噪音机${n}`, `[噪音机${n}] 隧道建立完成 #${round}-${n}`);
    }
  }

  const prog = h.find('progress hb_sent=');
  assert.strictEqual(
    prog.length, 1,
    `中间夹了 1200 条无关日志后 progress 仍必须只有 1 条；实际 ${prog.length} 条 —— 又回到"窗口一溢出就另起一条、各自从 x1 重算"`,
  );
  assert.strictEqual(prog[0].repeatCount, 3, `xN 必须连续累计到 3，实际 x${prog[0].repeatCount}`);
  assert.ok(prog[0].message.includes('hb_sent=30'), '必须显示最新一条的文本');
});

test('行为（护栏）：level 不同 / source 不同 / 非例行消息 绝不允许被折叠', () => {
  const h = makeFoldHarness();
  const probeMsg = '[A] L1 账号态探针通过（HTTP 层探针 ≠ 云电脑不会被关机）';

  h.ingest('ECLOUD', 'A', probeMsg, 'info');
  h.ingest('ECLOUD', 'A', probeMsg, 'error');
  assert.strictEqual(
    h.find('账号态探针通过').length, 2,
    'level 不同的同名日志不得互相折叠 —— 否则真实告警会被折进正常运行记录里被"吃掉"'
  );

  h.ingest('SOHO', 'A', '[A] 💓 心跳保持成功');
  h.ingest('MQTT', 'A', '[A] 💓 心跳保持成功');
  assert.strictEqual(
    h.find('心跳保持成功').length, 2,
    '不同 source 的同文本日志不得折叠 —— 三平台日志必须各自成流'
  );

  h.ingest('ECLOUD', 'A', '[A] 添加移动公众账号失败: CredentialMissing 缺少凭据 #1');
  h.ingest('ECLOUD', 'A', '[A] 添加移动公众账号失败: CredentialMissing 缺少凭据 #2');
  assert.strictEqual(
    h.find('缺少凭据').length, 2,
    '非例行消息不得因"只差一个数字"就被折叠掉 —— 那是在丢取证信息'
  );
});

test('静态：例行折叠必须走 routineFoldIndex 查表，不得退回"向前扫固定窗口"', () => {
  assert.ok(
    !/视为新一轮/.test(server) && !/isProgressMsg/.test(server),
    '旧的"每个间断点新起一条"逻辑必须已删除 —— 它正是 progress 日志"怎么看都还在重复"的根因'
  );

  assert.ok(
    /const routineFoldIndex = new Map\(\)/.test(server),
    '必须建立"折叠键 → 条目"的索引（O(1) 命中上一轮那条）'
  );
  assert.ok(
    !/ROUTINE_FOLD_SCAN_WINDOW/.test(server),
    '不得再依赖"向前扫固定窗口" —— 真机回放证明窗口会被密集日志挤爆，同类日志因此裂成两条（x190 + x37）'
  );

  const i = server.indexOf('const foldKey = routineFoldKey(source, message);');
  assert.ok(i > -1, '例行日志折叠必须统一走 routineFoldKey（不得再只认 progress）');
  const end = server.indexOf('const updatePayload = { ...prev, isUpdate: true };', i);
  const foldBlock = server.slice(i, end > -1 ? end : i + 2000);
  assert.ok(
    /routineFoldIndex\.get\(foldIndexKey\)/.test(foldBlock),
    '必须按折叠索引键取值命中上一轮那条，而不是线性回溯扫描'
  );
  assert.ok(
    !/\bbreak;/.test(foldBlock),
    '例行折叠不得用 break 打断搜索（一旦用 break，第一个干扰项就会中断匹配 → 日志重新分片）'
  );
  assert.ok(
    /logs\.indexOf\(prev\)/.test(foldBlock),
    '索引里可能残留已被淘汰的陈旧条目，命中后必须验明真身仍在内存数组里'
  );

  const patIdx = server.indexOf('ROUTINE_MESSAGE_PATTERNS = [');
  assert.ok(patIdx > -1, '找不到例行日志模式表 ROUTINE_MESSAGE_PATTERNS');
  const patBlock = server.slice(patIdx, server.indexOf('];', patIdx) + 2);
  for (const p of ['分层巡检结果', '桌面登记成功', '账号态探针通过', 'progress hb_sent=']) {
    assert.ok(patBlock.includes(`'${p}'`), `例行模式表必须覆盖「${p}」（否则这类周期性汇报每轮都会新增一行）`);
  }
});

test('悬停可见完整文本：两平台「上次保活 / 周期」行必须挂 title，且由纯文本工具生成', () => {
  assert.ok(/function htmlToPlainTitle\(/.test(appJs), '缺少"渲染片段 → title 纯文本"的工具函数');
  assert.ok(/const timeLineFull = htmlToPlainTitle\(/.test(appJs), '移动爱家时间行必须生成纯文本 title');
  assert.ok(
    /title="\$\{escapeHtml\(timeLineFull\)\}"/.test(appJs),
    '移动爱家「上次保活: …」行必须挂 title —— 否则被 ellipsis 截断后无处可看'
  );
  assert.ok(/const lastTextFull = htmlToPlainTitle\(/.test(appJs), '移动公众时间行必须生成纯文本 title');
  assert.ok(
    /title="\$\{escapeHtml\(lastTextFull\)\}"/.test(appJs),
    '移动公众「上次保活: …」行必须挂 title'
  );

  // 行为：把工具函数抽出来真跑（去标签 + 实体还原，避免悬停看到 &amp; 乱码）
  // eslint-disable-next-line no-new-func
  const htmlToPlainTitle = new Function(
    `${extractFunctionFrom(appJs, 'htmlToPlainTitle')}\nreturn htmlToPlainTitle;`
  )();
  assert.strictEqual(
    htmlToPlainTitle('上次保活: <b style="color: #0f172a;">5 分前</b> · 周期: <b>10 分钟</b> · 距下次 <b>5 分</b>'),
    '上次保活: 5 分前 · 周期: 10 分钟 · 距下次 5 分',
    'title 必须是去掉标签后的纯文本'
  );
  assert.strictEqual(
    htmlToPlainTitle('a &amp; b'), 'a & b',
    '实体必须先还原 —— 否则 escapeHtml 会二次转义，悬停看到 &amp;amp;'
  );
});

// ============================================================================
// 组 21 · 客户端日志渲染必须幂等（用户 2026-09-25 第六轮）
// ----------------------------------------------------------------------------
// 用户原话：「移动爱家的保活提示，还是没有合并啊。progress hb_sent= 后面有区别就不合并了，
//            建议直接按 progress hb_sent= 作为标记，合并」「移动公众的也一样」
//
// 证据链（先回放真实日志证明服务端是对的，再定位到服务端之外的渲染层）：
//   · 把 2 万多条**真实**日志按原顺序喂进真的 ingestLogEntry ⇒ 内存里 progress hb_sent=
//     **只有 1 条**（x6696，说明服务端折叠完全正常）。
//   · 而用户屏幕上同一件事有几十行、xN 逐个递增（x3353 / x3354 / … / x3362）。
//   ⇒ 重复是**渲染层**造出来的：服务端每次 SSE 连接都会重发最近 80 条历史，
//     旧前端把"非 isUpdate 分支"写成无条件 appendChild/push ⇒ 每重连一次就把同一批日志
//     再画一遍，且每条都带着"当时那一刻"的 xN 快照，于是铺出一串 x3353…x3362。
// ============================================================================
group('组 21 · 客户端日志渲染：历史重发必须幂等（同一件事只留一行）');

test('行为：同一 id 的历史重发 10 次（计数 3353…3362），内存列表必须只剩 1 条且显示最新计数', () => {
  // eslint-disable-next-line no-new-func
  const upsertLogList = new Function(
    `${extractFunctionFrom(appJs, 'logLineKey')}\n${extractFunctionFrom(appJs, 'upsertLogList')}\nreturn upsertLogList;`
  )();

  const list = [];
  // 服务端每次重连重发历史时，同一条折叠日志的 xN 会推进 —— 这正是用户截图里的那一串
  for (let k = 3353; k <= 3362; k++) {
    upsertLogList(list, {
      id: 'log_7783', timestamp: '2026-09-25 09:00:00', source: 'CAGRAW', platform: 'ydpc',
      accountName: 'ZTE样本主号', level: 'info', repeatCount: k,
      message: `[ZTE样本主号] progress hb_sent=${k} hb_recv=300 data=1 left=890s`,
    });
  }

  assert.strictEqual(
    list.length, 1,
    `重发 10 次后必须只剩 1 条，实际 ${list.length} 条 —— 这就是"x3353、x3354 … 铺满一屏"的来源`
  );
  assert.strictEqual(list[0].repeatCount, 3362, '必须保留**最新**快照的计数');
  assert.ok(list[0].message.includes('hb_sent=3362'), '必须展示最新文本，而不是第一次重发时的旧文本');

  // 不同 id 的正常日志仍必须各自保留（幂等 ≠ 把所有日志合成一条）
  upsertLogList(list, {
    id: 'log_7784', timestamp: '2026-09-25 09:00:01', source: 'ECLOUD', platform: 'ecloud',
    accountName: '公众样本账号', level: 'info', repeatCount: 1, message: '[公众样本账号] L1 账号态探针通过',
  });
  assert.strictEqual(list.length, 2, '不同 id 的日志不得被合并');
});

test('行为：无 id 的日志按"来源+平台+账号+文本"兜底去重', () => {
  // eslint-disable-next-line no-new-func
  const upsertLogList = new Function(
    `${extractFunctionFrom(appJs, 'logLineKey')}\n${extractFunctionFrom(appJs, 'upsertLogList')}\nreturn upsertLogList;`
  )();
  const list = [];
  const item = { source: 'System', platform: 'ctyun', accountName: '', message: '同一条系统消息' };
  upsertLogList(list, item);
  upsertLogList(list, { ...item });
  assert.strictEqual(list.length, 1, '无 id 时也必须按合成键去重');
  upsertLogList(list, { ...item, message: '另一条系统消息' });
  assert.strictEqual(list.length, 2, '文本不同则是另一条');
});

test('静态：SSE 的"新增"与"折叠更新"必须共用同一条幂等落盘路径', () => {
  assert.ok(/let renderedLogLines = new Map\(\)/.test(appJs), '必须有"行身份键 → 元素"的注册表');
  assert.ok(/function upsertLogLine\(logBox, item\)/.test(appJs), '必须有统一的 upsertLogLine');

  const sse = extractFunctionFrom(appJs, 'initLogStream');
  assert.ok(
    /upsertLogList\(allReceivedLogs, item\)/.test(sse),
    'SSE 收到日志后必须走幂等 upsert 入内存列表'
  );
  assert.ok(
    /upsertLogLine\(logBox, item\)/.test(sse),
    'SSE 收到日志后必须走统一的幂等落盘（新增与折叠更新同一条路径）'
  );
  assert.ok(
    !/logBox\.appendChild\(createLogLineElement\(item\)\)/.test(sse),
    '不得再在 SSE 里无条件 appendChild —— 服务端每次连接都重发最近 80 条历史，那会让日志整屏翻倍'
  );
  assert.ok(
    !/l\.source === item\.source && l\.accountName === item\.accountName/.test(appJs),
    '不得再用"同源同账号"当作同一条日志的判据 —— 它会把同源的其它条目误当成自己'
  );
  assert.ok(
    /renderedLogLines\.clear\(\)/.test(appJs),
    '整表重建 / 清空 / 退出登录时必须同步清空注册表，否则会残留指向已销毁节点的引用'
  );
});

// ============================================================================
// 组 22 · 移动公众卡片：栏目更名 / instanceId 悬停看全 / 运行状态徽章（诚实三态）
// ----------------------------------------------------------------------------
// 用户 2026-09-25 第七轮三条要求：
//   ① 监视板块（「握手与心跳监视」「保活监视」）里的主机名以 16px 渲染 —— 比周围
//      11 / 11.5 / 12px 明显偏大，用户点名「云电脑省侧部署包高阶版月报 / 8C16G版云电脑月包 /
//      我的电脑」这几台。根因（外部事实源=浏览器字号继承规则）：.account-card 与
//      .features-box 都**未声明 font-size** ⇒ 未写 font-size 的主机名落到**浏览器默认 16px**。
//   ② 「移动公众 保活监视 · 分层明细见日志」只留「移动公众 保活监视」。
//   ③「名下云电脑」→「名下云主机」；instanceId 整行省略 + 悬停看全文；
//      右侧补「运行中 / 已关机」徽章（与移动爱家「名下云主机」列表一致）。
//
// ③ 的状态真源：服务端 POST /user/getDesktopStatus 的 resourceStatus
//      → desktop_list.normalize_power_state() → on / off / unknown
// **诚实性红线**：unknown 绝不能渲染成「已关机」——把"不知道"说成"已关机"，
// 会让用户以为机器掉了，比不显示状态更坏。
// ============================================================================
group('组 22 · 移动公众卡片：栏目更名 / instanceId 悬停看全 / 运行状态徽章（诚实三态）');

test('监视板块的主机名必须显式声明 12px（不得继承 16px 浏览器默认）', () => {
  const cases = [['移动爱家监视行', 'vmName']];
  for (const [label, expr] of cases) {
    const re = new RegExp(
      `<span style="font-size: 12px; font-weight: 700; color: #0f172a;[^"]*">\\$\\{escapeHtml\\(${expr}\\)\\}</span>`,
      'g'
    );
    const hits = appJs.match(re) || [];
    assert.strictEqual(
      hits.length, 2,
      `${label}：降级分支与正常分支都必须显式声明 font-size: 12px，实际 ${hits.length} 处` +
      '（不给字号就会继承浏览器默认 16px，正是用户看到的"字体偏大"）'
    );
  }
  // 移动公众改为紧凑卡片，字号由 CSS 类明确指定；两个状态分支都须使用该类。
  const ecMonitor = extractFunctionFrom(appJs, 'buildEcloudDesktopMonitorHtml');
  const ecNames = ecMonitor.match(/<div class="ec-mon-name"[^>]*>.*?<strong>\$\{escapeHtml\(name\)\}<\/strong>/g) || [];
  assert.strictEqual(ecNames.length, 2, '移动公众降级与正常监视卡都必须使用 ec-mon-name');
  assert.ok(/\.ec-mon-name\s*\{[^}]*font-size:\s*12px/s.test(read('app/static/style.css')),
    '移动公众主机名必须由 ec-mon-name 明确设为 12px');
  // 反向：不得再出现"没写 font-size 的主机名 span"（就是本次要修的那种写法）
  const raw = appJs.match(
    /<span style="font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">\$\{escapeHtml\((?:vmName|name)\)\}<\/span>/g
  ) || [];
  assert.strictEqual(raw.length, 0, `监视行主机名不得再出现未声明字号的写法，实际 ${raw.length} 处`);
});

test('三平台栏目名统一为「名下云主机」（全仓不得再出现旧名）', () => {
  const cardFn = extractFunctionFrom(appJs, 'buildAccountCardElement');
  const ecStart = cardFn.indexOf('if (isEcloud) {');
  const ecEnd = cardFn.indexOf('if (isYdpc) {');
  assert.ok(ecStart > -1 && ecEnd > ecStart, '无法定位移动公众卡片分支（结构已变，请同步本断言）');
  const ecCard = cardFn.slice(ecStart, ecEnd);

  assert.ok(ecCard.includes('名下云主机 ('), '移动公众列表标题必须为「名下云主机 (N台)」');
  assert.ok(
    !ecCard.includes('名下云电脑'),
    '移动公众卡片不得再出现旧栏目名 —— 用户要求与移动爱家统一为「名下云主机」'
  );
  // 监视板块的降级文案也必须跟上，否则同一平台两处叫法不一致
  const monFn = extractFunctionFrom(appJs, 'buildEcloudDesktopMonitorHtml');
  assert.ok(!monFn.includes('名下云电脑'), '移动公众监视板块的降级文案也必须改成「名下云主机」');

  // 【2026-09-25·第七轮补】用户追加：天翼云卡片也必须统一。
  // 本组由"只改移动公众"升级为**全平台口径统一** —— 旧栏目名不得再出现在任何用户可见文案里。
  // ⚠️ 扫描走 stripComments，但**模板串内部的 HTML 注释剥不掉**（它算字符串内容）⇒
  //    源码注释里也一律不得复述旧名，否则这条断言会红在自己写的说明上（回归网教训 6c）。
  assert.ok(
    !/名下云电脑/.test(stripComments(appJs)),
    '旧栏目名已全平台废弃：三张卡片（天翼云 / 移动爱家 / 移动公众）都不得再出现它'
  );
  assert.ok(
    /名下云主机 \(\$\{dList\.length\}台\)/.test(appJs),
    '天翼云卡片标题必须同步更名为「名下云主机 (N台)」（该串同时锁住"确实改到了天翼云那一处"）'
  );
  // 静态页面的用户可见文案同样要跟上（HTML 注释先剥掉，避免说明性注释误伤）
  assert.ok(indexHtml.length > 0, '无法读取 app/static/index.html（结构已变，请同步本断言）');
  assert.ok(
    !/名下云电脑/.test(indexHtml.replace(/<!--[\s\S]*?-->/g, '')),
    'index.html 的用户可见文案（通知说明等）也必须统一为「名下云主机」'
  );
});

test('instanceId 整行必须可省略且悬停可见全文', () => {
  const cardFn = extractFunctionFrom(appJs, 'buildAccountCardElement');
  const ecCard = cardFn.slice(cardFn.indexOf('if (isEcloud) {'), cardFn.indexOf('if (isYdpc) {'));
  assert.ok(
    /const iidLineText = `instanceId: \$\{iid \|\| '—'\}`;/.test(ecCard),
    'instanceId 行文本必须先抽成变量（title 与正文必须同源，不能一处截断一处写死）'
  );
  assert.ok(
    /title="\$\{escapeHtml\(iidLineText\)\}"[\s\S]{0,220}?text-overflow: ellipsis;[\s\S]{0,80}?>\$\{escapeHtml\(iidLineText\)\}<\/div>/.test(ecCard),
    'instanceId 行必须整行 ellipsis 截断 + title 挂完整文本（鼠标移上去能看到完整 ID）'
  );
});

test('运行状态徽章：on/off/unknown 三态必须如实渲染（unknown 绝不当成已关机）', () => {
  const cardFn = extractFunctionFrom(appJs, 'buildAccountCardElement');
  const ecCard = cardFn.slice(cardFn.indexOf('if (isEcloud) {'), cardFn.indexOf('if (isYdpc) {'));

  assert.ok(
    /powerState === 'on'[\s\S]{0,200}运行中<\/span>/.test(ecCard),
    'powerState=on 必须渲染「运行中」徽章'
  );
  assert.ok(
    /powerState === 'off'[\s\S]{0,200}已关机<\/span>/.test(ecCard),
    'powerState=off 必须渲染「已关机」徽章'
  );
  assert.ok(
    /状态未知/.test(ecCard),
    'powerState=unknown 必须如实渲染「状态未知」，不得静默或退化成「已关机」'
  );
  assert.ok(
    /badge-online/.test(ecCard) && /badge-offline/.test(ecCard),
    '两枚徽章必须复用既有 badge-online / badge-offline 样式（与移动爱家视觉一致）'
  );

  // 后端：状态真源必须真的取回来并归一，且侧车把三态下发给前端
  const sidecar = read('app/ecloud_engine/sidecar.py');
  assert.ok(
    /"powerState":\s*desktop_list_mod\.normalize_power_state\(/.test(sidecar),
    '侧车 desktop.list 必须把归一后的 powerState 逐台下发给前端'
  );
  assert.ok(
    /"resourceStatus":\s*raw_status/.test(sidecar),
    '侧车必须同时保留服务端原始 resourceStatus（便于排查对不上的新枚举）'
  );
  assert.ok(
    /desktop_list_mod\.get_desktop_status\(s\["http"\], desktops\)/.test(sidecar),
    '侧车必须真的调用 getDesktopStatus 取运行状态（不得只回填占位值）'
  );
  // 状态是增量信息：查询失败只能降级为 unknown，不得把整个列表拉挂
  assert.ok(
    /except Exception as e:[\s\S]{0,120}log\.warning\([\s\S]{0,160}\n/.test(sidecar),
    '状态查询失败必须降级（try/except + warning），不得让 desktop.list 整体失败'
  );

  const dl = read('app/ecloud_engine/desktop_list.py');
  assert.ok(/def normalize_power_state\(/.test(dl), 'desktop_list 必须提供唯一的电源状态归一化入口');
  assert.ok(
    /if not s:\s*\n\s*return "unknown"/.test(dl),
    '空状态必须归到 unknown（不得猜成 off）'
  );
  assert.ok(
    /return "unknown"\s*$/.test(dl.trim()) || /return "unknown"/.test(dl),
    '归一化必须存在 unknown 兜底分支'
  );
  // 唯一判定入口：旧的"内联白名单"必须已被移除，否则两处判定早晚不一致
  assert.ok(
    !/st\.lower\(\) in \("running", "active", "available", "1", "on", "up"\)/.test(dl),
    'select_running_desktop 不得再内联一份白名单 —— 判定必须统一走 normalize_power_state'
  );
});

// ============================================================================
// 组 23 · 底座闸门（G1）：判定必须可执行、且"不支持"时真的拒绝拨号
// ----------------------------------------------------------------------------
//   底座闸门：SCG / ZTE / ERROR 三分类互斥一次判定，自动查底座、无手选。
//
//   【要修的既有缺陷】`vm.vendor` 在本组之前**只用于界面展示**，没有任何执行路径
//   读过它 —— 于是一台底座为 SCG 的机器每轮仍被 ZTE 握手盲拨；而 getFirmAuth 抛错时
//   旧代码还会按 vmName/skuName 里的"家庭"等字样**猜**一个底座（猜不出就默认 ZTE）。
//
//   本组要求：
//     ① 判定收敛到一个**纯函数**（可单独调用、零网络零凭据），不得散落在业务代码里；
//     ② `spuCode`（官方口径，不随开关机漂移）优先于 firm-auth —— 后者会把一台
//        空闲的 ZTE 机器误判成 SCG（cagIp 只在机器拉起后才下发）；
//     ③ 两级信号都不足 → UNKNOWN，**拒绝猜测**；
//     ④ 闸门判定为"不支持"时，保活轮与开机路径都必须真的**不拨号**；
//     ⑤ 纯函数层不得引入任何凭据 / 指纹 / 网络 / 依赖。
// ============================================================================
group('组 23 · 底座闸门（G1）：纯函数判定 + 不支持时必须拒绝拨号');

const productRouteCode = stripComments(read('app/ydpc/product_route.js'));
// eslint-disable-next-line global-require
const productRoute = require(path.join(ROOT, 'app/ydpc/product_route.js'));

test('底座判定必须收敛到纯函数层 product_route.js，且不得有依赖 / 网络 / 凭据', () => {
  // 注意：必须用 __dirname 直接读，**不能走 read('tests/...')** —— 变异验证的沙箱
  // 刻意不拷贝 tests/ 目录（CTYUN_TEST_ROOT 指向沙箱），走 ROOT 拼路径会 ENOENT 崩溃，
  // 而"崩溃"会被变异判据算作 BROKEN，直接把整轮变异验证拖垮。
  const syntaxCheckSrc = fs.readFileSync(path.join(__dirname, 'syntax_check.js'), 'utf8');
  assert.ok(/app\/ydpc\/product_route\.js/.test(syntaxCheckSrc), 'product_route.js 必须登记进语法闸门的 FILES 清单');
  assert.ok(
    /require\(\s*'\.\/product_route'\s*\)/.test(ydpcCode),
    'ydpc_client.js 必须 require 本地的 product_route 纯函数层（判定不得就地散写）'
  );
  assert.ok(
    !/require\s*\(/.test(productRouteCode),
    'product_route.js 必须是零依赖纯函数层 —— 出现 require 意味着它开始承担 I/O 职责'
  );
  assert.ok(
    !/rejectUnauthorized|sc-user-|SC_RSA_PK|cdpsdk-server|createConnection|https?\.request/.test(productRouteCode),
    'product_route.js 不得出现任何凭据 / 伪造身份指纹 / TLS 开关 / 网络调用'
  );
  assert.ok(
    !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(productRouteCode),
    'product_route.js 不得硬编码任何 IP —— DNS 才是唯一正确入口'
  );
});

test('行为：spuCode 必须优先于 firm-auth（后者会把空闲 ZTE 机器误判成 SCG）', () => {
  const { resolveVmRoute } = productRoute;

  // 误判陷阱：ZTE 机器在空闲/刚关机时 cagIp 为空，若 scAuthCode 非空，
  // 仅凭 firm-auth 会得出 SCG —— 这正是"每轮盲拨 ZTE 却显示 SCG"的来源。
  const trap = resolveVmRoute({ spuCode: 'zte-cloud-pc' }, { scAuthCode: 'ABC', cagIp: '' });
  assert.strictEqual(trap.kind, 'ZTE', `spuCode=zte-cloud-pc 必须压过 firm-auth 的 SCG 误判，实际 ${trap.kind}`);
  assert.strictEqual(trap.supported, true, 'ZTE 底座必须被标记为受支持');
  assert.strictEqual(trap.source, 'spuCode', '该判定必须记明来自 spuCode，便于日志溯源');

  assert.strictEqual(resolveVmRoute({}, { cagIp: '10.0.0.1' }).kind, 'ZTE', '缺 spuCode 时回退 firm-auth：有 cagIp 即 ZTE');
  assert.strictEqual(resolveVmRoute({}, { vmUserName: 'u' }).kind, 'ZTE', '缺 spuCode 时回退 firm-auth：有 vmUserName 即 ZTE');
  assert.strictEqual(resolveVmRoute({ spuCode: 'sc-cloud-pc' }, { cagIp: '10.0.0.1' }).kind, 'SCG', 'spuCode 命中 SCG 必须判 SCG');

  const scg = resolveVmRoute({}, { scAuthCode: 'X', cagIp: '' });
  assert.strictEqual(scg.kind, 'SCG', '无 spuCode + scAuthCode 非空且 cagIp 为空 → SCG');
  assert.strictEqual(scg.supported, true, 'SCG 通道已实现（app/ydpc/scg_keepalive.js）⇒ 必须标为受支持');

  const unknown = resolveVmRoute({}, {});
  assert.strictEqual(unknown.kind, 'UNKNOWN', '两级信号都不足 → UNKNOWN');
  assert.strictEqual(unknown.supported, false, 'UNKNOWN 不得被当成"可以试试"，必须标为不受支持');
  assert.ok(/拒绝猜测/.test(unknown.reason), `UNKNOWN 的原因必须写明"拒绝猜测"，实际: ${unknown.reason}`);
});

test('行为：闸门对"不支持"必须返回拒绝，对未判定必须放行（fail-open 防自我封锁）', () => {
  const { routeGate } = productRoute;
  assert.strictEqual(routeGate(null).allow, true, '从未判定过（null）必须放行：否则一次探测失败会把机器永久锁死');
  assert.strictEqual(routeGate(undefined).allow, true, 'undefined 同上');
  assert.strictEqual(routeGate({ kind: 'ZTE', supported: true }).allow, true, 'ZTE 必须放行');
  const denied = routeGate({ kind: 'SCG', supported: false, reason: 'scAuthCode 非空' });
  assert.strictEqual(denied.allow, false, 'SCG 必须被闸门拒绝');
  assert.ok(denied.reason.length > 0, '拒绝必须带可读原因，不能只返回一个 false');
  assert.strictEqual(routeGate({ kind: 'UNKNOWN', supported: false, reason: 'x' }).allow, false, 'UNKNOWN 必须被拒绝');
});

test('行为：重启后必须能从已持久化的 vendor 重建判定（否则闸门 fail-open，SCG 机被 ZTE 盲拨）', () => {
  const { routeFromPersistedVendor, routeGate } = productRoute;
  assert.strictEqual(
    typeof routeFromPersistedVendor, 'function',
    'product_route.js 必须导出 routeFromPersistedVendor（重建必须收敛到纯函数层）'
  );

  // 现场缺陷：判定的输入（vendor）落盘、结果（_route）不落盘 ⇒ 重启后闸门 fail-open。
  const zte = routeFromPersistedVendor('ZTE');
  assert.strictEqual(zte.kind, 'ZTE', 'vendor=ZTE 必须重建成 ZTE');
  assert.strictEqual(zte.supported, true, 'ZTE 重建后必须受支持 —— 不得把在正常保活的机器锁死');
  assert.strictEqual(routeGate(zte).allow, true, 'ZTE 重建后闸门必须放行');

  const scg = routeFromPersistedVendor('SCG');
  assert.strictEqual(scg.kind, 'SCG', 'vendor=SCG 必须重建成 SCG');
  assert.strictEqual(
    scg.supported, true,
    'SCG 通道已实现 ⇒ 重建后必须受支持（否则进程重启一次就把 SCG 机器永久锁死）'
  );
  assert.strictEqual(routeGate(scg).allow, true, 'SCG 重建后闸门必须放行（通道已实现，见 scg_keepalive.js）');

  const unknown = routeFromPersistedVendor('');
  assert.strictEqual(unknown.kind, 'UNKNOWN', '认不出的 vendor 必须判 UNKNOWN');
  assert.strictEqual(routeGate(unknown).allow, false, '认不出的 vendor 不得默认放行 —— 那正是盲拨的来源');
});

test('静态：refreshVms 必须对"无判定但有 vendor"的机器补一次重建（fail-open 空洞的机制性拦截）', () => {
  assert.ok(
    /if \(!vm\._route && vm\.vendor\)/.test(ydpcCode),
    'refreshVms 必须补重建：否则进程重启后 _route 永远 undefined，runCycle 里的闸门形同虚设'
  );
  assert.ok(
    /resolveVmRoute\(vm, null\)/.test(ydpcCode),
    '重建必须先尝试 spuCode（零网络权威信号，不依赖任何 HTTP 探测）'
  );
  assert.ok(
    /routeFromPersistedVendor\(vm\.vendor\)/.test(ydpcCode),
    'spuCode 不可用时必须回退纯函数 routeFromPersistedVendor，不得就地散写映射'
  );
});

test('接入点：保活轮与开机路径都必须在拨号前过闸门（且不再是名称猜测）', () => {
  const calls = (ydpcCode.match(/routeGate\s*\(/g) || []).length;
  assert.ok(calls >= 2, `闸门必须在保活轮与开机路径各过一道，实际 ${calls} 处`);
  assert.ok(
    /const gate = routeGate\(vm\._route \|\| null\);/.test(ydpcCode),
    '保活轮必须在 runCycle 内以 vm._route 过闸门（该处正是盲拨 ZTE 的发生地）'
  );
  assert.ok(
    /routeGate\(resolveVmRoute\(vmRef, firmAuth\)\)/.test(ydpcCode),
    '开机路径必须在 cag_boot 之前用**刚取到的** firmAuth 现算并过闸门'
  );
  assert.ok(
    !/\/深信服\|家庭\|SCG\/i/.test(ydpcCode),
    'refreshVms 不得再按 vmName/skuName 的名称字样猜测底座 —— 那是猜，不是判定'
  );
  assert.ok(
    /probeFailed && route\.kind === 'UNKNOWN'/.test(ydpcCode),
    '探测通道本身失败且无信号时不得写入判定（否则瞬时故障会固化成永久拒绝）'
  );
  assert.ok(
    /vm\._lastFailureKind = 'none';/.test(ydpcCode),
    '每轮必须复位失败等级 —— 否则一次瞬时失败会永久挂在卡片上，把"如实"变成恒常误报'
  );
});

// ============================================================================
// 组 24 · 失败分级（G2）：tokenRetry / soft / hard 三分类必须真的分得开
// ----------------------------------------------------------------------------
//   失败三分类（软失败 / 硬失败 / 未执行）。要避免两个方向的错：
//     ① 把"维护窗口 / 时长耗尽 / 限流"当硬失败 → 一维护就整轮熔断（假故障）；
//     ② 把"会话失效"静默吞掉 → 明明重登一次就好，却一直不保活。
//   还有一条**顺序红线**：TLS/证书类必须先于"到期"被识别，否则
//   `CERT_HAS_EXPIRED`（证书真过期）会被"套餐到期"的规则吞成软失败。
// ============================================================================
group('组 24 · 失败分级（G2）：tokenRetry / soft / hard 三分类');

test('行为：错误串必须被分到正确的一档（含关键反例 CERT_HAS_EXPIRED）', () => {
  const { classifyZteError } = productRoute;
  const eq = (text, expect) => assert.strictEqual(
    classifyZteError(text), expect,
    `classifyZteError(${JSON.stringify(text)}) 应为 ${expect}，实际 ${classifyZteError(text)}`
  );

  // tokenRetry：会话 / token 失效 —— 重登一次即可自愈
  eq('CSAP 用户会话已失效 (1000100)', 'tokenRetry');
  eq('移动爱家登录失败 (code 4001)', 'tokenRetry');
  eq('用户未登录', 'tokenRetry');

  // soft：已知非致命 —— 只告警，绝不熔断
  eq('当前计费周期时长已用完', 'soft');
  eq('套餐已到期', 'soft');
  eq('平台正在维护中', 'soft');
  eq('云电脑处于已关机状态', 'soft');
  eq('too many requests', 'soft');

  // hard：TLS / DNS / 网络层 / 未知 —— 兜底
  eq('CERT_HAS_EXPIRED', 'hard');
  eq('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'hard');
  eq('getaddrinfo ENOTFOUND gwyilian.ctyun.cn', 'hard');
  eq('fetch failed (ECONNRESET)', 'hard');
  eq('请求超时', 'hard');
  eq('未知的神秘错误 xyz', 'hard');
  eq('', 'hard');
  eq(null, 'hard');
  eq(undefined, 'hard');
});

test('行为：只有 hard 才应熔断（soft / tokenRetry 一律不熔断）', () => {
  const { shouldTripBreaker } = productRoute;
  assert.strictEqual(shouldTripBreaker('hard'), true, 'hard 必须熔断本轮');
  assert.strictEqual(shouldTripBreaker('soft'), false, 'soft 不得熔断 —— 否则一次维护窗口就变成假故障');
  assert.strictEqual(shouldTripBreaker('tokenRetry'), false, 'tokenRetry 不得熔断 —— 它的处理方式是重登重试');
});

test('接入点：保活轮必须按分级分流（重登重试 / 只告警 / 记异常）', () => {
  assert.ok(/const runWithGrade = async \(label, fn\)/.test(ydpcCode), '必须实现 runWithGrade 分级包装器');
  assert.ok(
    /if \(kind !== 'tokenRetry'\) return \{ kind, err: e1, retried: false \};[\s\S]{0,400}?await this\.login\(\)/.test(ydpcCode),
    'tokenRetry 必须真的重登一次再试（只分类不处理等于没做分级）'
  );
  assert.ok(/const hbFail = await runWithGrade\('SOHO 心跳'/.test(ydpcCode), 'SOHO 心跳必须走分级');
  assert.ok(/const cagFail = await runWithGrade\('CAG 握手'/.test(ydpcCode), 'CAG 握手必须走分级');
  assert.ok(/bump\('warn', `CAG 握手暂不可用\(软失败,不熔断\)/.test(ydpcCode), 'soft 必须走 warn 且文案写明"不熔断"');
  assert.ok(/bump\('error', `CAG 握手异常/.test(ydpcCode), 'hard 必须走 error');
});

// ============================================================================
// 组 25 · 诚实性不变量（G3）：双标志必须分离，keepaliveProven 恒为 false
// ----------------------------------------------------------------------------
//   两个概念必须**分成两个字段** ——
//     candidateAccepted  : 服务端接受过我们的动作（可以是真的）
//     desktopKeepaliveProven : 保活有效性是否被证明（硬编码 False）
//   理由是它自己的实测结论：响应被接受 ≠ 机器没被关机。
//
//   本项目的既有问题：诚实措辞只存在于散文注释里，**没有任何字段或断言锁住它**，
//   于是后人完全可以把"通道通了一次"顺势说成"保活已验证"而无人能拦。
//   本组把它固化为可执行不变量。
// ============================================================================
group('组 25 · 诚实性不变量（G3）：serverAccepted 与会话是否"被证明"必须分离');

test('静态：keepaliveProven 必须是字面量常量 false，不得被推导', () => {
  assert.ok(
    /keepaliveProven:\s*false\b/.test(ydpcCode),
    '必须显式给出 keepaliveProven 字段且为字面量 false'
  );
  assert.ok(
    !/keepaliveProven:\s*(?!\s*false\b)/.test(ydpcCode),
    'keepaliveProven 不得被赋成任何表达式 —— 它不是推导量，而是"本项目从未证明"的事实'
  );
  assert.ok(
    /serverAccepted:\s*!!\(this\.metrics/.test(ydpcCode),
    '必须另有 serverAccepted 字段承载"服务端接受过"这一（可为真的）事实'
  );
});

test('行为：无论服务端接受多少次、失败等级如何，keepaliveProven 都必须为 false', () => {
  const proto = loadYdpcHarness();
  const now = Date.now();
  const vm = {
    userServiceId: '7001', vmName: '西安A', vmStatus: '运行中', vmStatusCode: 1,
    keepaliveEnabled: true, lastKeepAliveAt: now - 30 * 1000
  };

  // ① 服务端大量接受过、且没有任何失败 —— 最"像成功"的场景
  const ctxOk = makeViewCtx(proto);
  ctxOk.metrics.successCount = 999;
  const okView = proto.describeVmKeepAlive.call(ctxOk, vm);
  assert.strictEqual(okView.serverAccepted, true, 'successCount>0 时 serverAccepted 必须为 true');
  assert.strictEqual(
    okView.keepaliveProven, false,
    'serverAccepted=true 只证明管道通，绝不能顺势变成"保活已被证明"'
  );

  // ② 服务端从未接受过
  const ctxNone = makeViewCtx(proto);
  ctxNone.metrics.successCount = 0;
  assert.strictEqual(proto.describeVmKeepAlive.call(ctxNone, vm).keepaliveProven, false, '恒 false');
  assert.strictEqual(proto.describeVmKeepAlive.call(ctxNone, vm).serverAccepted, false, '未接受过时必须为 false');

  // ③ 携带失败等级 / 路由判定时同样恒 false，且字段如实带出
  const ctxHard = makeViewCtx(proto);
  ctxHard.metrics.successCount = 5;
  const hardView = proto.describeVmKeepAlive.call(ctxHard, {
    ...vm, _lastFailureKind: 'hard', _lastFailureText: 'ECONNRESET', _route: { kind: 'ZTE', supported: true }
  });
  assert.strictEqual(hardView.keepaliveProven, false, '硬失败下更不可能"被证明"');
  assert.strictEqual(hardView.keepaliveProven, false, '同上');
  assert.strictEqual(hardView.failureKind, 'hard', 'failureKind 必须如实带出 runCycle 的分级结论');
  assert.strictEqual(hardView.routeKind, 'ZTE', 'routeKind 必须如实带出 G1 的底座判定');
});

test('行为：失败等级必须驱动基调（soft→warn / hard→error，且不得冒充"保活运行中"）', () => {
  const proto = loadYdpcHarness();
  const now = Date.now();
  const base = {
    userServiceId: '7002', vmName: '西安B', vmStatus: '运行中', vmStatusCode: 1,
    keepaliveEnabled: true, lastKeepAliveAt: now - 30 * 1000
  };

  const soft = proto.describeVmKeepAlive.call(makeViewCtx(proto), { ...base, _lastFailureKind: 'soft', _lastFailureText: '平台维护中' });
  assert.strictEqual(soft.tone, 'warn', `soft 应为 warn 基调（复用既有 🟠），实际 ${soft.tone}`);
  assert.ok(soft.actionText.includes('暂不可用'), `soft 的当前动作应写明通道不可用，实际: ${soft.actionText}`);

  const hard = proto.describeVmKeepAlive.call(makeViewCtx(proto), { ...base, _lastFailureKind: 'hard', _lastFailureText: 'ECONNRESET' });
  assert.strictEqual(hard.tone, 'error', `hard 应为 error 基调（复用既有 🔴），实际 ${hard.tone}`);
  assert.notStrictEqual(hard.actionText, '保活运行中', '真失败绝不能被渲染成"保活运行中"');

  // 未发生失败时不得无端降级（否则"如实"变成"永远报警"，一样是失真）
  const clean = proto.describeVmKeepAlive.call(makeViewCtx(proto), base);
  assert.strictEqual(clean.tone, 'ok', `无失败时应保持 ok，实际 ${clean.tone}`);

  // 底座闸门拒绝必须显式说出来 —— 否则会呈现成"在保活但没效果"，这是最失真的一种展示
  const gated = proto.describeVmKeepAlive.call(makeViewCtx(proto), {
    ...base, _route: { kind: 'SCG', supported: false, reason: 'spuCode=sc-cloud-pc' }
  });
  assert.strictEqual(gated.tone, 'warn', `底座不支持应为 warn 基调，实际 ${gated.tone}`);
  assert.ok(gated.actionText.includes('底座不支持'), `当前动作必须写明底座不支持，实际: ${gated.actionText}`);
  assert.ok(gated.actionText.includes('SCG'), `应带出具体底座，实际: ${gated.actionText}`);
  assert.strictEqual(gated.routeKind, 'SCG', 'routeKind 必须如实带出');
  assert.notStrictEqual(gated.actionText, '保活运行中', '被闸门拒绝的机器不得渲染成"保活运行中"');
});

// ============================================================================
// 组 26 · 地址族路由（G5）：内层主机决定数据面通道，不得一律走 raw
// ----------------------------------------------------------------------------
//   为什么值得单独立组：既有 zte_cag_raw.js 只实现了 IPv6 raw 路径，而它的
//   `ipv6ToBytes()` 遇到 IPv4 字面量会抛 `非法 IPv6 段` —— 那一抛发生在
//   `sock.on('data')` 回调里、**不在 Promise 链上**：既成为未捕获异常，又让返回的
//   Promise 一直挂到 15s 超时。于是这台机器的失败既不是 tokenRetry 也不是 soft/hard，
//   而是**绕过了 G2 失败分级**（无人接管）。
//
//   正确口径：地址族由 connectStr
//   解出的**内层主机字面量**决定，是「每台每次取材料」的属性，**不是账号属性** ——
//   官方同一次取材料会同时给 `-h`(IPv4) 与 `--hv6`(IPv6)，两条通道完全不同。
//     含 `:`          ⇒ raw ZTEC（50B 短头 + 220B blob，不升 TLS）
//     点分四段十进制   ⇒ TLS + CAGMux + raw SPICE（178B 长头 → 同 socket 升 TLS）
//     其余（空/主机名）⇒ 明确拒绝 —— 绝不"先按 raw 试一下"
// ============================================================================
group('组 26 · 地址族路由（G5）：内层主机决定数据面通道，不得一律走 raw');

const innerRouteOf = productRoute.resolveInnerRoute;
const isIpv4LiteralFn = productRoute.isIpv4Literal;

test('静态：判定必须收敛到纯函数，且 ydpc 必须在**拨号前**按 path 分流', () => {
  assert.strictEqual(typeof innerRouteOf, 'function', 'product_route.js 必须导出 resolveInnerRoute');
  assert.ok(/resolveInnerRoute/.test(ydpcCode), 'ydpc_client.js 必须调用 resolveInnerRoute 判定地址族');
  assert.ok(
    /if\s*\(\s*innerRoute\.path === 'reject'\s*\)/.test(ydpcCode),
    "path==='reject' 时必须拒绝拨号 —— 不得猜测通道后继续"
  );
  assert.ok(/if\s*\(\s*innerRoute\.path === 'tls'\s*\)/.test(ydpcCode), 'tls 分支必须显式分流');
  assert.ok(/runTlsSpiceSession\s*\(/.test(ydpcCode), 'tls 分支必须调用 runTlsSpiceSession');
  assert.ok(/dialCagTcpRaw\s*\(/.test(ydpcCode), 'raw 分支必须保留 dialCagTcpRaw');
  assert.ok(
    /require\(\s*'\.\/zte_cag_tls'\s*\)/.test(ydpcCode),
    'ydpc_client.js 调用了 runTlsSpiceSession，却未 require ./zte_cag_tls —— 运行期必然 ReferenceError'
  );
  const iRoute = ydpcCode.indexOf('resolveInnerRoute(');
  const iRaw = ydpcCode.indexOf('dialCagTcpRaw(');
  assert.ok(
    iRoute > -1 && iRaw > -1 && iRoute < iRaw,
    '地址族判定必须早于 raw 拨号 —— 否则又是在 sock 回调里撞，异常无人接管'
  );
});

test('行为：内层主机字面量必须分到正确的通道（IPv6→raw / IPv4→tls / 其余→拒绝）', () => {
  const r6 = innerRouteOf('2409:8c70:3a50:24f7::534');
  assert.strictEqual(r6.path, 'raw', 'IPv6 字面量必须走 raw ZTEC');
  assert.strictEqual(r6.family, 'ipv6', 'kind 必须是 ipv6');

  const r4 = innerRouteOf('36.133.100.80');
  assert.strictEqual(r4.path, 'tls', 'IPv4 字面量必须走 TLS+CAGMux+SPICE，而不是 raw');
  assert.strictEqual(r4.family, 'ipv4', 'family 必须是 ipv4');

  // 带 zone id 的链路本地 IPv6 仍属 IPv6 字面量
  assert.strictEqual(innerRouteOf('fe80::1%eth0').path, 'raw', '带 %zone 的 IPv6 仍走 raw');
  // IPv4 边界：0 与 255 都是合法段，且必须容忍两端空白
  assert.strictEqual(innerRouteOf('0.0.0.0').path, 'tls');
  assert.strictEqual(innerRouteOf('255.255.255.255').path, 'tls');
  assert.strictEqual(innerRouteOf(' 10.1.2.3 ').path, 'tls', '两端空白必须被容忍');

  // 拒绝猜测：既非 IPv4 也非 IPv6 字面量一律拒绝
  const bad = ['', null, undefined, 'example.com', 'cloud-pc.internal',
    '10.1.2', '10.1.2.3.4', '10.1.2.256', '1.2.3.a', '999.1.1.1'];
  for (const b of bad) {
    const r = innerRouteOf(b);
    assert.strictEqual(r.path, 'reject', `非字面量内层主机必须被拒绝：${JSON.stringify(b)} → ${r.path}`);
    assert.ok(r.reason && r.reason.length > 0, '拒绝必须带可读原因');
  }

  // 判据本身：必须只认"点分四段、每段 0-255 的十进制"
  assert.strictEqual(isIpv4LiteralFn('1.2.3.4'), true, '1.2.3.4 是 IPv4');
  assert.strictEqual(isIpv4LiteralFn('1.2.3'), false, '三段不是 IPv4');
  assert.strictEqual(isIpv4LiteralFn('2409::1'), false, 'IPv6 不是 IPv4');
  assert.strictEqual(isIpv4LiteralFn('10.1.2.3.4'), false, '五段不是 IPv4');
  assert.strictEqual(isIpv4LiteralFn('abc.def.ghi.jkl'), false, '非数字段不是 IPv4');
});

test('静态：状态视图不得把通道名写死（地址族是每台的属性，写死会误标 IPv4 机器）', () => {
  const m = ydpcCode.match(/describeVmKeepAlive\(vm\) \{[\s\S]*?\n  \}/);
  assert.ok(m, '未找到 describeVmKeepAlive 实现');
  assert.ok(
    !/数据面保活中 \(raw ZTEC\)/.test(m[0]),
    'describeVmKeepAlive 不得把通道名写死为 raw ZTEC —— IPv4/TLS 机器会被误标成 raw'
  );
  assert.ok(
    /dataPlanePath|dpChannel/.test(m[0]),
    '必须按任务实际 path 推导通道名（raw=IPv6 / tls=IPv4）'
  );
});

// ============================================================================
// 组 27 · IPv4/TLS 数据面（G5）：受控降级 + 异常就地收敛
// ----------------------------------------------------------------------------
//   两个必须守住的点，都直接来自 2026-09-23 的实证与事故：
//   ① **证书校验受控降级**：CAG 服务端只下发叶证书、无中间 CA ⇒ 严格校验必失败
//      （UNABLE_TO_VERIFY_LEAF_SIGNATURE）。因此允许降级，但只允许在"证书链缺陷"
//      白名单内、且必须留证。网络抖动这类通用错误**绝不能**触发降级 —— 那等于
//      把"关掉证书校验"变成默认行为。
//   ② **data 回调必须就地收敛异常**：blob 构造（IPv4 编码）抛错过去发生在
//      `sock.on('data')` 里、不在 Promise 链上 ⇒ 未捕获异常 + Promise 挂到超时
//      ⇒ 绕过 G2 分级。这条已在两个通道文件里修好，必须锁住不得回退。
// ============================================================================
group('组 27 · IPv4/TLS 数据面（G5）：受控降级 + 异常就地收敛');

const tlsCode = stripComments(read('app/ydpc/zte_cag_tls.js'));
const rawCode = stripComments(read('app/ydpc/zte_cag_raw.js'));
// eslint-disable-next-line global-require
const tlsMod = require(path.join(ROOT, 'app/ydpc/zte_cag_tls.js'));

test('静态：证书校验必须"严格先行 + 白名单降级"，不得无条件关校验', () => {
  assert.ok(!/CERT_NONE/.test(tlsCode), '不得使用 CERT_NONE —— 证书校验不可被完全绕过');
  assert.ok(
    /CERT_CHAIN_ERROR_CODES/.test(tlsCode) && /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(tlsCode),
    '必须存在证书链错误码白名单（不得笼统 catch 所有 TLS 错误后放行）'
  );
  assert.ok(
    /rejectUnauthorized\s*=\s*false/.test(tlsCode),
    '受控降级必须有"放宽校验"的实现，否则降级是空话'
  );
  assert.ok(
    /if\s*\(\s*allowInsecure\s*\)/.test(tlsCode),
    'rejectUnauthorized=false 必须受 allowInsecure 显式开关约束 —— 默认必须走严格校验'
  );
  assert.ok(
    !/\{\s*[^}]*rejectUnauthorized\s*:\s*false[^}]*\}/.test(tlsCode),
    '不得在请求选项里写死 rejectUnauthorized:false（那是无条件关校验）'
  );
  assert.ok(
    /dialCagTcpTlsOnce\(opts, false\)/.test(tlsCode),
    '必须严格校验先行：第一次拨号必须以 allowInsecure=false 发起'
  );
  assert.ok(
    /CERT_CHAIN_ERROR_CODES\.some\(/.test(tlsCode),
    '是否降级必须查白名单判定，不得无条件重试'
  );
  assert.ok(
    /TLS 证书链验证失败/.test(tlsCode) && /受控降级/.test(tlsCode),
    '降级必须留证 —— 必须打一条含 host + 错误码的 warning'
  );
});

test('行为：证书链白名单只能含证书链缺陷，不得混入通用网络/协议错误', () => {
  const codes = tlsMod.CERT_CHAIN_ERROR_CODES;
  assert.ok(Array.isArray(codes) && codes.length > 0, '必须导出证书链错误码白名单');
  assert.ok(
    codes.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    '必须含实测命中的 UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  );
  const generic = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ERR_SSL_WRONG_VERSION_NUMBER'];
  for (const g of generic) {
    assert.ok(
      !codes.includes(g),
      `白名单不得包含通用网络/协议错误码 ${g} —— 否则一次网络抖动就会触发"无条件放宽校验"`
    );
  }
});

test('静态：TLS 与 raw 拨号的 data 回调都必须就地收敛异常（不得复活未捕获异常）', () => {
  assert.ok(
    /try\s*\{\s*handleData\(chunk\);\s*\}/.test(tlsCode),
    'zte_cag_tls.js 的 data 回调必须 try/catch 包住 handleData —— ' +
      '否则 blob 构造抛错会成为未捕获异常，并让 Promise 挂到超时、绕过 G2 分级'
  );
  assert.ok(
    /try\s*\{\s*handleData\(chunk\);\s*\}/.test(rawCode),
    'zte_cag_raw.js 的 data 回调必须 try/catch 包住 handleData（2026-09-23 修复的缺陷，不得回退）'
  );
});

testAsync('行为：严格先行 + 非证书错误绝不触发降级重拨（只拨一次）', async () => {
  // eslint-disable-next-line global-require
  const net = require('net');
  let accepts = 0;
  // 一个"接了立刻掐断"的假 CAG 端点：认证不可能完成，且错误**不是**证书链缺陷。
  const srv = net.createServer((sock) => { accepts++; sock.destroy(); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    let threw = null;
    try {
      await tlsMod.dialCagTcpTls({
        outerHost: '127.0.0.1', outerPort: port,
        innerHost: '10.0.0.1', innerPort: 5100, proxySport: 60065,
        vmId: '0'.repeat(36), timeoutMs: 4000
      });
    } catch (e) { threw = e; }
    assert.ok(threw, '连接被立即掐断时必须抛错，不得静默成功');
    assert.strictEqual(
      accepts,
      1,
      `非证书链错误不得触发降级重拨 —— 期望只拨 1 次，实际 ${accepts} 次` +
        `（若为 2 次，说明降级判定退化成了"无条件重试"，等价于默认关掉证书校验）`
    );
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

// ============================================================================
// 组 28 · 例行日志折叠计数（xN）按天清零（用户 2026-09-26）
// ----------------------------------------------------------------------------
// 用户原话：「[ZTE样本主号] progress hb_sent=261 hb_recv=555 data=5 left=637sx4056
//            类似这样的日志，要按天清零，不然一直循环下去增加数量了。0点更新一下吧。」
// 即：折叠徽章 xN 只增不减（x4056 → x4057 …）→ 改为**按北京时间每天 0 点归 1**，
// 当天内照旧累计，界面上的 xN 于是表示"今日重复次数"。三条不可破的边界：
//   ① 只动 routineFoldKey 非空的**例行日志**；异常 / 业务条目一条都不许碰（取证红线）；
//   ② 只把 repeatCount 归 1 —— 不改文本、不删条目、不动磁盘原始流水；
//   ③ 双保险：appendLog 惰性检查（进程休眠/重启后补上）+ 北京 0 点自续期定时器。
// ============================================================================
group('组 28 · 例行日志折叠计数（xN）按天清零：只动例行、只归 1、北京 0 点');

/** 造一套"真 ingestLogEntry + 真 rolloverRoutineFoldCountsIfNeeded"的沙箱（"今天"由 dayRef 控制） */
function makeRolloverHarness(dayRef) {
  const code = [
    extractFunctionFrom(server, 'normalizeRoutineDigits'),
    extractServerConst('ROUTINE_MESSAGE_PATTERNS'),
    extractFunctionFrom(server, 'routineFoldKey'),
    extractServerConst('routineFoldIndex'),
    extractFunctionFrom(server, 'routineFoldIndexKey'),
    extractFunctionFrom(server, 'isHeartbeatOrRoutine'),
    extractServerConst('routineFoldDay'),
    extractFunctionFrom(server, 'rolloverRoutineFoldCountsIfNeeded'),
    extractFunctionFrom(server, 'ingestLogEntry'),
  ].join('\n');

  const logs = [];
  const sseClients = new Set();
  let tick = 0;
  const clock = () => {
    const n = tick++;
    return `2026-09-26 00:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  };
  // eslint-disable-next-line no-new-func
  const api = new Function(
    'logs', 'sseClients', 'canUserSeeLog', 'getBeijingTimeString', 'getBeijingDateOnly',
    `${code}\nreturn { ingestLogEntry, routineFoldIndex, rolloverRoutineFoldCountsIfNeeded };`
  )(logs, sseClients, () => true, clock, () => dayRef.value);

  return {
    logs,
    ingest: (source, accountName, message, level = 'info') =>
      api.ingestLogEntry({
        id: `log_${logs.length + 1}_${tick}`,
        timestamp: clock(),
        source, message, level, accountName,
        platform: 'ydpc', repeatCount: 1,
      }),
    rollover: () => api.rolloverRoutineFoldCountsIfNeeded(false),
    find: (needle) => logs.filter((l) => String(l.message).includes(needle)),
  };
}

test('行为：跨天把例行日志的 xN 归 1；同一天内绝不重置（锁死"每次调用都清零"）', () => {
  const dayRef = { value: '2026-09-26' };
  const h = makeRolloverHarness(dayRef);
  const acc = 'ZTE样本主号';
  const progress = (k) => `[${acc}] progress hb_sent=${k * 10} hb_recv=${300 + k} data=1 left=${900 - k}s`;
  for (let k = 1; k <= 5; k++) h.ingest('CAGRAW', acc, progress(k));

  const e = h.find('progress hb_sent=')[0];
  assert.ok(e, 'progress 心跳必须已入库');
  assert.strictEqual(e.repeatCount, 5, `当天内应累计到 5，实际 ${e.repeatCount}`);

  // ① 同一天里调用：必须"什么都不做" —— 否则当天计数被反复清零，xN 永远停在 1，折叠形同虚设
  assert.strictEqual(h.rollover(), 0, '同一天内的清理调用必须返回 0（无条目被重置）');
  assert.strictEqual(e.repeatCount, 5, '同一天内绝不允许清零');

  // ② 跨天：归 1
  dayRef.value = '2026-09-27';
  assert.strictEqual(h.rollover(), 1, '跨天应重置 1 条');
  assert.strictEqual(e.repeatCount, 1, '跨天后 xN 必须归 1');
  assert.strictEqual(h.rollover(), 0, '同一天内重复调用不得再重置');
});

test('行为：跨天只动例行日志 —— 异常条目、条目数、文本一律不得改变（取证红线）', () => {
  const dayRef = { value: '2026-09-26' };
  const h = makeRolloverHarness(dayRef);
  const acc = 'ZTE样本主号';
  const errMsg = `[${acc}] 隧道建立失败：ECONNRESET`;
  h.ingest('CAGRAW', acc, errMsg, 'error');
  h.ingest('CAGRAW', acc, errMsg, 'error'); // 完全同文本相邻重复 ⇒ 折叠成 x2
  h.ingest('CAGRAW', acc, `[${acc}] progress hb_sent=10 hb_recv=1 data=1 left=890s`);
  h.ingest('CAGRAW', acc, `[${acc}] progress hb_sent=20 hb_recv=2 data=1 left=880s`);

  const err = h.find('隧道建立失败')[0];
  const prog = h.find('progress hb_sent=')[0];
  assert.ok(err && prog, '两类日志都必须已入库');
  assert.strictEqual(err.repeatCount, 2, '前提：非例行日志也会因完全同文本相邻重复而折叠');
  assert.strictEqual(prog.repeatCount, 2, '前提：例行日志当天累计到 2');

  const beforeLen = h.logs.length;
  const errTextBefore = err.message;

  dayRef.value = '2026-09-27';
  const n = h.rollover();
  assert.strictEqual(n, 1, `跨天只应重置 1 条（例行那条），实际 ${n}`);
  assert.strictEqual(err.repeatCount, 2, '⚠️ 非例行（异常）条目的计数绝不允许被跨天清零');
  assert.strictEqual(prog.repeatCount, 1, '例行日志的计数应被归 1');
  assert.strictEqual(h.logs.length, beforeLen, '清零不得增删任何条目');
  assert.strictEqual(err.message, errTextBefore, '清零不得改写任何日志文本');
});

test('静态：清零必须落在 appendLog（落新日志之前）+ 北京 0 点自续期定时器', () => {
  const appendSrc = stripLineComments(extractFunctionFrom(server, 'appendLog'));
  const callAt = appendSrc.indexOf('rolloverRoutineFoldCountsIfNeeded');
  assert.ok(callAt > -1, 'appendLog 必须调用 rolloverRoutineFoldCountsIfNeeded');
  const buildAt = appendSrc.indexOf('buildLogEntry');
  assert.ok(buildAt > -1, '无法定位 appendLog 里的 buildLogEntry（结构已变，请同步本断言）');
  assert.ok(
    callAt < buildAt,
    '清零必须在落新日志之前 —— 否则跨天后的第一条会先把 xN+1 再被削回，出现 x(N+1) 瞬时值'
  );

  assert.ok(/function scheduleRoutineFoldDayRollover\s*\(/.test(server), '必须存在 0 点定时器函数');
  assert.ok(
    /msUntilNextBeijingMidnight/.test(server),
    '定时器必须以"距下一个北京 0 点的毫秒数"为界（不得写死 86400000 轮询）'
  );
  assert.ok(
    /scheduleRoutineFoldDayRollover\(\)\s*;/.test(server),
    '定时器必须在启动时就排程（否则第一个 0 点不会触发）'
  );
  assert.ok(
    /routineFoldDay\s*=\s*getBeijingDateOnly\(\)/.test(server),
    '跨天判定必须用北京日期（getBeijingDateOnly），不得用 UTC / 本地日期'
  );
  assert.ok(
    /rolloverRoutineFoldCountsIfNeeded\(true\)/.test(server),
    '定时器路径必须以 notify=true 调用，界面才会在 0 点即时清掉徽章'
  );
});

test('静态：清零函数只允许"归 1"，不得删条目 / 改文本 / 触碰非例行日志', () => {
  const src = stripLineComments(extractFunctionFrom(server, 'rolloverRoutineFoldCountsIfNeeded'));
  assert.ok(/routineFoldKey\s*\(/.test(src), '必须用 routineFoldKey 过滤出例行日志');
  assert.ok(
    /if\s*\(\s*!routineFoldKey\([\s\S]*?\)\s*\)\s*continue\s*;/.test(src),
    '非例行日志必须 continue 跳过（绝不允许被清零）'
  );
  assert.ok(/repeatCount\s*=\s*1\s*;/.test(src), '必须把 repeatCount 归 1');
  assert.ok(/today\s*===\s*routineFoldDay/.test(src), '同日必须直接返回（否则当天计数会被反复清零）');
  assert.ok(!/logs\.(splice|shift|pop)\s*\(/.test(src), '只允许改计数，不得增删内存条目');
  assert.ok(!/entry\.message\s*=[^=]/.test(src), '不得改写任何日志文本（取证红线）');
});

// ============================================================================
// 组 29 · 平台口径必须可回放：状态变化留证 + 在线时长回退告警（用户 2026-09-26）
// ----------------------------------------------------------------------------
// 事故：公众样本账号「我的电脑」09-26 02:01 **真关机**（用户从云电脑自身系统取到的开机/
// 关机时间），我们的卡片却从那一刻起一直显示「运行中」，L1/L2 一路"正常"。
// 复盘才发现：平台原始 `resourceStatus`（当时 available）**从未进过日志** —— 它只落在
// app_config.json 的最后一帧 ⇒ 历史无法回放，只能靠"在线时长"数字反推。
// 本组锁死补上的两条观测：
//   ① 平台电源状态**变化时**必须留一条日志（含原始 resourceStatus 与归一后的 powerState）；
//   ② 平台「在线时长」**回退时**必须告警（回退 = 平台侧会话记录被重建 ⇒ 极可能刚关机/重启）。
// 另锁死"在线时长解析"这一纯函数 —— 它是回退判定的地基，解析错则整条哑火。
// ============================================================================
group('组 29 · 平台口径可回放：状态变化留证 + 在线时长回退告警');

/** 抽取类方法（extractFunctionFrom 只认 `function name(`，方法需自己配平大括号） */
function extractMethodFrom(src, anchor) {
  const i = src.indexOf(anchor);
  assert.ok(i > -1, `无法定位方法 ${anchor}（结构已变，请同步本断言）`);
  const j = src.indexOf('{', i);
  let depth = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  assert.fail(`${anchor} 的大括号不平衡，无法抽取`);
}

test('行为：平台「在线时长」解析必须正确（回退判定的地基，解析错则整条哑火）', () => {
  const ecSrc = read('app/ecloud/ecloud_client.js');
  const fnSrc = extractFunctionFrom(ecSrc, 'parseUptimeSeconds');
  // eslint-disable-next-line no-new-func
  const parseUptimeSeconds = new Function(`${fnSrc}\nreturn parseUptimeSeconds;`)();

  // 真机原值（取自 data/logs/dashboard-2026-09-26.jsonl，可回放核对）
  assert.strictEqual(parseUptimeSeconds('10小时14分33秒'), 36873, '10小时14分33秒 应 = 36873 秒');
  assert.strictEqual(parseUptimeSeconds('57小时37分49秒'), 207469, '57小时37分49秒 应 = 207469 秒');
  assert.strictEqual(parseUptimeSeconds('0小时15分29秒'), 929, '0小时15分29秒 应 = 929 秒');
  assert.strictEqual(parseUptimeSeconds('8秒'), 8, '8秒 应 = 8');
  assert.strictEqual(parseUptimeSeconds('4小时'), 14400, '只给小时也要能算');
  // 未知一律 -1 —— 绝不猜 0（猜 0 会让"回退告警"误触发/漏触发）
  assert.strictEqual(parseUptimeSeconds(''), -1, '空串必须返回 -1');
  assert.strictEqual(parseUptimeSeconds('—'), -1, '占位符必须返回 -1');
  assert.strictEqual(parseUptimeSeconds(null), -1, 'null 必须返回 -1');
});

test('静态：平台电源状态变化必须留证（含原始 resourceStatus，否则事后无法回放）', () => {
  const ecSrc = read('app/ecloud/ecloud_client.js');
  const body = stripLineComments(extractMethodFrom(ecSrc, 'async refreshDesktops()'));
  assert.ok(/resourceStatus/.test(body), 'refreshDesktops 必须读原始 resourceStatus');
  assert.ok(
    /rawPrev\s*!==\s*rawNow/.test(body),
    '必须按"取值是否变化"决定是否留证（变化才写，避免刷屏）'
  );
  assert.ok(/平台电源状态/.test(body), '必须有一条"平台电源状态…"的事件日志');
  assert.ok(
    /_log\(/.test(body) && /powerState/.test(body),
    '该日志必须同时给出归一后的 powerState，便于对照平台原文'
  );
});

test('静态：在线时长回退必须告警（回退 = 平台侧会话记录被重建）', () => {
  const ecSrc = read('app/ecloud/ecloud_client.js');
  const body = stripLineComments(extractMethodFrom(ecSrc, 'async keepaliveL2(desktop)'));
  assert.ok(/parseUptimeSeconds\(/.test(body), 'keepaliveL2 必须解析在线时长');
  assert.ok(/upNow\s*<\s*upPrev/.test(body), '必须比较"本次 < 上次"才算回退');
  assert.ok(/UPTIME_REGRESSION_MIN_SEC/.test(body), '回退判定必须用具名阈值常量');
  assert.ok(/在线时长回退/.test(body), '回退必须落一条可读告警');
  assert.ok(
    /_uptimeSeconds\s*=/.test(body),
    '必须把本次秒数存进 `_` 前缀字段（跨刷新保留），否则永远比不出回退'
  );
  assert.ok(
    /不是虚机运行时长/.test(ecSrc),
    '源码必须写明"在线时长 ≠ 虚机运行时长"的纠偏结论（本次实测得出，防后人误当运行时长用）'
  );
});

// ============================================================================
// 组 30 · SCG 数据面（深信服底座）：第二套通道的协议 / 红线 / 诚实性
// ----------------------------------------------------------------------------
// 为什么单独立组：SCG 与 ZTE 是**两条完全不同的数据面**，且 SCG 的实现是照
// 官方客户端（Go chuanyun）同源行为，**逐字节对齐协议格式**而来。
// "抄协议格式"这件事本身没问题，但它有两个必须被机械拦住的危险：
//   ① 协议常量与身份材料错抄乱带（伪造服务端 UA / CERT_NONE 关校验）；
//   ② 协议格式错一个字节（帧头长度、ExtInfo 长度、偏移量）不会有任何报错，
//      只会在真机上"连得上但永远收不到显示数据"，且看起来像"平台不给"。
//
// 【2026-09-26 真机实测更正】此前本组注释与断言消息里写着"我们不需要 CEM：
// firm-auth 已直接下发 scgIp/scgTcpPort/scAuthCode"——**这条前提是错的**。真机对照确认：
// 产品路径**从不使用 firm-auth 的 scgIp** —— 只取 scAuthCode，而 scgIp/scgTcpPort/
// 刷新后的 scAuthCode 全部由 CEM `getConnectInfo` 下发，
// 且**这一步本身会触发 SCG 会话开通/机器开机**。
// ⇒ 真机"服务端零应答"的机制性成因正是缺了这一步（网关没有属于该会话的上下文）。
// 【2026-09-26 用户放宽红线】经真机四轮探针实证后，用户批准在**保活路径**引入 CEM
// 控制面（OAuth ext grant → getConnectInfo → 就绪轮询），含官方 SDK 内嵌的 client_id 与
// sdk2 RSA 公钥（公钥非机密；伪造服务端 UA cdpsdk-server 与 CERT_NONE 仍然禁止）。
// 本组把"放宽了什么 / 仍然禁止什么 / CEM 必须先于拨号"都固化为可执行断言。
//
// ⚠️ 本组**不**声称 SCG 保活已生效。它锁的只是"我们有没有按协议正确实现、
//    有没有越红线、有没有如实报告"。真机是否被保活，只有实跑才算。
// ============================================================================
group('组 30 · SCG 数据面（深信服底座）：第二套通道的协议 / 红线 / 诚实性');

const SCG_PATH = 'app/ydpc/scg_keepalive.js';
const scgCode = stripComments(read(SCG_PATH));
// eslint-disable-next-line global-require
const scg = require(path.join(ROOT, SCG_PATH));

test('静态：SCG 的 CEM 控制面已获批准（2026-09-26），但 boot 引擎脏手段仍然禁止', () => {
  // 【已放宽】client_id（官方 SDK 内嵌）与 sdk2 公钥允许出现在本文件（组 7 指纹同步豁免）。
  // 【仍禁止】伪造服务端 UA（cdpsdk-server）、CERT_NONE、
  //           无条件关校验、IP 字面量、PEM 形态的公钥字面量、历史脏通道模块引用。
  assert.ok(
    !/cdpsdk-server/.test(scgCode),
    'SCG 通道不得出现 cdpsdk-server（伪造服务端身份串）；保活用的是 cdpsdk-macos 客户端 UA'
  );
  assert.ok(!/CERT_NONE/.test(scgCode), '不得使用 CERT_NONE —— 证书校验不可被完全绕过');
  assert.ok(
    !/\{\s*[^}]*rejectUnauthorized\s*:\s*false[^}]*\}/.test(scgCode),
    '不得在 TLS 选项里写死 rejectUnauthorized:false —— 那等价于无条件关校验'
  );
  assert.ok(
    // 官方 SDK UA（cdpsdk-macos-2.18.21(2.18.21.159)）的版本号形似 IPv4，扫描前剔除
    !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(scgCode.replace(/cdpsdk-macos-[^(]*\([^)]*\)/g, '')),
    'SCG 通道不得硬编码任何 IP —— 数据面端点必须来自 CEM getConnectInfo 下发的会话绑定材料'
  );
  assert.ok(
    !/-----BEGIN[^-]{0,30}PUBLIC KEY-----[\s\S]{100,}-----END/.test(scgCode),
    '不得内嵌完整 PEM 形态 RSA 公钥字面量 —— SPICE ticket 公钥必须取自服务端本次下发的 LinkReply' +
      '（CEM sdk2 公钥以裸 base64 常量存在，不受本条约束）'
  );
});

test('静态：CEM 控制面必须先于数据面拨号（材料校验 → CEM 三步 → scgConnect）', () => {
  assert.ok(
    /prepareScgSession\(/.test(scgCode) && /cemExchangeToken/.test(scgCode) &&
      /cemGetConnectInfo/.test(scgCode) && /cemBootVm/.test(scgCode),
    'CEM 开机/会话链（OAuth 换 token / getConnectInfo / cemBootVm）必须齐备'
  );
  // 顺序契约：材料校验必须先于任何网络动作（缺料先行拒绝），CEM 必须先于 scgConnect
  // （跳过 CEM 直接拨号 = 边缘无会话上下文 = 静默丢包，正是本轮根因）。
  const iMaterial = scgCode.indexOf('resolveScgMaterial(firmAuth)');
  const iCem = scgCode.indexOf('prepareScgSession(material');
  const iDial = scgCode.indexOf('scgConnect({');
  assert.ok(iMaterial >= 0, 'runScgSession 必须先做材料校验');
  assert.ok(iCem > iMaterial, 'CEM 会话准备必须发生在材料校验之后');
  assert.ok(iDial > iCem, '数据面拨号（scgConnect）必须使用 CEM 会话材料，不得先于 CEM');
  // 就绪轮询未达标必须显式拒绝，不得拿未就绪材料硬拨（那会回到静默丢包的老路）
  assert.ok(
    /SCG_CEM_NOT_READY/.test(scgCode) && /SCG_CEM_MATERIAL_MISSING/.test(scgCode),
    'CEM 未就绪 / 材料缺失必须有独立错误码（不得静默降级为直拨）'
  );
});

test('静态：TLS 必须"严格先行 + 证书链白名单降级一次 + 留证"，非证书错误绝不降级', () => {
  assert.ok(
    /CERT_CHAIN_ERROR_CODES/.test(scgCode) && /UNABLE_TO_VERIFY_LEAF_SIGNATURE/.test(scgCode),
    '必须存在证书链错误码白名单（不得笼统 catch 所有 TLS 错误后放行）'
  );
  assert.ok(
    /rejectUnauthorized\s*:\s*!allowInsecure/.test(scgCode),
    'TLS 校验必须由 allowInsecure 显式驱动（rejectUnauthorized: !allowInsecure）'
  );
  assert.ok(
    /scgConnectOnce\(\{\s*\.\.\.opts,\s*allowInsecure:\s*false\s*\}\)/.test(scgCode),
    '必须严格校验先行：第一次拨号必须以 allowInsecure=false 发起'
  );
  assert.ok(
    /if\s*\(\s*!CERT_CHAIN_ERROR_CODES\.includes\(code\)\s*\)\s*throw\s+e\s*;/.test(scgCode),
    '是否降级必须查白名单判定 —— 不得无条件重试（那等于默认关掉证书校验）'
  );
  // 白名单闸门必须同时守着**两处**降级点：数据面（scgConnect）与 CEM 请求（cemRequestStrict）。
  // 只数一处的话，拆掉另一处不会被静态断言发现（2026-09-26 M71 漏网教训）。
  const whitelistGates = (scgCode.match(/if\s*\(\s*!CERT_CHAIN_ERROR_CODES\.includes\(code\)\s*\)\s*throw\s+e\s*;/g) || []).length;
  assert.ok(
    whitelistGates >= 2,
    `证书链白名单闸门必须同时覆盖数据面与 CEM 请求（期望 ≥2 处，实际 ${whitelistGates} 处）`
  );
  assert.ok(
    /TLS 严格校验失败/.test(scgCode) && /host=\$\{opts\.host\}/.test(scgCode) &&
      /code=\$\{code\}/.test(scgCode) && /'warning'/.test(scgCode),
    '降级必须留证 —— 必须打一条含 host + 错误码的 warning'
  );
});

test('行为：SCG 证书链白名单只能含证书链缺陷，不得混入通用网络/协议错误', () => {
  const codes = scg.CERT_CHAIN_ERROR_CODES;
  assert.ok(Array.isArray(codes) && codes.length > 0, '必须导出证书链错误码白名单');
  assert.ok(
    codes.includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),
    '必须含实测命中的 UNABLE_TO_VERIFY_LEAF_SIGNATURE'
  );
  const generic = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
    'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ERR_SSL_WRONG_VERSION_NUMBER'];
  for (const g of generic) {
    assert.ok(
      !codes.includes(g),
      `白名单不得包含通用网络/协议错误码 ${g} —— 否则一次网络抖动就会触发"无条件放宽校验"`
    );
  }
});

test('静态：SCG 通道必须注册进语法闸门 + 被 ydpc 在 cagBootVm **之前**分流', () => {
  const syntaxCheckSrc = fs.readFileSync(path.join(__dirname, 'syntax_check.js'), 'utf8');
  assert.ok(
    /app\/ydpc\/scg_keepalive\.js/.test(syntaxCheckSrc),
    'scg_keepalive.js 必须登记进语法闸门的清单'
  );
  assert.ok(
    /require\(\s*'\.\/scg_keepalive'\s*\)/.test(ydpcCode),
    'ydpc_client.js 必须 require ./scg_keepalive（SCG 通道不得就地散写）'
  );
  assert.ok(/task\.path = 'scg'/.test(ydpcCode), 'SCG 分支必须如实标记 task.path=scg');
  assert.ok(
    /dpPath === 'scg' \? 'SCG · trunk\+SPICE'/.test(ydpcCode),
    '状态视图必须按 path 如实给出 SCG 通道名（不得复用 raw ZTEC / TLS 的文案）'
  );

  const iScg = ydpcCode.indexOf("vm._route.kind === 'SCG'");
  // 必须定位到 startDataPlaneTask **内部**那一次取材料（bootVmViaCag 里也有一次
  // `await cagBootVm(firmAuth`，用宽泛字符串会定位到开机路径、得出相反的结论）。
  const iCagBoot = ydpcCode.indexOf('const boot = await cagBootVm(firmAuth');
  assert.ok(iScg > -1, '未找到 SCG 分流点（结构已变，请同步本断言）');
  assert.ok(iCagBoot > -1, '未找到数据面取材料点（结构已变，请同步本断言）');
  assert.ok(
    iScg < iCagBoot,
    'SCG 必须在 cagBootVm **之前**分流 —— 否则会拿 SCG 材料去撞 CAG 开机路径，' +
      '历史症状就是每 30s 报一次「该机器未暴露 CAG 连接材料（cagIp 缺失），无法开机」'
  );
});

test('静态：SCG 开机走 CEM 通道（2026-09-26 真机打通），材料未下发仍按软失败退避', () => {
  // 【2026-09-26 第三轮修订】SCG 开机已真机验证（畅享版 ~77s 拉起），旧"明确拒绝"断言作废，
  // 反转为：开机必须走 CEM（bootVmViaCem）。材料未下发的软失败退避语义保持不变。
  assert.ok(
    /bootVmViaCem\(/.test(ydpcCode),
    'SCG 开机必须走 bootVmViaCem（CEM 官方通道），不得再拒绝、更不得撞 CAG'
  );
  assert.ok(
    /resolveVmRoute\(vmRef, firmAuth\)\.kind === 'SCG'/.test(ydpcCode),
    '分流必须由**刚取到的** firmAuth 现算判定，不得依赖可能过期的 vm._route'
  );
  assert.ok(/SCG 材料未下发/.test(ydpcCode), '材料未下发必须有一条可读日志（不得只抛英文 code）');
  assert.ok(
    /err\.code === 'SCG_MATERIAL_MISSING'/.test(ydpcCode),
    '必须同时按 err.code 识别（日志措辞可能变，错误码不变）'
  );
  assert.ok(
    /await new Promise\(\(r\) => setTimeout\(r, 60000\)\)/.test(ydpcCode),
    'SCG 材料未下发属于"机器未就绪"的软失败，必须以 60s 退避（不得用 30s 网络抖动节奏）'
  );
});

test('行为：SCG 材料缺失必须**明确拒绝**（必填=scAuthCode+vmId；scgIp/scgTcpPort 为间歇性字段不作门槛）', () => {
  // 【2026-09-27 修订】真机实证：firm-auth 的 scgIp/scgTcpPort 时有时无（会话失效时不下发），
  // 而 CEM getConnectInfo 自带拨号地址 —— 旧实现把它们当必填 ⇒ 数据面每 60s 误报一次。
  const cases = [
    [{}, ['scAuthCode', 'vmId']],
    [{ scgIp: '10.1.2.3', scgTcpPort: 8800 }, ['scAuthCode', 'vmId']],
    [{ scgIp: '10.1.2.3', scgTcpPort: 8800, scAuthCode: 'X' }, ['vmId']],
    [{ scgIpv6: 'fd00::1', scgTcpPort: 8800, vmId: '99887766' }, ['scAuthCode']],
  ];
  for (const [input, missing] of cases) {
    let err = null;
    try { scg.resolveScgMaterial(input); } catch (e) { err = e; }
    assert.ok(err, `材料不全必须抛出：${JSON.stringify(input)}`);
    assert.strictEqual(err.code, 'SCG_MATERIAL_MISSING', '错误码必须是 SCG_MATERIAL_MISSING');
    assert.deepStrictEqual(err.missing, missing, `缺项清单必须逐项列出：期望 ${missing}，实际 ${err.missing}`);
    assert.ok(/SCG 连接材料不完整/.test(err.message), '错误信息必须可读');
  }

  // 齐全（scAuthCode+vmId，无 scgIp/scgTcpPort）必须放行 —— 拨号地址由 CEM 下发
  const m = scg.resolveScgMaterial({ scAuthCode: 'CODE', vmId: '99887766' });
  assert.strictEqual(m.host, '', 'scgIp 缺失时 host 落空串（不拦，仅供日志回带）');
  assert.strictEqual(m.port, 0, 'scgTcpPort 缺失时 port 落 0（不拦）');
  assert.strictEqual(m.scAuthCode, 'CODE');
  assert.strictEqual(m.vmId, '99887766');
  assert.strictEqual(m.bizCode, '10002', 'bizCode 缺省必须回落 10002');

  // 带 scgIp/scgTcpPort 时原样回带（数值归一）
  const m2 = scg.resolveScgMaterial({
    scgIp: '10.1.2.3', scgTcpPort: '8800', scAuthCode: 'CODE', vmId: '99887766'
  });
  assert.strictEqual(m2.host, '10.1.2.3');
  assert.strictEqual(m2.port, 8800, '端口必须归一成数字');

  // presence 只报"有没有"，绝不吐凭据本体
  const pres = scg.describeScgMaterialPresence({
    scgIp: '10.1.2.3', scgTcpPort: 8800, scAuthCode: 'SUPER-SECRET', vmId: '1'
  });
  assert.strictEqual(pres.scgIp, true);
  assert.strictEqual(pres.scgTcpPort, true);
  assert.strictEqual(pres.scAuthCode, true);
  assert.strictEqual(pres.vmId, true);
  assert.ok(
    !JSON.stringify(pres).includes('SECRET'),
    'presence 是给日志用的，绝不能把 scAuthCode 本体吐回去'
  );
});

test('行为：协议编解码必须逐字节对齐抓包样本（帧头 24B / auth 包 2+13+TLV / switch 56B）', () => {
  assert.strictEqual(scg.SCG_FRAME_HEAD_SIZE, 24, 'Chuanyun 帧头必须是 24B');
  assert.strictEqual(scg.SCG_DATA_TYPE, 1, 'DATA 帧类型必须是 1');
  assert.strictEqual(scg.SCG_CONTROL_TYPE, 2, 'CONTROL 帧类型必须是 2');

  const tlv = 'ABCDEF|123456';
  const authPkt = scg.buildScgAuthPacket('ABCDEF', '123456');
  // 明文 = 2B(0x0002) + 8B(ts BE) + 1B(0x03) + 2B(len BE) + TLV = 13 + TLV
  // 密文与明文等长（Go 版 CTR 按明文长度截断），外面再包 2B 前导
  assert.strictEqual(
    authPkt.length, 2 + 13 + tlv.length,
    `auth 包长度应为 2 + 13 + TLV(=13) = 28，实际 ${authPkt.length}`
  );
  assert.strictEqual(authPkt[0], 0x01, 'auth 包首字节必须是 0x01');
  assert.strictEqual(authPkt[1], authPkt.length - 2, 'auth 包第 2 字节是密文长度（低 8 位）');
  // CTR 流必须真的生效（否则等于明文发凭据）：密文里不得直接出现凭据子串
  assert.ok(
    authPkt.indexOf(Buffer.from('ABCDEF|123456', 'utf8')) < 0,
    'auth 包里的 TLV 必须已被 AES-CTR 加密 —— 明文出现即等于把 scAuthCode 裸发'
  );

  const head = scg.frameHeadPack(1, 0, 7, 2);
  assert.strictEqual(head.length, 24, '帧头必须 24B');
  assert.strictEqual(head.readUInt8(0), 1, '帧版本必须是 1');
  assert.strictEqual(head.readUInt8(1), 1, 'pktType 必须写在 [1]');
  assert.strictEqual(head.readBigUInt64LE(8), 7n, 'field1(sid) 必须写在 [8] LE u64');
  assert.strictEqual(head.readBigUInt64LE(16), 2n, 'field2(channelId) 必须写在 [16] LE u64');

  assert.strictEqual(scg.trunkSwitchPack(1, 2, 3, 0, 0, 1, 2).length, 56, 'trunk_switch = 24B 头 + 32B 载荷');

  // 通道认证：ExtInfo(22B) + REDQ 令牌；主/显示/PLAYBACK/RECORD 与 INPUTS/CURSOR 分支长度不同
  const mainAuth = scg.buildChannelAuth(7, scg.SCG_CH_MAIN, scg.SPICE_CH_MAIN_TYPE, 0, 0);
  assert.strictEqual(mainAuth.length, 24 + 22 + 24 + 16 + 42, `main 通道认证长度应为 128，实际 ${mainAuth.length}`);
  const ext = mainAuth.subarray(24, 46);
  assert.strictEqual(ext.length, 22, 'ExtInfo 必须是 22B');
  assert.strictEqual(ext[21], scg.SPICE_CH_MAIN_TYPE, 'ExtInfo 末字节必须被写成 channelType');
  assert.ok(
    ext.subarray(0, 21).equals(Buffer.from('010013f300080000000000010820f1000101f2000104', 'hex').subarray(0, 21)),
    'ExtInfo 模板必须逐字节沿用协议格式（只允许改写末字节与 [10:14]）'
  );
  const vmSlot = scg.buildChannelAuth(7, 1, 1, 0, 67616).subarray(34, 38);
  assert.strictEqual(vmSlot.readUInt32BE(0), 67616, 'vmId 必须写进 ExtInfo[10:14]（BE）');
  const inputAuth = scg.buildChannelAuth(7, scg.SCG_CH_INPUTS, scg.SPICE_CH_INPUTS_TYPE, 0, 0);
  assert.strictEqual(inputAuth.length, 24 + 22 + 24 + 16 + 38, `inputs 通道认证长度应为 124，实际 ${inputAuth.length}`);

  // SPICE LinkReply 公钥提取（运行期材料）
  const fakeReply = Buffer.concat([
    Buffer.alloc(11), Buffer.from('30819f300d', 'hex'), Buffer.alloc(200)
  ]);
  const pub = scg.findReplyPubkey(fakeReply);
  assert.ok(pub && pub.length === 162, '必须能从 LinkReply 里取出 162B 的 DER 公钥');
  assert.strictEqual(scg.findReplyPubkey(Buffer.alloc(50)), null, '取不到必须返回 null（绝不兜底成硬编码公钥）');
});

test('行为：SPICE ticket 必须用**运行期**公钥做 RSA-OAEP(SHA-1) 加密', () => {
  const crypto = require('crypto');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' }
  });
  const ticket = scg.encodeSpiceTicket(publicKey, Buffer.alloc(0));
  assert.ok(Buffer.isBuffer(ticket) && ticket.length === 256, '2048 位密钥的 OAEP 密文应为 256B');
  const plain = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
    ticket
  );
  assert.strictEqual(plain.length, 0, 'ticket 明文是空口令（SPICE 约定）');

  // 非公钥字节必须抛（说明它真的在做 RSA，而不是把入参原样返回）
  let threw = false;
  try { scg.encodeSpiceTicket(Buffer.alloc(162), Buffer.alloc(0)); } catch (e) { threw = true; }
  assert.ok(threw, '非法公钥必须抛错，绝不静默返回一个"假 ticket"');
});

test('行为：显示面判据必须"发了 DISPLAY_INIT + 收到 MARK + 收到真实显示数据"三者齐全', () => {
  const SP = scg.SPICE_MSG;
  /** 构造 SPICE data 消息（18B data 头；与真机抓包同形） */
  const dataMsg = (type, payload) => {
    const p = Buffer.from(payload || []);
    const head = Buffer.alloc(18);
    head.writeBigUInt64LE(0n, 0);
    head.writeUInt16LE(type, 8);
    head.writeUInt32LE(p.length, 10);
    head.writeUInt32LE(0, 14);
    return Buffer.concat([head, p]);
  };

  // ① 只建立连接 / 只完成通道认证 —— 一概不算
  const p0 = scg.createProtocolProgress();
  assert.strictEqual(scg.isDisplayProven(p0), false, '什么都没收到时必须 unproven');
  assert.strictEqual(
    scg.isDisplayProven({ displayInitSent: true }), false,
    '只发了 DISPLAY_INIT 不算 —— 这正是"假保活声明"最容易被写出来的地方'
  );

  // ② MARK 能被 data 头正确解出（本文件第一版曾因 mini 头贪婪吞字节而永远收不到 MARK）
  const p1 = scg.createProtocolProgress();
  scg.handleDisplayPayload(dataMsg(SP.MARK), p1);
  assert.strictEqual(p1.markReceived, true, 'data 头形式的 MARK 必须被解出（否则 display 永远 unproven）');
  p1.displayInitSent = true;
  assert.strictEqual(scg.isDisplayProven(p1), false, 'DISPLAY_INIT + MARK 仍不算 —— 缺真实显示数据');

  // ③ SURFACE_CREATE 或 DRAW_COPY 到位才算
  scg.handleDisplayPayload(dataMsg(SP.SURFACE_CREATE, Buffer.alloc(20, 7)), p1);
  assert.strictEqual(p1.surfaceCreateReceived, true, 'SURFACE_CREATE 必须被解出');
  assert.strictEqual(scg.isDisplayProven(p1), true, '三者齐全才算 proven');

  const p2 = scg.createProtocolProgress();
  p2.displayInitSent = true;
  scg.handleDisplayPayload(dataMsg(SP.MARK), p2);
  scg.handleDisplayPayload(dataMsg(SP.DRAW_COPY, Buffer.alloc(8)), p2);
  assert.strictEqual(scg.isDisplayProven(p2), true, 'DRAW_COPY 可替代 SURFACE_CREATE');

  // ④ 保活应答：SET_ACK → ACK_SYNC / PING → PONG（且类型号必须是 SPICE 消息号）
  const p3 = scg.createProtocolProgress();
  const ack = Buffer.alloc(8);
  ack.writeUInt32LE(1, 0); ack.writeUInt32LE(20, 4);
  const r1 = scg.handleDisplayPayload(dataMsg(SP.SET_ACK, ack), p3);
  assert.strictEqual(p3.setAckReceived, true);
  assert.strictEqual(p3.ackSyncSent, true);
  assert.strictEqual(r1.length, 1, 'SET_ACK 必须回一条 ACK_SYNC');
  assert.strictEqual(r1[0].readUInt16LE(0), SP.ACK_SYNC, 'ACK_SYNC 的消息号必须是 0x0006');
  const r2 = scg.handleDisplayPayload(dataMsg(SP.PING, Buffer.from([1, 2, 3, 4])), p3);
  assert.strictEqual(p3.pingReceived, true);
  assert.strictEqual(r2.length, 1, 'PING 必须回一条 PONG');
  assert.strictEqual(r2[0].readUInt16LE(0), SP.PONG, 'PONG 的消息号必须是 0x0005');

  // ⑤ 前缀剥离不得吃掉合法 data 帧：serial 恰好为 0x0100 时前两字节就是 `00 01`
  const tricky = dataMsg(SP.MARK);
  tricky.writeBigUInt64LE(0x0100n, 0);
  const p5 = scg.createProtocolProgress();
  scg.handleDisplayPayload(tricky, p5);
  assert.strictEqual(p5.markReceived, true, 'serial=0x0100 的合法 data 帧不得被误当 6B 令牌前缀剥掉');

  // ⑥ 未知字节：停止解析、不抛、不误判
  const p6 = scg.createProtocolProgress();
  scg.handleDisplayPayload(Buffer.from([9, 9, 9, 9, 9, 9, 9]), p6);
  assert.strictEqual(p6.markReceived, false, '未知字节不得被猜成任何消息');
});

test('静态 + 行为：连接成功 / 通道认证 / 显示观察都不得升级成"保活已被证明"', () => {
  // 静态：必须是字面量 false，不得被推导
  assert.ok(
    /keepaliveProven:\s*false\b/.test(scgCode),
    'runScgSession 必须显式给出 keepaliveProven: false'
  );
  assert.ok(
    !/keepaliveProven:\s*(?!\s*false\b)/.test(scgCode),
    'keepaliveProven 不得被赋成任何表达式 —— 它不是推导量，而是"本项目从未证明"的事实'
  );
  assert.ok(
    /displayProven,/.test(scgCode) && /isDisplayProven\(handshake\.progress\)/.test(scgCode),
    '必须另有一个如实的 displayProven 字段承载"是否观察到真实显示数据"'
  );
  assert.ok(
    !/保活成功/.test(scgCode),
    'SCG 模块内不得出现"保活成功"字样（未收到真实显示数据时只称"切片完成 / 重拨"）'
  );
});

testAsync('行为：材料缺失时 runScgSession 必须在**建连之前**就拒绝（不产生任何网络动作）', async () => {
  let err = null;
  try { await scg.runScgSession({ firmAuth: { cagIp: '10.0.0.1' }, holdSeconds: 1 }); } catch (e) { err = e; }
  assert.ok(err, '材料缺失必须抛错，不得静默返回一个"看起来成功"的会话');
  assert.strictEqual(err.code, 'SCG_MATERIAL_MISSING', `错误码应为 SCG_MATERIAL_MISSING，实际 ${err.code}`);
});

testAsync('行为：非证书链错误绝不触发降级重拨（只拨一次）', async () => {
  const net = require('net');
  let accepts = 0;
  // 一个"接了立刻掐断"的假 SCG 端点：认证不可能完成，且错误**不是**证书链缺陷。
  const srv = net.createServer((sock) => { accepts++; sock.destroy(); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  try {
    const logs = [];
    let threw = null;
    try {
      await scg.scgConnect({
        host: '127.0.0.1', port, scAuthCode: 'X', vmId: '9',
        timeoutMs: 1500, onLog: (label, message) => logs.push(message)
      });
    } catch (e) { threw = e; }
    assert.ok(threw, '连接被立即掐断时必须抛错，不得静默成功');
    assert.strictEqual(
      accepts, 1,
      `非证书链错误不得触发降级重拨 —— 期望只拨 1 次，实际 ${accepts} 次` +
        '（若为 2 次，说明降级判定退化成了"无条件重试"，等价于默认关掉证书校验）'
    );
    assert.ok(
      !logs.some((m) => /降级重连一次/.test(m)),
      '既然没有降级，就不得留下"已降级"的日志（留证必须如实，不能预设结果）'
    );
  } finally {
    await new Promise((res) => srv.close(res));
  }
});

testAsync('行为：状态视图必须按数据面 path 如实给出通道名（scg 不得被写成 raw ZTEC）', async () => {
  const proto = loadYdpcHarness();
  const now = Date.now();
  const usid = '7003';
  const vm = {
    userServiceId: usid, vmName: '公众样本账号SCG', vmStatus: '运行中', vmStatusCode: 1,
    keepaliveEnabled: true, autoBootEnabled: true, lastKeepAliveAt: now - 30 * 1000,
    _route: { kind: 'SCG', supported: true, reason: 'spuCode=sc-cloud-pc' }
  };
  const ctx = makeViewCtx(proto, { features: { autoBoot: true }, dataPlaneActive: true });
  // dataPlaneTasks 是实例字段（见 app/ydpc/ydpc_client.js），makeViewCtx 不代管，就地注入
  ctx.dataPlaneTasks = new Map([[usid, { running: true, path: 'scg' }]]);

  const view = proto.describeVmKeepAlive.call(ctx, vm);
  assert.strictEqual(view.routeKind, 'SCG', 'routeKind 必须如实带出');
  assert.strictEqual(view.dataPlanePath, 'scg', 'dataPlanePath 必须如实带出 scg');
  assert.strictEqual(view.dataPlaneChannel, 'SCG · trunk+SPICE', 'SCG 通道名必须独立，不得复用 ZTE 文案');
  assert.ok(
    !/raw ZTEC/.test(JSON.stringify(view)),
    'SCG 机器绝不能在中显示 raw ZTEC —— 那会把"另一套通道"谎报成 ZTE'
  );
  assert.ok(/SCG/.test(view.actionText), `运行中的 SCG 机器必须点明通道，实际: ${view.actionText}`);

  // 已关机 + 开着守护：SCG 开机已真机打通（CEM 通道）⇒ 如实显示"守护中"，
  // 且必须点明底座（SCG）与通道（CEM），让用户知道这次承诺是真的。
  const off = proto.describeVmKeepAlive.call(ctx, {
    ...vm, vmStatus: '已关机', vmStatusCode: 0
  });
  assert.strictEqual(off.running, false, '前提：该机必须被判为已关机');
  assert.ok(/SCG/.test(off.actionText), `SCG 关机态必须点明底座，实际: ${off.actionText}`);
  assert.ok(
    /自动开机守护中（CEM）/.test(off.actionText),
    `SCG 开机已真机打通（CEM），关机+守护必须如实显示守护中，实际: ${off.actionText}`
  );
});

// ---------------------------------------------------------------------------
// 组 30 追加 · "零应答"不得被渲染成一个字节（编造数据 = 失真）
//
// 现场日志（2026-09-26）：「SCG auth 失败：byte[0]=0x0」。这句话读起来像服务端
// 明确回了零字节，实际上 SCG 侧**一个字节都没回**（超时未回包 / 连接已被断开）：
// 旧代码写的是 `(resp.length ? resp[0] : 0)` —— 空应答被兜底成 0 ⇒ 编造出一个
// 不存在的字节值。同一分支的正确语义是 -1（即"这个字节不存在"），
// 而不是 0（"这个字节等于 0"）。
// 危害：把排查方向从"通道根本没应答"带偏到"协议首字节对不上"——
// 这正是"假故障也是失真"那一类：故障是真的，但描述是编的。
// ---------------------------------------------------------------------------

test('静态：SCG auth 的"零应答"不得被兜底成一个字节值（0 是编出来的）', () => {
  const code = stripComments(read('app/ydpc/scg_keepalive.js'));
  assert.ok(
    !/\(resp\.length \? resp\[0\] : 0\)/.test(code),
    '空应答兜底成 0 是编造数据（把"没收到"写成"收到了 0x00"）—— 必须显式区分零应答'
  );
  assert.ok(
    /SCG_AUTH_NO_RESPONSE/.test(code) && /无应答/.test(code),
    '零应答必须有独立分支与机器可读错误码（否则又会被混进"字节不符"这一类）'
  );
});

testAsync('行为：SCG 服务端一个字都不回时，必须报"无应答"而不是"byte[0]=0x0"', async () => {
  const net = require('net');
  const { scgConnectOnce } = require(path.join(ROOT, 'app', 'ydpc', 'scg_keepalive.js'));
  // 服务端收下 TCP 连接，但一个字都不回 —— 复刻现场情形。
  // ⚠️ 必须自己收好 socket 并显式 destroy：服务端 socket 停在半开态时
  // `await new Promise(res => srv.close(res))` 的回调**永不触发**，
  // 而 Node 在事件循环耗尽时会**以退出码 0 静默退出**
  //（现场实测：整张回归测试网一行输出都没有、退出码 0 —— 与"全绿"无法区分）。
  const held = [];
  const srv = net.createServer((s) => { held.push(s); /* 静默：不回包、也不主动断开 */ });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const port = srv.address().port;
  let threw = null;
  try {
    await scgConnectOnce({ host: '127.0.0.1', port, scAuthCode: 'X', vmId: '9', timeoutMs: 400 });
  } catch (e) { threw = e; }
  for (const s of held) { try { s.destroy(); } catch (e) { /* 已断开 */ } }
  srv.close(); // 不 await：见上方说明

  assert.ok(threw, '服务端不回包时必须抛错，绝不能当成"认证通过"继续往下走');
  assert.strictEqual(
    threw.code, 'SCG_AUTH_NO_RESPONSE',
    '必须给出"无应答"这一档（不是"字节不符"）—— 两者的排查方向完全不同'
  );
  assert.ok(/无应答/.test(threw.message), `文案必须点明"零应答"，实际: ${threw.message}`);
  assert.ok(
    !/byte\[0\]=0x0/.test(threw.message),
    `绝不能把"一个字都没收到"写成 byte[0]=0x0（编造数据），实际: ${threw.message}`
  );
});

// ============================================================================
// 组 31 · SCG 底座下的 UI 分叉（用户 2026-09-26：「另一套 SCG 的保活，下面的
//        自动化保活开关下面的内容是不是也要变掉了」）
// ----------------------------------------------------------------------------
// 为什么必须分叉而不是"把 raw ZTEC 改成原生协议"一句话了事：SCG 与 ZTE 的差别**不是**
// 措辞差别，而是**能力差别**：
//   · SCG 材料里没有 cagIp / connectStr ⇒ 它不走 CAG 握手，开机/保活走 CEM 控制面；
//   · SCG 的"显示面是否真的出图"未在本项目被证明 ⇒ 不得沿用 ZTE 的「真保活」措辞。
// 因此三处必须按底座分叉渲染，否则就是把"做不到"渲染成"做得到"（假承诺）：
//   ① 开关区的「自动开机守护」——SCG 走 **CEM 通道**（文案按底座分流）；
//   ② 数据面/控制面开关的文案——SCG 不得写成 raw ZTEC / CAG 握手；
//   ③ 单机控制行的「🛡️守护」与「🖥️开机」——所有底座恒渲染，开机按底座走 CAG/CEM。
// 【2026-09-26 第三轮 · 用户】「已经顺利开机了，那么恢复这几个按钮……把你成功试验的
//   开机逻辑放到这个按钮中」—— SCG 开机已真机验证（畅享版：getConnectInfo 触发开机，
//   ~77 秒后运行中）。此前"整块不渲染"的删除决定**随之作废**：控件恢复渲染，
//   且必须接 CEM 开机（cemBootVm）。原文案里的"SCG 机无效"是过时的假承诺，一并禁止。
// 另有一条**容易漏掉的腐化点**：5 秒增量轮询会就地覆写守护胶囊的文案，必须保留
//   "按元素存在性跳过"——元素不存在时 getElementById 为 null 天然跳过，不造幽灵控件。
// ============================================================================
group('组 31 · SCG 底座下的 UI 分叉（开关区 / 单机控制行 / 增量同步）');

test('静态：底座画像必须只读已持久化的 vendor，且**不得**按名称猜底座', () => {
  assert.ok(
    /const _ydpcAllScg = vms\.length > 0/.test(appJs),
    '移动爱家卡片必须有"整账号是否全为 SCG 底座"的判定（开关区据此分叉）'
  );
  assert.ok(
    /const _ydpcVendors = Array\.from\(new Set\(/.test(appJs) &&
      /\(v && v\.vendor\)/.test(appJs),
    '底座画像必须取自 vm.vendor（由后端 refreshVms 持久化），前端不自行嗅探'
  );
  assert.ok(
    /const _isScgVm = \(v\) => String\(\(v && v\.vendor\) \|\| ''\)\.toUpperCase\(\) === 'SCG'/.test(appJs),
    '单机判定必须收敛到一个只读 vendor 的小函数（四处复用同一判据）'
  );
  assert.ok(
    !/家庭/.test(appJs),
    '前端不得再按名称字样（"家庭"等）猜底座 —— 猜测的代价是真 SCG 机被硬判成 ZTE 盲拨'
  );
  assert.ok(
    /_ydpcMixedBase/.test(appJs),
    '混挂多底座必须降级为中性文案（宁可少说，不可说错）'
  );
});

test('静态：「自动开机守护」对全底座恒渲染（SCG 走 CEM 通道 · 真机已验证），过时假承诺文案禁止复活', () => {
  // 【2026-09-26 第三轮】SCG 开机真机打通 ⇒ "整块不渲染"的删除决定作废，控件必须恒渲染：
  assert.ok(
    !/\$\{_ydpcAllScg \? '' : `<div class="feature-row">/.test(appJs),
    '守护开关块不得再按 _ydpcAllScg 隐藏 —— SCG 开机已打通，隐藏它等于砍掉真功能'
  );
  assert.ok(
    /自动开机守护（CEM 通道）/.test(appJs),
    'SCG 全底座账号必须显示 CEM 通道文案（开机真机已验证）'
  );
  assert.ok(
    /自动开机守护（CAG 通道）/.test(appJs),
    'ZTE 底座必须保留原有开关（分叉≠把功能删掉）'
  );
  assert.ok(
    /CAG\/CEM 通道 · 按底座自动分流/.test(appJs),
    '混挂多底座必须写明按底座自动分流（ZTE→CAG / SCG→CEM）'
  );
  assert.ok(
    !/SCG 机无效/.test(appJs),
    '"SCG 机无效"是过时的假承诺 —— SCG 开机已打通，该文案不得复活'
  );
  assert.ok(
    !/自动开机守护（SCG 底座无此通道）/.test(appJs),
    '占位文案必须整体删除（用户 2026-09-26 第二轮：「都删掉吧」）'
  );
  assert.ok(
    /onchange="toggleFeature\('\$\{acc\.id\}', 'autoBoot', this\.checked\)"/.test(appJs),
    '账号级守护开关必须仍然走 toggleFeature(autoBoot)（分叉≠换判定入口）'
  );
});

test('静态：数据面 / 控制面开关文案必须按底座分叉（SCG 不得被写成 raw ZTEC / CAG 握手）', () => {
  assert.ok(
    /数据面保活（SCG · trunk\+SPICE）/.test(appJs),
    'SCG 底座的数据面开关必须写明它走的是 trunk+SPICE'
  );
  assert.ok(
    /控制面保活（SOHO 心跳 · SCG 无 CAG 握手）/.test(appJs),
    'SCG 没有 cagIp ⇒ 控制面开关必须写明"无 CAG 握手"，只驱动 SOHO 心跳'
  );
  // 反向：ZTE 侧文案一字不得少
  assert.ok(/数据面保活（raw ZTEC \/ TLS\+SPICE · 真保活）/.test(appJs), 'ZTE 侧数据面文案必须保留');
  assert.ok(/控制面保活（CAG 握手 \+ SOHO 心跳）/.test(appJs), 'ZTE 侧控制面文案必须保留');
  assert.ok(appJs.includes('移动爱家 ZTEC 握手与心跳监视'), 'ZTE 侧监视板块标题必须保留');

  // 诚实性：ZTE 侧才允许用「真保活」；SCG 侧的文案里不得出现
  const scgLabel = appJs.match(/'📡 数据面保活（SCG · [^']*'/);
  assert.ok(scgLabel, '未找到 SCG 数据面文案（结构已变，请同步本断言）');
  assert.ok(
    !/真保活/.test(scgLabel[0]),
    'SCG 数据面在本项目**尚未被证明**，其开关文案不得沿用 ZTE 的「真保活」措辞'
  );
});

test('静态：单机控制行的守护 / 开机控件对 SCG 恢复渲染（开机按底座走 CAG/CEM）', () => {
  assert.ok(
    !/🛡️守护: 无通道/.test(appJs),
    'SCG 机器的守护占位必须整体删除（用户原话：「守护：无通道的按钮可以直接去掉了」）'
  );
  assert.ok(
    !/🖥️开机: 不支持/.test(appJs),
    'SCG 机器的开机占位必须整体删除（用户原话：「开机：不支持……可以直接去掉了」）'
  );
  // 【2026-09-26 第三轮】SCG 控件恢复渲染 —— 隐藏用的条件必须消失：
  assert.ok(
    !/\$\{_isScgVm\(vm\) \? '' : `<button type="button" class="pill-toggle-btn/.test(appJs),
    '守护胶囊不得再按 _isScgVm 隐藏 —— SCG 开机已打通，控件恢复渲染'
  );
  assert.ok(
    !/!isRunning && !_isScgVm\(vm\)/.test(appJs),
    '「🖥️开机」不得再把 SCG 排除在渲染条件外 —— SCG 关机时同样要有可点的开机按钮'
  );
  assert.ok(
    /通过 CEM 官方通道拉起这台云电脑（深信服底座/.test(appJs),
    'SCG 机器的开机按钮必须标明走 CEM 通道（真机已验证）'
  );
  // 双向：无论底座，控件必须仍然可点且走同一套函数
  assert.ok(
    /onclick="toggleVmFeature\('\$\{acc\.id\}', '\$\{usid\}', 'autoBootEnabled'/.test(appJs),
    '守护胶囊必须仍然走 toggleVmFeature(autoBootEnabled)'
  );
  assert.ok(
    /onclick="bootYdpcVm\('\$\{acc\.id\}', '\$\{usid\}'/.test(appJs),
    '开机按钮必须仍然走 bootYdpcVm（后端按底座分流 CAG/CEM）'
  );
});

test('静态：5 秒增量轮询按元素存在性同步（SCG 控件恢复渲染后同样被同步，不造幽灵控件）', () => {
  assert.ok(
    /if \(pAutoBoot\) \{/.test(appJs),
    '就地覆写守护胶囊前必须判元素存在 —— 元素不存在的机器 getElementById 返回 null 即天然跳过'
  );
  assert.ok(
    !/pAutoBoot\.disabled/.test(appJs),
    '不得保留 disabled 占位过滤 —— 控件已全部真实渲染，再留着它等于承认"还有一个按不动的胶囊"存在'
  );
  assert.ok(
    /pAutoBoot\.innerText = `🛡️守护: /.test(appJs),
    '守护胶囊（含 SCG 机）必须被 5 秒轮询同步（分叉≠把同步删掉）'
  );
});

test('静态：SCG 开机 CEM 接线（bootVmViaCag SCG 分支 → bootVmViaCem → cemBootVm）', () => {
  const scg = stripLineComments(read('app/ydpc/scg_keepalive.js'));
  const ydpc = stripLineComments(read('app/ydpc/ydpc_client.js'));
  // 数据面 / 开机共用的 CEM 开机函数必须存在：
  assert.ok(/async function cemBootVm\(/.test(scg), 'cemBootVm（OAuth → getConnectInfo 触发开机 → ready 轮询）必须存在');
  assert.ok(/timeoutMs: 120000/.test(scg), 'getConnectInfo 对冷启动机器必须放大超时到 120s（真机实测 >30s 才响应）');
  assert.ok(/maxWaitSeconds/.test(scg) && /getVmReadyStatus/.test(scg), '必须轮询 getVmReadyStatus 至 readyStatus=1');
  // 开机按钮 / 守护自动开机 → bootVmViaCag → SCG 分支必须接 CEM：
  assert.ok(/async bootVmViaCem\(/.test(ydpc), 'ydpc_client 必须有 bootVmViaCem（SCG 开机的 CEM 实现）');
  assert.ok(
    /return await this\.bootVmViaCem\(userServiceId, accName, firmAuth\);/.test(ydpc),
    'bootVmViaCag 的 SCG 分支必须转接 bootVmViaCem（复用已取到的 firmAuth）'
  );
  assert.ok(
    !/暂不支持自动开机/.test(ydpc),
    '"SCG 底座暂不支持自动开机"的过时拒绝必须删除 —— 开机已真机打通'
  );
  assert.ok(/maxWaitSeconds: 180/.test(ydpc), '开机路径的就绪等待预算必须 ≥180s（真机实测 ~77s 拉起）');
  // 诚实性：未就绪≠失败 —— 必须区分"已触发启动中"与"完成"
  assert.ok(/开机指令已下发/.test(ydpc), '等待窗口内未就绪必须如实报"已下发、启动中"，不得虚报完成');
});

test('静态：CEM 开机必须把 504/超时当"在途"（真机 2026-09-27：504 后机器照样被拉起）', () => {
  const scg = stripLineComments(read('app/ydpc/scg_keepalive.js'));
  const ydpc = stripLineComments(read('app/ydpc/ydpc_client.js'));
  // ① getConnectInfo 必须把 5xx 与网络超时标记为可重试（在途），而不是致命失败：
  assert.ok(/res\.status >= 500/.test(scg), 'getConnectInfo 必须把 HTTP 5xx（含 504）识别为可重试');
  assert.ok(/err\.retryable = true/.test(scg), '5xx/超时必须携带 retryable 标记（在途语义）');
  assert.ok(/if \(!e\.retryable\) throw e;/.test(scg), '非可重试错误（OAuth 被拒等）必须原样抛出，不得吞');
  assert.ok(/pending: true/.test(scg), '预算耗尽必须返回 pending（开机在途），不得抛致命错误');
  // ② 开机调用方必须先做独立状态核验再下结论（对齐实测结论文档的核验纪律）：
  assert.ok(/async _verifyVmRunning\(/.test(ydpc), '必须有独立状态核验（走 SOHO 列表接口，不依赖开机链路自证）');
  const verifyCalls = (ydpc.match(/this\._verifyVmRunning\(/g) || []).length;
  assert.ok(
    verifyCalls >= 2,
    `开机异常与"在途未就绪"两条路径都必须做独立核验（实际 ${verifyCalls} 处）—— 少一处就会把已成功的开机报成失败`
  );
  const vIdx = ydpc.indexOf('async _verifyVmRunning');
  assert.ok(
    vIdx > -1 && /listCloudPcs/.test(ydpc.slice(vIdx, vIdx + 400)),
    '核验函数体内必须走独立的云电脑列表接口（不得只看开机链路自己的返回）'
  );
  assert.ok(
    /CEM 开机流程异常/.test(ydpc),
    'CEM 异常必须落到日志（此前直接冒泡到 toast，日志里什么都没有）'
  );
  assert.ok(
    /开机已在途并核实生效|开机已生效：独立状态接口显示机器已在运行/.test(ydpc),
    '独立核验显示运行中时必须报"开机生效"，绝不把已成功的开机报成失败'
  );
});

test('静态：移动爱家卡片分支同样不得出现"已保活/保活成功"（诚实性红线，与移动公众一致）', () => {
  const cStart = appJs.indexOf('// 📱 移动云电脑专属卡片呈现');
  const cEnd = appJs.indexOf('// ☁️ 天翼云电脑专属卡片呈现');
  assert.ok(cStart > -1 && cEnd > cStart, '无法定位移动爱家卡片分支（结构已变，请同步本断言）');
  const ydpcBranch = appJs.slice(cStart, cEnd);
  assert.ok(
    !/已保活|保活成功|保证不被关机|已完成保活/.test(ydpcBranch),
    '移动爱家卡片不得出现"已保活/保活成功"等未经证实的结论 —— ' +
      'SCG 通道连"是否观察到显示数据"都只是如实打点，更不得给出保活结论'
  );
});

// ============================================================================
// 组 32 · 电源状态判据唯一化 + 「没做事 ≠ 成功」（用户 2026-09-26 现场日志）
// ----------------------------------------------------------------------------
// 现场症状：SCG 机「家庭云电脑畅享版」状态是「未开机」，卡片显示"已关机"，
//   但保活循环每 10 分钟仍对它打出一条 success 级的「ZTEC CAG TCP 握手保活成功」。
// 两个并存的缺陷：
//   ① **判据分叉**：runCycle 与 MQTT 预检各就地重写了一份"是否关机"，都漏掉了
//      「未开机」文案与 vmStatusCode === 0（权威 isYdpcVmOff() 两者都算关机）
//      ⇒ 同一台机器"卡片说关机、循环说在跑"，于是照常打心跳与握手；
//   ② **假成功**：sendHeartbeat / pingCag 对关机机是**返回** { success:false } 而非抛错，
//      而 runWithGrade 只判"有没有抛" ⇒ 记成成功并打出 success 日志。
// 判据只允许存在一份；"没做事"必须与"做过且成功"区分开。
// ============================================================================
group('组 32 · 电源状态判据唯一化 + 「没做事 ≠ 成功」');

function loadPowerStateFn() {
  const m = ydpcCode.match(/function isYdpcVmOff\(vm\) \{[\s\S]*?\n\}/);
  assert.ok(m, '无法抽取 isYdpcVmOff（结构已变，请同步本断言）');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn isYdpcVmOff;`)();
}

test('行为：关机判定必须唯一收敛到 isYdpcVmOff（含「未开机」与状态码 0）', () => {
  const isOff = loadPowerStateFn();
  // 现场真机样本（2026-09-26 getFirmAuth 同批取得）：深信服机「家庭云电脑畅享版」
  assert.strictEqual(isOff({ vmStatus: '未开机', vmStatusCode: 0 }), true, '「未开机」必须判为已关机');
  assert.strictEqual(isOff({ vmStatusCode: 0 }), true, '状态码 0 必须判为已关机');
  assert.strictEqual(isOff({ vmStatus: '已关机', vmStatusCode: 23 }), true, '「已关机」仍必须判为关机');
  assert.strictEqual(isOff({ vmStatus: '运行中', vmStatusCode: 1 }), false, '「运行中」不得误判为关机');
});

test('静态：不得再就地重写关机判据（两处调用必须走同一份权威实现）', () => {
  assert.ok(
    /function isYdpcVmOff\(vm\) \{/.test(ydpcCode),
    '权威判据 isYdpcVmOff 必须仍定义在 ydpc_client.js 顶部'
  );
  assert.ok(
    !/String\(vm\.vmStatus \|\| ''\)\.includes\('关机'\)/.test(ydpcCode),
    'ydpc_client.js 不得再出现就地重写的关机判据 —— 漏一个状态串（如「未开机」）' +
      '就会与卡片口径打架：卡片说已关机、循环说在跑，然后对关机机打心跳'
  );
  const calls = ydpcCode.split('const isVmOff = isYdpcVmOff(vm);').length - 1;
  assert.strictEqual(
    calls,
    2,
    `MQTT 预检与保活循环两处都必须走 isYdpcVmOff(vm)，实际 ${calls} 处（判定不允许有两份口径）`
  );
});

testAsync('行为：对已关机机器 sendHeartbeat / pingCag 必须报 success:false（"待命"不是"完成"）', async () => {
  const { YdpcClient } = require(path.join(ROOT, 'app', 'ydpc', 'ydpc_client.js'));
  const account = {
    id: 'yd_probe_test',
    name: '测试账号',
    // 现场样本：SCG 机「家庭云电脑畅享版」= vmStatus「未开机」+ vmStatusCode 0
    vms: [{ userServiceId: 41371897, vmName: '家庭云电脑畅享版', vmStatus: '未开机', vmStatusCode: 0 }],
    features: {}
  };
  const client = new YdpcClient(account, {
    appendLog: () => {},
    sendNotification: () => {},
    saveConfig: () => {}
  });
  const hb = await client.sendHeartbeat(41371897);
  assert.strictEqual(hb && hb.success, false, 'SOHO 心跳：机器没开机时绝不能报成功');
  const cag = await client.pingCag(41371897, 1);
  assert.strictEqual(cag && cag.success, false, 'CAG 握手：机器没开机时绝不能报成功');
  assert.ok(
    !/success: true, message: '云电脑处于关机状态'/.test(ydpcCode),
    '"关机待命"必须是 success:false —— 旧写法（success:true）正是假成功的源头'
  );
  const offReturns = ydpcCode.split("return { success: false, message: '云电脑处于关机状态' };").length - 1;
  assert.strictEqual(offReturns, 2, `sendHeartbeat 与 pingCag 的关机契约必须一致，实际 ${offReturns} 处`);
});

test('静态：runWithGrade 必须把「不抛异常但 success:false」判为 skipped（不得记成功）', () => {
  assert.ok(
    /r && r\.success === false/.test(ydpcCode),
    'runWithGrade 必须识别"回调没抛异常、但明确没做事"—— 只看"有没有抛"会把' +
      '关机机的 pingCag/sendHeartbeat 记成成功（用户 2026-09-26 看到的就是这条假日志）'
  );
  assert.ok(/skipped: true/.test(ydpcCode), '识别后必须标成 skipped，供调用点与真失败区分');
  assert.ok(
    /!hbFail\.skipped/.test(ydpcCode) && /!cagFail\.skipped/.test(ydpcCode),
    'SOHO 心跳与 CAG 握手两个调用点都必须排除 skipped —— 否则会继续打「握手保活成功」'
  );
  // 反向：真失败的分级告警不得被顺手删掉（skip 与 fail 是两码事）
  assert.ok(
    /SOHO 心跳暂不可用\(软失败,不熔断\)/.test(ydpcCode) &&
      /SOHO 心跳\$\{hbFail\.retried \? '重登后仍失效' : '异常'\}/.test(ydpcCode),
    'SOHO 心跳的真失败分级告警必须保留（分叉≠删除）'
  );
  assert.ok(
    /CAG 握手软失败\(不熔断\)/.test(ydpcCode),
    'CAG 握手的软失败告警必须保留（分叉≠删除）'
  );
});

test('静态：手动心跳 / CAG 按钮必须把「机器未开机」渲染成等待，而不是失败', () => {
  const helper = appJs.match(/function isVmOffSkipResult\(data\) \{[\s\S]*?\n\}/);
  assert.ok(helper, '前端必须有一个统一的"未开机 ⇒ 本次未执行"识别函数');
  assert.ok(
    /data\.success === false && !data\.error/.test(helper[0]),
    '识别条件必须排除 400 兜底路径（那条带 error 字段，是真失败）'
  );
  assert.ok(
    /关机/.test(helper[0]) && /未开机/.test(helper[0]),
    '必须按后端文案（"云电脑处于关机状态"）识别 —— 关机是"待命"，不是"异常"'
  );
  // 只数**调用点**（函数定义那一行也含同名字样，不能用裸字符串计数）
  const CALL = 'else if (isVmOffSkipResult(data)) {';
  const uses = appJs.split(CALL).length - 1;
  assert.strictEqual(uses, 2, `手动心跳与手动 CAG 两个按钮都必须区分"未执行"与"失败"，实际 ${uses} 处`);
  assert.ok(
    /showToast\("云电脑未开机，本次未发送心跳（开机后会自动继续）", "info"\)/.test(appJs),
    '未开机时的心跳提示必须是 info 等待语义'
  );
  assert.ok(
    /showToast\("云电脑未开机，本次未发起 CAG 握手（开机后会自动继续）", "info"\)/.test(appJs),
    '未开机时的 CAG 提示必须是 info 等待语义'
  );
  // 顺序：未执行的分支必须排在失败分支之前，否则照样渲染成报错
  assert.ok(
    appJs.indexOf(CALL) < appJs.indexOf('CAG 握手失败: '),
    '未开机分支必须排在 CAG 失败分支之前'
  );
  assert.ok(
    appJs.lastIndexOf(CALL) < appJs.indexOf('心跳异常: '),
    '未开机分支必须排在心跳失败分支之前'
  );
});

// ============================================================================
// 组 33 · 数据面「假活跃」与 CAG 材料缺失
//        （用户 2026-09-26 现场原话："我一台已经开机了，为什么无法保活？一直自动关机"）
//
// 两处真实缺陷 —— 都不报错、都不影响启动，只有用户会发现：
//   ① 抑制控制面的判据是 `task.running`：一个**每轮都抛错、从未建立过隧道**的重试循环
//      同样是 running ⇒ 数据面（做不成事）在跑，却把控制面（SOHO 心跳 + CAG 握手）压住
//      ⇒ 这台机器**一条保活动作都没有** ⇒ 平台按"无活动"把它关机。
//      同期告警里还写着"数据面保活=活跃" —— 与"假成功"同源的**假活跃**。
//   ② `String(firmAuth.cagIp || firmAuth.cagHost)` 在两者皆空时得到**字面量 "undefined"**，
//      于是真的去解析一个名叫 undefined 的主机 ⇒ `getaddrinfo ENOTFOUND undefined`
//      （用户贴出的原句），再被 classifyZteError 按 /ENOTFOUND|getaddrinfo/ 判成 hard
//      ⇒ 每轮一条 error 告警：把"这台机器没有这条通道"报成了"链路故障"。
// ============================================================================

test('静态：数据面"在场"判据不得只看 task.running（连续失败必须交还控制面）', () => {
  const fn = ydpcCode.match(/isDataPlaneActive\(usid\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 isDataPlaneActive 实现');
  assert.ok(
    /failStreak/.test(fn[0]) && /DATA_PLANE_FAIL_LIMIT/.test(fn[0]),
    'isDataPlaneActive 必须把"连续失败次数"纳入判据 —— 只看 task.running 会让一个' +
      '每 30s 抛错、从未建过隧道的任务把控制面永久压住（现场：机器一条保活动作都没有）'
  );
  assert.ok(
    !/return !!\(task && task\.running\);/.test(ydpcCode),
    '旧判据（只看 running）不得复活 —— 那正是"假活跃"的定义'
  );
  const progress = ydpcCode.split('this._noteDataPlaneProgress(task, usid, name);').length - 1;
  assert.ok(progress >= 3, `SCG 切片 / TLS 会话建立 / raw 隧道建成 三处都必须计为"有进展"，实际 ${progress} 处`);
  const failures = ydpcCode.split('this._noteDataPlaneFailure(task, usid, name, errMsg);').length - 1;
  assert.ok(failures >= 2, `"SCG 材料未下发"与"通用异常"两条错误分支都必须累加计数，实际 ${failures} 处`);
  assert.ok(
    /已交还控制面保活/.test(ydpcCode),
    '降级必须留证（写明控制面已接管）—— 否则用户只看到"数据面=活跃"的结论，看不到其实每 30s 都在失败'
  );
  // 留证的**措辞**也必须按底座分叉。SCG 底座的 firm-auth 里根本没有 cagIp
  // （只有 scgIp/scgTcpPort/scAuthCode），控制面上不存在"CAG 握手"这个动作 ——
  // 笼统写"已交还控制面保活（SOHO 心跳 + CAG 握手）"就是在告诉用户
  // 一条**在这台机器上不存在**的保活通道正在跑，与"假成功"同源的失真。
  assert.ok(
    /task\.routeKind === 'SCG'/.test(ydpcCode) && /SCG 底座无 CAG 握手通道/.test(ydpcCode),
    '降级文案必须区分 SCG 底座（无 CAG 握手通道）—— 否则等于宣称一条不存在的保活通道在运行'
  );
  // 但"有分叉"不等于"分叉拿得到标签"：task.routeKind 必须**由 vm 写入**。
  // 写死成空串时，上面的分叉就成了空转 —— 所有底座（含 SCG）都会退回 ZTE 措辞。
  const taskObj = ydpcCode.match(/const task = \{[\s\S]*?\n    \};/);
  assert.ok(taskObj, '未找到 startDataPlaneTask 里的 task 对象字面量');
  assert.ok(
    /routeKind:\s*\(vm && vm\._route && vm\._route\.kind\)/.test(taskObj[0]),
    'task.routeKind 必须从 vm._route.kind 写入 —— 写死空串会让 SCG 机退回"CAG 握手"措辞'
  );
});

testAsync('行为：数据面连续失败到阈值后必须判为"不在场"（控制面必须拿回保活权）', async () => {
  const { YdpcClient } = require(path.join(ROOT, 'app', 'ydpc', 'ydpc_client.js'));
  const logs = [];
  const client = new YdpcClient({ id: 'yd_dp_test', name: '测试账号', vms: [], features: {} }, {
    appendLog: (tag, message, level) => logs.push(`${tag}|${level}|${message}`),
    sendNotification: () => {},
    saveConfig: () => {}
  });
  const usid = 41371819;
  const task = { running: true, failStreak: 0, demoted: false, socket: null };
  client.dataPlaneTasks.set(String(usid), task);

  assert.strictEqual(client.isDataPlaneActive(usid), true, '刚启动（尚未失败）应当算在场');
  client._noteDataPlaneFailure(task, usid, '测试账号', '模拟失败 A');
  assert.strictEqual(client.isDataPlaneActive(usid), true, '单次失败仍给一次机会（避免一次抖动就交还）');

  client._noteDataPlaneFailure(task, usid, '测试账号', '模拟失败 B');
  assert.strictEqual(
    client.isDataPlaneActive(usid), false,
    '连续失败达阈值 ⇒ 隧道并不存在 ⇒ 必须交还控制面（这就是"一直自动关机"的解法）'
  );
  const demoteLines = logs.filter((l) => l.includes('已交还控制面保活'));
  assert.strictEqual(demoteLines.length, 1, '同一次降级只允许留证一次（不得每轮刷屏）');

  client._noteDataPlaneFailure(task, usid, '测试账号', '模拟失败 C');
  assert.strictEqual(
    logs.filter((l) => l.includes('已交还控制面保活')).length, 1,
    '已降级状态下的继续失败不得重复刷屏'
  );

  // ── 措辞按底座分叉（SCG 机器不得被宣称"CAG 握手"在保活）──────────────
  // 现场就是 SCG 机：firm-auth 无 cagIp ⇒ 控制面上**没有** CAG 握手这条路。
  const scgUsid = 29566229;
  const scgLogs = [];
  const scgClient = new YdpcClient(
    { id: 'yd_dp_scg', name: '测试账号', vms: [], features: {} },
    {
      appendLog: (tag, message, level) => scgLogs.push(`${tag}|${level}|${message}`),
      sendNotification: () => {},
      saveConfig: () => {}
    }
  );
  const scgTask = { running: true, failStreak: 0, demoted: false, socket: null, routeKind: 'SCG' };
  scgClient.dataPlaneTasks.set(String(scgUsid), scgTask);
  scgClient._noteDataPlaneFailure(scgTask, scgUsid, '测试账号', 'SCG auth 失败：byte[0]=0x0');
  scgClient._noteDataPlaneFailure(scgTask, scgUsid, '测试账号', 'SCG auth 失败：byte[0]=0x0');
  const scgDemote = scgLogs.filter((l) => l.includes('已交还控制面保活'));
  assert.strictEqual(scgDemote.length, 1, 'SCG 机的降级同样必须留证（且只一次）');
  assert.ok(
    /SCG 底座无 CAG 握手通道/.test(scgDemote[0]),
    'SCG 底座没有 CAG 握手通道 ⇒ 降级文案必须如实说明它只剩什么'
  );
  assert.ok(
    !/SOHO 心跳 \+ CAG 握手/.test(scgDemote[0]),
    '不得对 SCG 机器宣称"CAG 握手"参与保活 —— 这条通道在 SCG 上根本不存在（失真）'
  );

  // 行为：底座标签必须真的由 startDataPlaneTask 写进 task。
  // 只断言"源码里有 routeKind === 'SCG'"是不够的 —— 把赋值写死成空串，分叉照样存在却永不生效。
  const dpClient = new YdpcClient(
    { id: 'yd_dp_tag', name: '测试账号', vms: [], features: {} },
    { appendLog: () => {}, sendNotification: () => {}, saveConfig: () => {} }
  );
  dpClient.sohoClient = { sohoToken: null, getFirmAuth: async () => ({}) };
  // login 永不 resolve ⇒ loop 停在第一行，我们只观察"同步写入 task"这一段：
  // 不触网、不留定时器、也不进任何错误分支（悬挂 promise 无害）。
  dpClient.login = () => new Promise(() => {});
  dpClient.startDataPlaneTask({ _route: { kind: 'SCG' } }, '88001', '测试账号');
  const tagged = dpClient.dataPlaneTasks.get('88001');
  assert.ok(tagged, 'startDataPlaneTask 必须把任务登记进 dataPlaneTasks');
  assert.strictEqual(
    tagged.routeKind, 'SCG',
    'startDataPlaneTask 必须把 vm 的底座标签写进 task —— 否则 SCG 机的降级留证会谎称"CAG 握手在保活"'
  );
  dpClient.startDataPlaneTask({ _route: { kind: 'ZTE' } }, '88002', '测试账号');
  assert.strictEqual(
    dpClient.dataPlaneTasks.get('88002').routeKind, 'ZTE',
    'ZTE 机同样要如实带标签（不得一律写死同一边）'
  );

  client._noteDataPlaneProgress(task, usid, '测试账号');
  assert.strictEqual(client.isDataPlaneActive(usid), true, '隧道重建后必须恢复在场（降级不得被永久焊死）');
  assert.ok(logs.some((l) => l.includes('数据面已恢复')), '恢复也必须有留证（状态变化是双向的）');

  // 任务停掉之后一律不算在场
  task.running = false;
  assert.strictEqual(client.isDataPlaneActive(usid), false, '任务已停止 ⇒ 当然不算在场');
});

testAsync('行为：CAG 材料缺失必须在**拨号前**明确拒绝（不得把 undefined 当主机名去查 DNS）', async () => {
  const { performCagAuthHold } = require(path.join(ROOT, 'app', 'ydpc', 'cag_client.js'));
  const t0 = Date.now();
  let err = null;
  try {
    await performCagAuthHold({ vmId: '41371819' }, 0);
  } catch (e) {
    err = e;
  }
  const cost = Date.now() - t0;

  assert.ok(err, 'cagIp / cagHost 皆空时必须**当场拒绝**，绝不能带着 undefined 去拨号');
  assert.strictEqual(err.code, 'CAG_MATERIAL_MISSING', '必须带机器可读错误码，供调用方按"没材料"处理');
  assert.ok(/未下发 CAG 连接材料/.test(err.message), '文案必须点明"没有材料"，不能伪装成网络故障');
  assert.ok(!/undefined/.test(err.message), '文案里不得出现 undefined（那正是旧 bug 的指纹）');
  assert.ok(cost < 500, `必须在拨号前当场拒绝（实测 ${cost}ms）—— 明显变慢说明已经去碰网络了`);

  const cagCode = stripComments(read('app/ydpc/cag_client.js'));
  assert.ok(
    !/String\(firmAuth\.cagIp \|\| firmAuth\.cagHost\)/.test(cagCode),
    '旧写法 String(firmAuth.cagIp || firmAuth.cagHost) 得到字面量 "undefined" —— ' +
      '本轮现场 getaddrinfo ENOTFOUND undefined 的根因，不得复活'
  );
  assert.ok(
    /Number\(a\.cagPort \|\| 8899\)/.test(cagCode),
    'cagPort 缺省仍要保持历史默认 8899（别顺手把能正常工作的 ZTE 机改坏）'
  );
});

test('静态：pingCag 必须对 SCG 机 / 材料缺失**提前拒绝**（跳过语义，而不是失败）', () => {
  const fn = ydpcCode.match(/async pingCag\(userServiceId, holdSeconds = 3\) \{[\s\S]*?\n  \}/);
  assert.ok(fn, '未找到 pingCag 实现');
  const body = fn[0];
  assert.ok(
    /currentVm\.vendor === 'SCG'/.test(body),
    'SCG 机没有 CAG 通道（firm-auth 里 cagIp/cagPort/vmcIp 全空）⇒ 必须提前拒绝，不得去拨'
  );
  assert.ok(/未下发 CAG 连接材料/.test(body), '材料缺失必须在拨号前拒绝 —— ENOTFOUND undefined 的源头');
  assert.ok(
    body.indexOf("currentVm.vendor === 'SCG'") < body.indexOf('performCagAuthHold'),
    'SCG 判定必须排在真正拨号之前'
  );
  assert.ok(
    body.indexOf('未下发 CAG 连接材料') < body.indexOf('performCagAuthHold'),
    '材料判定必须排在真正拨号之前'
  );
  // 三条"没做事"都必须是 return（而非 throw）：抛错会被 runWithGrade 记成真失败并弹 error 告警
  const returns = body.split('return { success: false, message:').length - 1;
  assert.ok(returns >= 3, `关机 / SCG / 材料缺失 三种"没做事"都必须 return success:false，实际 ${returns} 处`);

  // 前端必须同样认识这两类文案，否则手动点按钮会把"跳过"渲染成「握手失败」
  // （断言打在**函数体**上，不打在文件上 —— 否则改了同文件的注释就能让断言假绿）
  const helper = appJs.match(/function isVmOffSkipResult\(data\) \{[\s\S]*?\n\}/);
  assert.ok(helper, '前端必须保留统一的"未执行"识别函数');
  assert.ok(
    /未发起/.test(helper[0]),
    '识别函数必须认识"未发起" —— 否则 SCG 机/材料缺失被点手动按钮时会渲染成失败（假故障）'
  );
});

testAsync('行为：pingCag 对 SCG 机与材料缺失机必须"返回未执行"而不是抛错、更不得去拨号', async () => {
  // 为什么必须用**行为**断言：静态只能证明"那两行字还在"。
  // 把守卫改成 `if (false)`，字符串依旧在、位置依旧在——静态断言全绿而缺陷复活。
  // 所以这里直接调真函数，靠"返回值 / 是否抛错"来判定守卫是否**真的生效**。
  const { YdpcClient } = require(path.join(ROOT, 'app', 'ydpc', 'ydpc_client.js'));
  const running = { vmStatus: '运行中', vmStatusCode: 1 };
  const account = {
    id: 'yd_ping_test',
    name: '测试账号',
    features: {},
    vms: [
      { userServiceId: 41371819, vmName: '家庭云电脑高级版', vendor: 'SCG', ...running },
      { userServiceId: 29566229, vmName: '中兴某机', vendor: 'ZTE', ...running }
    ]
  };
  const client = new YdpcClient(account, {
    appendLog: () => {},
    sendNotification: () => {},
    saveConfig: () => {}
  });
  // 把网络面打桩：守卫若生效，这两处**一次都不该被调用到**
  let firmAuthCalls = 0;
  client.sohoClient = {
    sohoToken: 'stub',
    getFirmAuth: async () => { firmAuthCalls++; return {}; }
  };
  client.login = async () => { throw new Error('守卫失效：不该走到重新登录'); };

  // ① SCG 机：没有 CAG 通道 ⇒ 必须"未执行"
  const scgRes = await client.pingCag(41371819, 1);
  assert.strictEqual(scgRes && scgRes.success, false, 'SCG 机的 CAG 握手绝不能报成功');
  assert.ok(/SCG/.test(String(scgRes.message || '')), '必须说明白是"SCG 无 CAG 通道"，而不是含糊失败');
  assert.strictEqual(firmAuthCalls, 0, 'SCG 守卫必须在取材料**之前**就返回（一次网络都不该发生）');

  // ② ZTE 机但材料缺失（cagIp 未下发）：也必须"未执行"，不得抛错
  let threw = null;
  let zteRes = null;
  try {
    zteRes = await client.pingCag(29566229, 1);
  } catch (e) {
    threw = e;
  }
  assert.strictEqual(
    threw, null,
    '材料缺失必须 return 而不是 throw —— 抛错会被 runWithGrade 记成真失败并弹 error 告警' +
      '（这正是现场 getaddrinfo ENOTFOUND undefined 被报成"链路故障"的机制）'
  );
  assert.strictEqual(zteRes && zteRes.success, false, '没拨号就绝不能报成功');
  assert.ok(
    /未下发 CAG 连接材料/.test(String(zteRes.message || '')),
    '必须点明"材料未下发"，不能伪装成网络故障'
  );
  assert.strictEqual(firmAuthCalls, 1, '材料判定必须紧跟在取材料之后、在拨号之前');
});

// ============================================================================
// 汇总输出（先跑完全部异步断言，再统一出结果）
// ============================================================================
(async () => {
  for (const t of asyncTests) {
    try {
      await t.fn();
      passed++;
      lines.push(`  ok    ${t.name}`);
    } catch (e) {
      failed++;
      const msg = String(e && e.message ? e.message : e).split('\n').join('\n        ');
      lines.push(`  FAIL  ${t.name}`);
      lines.push(`        ${msg}`);
    }
  }

  console.log(lines.join('\n'));
  console.log('\n' + '='.repeat(64));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  console.log('='.repeat(64));

  // 显式退出：测试中可能残留定时器（保活循环句柄 / 永不回包的本地服务端），
  // 不能让进程挂在这里。
  process.exit(failed > 0 ? 1 : 0);
})();
