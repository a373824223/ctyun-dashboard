#!/usr/bin/env node
'use strict';

/**
 * 静态语法检查：对参与运行的核心 JS 文件执行 `node --check`。
 * 为什么独立成脚本：不依赖 shell 的 && 连接与平台差异，Windows/Linux 行为一致，
 * 可直接被 CI 与本地 `npm run check` 复用。
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const FILES = [
  'server.js',
  'app/persist_log.js',
  'app/tasks/native_tasks.js',
  'app/tasks/scheduler.js',
  'app/ydpc/ydpc_client.js',
  'app/ydpc/product_route.js',
  'app/ydpc/cag_boot.js',
  'app/ydpc/zte_cag_raw.js',
  'app/ydpc/zte_cag_tls.js',
  'app/ydpc/scg_keepalive.js',
  'app/ecloud/ecloud_engine.js',
  'app/ecloud/ecloud_client.js',
  'app/ecloud/cmss_connect.js',
  'app/static/app.js',
];

let failed = 0;

// 【自检】关键运行时文件必须留在清单里 —— 防止重构时被误删，导致语法闸门"看不见"它。
// 教训：变异验证曾因清单漂移而退化成假 PASS（见 tests/mutation_check.js 的 2026-09-23 修复）。
const REQUIRED = [
  'server.js',
  'app/ydpc/product_route.js',
  'app/ydpc/zte_cag_tls.js',
  'app/ydpc/scg_keepalive.js',
  'app/ecloud/ecloud_engine.js',
  'app/ecloud/ecloud_client.js',
  'app/ecloud/cmss_connect.js',
];
for (const f of REQUIRED) {
  if (!FILES.includes(f)) {
    console.error(`语法闸门自检失败：关键文件未登记进 FILES —— ${f}`);
    process.exit(1);
  }
}

for (const f of FILES) {
  const abs = path.join(ROOT, f);
  const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`  ok    ${f}`);
  } else {
    failed++;
    console.error(`  FAIL  ${f}`);
    console.error((r.stderr || r.stdout || '').trim());
  }
}

if (failed > 0) {
  console.error(`\n语法检查未通过：${failed} 个文件存在语法错误。`);
  process.exit(1);
}

console.log(`\n语法检查通过：${FILES.length} 个文件全部正常。`);
