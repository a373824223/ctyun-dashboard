'use strict';

// 用本地假桌面组件验证短连接与保持连接的控制消息；不访问真实云电脑。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const net = require('net');
const { EventEmitter } = require('events');

const source = fs.readFileSync(path.join(__dirname, '../app/ecloud/cmss_connect.js'), 'utf8');
let moduleExports = {};
let componentSocket = null;
let disconnectCount = 0;
const timerDelays = [];
const sandbox = {
  module: { exports: moduleExports },
  Buffer,
  process: { platform: 'win32', env: {} },
  clearTimeout,
  setTimeout(fn, ms) {
    timerDelays.push(ms);
    return setTimeout(fn, ms >= 15000 ? 1000 : Math.min(ms, 10));
  },
  require(name) {
    if (name === 'fs') return { readFileSync: () => 'fake-public-key', existsSync: () => true };
    if (name === 'path') return path;
    if (name === 'net') return net;
    if (name === 'crypto') return {
      constants: { RSA_PKCS1_PADDING: 1 },
      createPublicKey: () => ({ asymmetricKeyDetails: { modulusLength: 2048 } }),
      publicEncrypt: (_, bytes) => bytes,
    };
    if (name === 'child_process') return {
      spawn(_exe, args) {
        const params = JSON.parse(Buffer.from(args[1], 'base64').toString('utf8'));
        const child = new EventEmitter();
        child.exitCode = null;
        child.killed = false;
        child.kill = () => { child.killed = true; componentSocket?.destroy(); };
        componentSocket = net.connect(Number(params.socketPort), '127.0.0.1');
        componentSocket.on('error', () => {});
        componentSocket.on('connect', () => {
          componentSocket.write(moduleExports.encodeFrame(1010, params.vmid, 'CMSSZTE',
            { msg_type: 6, msg_data: { type: 6 } }));
        });
        componentSocket.on('data', data => {
          const frame = moduleExports.decodeFrame(data.subarray(0, data.indexOf(13)));
          if (frame.command === 1008 && frame.payload.data.ctrlData.ctrl_type === 3) {
            disconnectCount++;
            componentSocket.write(moduleExports.encodeFrame(1010, params.vmid, 'CMSSZTE',
              { msg_type: 6, msg_data: { type: 7 } }));
          }
        });
        return child;
      },
    };
    throw new Error(`unexpected require: ${name}`);
  },
  __dirname: path.join(__dirname, '../app/ecloud'),
};
vm.runInNewContext(source, sandbox, { filename: 'cmss_connect.js' });
moduleExports = sandbox.module.exports;

const info = { machineId: 'fake-machine', instanceId: 'fake-instance', accessTicket: 'fake-ticket', machineName: '测试设备' };
async function main() {
  const short = await moduleExports.connectOnce(info, { onConnected: async () => {} });
  assert.equal(short.connected, true);
  assert.equal(short.disconnected, true);
  assert.equal(disconnectCount, 1, '进入后退出必须发送一次断开会话指令');
  assert.ok(timerDelays.includes(10000), '默认连接保持时间应为约 10 秒');
  const held = await moduleExports.connectPersistent(info, { onConnected: async () => {} });
  assert.equal(held.connected, true);
  assert.equal(moduleExports.isConnectionBusy(), true);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(disconnectCount, 1, '保持连接不应自动发送断开指令');
  await assert.rejects(moduleExports.connectOnce(info), /已有一台云电脑/);
  await held.disconnect();
  assert.equal(disconnectCount, 2, '关闭开关只发送断开会话指令');
  assert.equal(moduleExports.isConnectionBusy(), false);
  console.log('移动公众连接测试通过：10 秒退出、保持连接、手动断开');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
