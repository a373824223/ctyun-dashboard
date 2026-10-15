'use strict';

// 移动公众 CMSSZTE 桌面使用本机 uSmartView 组件。这里复用其本地 IPC 协议，
// 以组件的「已连接」(6) 为成功依据，再发送「断开连接」(3)。不调用电源接口。
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PUBLIC_KEY = fs.readFileSync(path.join(__dirname, 'cmss_public_key.pem'), 'utf8');
const DEFAULT_SDK = 'D:\\CloudComputer\\drivers\\CMSS\\client\\uSmartView_VDI_Client.exe';
const MAX_FRAME = 1024 * 1024;
let activeConnection = false;

function encryptParams(params) {
  const bytes = Buffer.from(JSON.stringify(params), 'utf8');
  const key = crypto.createPublicKey(PUBLIC_KEY);
  const blockSize = key.asymmetricKeyDetails.modulusLength / 8;
  const chunks = [];
  for (let at = 0; at < bytes.length; at += blockSize - 11) {
    chunks.push(crypto.publicEncrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING },
      bytes.subarray(at, at + blockSize - 11)));
  }
  return Buffer.concat(chunks).toString('base64');
}

function encodeFrame(command, id, companyCode, data) {
  const body = Buffer.from(JSON.stringify({ id, companyCode, data }), 'utf8');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(body.length, 4);
  const raw = Buffer.concat([header, body]);
  const encoded = [];
  for (const byte of raw) {
    if (byte === 14) encoded.push(14, 1);
    else if (byte === 13) encoded.push(14, 2);
    else encoded.push(byte);
  }
  encoded.push(13);
  return Buffer.from(encoded);
}

function decodeFrame(encoded) {
  if (encoded.length > MAX_FRAME) throw new Error('桌面组件消息过大');
  const bytes = [];
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === 14) {
      i++;
      if (encoded[i] === 1) bytes.push(14);
      else if (encoded[i] === 2) bytes.push(13);
      else throw new Error('桌面组件消息转义无效');
    } else bytes.push(encoded[i]);
  }
  const raw = Buffer.from(bytes);
  if (raw.length < 8 || raw.readUInt32LE(4) !== raw.length - 8) {
    throw new Error('桌面组件消息长度无效');
  }
  return { command: raw.readUInt32LE(0), payload: JSON.parse(raw.subarray(8).toString('utf8')) };
}

function sdkParams(info, socketPort) {
  const policies = {
    shutdown: 0, restart: 0, shutdownType: 1, restartType: 1,
    netCheck: 0, attention: 0, set: 0, minize: 0, windowed: 0,
    quit: 0, quitBreak: 0, quitRestart: 0, quitShut: 0,
    closeDeviceSource: 0, reconnectInterval: 0, reconnectTotal: 0,
    autoBreak: 0,
  };
  return {
    vmid: info.machineId,
    timestamp: String(Date.now()),
    socketPort: String(socketPort),
    adUser: info.adUser,
    adPassword: info.adPassword,
    customParams: info.customParams,
    customLoginParams: info.customLoginParams,
    customPrivateLoginParams: info.customPrivateLoginParams,
    forcePreemption: 0,
    isThinClient: false,
    vmName: info.machineName,
    operatePolicys: policies,
    userInfo: info.userInfo,
    osVersion: info.customParams?.osVersion || '',
    desktopname: info.machineName,
    vm_start: false,
    isSpecialLine: false,
    isShowCooperate: false,
    clientVersion: '3.8.4',
    clientType: 'pc_windows',
    accessTicket: info.accessTicket,
    deviceId: info.deviceUid,
    isDev: false,
    connectSession: { connectId: info.connectId, loginId: info.loginUid },
    desktopStatus: info.resourceStatus,
  };
}

async function connectOnce(info, options = {}) {
  if (activeConnection) throw new Error('已有一台云电脑正在执行进入操作，请稍后再试');
  if (process.platform !== 'win32') throw new Error('真实进入仅支持安装了移动云电脑客户端的 Windows 主机');
  if (!info?.machineId || !info?.accessTicket) throw new Error('缺少桌面组件连接参数');
  const sdkPath = process.env.ECLOUD_CMSS_SDK_PATH || DEFAULT_SDK;
  if (!fs.existsSync(sdkPath)) throw new Error('未找到移动云电脑桌面组件，请先安装官方客户端');
  const holdMs = Math.max(3000, Math.min(30000, Number(options.holdMs) || 5000));
  const timeoutMs = Math.max(15000, Math.min(180000, Number(options.timeoutMs) || 90000));
  const onConnected = options.onConnected || (() => Promise.resolve());
  activeConnection = true;
  let child, socket, server, pending = Buffer.alloc(0), connected = false, disconnectSent = false;
  let finished = false, connectedAt = 0, disconnectedAt = 0;
  let timeoutTimer, holdTimer, disconnectTimer, report = null;
  let resolveDone, rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  function cleanup() {
    clearTimeout(timeoutTimer);
    clearTimeout(holdTimer);
    clearTimeout(disconnectTimer);
    if (socket) socket.destroy();
    if (server) server.close();
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
  function finish(error) {
    if (finished) return;
    finished = true;
    disconnectedAt = Date.now();
    cleanup();
    if (error) rejectDone(error);
    else resolveDone({ connected: true, disconnected: true, connectedAt, disconnectedAt });
  }
  function sendDisconnect() {
    if (socket && !socket.destroyed) {
      // 官方 CMSSZTE 客户端通过 1008 控制消息要求组件断开桌面连接。
      // ctrl_type=3 只断开会话，不会关闭云电脑电源。
      disconnectSent = true;
      socket.write(encodeFrame(1008, info.machineId, 'CMSSZTE',
        { ctrlIndex: 11, ctrlData: { ctrl_type: 3 } }));
      disconnectTimer = setTimeout(() => finish(new Error('已发送断开请求，但未收到桌面组件的退出确认')), 10000);
    } else finish(new Error('连接已建立，但桌面组件通道提前断开，无法确认退出'));
  }
  function onFrame(frame) {
    if (frame.payload?.id !== info.machineId || finished) return;
    if (frame.command !== 1010 || frame.payload?.data?.msg_type !== 6) return;
    const notification = frame.payload.data.msg_data;
    if (notification?.type === 6 && !connected) {
      connected = true;
      connectedAt = Date.now();
      report = Promise.resolve().then(() => onConnected())
        .then(() => ({ ok: true }), (error) => ({ ok: false, error: error?.message || String(error) }));
      holdTimer = setTimeout(sendDisconnect, holdMs);
    } else if (notification?.type === 7) {
      if (connected && disconnectSent) finish();
      else finish(new Error('桌面组件在连接成功前已断开'));
    }
  }
  try {
    server = net.createServer((peer) => {
      if (socket) { peer.destroy(); return; }
      socket = peer;
      peer.on('data', (data) => {
        pending = Buffer.concat([pending, data]);
        if (pending.length > MAX_FRAME) { finish(new Error('桌面组件消息过大')); return; }
        let end;
        while ((end = pending.indexOf(13)) !== -1) {
          const frameBytes = pending.subarray(0, end);
          pending = pending.subarray(end + 1);
          try { onFrame(decodeFrame(frameBytes)); }
          catch (e) { finish(e); return; }
        }
      });
      peer.on('error', (e) => { if (!finished) finish(e); });
      peer.on('close', () => {
        if (!finished) finish(new Error(connected
          ? '桌面组件通信已关闭，但未收到退出确认'
          : '桌面组件在连接成功前关闭'));
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const encrypted = encryptParams(sdkParams(info, server.address().port));
    child = spawn(sdkPath, ['--json', encrypted], { stdio: 'ignore', windowsHide: true });
    child.once('error', (e) => finish(e));
    child.once('exit', (code) => {
      // 组件启动器可能把界面交给子进程后以 0 退出，需继续等 IPC 结果。
      if (!finished && !connected && code !== 0) {
        finish(new Error(`桌面组件在连接成功前退出（代码 ${code}）`));
      }
    });
    timeoutTimer = setTimeout(() => finish(new Error('等待桌面组件连接成功超时，已结束本次尝试')), timeoutMs);
    const result = await done;
    if (report) {
      const outcome = await Promise.race([report, new Promise((resolve) => setTimeout(
        () => resolve({ ok: false, error: '会话登记响应超时' }), 10000))]);
      result.reported = outcome.ok;
      if (!outcome.ok) result.reportError = outcome.error;
    }
    return result;
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    activeConnection = false;
  }
}

module.exports = { connectOnce, isConnectionBusy: () => activeConnection, encodeFrame, decodeFrame, sdkParams };
