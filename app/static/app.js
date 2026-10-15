// 全局状态
let accounts = [];
let availableRewards = [];
let autoScroll = true;
let eventSource = null;
let currentUser = null;
let currentAuthToken = localStorage.getItem("ctyun_auth_token") || sessionStorage.getItem("ctyun_auth_token") || "";
let allReceivedLogs = [];
// 【2026-09-25 用户要求·第六轮】已渲染日志行的注册表：行身份键 → HTMLElement。
// 为什么必须有它：SSE 在**每次连接/重连**都会重发最近 80 条历史，而旧代码里
// "非 isUpdate 分支"是无条件 appendChild —— 于是每重连一次就把同一批日志再画一遍，
// 用户看到的就是同一件事带着 x3353、x3354、x3355 … 一长串计数铺满屏幕。
let renderedLogLines = new Map();
// 【2026-09-24 用户要求·第三轮】默认显示「全部」，不再默认只显示「任务」分栏
let activeLogFilter = 'all';
let activePlatformFilter = 'all'; // 'all' | 'ctyun' | 'ydpc' | 'ecloud'
let activeAccountViewTab = 'all'; // 'all' | 'ctyun' | 'ydpc' | 'ecloud'
let currentAddPlatform = 'ctyun';  // 'ctyun' | 'ydpc' | 'ecloud'
// 移动公众两段式登录：需要短信验证时后端返回 pendingId，这里保存中间态
// （未声明时读取会抛 ReferenceError，故必须显式声明）
let pendingEcloudLogin = null; // { pendingId, branch, mobile, name, user, password, keepaliveInterval }
let authMode = "login";
let cachedPointsDetails = [];
let activeEditingAccId = null;
let currentCaptchaChallenge = null;
let qrPollingTimer = null;
let currentQrCodeId = '';
let smsCountdown = 0;
let currentPowerDesktopId = '';
let currentPowerAccountDesktops = [];

// 请求包装：自动携带 token
async function authFetch(url, options = {}) {
  options.headers = options.headers || {};
  if (currentAuthToken) {
    options.headers["Authorization"] = `Bearer ${currentAuthToken}`;
  }
  return fetch(url, options);
}

document.addEventListener("DOMContentLoaded", () => {
  allReceivedLogs = [];
  renderedLogLines.clear();
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = "";
  checkCurrentUser();
  loadStatus();
  loadAccounts();
  // 5 秒自动轮询一次官方真实任务进度与保活心跳
  setInterval(() => {
    loadAccounts(true);
    loadStatus();
  }, 5000);

  // 窗口重获焦点时（例如关闭云电脑弹窗回到控制台主页），立即秒级同步最新开关与机器状态
  window.addEventListener("focus", () => {
    loadAccounts(true);
    loadStatus();
  });

  // 监听登录弹窗中的回车键，按回车直接提交登录！
  const authInputs = [document.getElementById("auth-username"), document.getElementById("auth-password")];
  authInputs.forEach(el => {
    if (el) {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAuth();
        }
      });
    }
  });
});

// 头像下拉菜单控制
function toggleUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  hideSettingsMenu();
}

function hideUserMenu() {
  const menu = document.getElementById("user-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

// 系统设置下拉菜单控制
function toggleSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.toggle("hidden");
  hideUserMenu();
}

function hideSettingsMenu() {
  const menu = document.getElementById("settings-dropdown-menu");
  if (menu) menu.classList.add("hidden");
}

// 点击页面其他区域自动收起所有下拉菜单
document.addEventListener("click", (e) => {
  const userContainer = document.getElementById("user-dropdown-container");
  if (userContainer && !userContainer.contains(e.target)) {
    hideUserMenu();
  }
  const settingsContainer = document.getElementById("settings-dropdown-container");
  if (settingsContainer && !settingsContainer.contains(e.target)) {
    hideSettingsMenu();
  }
});

// 检查当前登录用户身份
async function checkCurrentUser() {
  const authBtn = document.getElementById("btn-auth-action");
  const logPanel = document.getElementById("main-log-panel");
  const loggedActionsGroup = document.getElementById("logged-actions-group");
  const statsGrid = document.getElementById("main-stats-grid");
  const sectionHeader = document.getElementById("main-section-header");
  const headerAvatar = document.getElementById("header-avatar");
  const dropdownUsername = document.getElementById("dropdown-username");
  const menuAdminUsers = document.getElementById("menu-admin-users");

  // 如果本地有持久化凭据，提前恢复界面，消除刷新时 1~2 秒由于异步网络导致的“白屏返回登录界面”闪烁等待！
  if (currentAuthToken) {
    if (authBtn) authBtn.classList.add("hidden");
    if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
    if (statsGrid) statsGrid.classList.remove("hidden");
    if (sectionHeader) sectionHeader.classList.remove("hidden");
    if (logPanel) logPanel.classList.remove("hidden");
  }

  try {
    const res = await authFetch("/api/auth/me");
    const data = await res.json();

    // 动态同步主标题与副标题名称
    if (data.systemTitle) {
      const titleEl = document.getElementById("main-system-title");
      if (titleEl) titleEl.innerText = data.systemTitle;
      document.title = `${data.systemTitle} - 多账号保活控制台`;
    }
    if (data.systemSubtitle) {
      const subtitleEl = document.querySelector(".title-group p");
      if (subtitleEl) subtitleEl.innerText = data.systemSubtitle;
    }

    if (data.isLoggedIn && data.user) {
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      
      // 更新头像首字母/个性化头像和下拉菜单用户名
      const avatarText = currentUser.avatar || (currentUser.username || "A")[0].toUpperCase();
      if (headerAvatar) headerAvatar.innerText = avatarText;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);

      const menuChangePwd = document.getElementById("menu-change-pwd");
      if (menuChangePwd) {
        menuChangePwd.innerText = isAdmin ? "🔒 修改密码/用户名" : "🔒 修改密码";
      }

      const settingsDropdown = document.getElementById("settings-dropdown-container");
      if (settingsDropdown) settingsDropdown.classList.toggle("hidden", !isAdmin);

      // 未登录按钮隐藏，已登录整组展开
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      // 登录状态：显示可点击的蓝色超链接版本号
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      initLogStream();
    } else {
      currentUser = null;
      if (authBtn) {
        authBtn.classList.remove("hidden");
        authBtn.innerText = "🔑 立即登录";
        authBtn.onclick = openAuthModal;
      }
      
      // 未登录时隐藏所有业务区、控制台与已登录菜单
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");

      // 未登录状态：纯灰白普通文本，无下划线，不可点击
      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--text-muted)";
        versionBadge.style.cursor = "default";
        versionBadge.style.textDecoration = "none";
        versionBadge.title = "";
        versionBadge.onclick = null;
      }
    }
  } catch (e) {
    if (!currentAuthToken) {
      if (authBtn) authBtn.classList.remove("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.add("hidden");
      if (statsGrid) statsGrid.classList.add("hidden");
      if (sectionHeader) sectionHeader.classList.add("hidden");
      if (logPanel) logPanel.classList.add("hidden");
    }
  }
}

// Toast 提示 (带自动容错与自愈容器)
function showToast(message, type = "info") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.style.whiteSpace = "pre-line"; // 支持换行多排显示
  toast.innerText = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, 4500);
}

// 模态框辅助
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
}

function closeModal(id) {
  document.getElementById(id).classList.add("hidden");
}

// 1. 加载系统统计
async function loadStatus() {
  try {
    const res = await authFetch("/api/status");
    const data = await res.json();
    document.getElementById("stat-total").innerText = data.accountsTotal || 0;
    document.getElementById("stat-online").innerText = data.onlineKeepAlive || 0;
    document.getElementById("stat-signed").innerText = data.signedToday || 0;
    document.getElementById("stat-points").innerText = data.totalEarnedPoints || 0;
    cachedPointsDetails = data.pointsDetails || [];
  } catch (e) {
    console.error("加载状态异常:", e);
  }
}

// 打开每日已获得积分详细明细模态框 (展示各任务具体达成时间节点)
function openPointsDetailModal() {
  const sumEl = document.getElementById("modal-points-sum");
  const listEl = document.getElementById("points-detail-list");
  const totalEarned = document.getElementById("stat-points").innerText || "0";
  sumEl.innerText = totalEarned;
  listEl.innerHTML = "";

  if (!cachedPointsDetails || cachedPointsDetails.length === 0) {
    listEl.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted); font-size:13px;">暂无云电脑今日积分明细</div>`;
    openModal("points-detail-modal");
    return;
  }

  cachedPointsDetails.forEach(acc => {
    const item = document.createElement("div");
    item.style.cssText = "background:var(--bg-surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; box-shadow:var(--shadow-sm);";

    let taskRows = (acc.tasks || []).map(t => {
      const isDone = t.completed || t.points > 0;
      return `
        <div style="display:flex; justify-content:space-between; align-items:center; font-size:12.5px; padding:8px 0; border-bottom:1px dashed #e2e8f0;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:14px;">${isDone ? '✅' : '⏳'}</span>
            <span style="font-weight:600; color:#0f172a;">${escapeHtml(t.name)}</span>
            <span style="font-size:11px; font-weight:700; color:${isDone ? '#16a34a' : '#64748b'}; background:${isDone ? '#f0fdf4' : '#f1f5f9'}; padding:2px 8px; border-radius:9999px; border:1px solid ${isDone ? '#bbf7d0' : '#e2e8f0'};">
              ${isDone ? `+${t.points} 积分` : `进行中 (${t.progress || '0/1'})`}
            </span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; font-size:12px;">
            <span style="color:var(--text-muted);">达成时间节点:</span>
            <span style="font-family:monospace; font-weight:600; color:${isDone ? '#2563eb' : '#94a3b8'}; background:${isDone ? '#eff6ff' : '#f8fafc'}; padding:2px 8px; border-radius:4px; border:1px solid ${isDone ? '#dbeafe' : '#f1f5f9'};">
              ${isDone ? `🕒 ${escapeHtml(t.completedAt || '今日已达成')}` : '等待今日达成'}
            </span>
          </div>
        </div>
      `;
    }).join("");

    item.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; padding-bottom:8px; border-bottom:1px solid var(--border);">
        <span style="font-size:14px; font-weight:700; color:#0f172a;">🖥️ ${escapeHtml(acc.accountName)}</span>
        <span style="font-size:13px; color:#16a34a; font-weight:700;">今日获得: +${acc.todayPoints}分 (总积分: ${acc.totalPoints})</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:2px;">
        ${taskRows}
      </div>
    `;
    listEl.appendChild(item);
  });

  openModal("points-detail-modal");
}

// 2. 加载多账号列表
async function loadAccounts(isSilent = false) {
  try {
    const res = await authFetch("/api/accounts");
    accounts = await res.json();
    renderAccounts();
    if (!isSilent) loadStatus();
  } catch (e) {
    if (!isSilent) showToast("加载账号列表失败: " + e.message, "error");
  }
}

function switchAccountViewTab(tab) {
  activeAccountViewTab = tab;
  const tabAll = document.getElementById("view-tab-all");
  const tabCt = document.getElementById("view-tab-ctyun");
  const tabYd = document.getElementById("view-tab-ydpc");
  const tabEc = document.getElementById("view-tab-ecloud");
  if (tabAll) tabAll.className = tab === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabCt) tabCt.className = tab === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabYd) tabYd.className = tab === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tabEc) tabEc.className = tab === 'ecloud' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderAccounts();
}

// 记录每个卡片各折叠面板的展开/收起状态 (持久化到 localStorage)
function getDetailsStateKey(accId, panelKey) {
  return `ctyun_details_${accId}_${panelKey}`;
}

function isDetailsOpen(accId, panelKey, defaultOpen = true) {
  const saved = localStorage.getItem(getDetailsStateKey(accId, panelKey));
  if (saved === null) return defaultOpen;
  return saved === 'true';
}

function saveDetailsState(accId, panelKey, isOpen) {
  localStorage.setItem(getDetailsStateKey(accId, panelKey), String(isOpen));
}

// 获取当前网格的响应式列数
function getGridColumns() {
  const container = document.getElementById("accounts-container");
  if (!container) return 3;
  const style = window.getComputedStyle(container);
  const gridTemplateColumns = style.gridTemplateColumns;
  if (!gridTemplateColumns || gridTemplateColumns === "none") return 3;
  const cols = gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  return Math.max(1, cols);
}

// 缓存当前用户的网格插槽布局状态: array of (accId | null)
function getGridSlotsKey() {
  const uid = currentUser?.userId || 'u_admin';
  return `ctyun_grid_slots_${uid}_${activeAccountViewTab}`;
}

// 当前已配置的平台集合（三平台并行：ctyun / ydpc / ecloud）
// 只有 >=2 个平台并存时才展示平台视图 Tab 与筛选，单平台时自动隐藏以免视觉噪音。
function getPresentPlatforms() {
  const set = new Set();
  for (const a of (accounts || [])) {
    if (!a) continue;
    set.add(a.platform || 'ctyun');
  }
  return set;
}

function getFilteredAccounts() {
  const platforms = getPresentPlatforms();
  const multi = platforms.size >= 2;
  return (accounts || []).filter(acc => {
    if (!multi) return true; // 单一平台不过滤
    if (activeAccountViewTab === 'all') return true;
    if (activeAccountViewTab === 'ctyun') return acc.platform === 'ctyun' || !acc.platform;
    if (activeAccountViewTab === 'ydpc') return acc.platform === 'ydpc';
    if (activeAccountViewTab === 'ecloud') return acc.platform === 'ecloud';
    return true;
  });
}

function loadGridSlots(filteredAccs, cols) {
  const key = getGridSlotsKey();
  let savedSlots = null;
  try {
    const raw = localStorage.getItem(key);
    if (raw) savedSlots = JSON.parse(raw);
  } catch (e) {}

  const currentIds = new Set(filteredAccs.map(a => a.id));
  let slots = Array.isArray(savedSlots) ? [...savedSlots] : [];

  // 清理不存在于当前过滤列表的无效 ID
  for (let i = 0; i < slots.length; i++) {
    if (slots[i] && !currentIds.has(slots[i])) {
      slots[i] = null;
    }
  }

  // 确保所有当前账号都已映射到插槽
  const placedIds = new Set(slots.filter(Boolean));
  for (const acc of filteredAccs) {
    if (!placedIds.has(acc.id)) {
      const emptyIdx = slots.indexOf(null);
      if (emptyIdx !== -1) {
        slots[emptyIdx] = acc.id;
      } else {
        slots.push(acc.id);
      }
      placedIds.add(acc.id);
    }
  }

  // 计算最后一个实际有卡片占用的插槽索引
  let lastOccupied = -1;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (slots[i] && currentIds.has(slots[i])) {
      lastOccupied = i;
      break;
    }
  }

  // 约束总行数：以最高占用行与最少必要行对齐，杜绝末尾凭空多出空行
  const minRows = Math.ceil(filteredAccs.length / cols);
  const occupiedRows = lastOccupied >= 0 ? Math.ceil((lastOccupied + 1) / cols) : 0;
  const totalRows = Math.max(minRows, occupiedRows, 1);
  const totalSlots = totalRows * cols;

  if (slots.length > totalSlots) {
    slots = slots.slice(0, totalSlots);
  }
  while (slots.length < totalSlots) {
    slots.push(null);
  }

  return slots;
}

function saveGridSlots(slots) {
  const key = getGridSlotsKey();
  try {
    localStorage.setItem(key, JSON.stringify(slots));
  } catch (e) {}
}

function buildOfficialTasksHtml(m) {
  if (m.officialTasks && m.officialTasks.length > 0) {
    return m.officialTasks.map(t => {
      const isDone = t.status === 2 || (t.total > 0 && t.current >= t.total);
      const percent = Math.min(100, Math.round((t.current / (t.total || 1)) * 100));
      let progressText = `${t.current}/${t.total}`;
      if (t.name.includes('使用1小时')) {
        const mins = Math.floor(t.current / 60);
        progressText = `${mins}分钟 (${t.current}/3600秒)`;
      }

      return `
        <div style="background: #ffffff; padding: 8px 10px; border-radius: 6px; border: 1px solid var(--border); box-shadow: 0 1px 2px rgba(0,0,0,0.02);">
          <div style="display: flex; justify-content: space-between; align-items: center; font-size: 12px; margin-bottom: 5px; gap: 6px;">
            <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🎯 <b style="color:#0f172a;">${t.name}</b> <span style="color:#2563eb; font-weight:600;">(+${t.points}分)</span></span>
            <span style="color: ${isDone ? '#16a34a' : '#d97706'}; font-weight: 700; flex-shrink: 0; font-size: 11px;">
              ${isDone ? '✅ 已达成' : '⏳ ' + progressText}
            </span>
          </div>
          <div style="background: #e2e8f0; height: 5px; border-radius: 4px; overflow: hidden;">
            <div style="background: ${isDone ? '#16a34a' : '#2563eb'}; width: ${percent}%; height: 100%; transition: width 0.3s ease;"></div>
          </div>
        </div>
      `;
    }).join('');
  }
  return `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 6px 0;">正在同步天翼云官方任务中心数据...</div>`;
}

// 计算单账号多机周期的综合概览展示文本 (支持单机差异化周期精准动态呈现)
// 注：天翼云以「秒」为表达单位，移动爱家与移动公众以「分钟」为表达单位（各自习惯不同）。
function buildIntervalOverviewText(acc) {
  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  const useMinutes = isYdpc || isEcloud;
  const fallbackSec = isYdpc ? 600 : (isEcloud ? 300 : 30);
  const defaultIntervalSec = parseInt(acc.keepaliveInterval || acc.pulseIntervalSeconds) || fallbackSec;
  const items = isYdpc ? (acc.vms || []) : (acc.desktops || []);

  // 1. 若仅有 1 台云电脑，直接精准展示该主机的实际生效周期
  if (items.length === 1) {
    const singleSec = parseInt(items[0].keepaliveInterval) || defaultIntervalSec;
    return useMinutes ? `${Math.round(singleSec / 60)} 分钟` : `${singleSec}s`;
  }

  // 2. 若有多台云电脑
  if (items.length > 1) {
    const itemIntervals = items.map(it => parseInt(it.keepaliveInterval) || defaultIntervalSec);
    const allSame = itemIntervals.every(v => v === itemIntervals[0]);
    // 若多台云电脑设置的周期全部相同，直接统一展示该周期
    if (allSame) {
      return useMinutes ? `${Math.round(itemIntervals[0] / 60)} 分钟` : `${itemIntervals[0]}s`;
    }
    // 周期各不相同时，展示多机独立详情
    const parts = items.map(it => {
      const sec = parseInt(it.keepaliveInterval) || defaultIntervalSec;
      const rawName = String(it.vmName || it.machineName || it.desktopName || '主机');
      const shortName = rawName.slice(0, 4);
      return `${shortName} ${useMinutes ? Math.round(sec / 60) + '分' : sec + 's'}`;
    });
    return `多机独立 (${parts.join(' · ')})`;
  }

  return useMinutes ? `${Math.round(defaultIntervalSec / 60)} 分钟` : `${defaultIntervalSec}s`;
}

// ====================================================
// 📱 移动云：按主机维度的保活状态渲染
// ----------------------------------------------------
// 为什么需要：一个移动云账号下可挂多台云电脑，各机状态（运行/关机/时长耗尽/
// 单机保活开关/独立周期/数据面是否在场）可以完全不同。原来这里只有一行
// 账号级"当前动作"，既表达不了多机差异，又会长期停在「保活巡检待命中」。
// 现在逐台渲染；状态文字一律来自后端下发的 vm.keepAliveView（前端不臆造状态），
// 只有"距下次巡检"倒计时在本地按 nextDueAt 现算，保证 5 秒轮询下始终新鲜。
// ====================================================
const YDPC_TONE_COLORS = {
  ok: '#16a34a',     // 正常保活
  idle: '#0284c7',   // 等待/即将执行
  warn: '#d97706',   // 时长耗尽等需要注意
  off: '#94a3b8',    // 未参与/已关闭
  error: '#dc2626'   // 异常
};
const YDPC_TONE_DOTS = {
  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴'
};

// 剩余秒数 → 人类可读（秒 / 分钟 / 小时+分）
function formatYdpcRemainText(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

// 构造移动云"名下各主机当前动作"整块 HTML（逐台一行区，含状态/当前动作/时间与倒计时）
function buildYdpcVmMonitorHtml(acc) {
  const vms = acc.vms || acc.liveMetrics?.vms || [];
  if (!vms.length) {
    return '<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">暂未拉取到名下云主机，点击下方心跳或握手自动同步</div>';
  }

  return vms.map(vm => {
    const usid = String(vm.userServiceId || '');
    const vmName = vm.vmName || '移动云电脑';
    const view = vm.keepAliveView || null;

    // 后端视图缺失时降级：只展示能从 vm 直接读到的信息，绝不假装知道当前动作
    if (!view) {
      const running = String(vm.vmStatus || '').includes('运行') || vm.vmStatusCode === 1;
      return `
        <div class="vm-mon-row" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
          <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
            <span style="flex-shrink: 0;">${running ? '🟢' : '⚪'}</span>
            <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>
          </div>
          <div style="font-size: 11.5px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">当前动作: 等待后端状态同步…</div>
        </div>
      `;
    }

    const toneColor = YDPC_TONE_COLORS[view.tone] || '#64748b';
    const dot = YDPC_TONE_DOTS[view.tone] || '⚪';

    // 周期文本
    const intervalSec = parseInt(view.intervalSec) || 600;
    const intervalText = intervalSec >= 60 ? `${Math.round(intervalSec / 60)} 分钟` : `${intervalSec} 秒`;

    // 距下次巡检倒计时：仅"运行中 + 单机保活开着 + 已有保活记录"才是有效语义
    let nextText = '';
    if (view.running && view.keepaliveOn && view.nextDueAt > 0) {
      const remainSec = (view.nextDueAt - Date.now()) / 1000;
      nextText = remainSec <= 0
        ? ' · <b style="color: #0284c7;">即将巡检</b>'
        : ` · 距下次 <b style="color: #0f172a;">${formatYdpcRemainText(remainSec)}</b>`;
    }

    const timeLine = view.lastKeepAliveText
      ? `上次保活: <b style="color: #0f172a;">${escapeHtml(view.lastKeepAliveText)}</b> · 周期: <b>${intervalText}</b>${nextText}`
      : `周期: <b>${intervalText}</b>${nextText}`;

    const actionLine = view.lastActionText
      ? `最近动作: <span style="color: ${toneColor}; font-weight: 600;">${escapeHtml(view.lastActionText)}</span>`
      : '';

    // 【2026-09-25 用户要求】「上次保活: …」这一行会被 ellipsis 截断（卡片窄），
    // 用户要求鼠标悬停时能看到完整内容 ⇒ 用**去标签后的纯文本**做 title（title 属性不吃 HTML）。
    const timeLineFull = htmlToPlainTitle(timeLine + (actionLine ? ' · ' + actionLine : ''));

    // 【2026-09-24 用户要求·第四轮】「当前动作」后面的动作文字原先没写 font-size ⇒ 继承卡片正文字号
    // （.account-card 未声明 font-size，实际落到浏览器默认 16px），与 11.5px 的「当前动作:」标签一比就显大。
    // 此处显式对齐到 11.5px（颜色 / 字重不变）。
    //
    // 【2026-09-25 用户要求·第七轮】同一个"未声明字号"的坑也发生在**主机名**那一行：
    // 监视板块（.features-box）整体未声明 font-size，"云电脑省侧部署包高阶版月报 / 8C16G版云电脑月包 /
    // 我的电脑" 这类名称便以 16px 渲染，与周围 11 / 11.5 / 12px 的文字比明显偏大。
    // 现显式声明 12px —— 与「名下云主机」列表（.vm-device-item 本就是 12px）对齐，整卡字号重回一档。
    return `
      <div class="vm-mon-row" id="vm-mon-${acc.id}-${escapeHtml(usid)}" style="display: flex; flex-direction: column; gap: 2px; padding: 5px 0; border-top: 1px dashed var(--border);">
        <div style="display: flex; align-items: baseline; gap: 5px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0;">${dot}</span>
          <span style="font-size: 12px; font-weight: 700; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(vmName)}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0; padding-left: 16px;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span>
          <span title="${escapeHtml(view.actionText || '')}" style="font-size: 11.5px; color: ${toneColor}; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(view.actionText || '待命中')}</span>
        </div>
        <div title="${escapeHtml(timeLineFull)}" style="font-size: 11.5px; color: #475569; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${timeLine}${actionLine ? ' · ' + actionLine : ''}</div>
        ${view.hintText ? `<div style="font-size: 11px; color: #94a3b8; padding-left: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(view.hintText)}</div>` : ''}
      </div>
    `;
  }).join('');
}

// ====================================================
// 📡 移动公众：分层保活状态渲染
// ----------------------------------------------------
// 用户明令「移动爱家、移动公众、天翼云电脑，他们三个的保活代码机制不要重叠，各是各的，
// 日志也是」。因此本段**刻意不复用** buildYdpcVmMonitorHtml 的色调表 / 文案模板 /
// keepAliveView 字段（那是 userServiceId 主键 + 运行/关机语义）；移动公众自有：
//   - 主键 instanceId（与 ydpc 的 userServiceId 各自独立）
//   - 保活分层语义 L1 账号态 / L2 桌面登记（原 L3 占位层已于 2026-09-26 整层删除）
//   - 诚实性标注 claim:'none' —— HTTP 层探针成功 ≠ 云电脑不会被关机
// 视图数据一律来自后端下发的 desktop.keepAliveView（前端不臆造状态）。
// ====================================================
const ECLOUD_TONE_COLORS = {
  ok: '#16a34a',     // 探针通过（与移动爱家 ok 同色 —— 用户 2026-09-24：三平台「当前动作」文字颜色要一致）
  idle: '#0284c7',   // 等待/即将巡检
  warn: '#d97706',   // 需注意（如周期未到但上次异常）
  off: '#94a3b8',    // 未参与/已关闭
  error: '#dc2626',  // 异常
  unknown: '#7c3aed' // 尚未判定
};
const ECLOUD_TONE_DOTS = {
  ok: '🟢', idle: '🔵', warn: '🟠', off: '⚪', error: '🔴', unknown: '🟣'
};
// 【2026-09-24 用户要求·第二轮】移动公众的账号头像原先单独覆写品牌色（旧紫 #7c3aed → 后改 #0369a1），
// 而另两平台头像都沿用 style.css 的 .account-avatar 默认浅色 → 被用户判为「搞特殊」。
// 现**不再覆写**：三平台头像统一走 .account-avatar 默认样式（原用于头像的那个强调色常量已一并移除）。

// 剩余秒数 → 人类可读（移动公众自有实现，与移动爱家的 formatYdpcRemainText 分开）
function formatEcloudRemainText(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '';
  const s = Math.max(0, Math.round(Number(sec)));
  if (s < 60) return `${s} 秒`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `${h} 小时 ${rest} 分` : `${h} 小时`;
}

// 单机色调：关闭 > 异常 > 成功 > 待命
function ecloudViewTone(view) {
  if (!view) return 'unknown';
  if (!view.enabled) return 'off';
  const lvl = view.lastAction && view.lastAction.level;
  if (lvl === 'error') return 'error';
  if (lvl === 'warn') return 'warn';
  if (lvl === 'off') return 'off';
  if (lvl === 'ok') return 'ok';
  return 'idle';
}

// 【2026-09-24 用户要求】原「L1 账号态徽章」与「分层保活总览条」（L1/L2/L3 三行）
// 已从卡片移除 —— 卡片刻意只保留"账号下云电脑 + 逐台动作/保活状态"，
// 分层结论改由**日志流**承载（见 app/ecloud/ecloud_client.js 的 _logLayerSummary：
// L1 账号态 / L2 桌面登记的状态会在每轮巡检后写入 source='ECLOUD' 的日志）。
// 诚实性红线不变：L1/L2 只是 HTTP 层探针，探针成功 ≠ 云电脑不会被关机。

// 逐台云电脑"当前动作"整块 HTML（多机各自一行，状态全部来自后端 keepAliveView）
function getEcloudClientDisplayName(computerName) {
  const fullName = String(computerName || '').trim();
  if (!fullName) return '';
  // 平台返回 DESKTOP-<长随机串>-<创建时间>；客户端显示的 Windows 名称为前 15 字符。
  const windowsName = fullName.match(/^DESKTOP-[0-9a-f]{7}/i);
  return windowsName ? windowsName[0].toUpperCase() : fullName;
}

const ecloudDeviceSearch = new Map();
function ecloudDeviceSearchText(desktop) {
  return [desktop.computerName, getEcloudClientDisplayName(desktop.computerName), desktop.machineName]
    .filter(Boolean).join(' ').toLocaleLowerCase();
}
function applyEcloudDeviceFilter(card, value) {
  const query = String(value || '').trim().toLocaleLowerCase();
  let visible = 0;
  const rows = card.querySelectorAll('.ecloud-desktop-grid .vm-device-item');
  rows.forEach(row => {
    const match = !query || row.dataset.searchName.includes(query);
    row.classList.toggle('ecloud-device-hidden', !match);
    if (match) visible++;
  });
  card.querySelectorAll('.ecloud-monitor-grid .ec-mon-row').forEach(row => {
    row.classList.toggle('ecloud-device-hidden', !!query && !row.dataset.searchName.includes(query));
  });
  const count = card.querySelector('.ecloud-search-count');
  if (count) count.textContent = `显示 ${visible} / ${rows.length} 台`;
  const empty = card.querySelector('.ecloud-search-empty');
  if (empty) empty.hidden = !query || visible > 0;
}
function filterEcloudDevices(accId, value) {
  ecloudDeviceSearch.set(accId, value);
  const card = document.getElementById(`acc-card-${accId}`);
  if (card) applyEcloudDeviceFilter(card, value);
}

function buildEcloudDesktopMonitorHtml(acc) {
  const desktops = acc.desktops || acc.liveMetrics?.desktops || [];
  if (!desktops.length) {
    return '<div style="font-size: 12px; color: var(--text-muted); padding: 4px 0;">暂未拉取到名下云主机，点击下方「同步桌面」或「立即保活」自动拉取</div>';
  }

  return desktops.map(d => {
    const iid = String(d.instanceId || '');
    const name = getEcloudClientDisplayName(d.computerName) || d.machineName || '移动公众云电脑';
    const nameTitle = d.computerName ? `${d.computerName} · ${d.machineName || '移动公众云电脑'} · ${iid}` : `${name} · ${iid}`;
    const view = d.keepAliveView || null;
    // 【2026-09-24 用户要求】逐台监视行做减法：不再显示「启用徽章」与厂商徽章 CMSSZTE（两枚一并删除）——
    // 这些信息在「名下云主机」列表里已有；本行只保留 圆点 + 名称 + 当前动作。

    // 视图缺失时降级：只陈述客观事实，绝不臆造"当前动作"
    if (!view) {
      return `
        <div class="ec-mon-row" id="ec-mon-${acc.id}-${escapeHtml(iid)}" data-search-name="${escapeHtml(ecloudDeviceSearchText(d))}">
          <div class="ec-mon-name" title="${escapeHtml(nameTitle)}"><span>🟣</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(iid.slice(-8))}</small></div>
          <div class="ec-mon-action" style="color: #94a3b8;"><span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span><span>等待后端状态同步…</span></div>
        </div>
      `;
    }

    const tone = ecloudViewTone(view);
    const toneColor = ECLOUD_TONE_COLORS[tone] || '#64748b';
    const dot = ECLOUD_TONE_DOTS[tone] || '⚪';

    const intervalSec = parseInt(view.intervalSec) || 300;
    const intervalText = intervalSec >= 60 ? `${Math.round(intervalSec / 60)} 分钟` : `${intervalSec} 秒`;

    // 距下次巡检倒计时：仅"本机启用 + 已有保活记录"才是有效语义，否则不显示假倒计时
    let nextText = '';
    if (view.enabled && view.elapsedSec > 0 && view.remainSec >= 0) {
      nextText = view.remainSec <= 0
        ? ' · <b style="color: #0284c7;">即将巡检</b>'
        : ` · 距下次 <b style="color: #0f172a;">${formatEcloudRemainText(view.remainSec)}</b>`;
    }

    const lastText = view.elapsedSec > 0
      ? `上次保活: <b style="color: #0f172a;">${formatEcloudRemainText(view.elapsedSec)}前</b> · 周期: <b>${intervalText}</b>${nextText}`
      : `周期: <b>${intervalText}</b>${nextText}`;

    const actionText = (view.lastAction && view.lastAction.text) || (view.enabled ? '待巡检' : (view.disabledReason || '未参与巡检'));

    // 【2026-09-25 用户要求】同上：这一行会被 ellipsis 截断，悬停必须能看全 ⇒ title 用纯文本。
    const lastTextFull = htmlToPlainTitle(
      lastText + (view.uptime ? ` · 在线时长: ${view.uptime}` : '')
    );

    // 【2026-09-24 用户要求·第四轮】「当前动作」后面的动作文字显式对齐到 11.5px —— 原先未声明
    // font-size 会继承卡片正文字号（.account-card 未声明，实际是浏览器默认 16px），比 11.5px 的标签明显大。
    // 【2026-09-25 用户要求·第七轮】主机名同样补上显式 12px —— 理由与移动爱家监视行完全一致：
    // 这些 span 不写字号就会继承浏览器默认 16px，而周围是 11 / 11.5 / 12px，于是看着"字体偏大"。
    return `
      <div class="ec-mon-row" id="ec-mon-${acc.id}-${escapeHtml(iid)}" data-search-name="${escapeHtml(ecloudDeviceSearchText(d))}">
        <div class="ec-mon-name" title="${escapeHtml(nameTitle)}"><span>${dot}</span><strong>${escapeHtml(name)}</strong><small>${escapeHtml(iid.slice(-8))}</small></div>
        <div class="ec-mon-action"><span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span><span title="${escapeHtml(actionText)}" style="font-size: 11.5px; color: ${toneColor};">${escapeHtml(actionText)}</span></div>
        <div class="ec-mon-meta" title="${escapeHtml(lastTextFull)}">${lastText}${view.uptime ? ` · 在线时长: <b>${escapeHtml(String(view.uptime))}</b>` : ''}</div>
      </div>
    `;
  }).join('');
}

// 构造单个账号卡片 DOM 节点
function buildAccountCardElement(acc, slotIndex) {
  const card = document.createElement("div");
  card.className = "account-card";
  if (acc.platform === 'ecloud') card.classList.add('account-card--ecloud');
  card.id = `acc-card-${acc.id}`;
  card.dataset.accId = acc.id;
  card.dataset.slot = slotIndex;
  card.draggable = true;

  // 绑定 HTML5 原生无损拖拽事件
  card.addEventListener("dragstart", handleCardDragStart);
  card.addEventListener("dragover", handleCardDragOver);
  card.addEventListener("dragleave", handleCardDragLeave);
  card.addEventListener("drop", handleCardDrop);
  card.addEventListener("dragend", handleCardDragEnd);

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  // 【2026-09-24 用户要求·第三轮】账号级「保活在线/离线待机」徽章（原 statusBadge）已删除，
  // 连带 isYdpcRealOnline 一并移除 —— 监视板块改为可折叠标题，不再显示该 logo。

  const fullPhone = escapeHtml(acc.user);
  const displayName = acc.name || acc.user;
  const isEditingThis = (activeEditingAccId === acc.id);
  const f = acc.features || {};
  const m = acc.liveMetrics || {};

  if (isEcloud) {
    // ====================================================
    // 📡 移动公众云电脑专属卡片呈现
    // ----------------------------------------------------
    // 版式参考移动爱家卡片（用户要求），但**渲染函数与数据字段完全独立**：
    // 主机主键是 instanceId、状态来自 desktop.keepAliveView（后端现算）、
    // 保活分层为 L1/L2/L3。任何一处复用移动爱家的模块都会破坏"机制与日志不重叠"。
    // ====================================================
    const desktops = acc.desktops || m.desktops || [];
    const desktopsCountText = desktops.length > 0 ? `名下云主机 (${desktops.length}台)` : '云主机';

    const isGlobalKeepAliveOff = f.keepAlive === false;
    const isAutoEnterEnabled = f.autoEnter === true ||
      (f.autoEnter === undefined && desktops.some(d => d.realEnterEnabled === true));

    let ecMultiStatusBadge = '';
    if (isGlobalKeepAliveOff) {
      ecMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
    } else {
      const anyKeepOn = desktops.some(d => d.keepaliveEnabled !== false);
      const allKeepOn = desktops.every(d => d.keepaliveEnabled !== false);
      if (allKeepOn && desktops.length > 1) {
        ecMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
      } else if (anyKeepOn) {
        ecMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
      } else {
        ecMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
      }
    }

    // 【2026-09-24 用户要求】原「侧车 ready / 引擎离线」小徽章已从卡片移除。
    // 侧车进程状态改为落日志流（ecloud_client.js 的 engine.on('exit') 会写错误日志）。
    // 【2026-09-24 用户要求·第三轮】账号级状态徽章（保活在线 / 部分降级 / 待短信验证 / 离线待机）
    // 亦已随「保活在线 logo」一并删除 —— 在线口径改由日志流承载，卡片不再重复声明。

    let desktopsHtml = '';
    if (desktops.length > 0) {
      desktopsHtml = `
        <div class="ecloud-desktops-panel">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ ${desktopsCountText}${desktops.length > 9 ? ' <small style="font-weight: 400; color: #64748b;">· 区域内滚动查看更多</small>' : ''}</span>
            <span id="acc-multi-status-${acc.id}">${ecMultiStatusBadge}</span>
          </div>
          <div class="ecloud-desktop-grid ${desktops.length > 9 ? 'ecloud-list-scroll' : ''}">
            ${desktops.map(d => {
              const iid = String(d.instanceId || '');
              const isKeepaliveOn = d.keepaliveEnabled !== false;

              // 【2026-09-28 修订】状态徽章改用**合成判定**（保留 keepAliveView.powerState）：
              //   依据优先级 = 在线时长探测(NO_UPTIME ⇒ 已关机) > 平台操作表(powerOnEnable) > 平台状态。
              //   单一信号都不可全信（实测：平台状态会滞后数小时；09-26 关机后"在线时长"还能继续计时）。
              //   title 里如实标注依据来源与平台原始 resourceStatus，便于对不上时排查。
              const view = d.keepAliveView || null;
              const powerState = String((view && view.powerState) || d.powerState || '').toLowerCase();
              const powerEvidence = (view && view.powerEvidence) || '平台状态';
              const statusRaw = escapeHtml(String(d.resourceStatus || '—'));
              const powerBadge = powerState === 'on'
                ? `<span class="badge badge-online" title="依据：${escapeHtml(powerEvidence)}；平台原始 resourceStatus: ${statusRaw}">运行中</span>`
                : (powerState === 'off'
                  ? `<span class="badge badge-offline" title="依据：${escapeHtml(powerEvidence)}；平台原始 resourceStatus: ${statusRaw}">已关机</span>`
                  : `<span class="badge" style="background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;" title="尚未取到运行状态（getDesktopStatus 未返回）">状态未知</span>`);

              // instanceId 很长（CCA-<32hex>）且整行会被 ellipsis 截断 ⇒ 悬停用 title 给出完整文本
              const iidLineText = `instanceId: ${iid || '—'}`;
              const clientDisplayName = getEcloudClientDisplayName(d.computerName);
              const desktopDisplayName = clientDisplayName || d.machineName || '移动公众云电脑';
              const desktopNameTitle = d.computerName
                ? `客户端: ${d.computerName} · 云电脑: ${d.machineName || '移动公众云电脑'}`
                : desktopDisplayName;
              const lastRealEnterText = d.lastRealEnterAt
                ? `上次真实进入：${new Date(d.lastRealEnterAt).toLocaleString('zh-CN')}`
                : '尚未真实进入';
              // 平台 machineList[].expireTime 是服务期限（Unix 毫秒），与开机/在线时长无关。
              const serviceExpiryMs = Number(d.expireTime);
              const serviceExpiryValid = Number.isFinite(serviceExpiryMs) && serviceExpiryMs > 0;
              const serviceExpiryText = serviceExpiryValid
                ? new Date(serviceExpiryMs).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
                  })
                : '';

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="ec-item-${acc.id}-${escapeHtml(iid)}" data-search-name="${escapeHtml(ecloudDeviceSearchText(d))}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span title="${escapeHtml(desktopNameTitle)}" style="font-size: 12px; color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(desktopDisplayName)}</span>
                        ${d.originCompanyCode ? `<span class="badge" style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(d.originCompanyCode)}</span>` : ''}
                      </div>
                      <!-- instanceId 过长：整行省略号截断，鼠标悬停显示完整 ID -->
                      <div title="${escapeHtml(iidLineText)}" style="font-size: 11px; color: #64748b; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtml(iidLineText)}</div>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                      ${powerBadge}
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${escapeHtml(iid)}" onclick="toggleVmFeature('${acc.id}', '${escapeHtml(iid)}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关">⚡保活: ${keepText}</button>
                      <select class="pill-select" id="pill-interval-${acc.id}-${escapeHtml(iid)}" onchange="changeVmInterval('${acc.id}', '${escapeHtml(iid)}', this.value)" title="单台云电脑独立保活周期设置">
                        <option value="" ${!d.keepaliveInterval ? 'selected' : ''}>⏱️继承默认</option>
                        <option value="300" ${d.keepaliveInterval == 300 ? 'selected' : ''}>⏱️5分钟</option>
                        <option value="600" ${d.keepaliveInterval == 600 ? 'selected' : ''}>⏱️10分钟</option>
                        <option value="900" ${d.keepaliveInterval == 900 ? 'selected' : ''}>⏱️15分钟</option>
                        <option value="1800" ${d.keepaliveInterval == 1800 ? 'selected' : ''}>⏱️30分钟</option>
                      </select>
                      <!-- 【2026-09-28】单机自动开机守护开关：与账号级 features.autoBoot 构成双重把关
                           （沿用移动爱家设计；被平台强制关机后由守护自动拉起）。 -->
                      <button type="button" class="pill-toggle-btn ${d.autoBootEnabled !== false ? 'pill-on-keepalive' : 'pill-off-keepalive'}" id="pill-autoboot-${acc.id}-${escapeHtml(iid)}" onclick="toggleVmFeature('${acc.id}', '${escapeHtml(iid)}', 'autoBootEnabled', ${d.autoBootEnabled === false})" title="单台云电脑独立自动开机守护（需账号级「🛡️ 自动开机守护」同时开启；被平台强制关机后自动拉起，同机 10 分钟冷却）">🛡️守护: ${d.autoBootEnabled !== false ? '开' : '关'}</button>
                      <!-- 【2026-09-28】开机按钮接入：真实的平台 operate=available 通道（真机验证可受理）。
                           常驻可点（能力可见）；平台认为机器在运行时点击会得到平台原话的如实拒绝
                           （"当前状态为已开机，不允许进行如下操作:开机"），不会产生任何副作用。 -->
                      <button type="button" class="pill-toggle-btn pill-action-boot" id="pill-boot-${acc.id}-${escapeHtml(iid)}" onclick="bootEcloudDesktop('${acc.id}', '${escapeHtml(iid)}', '${escapeHtml(d.machineName || '')}')" title="${escapeHtml((view && view.powerOnHint) ? `平台开机操作提示：${view.powerOnHint}` : '通过平台官方 operate 通道开机（真机验证可受理；受理后约数十秒进入运行中）')}">🖥️ 开机</button>
                      ${d.originCompanyCode === 'CMSSZTE' ? `
                        <button type="button" class="pill-toggle-btn" id="pill-enter-${acc.id}-${escapeHtml(iid)}" onclick="enterEcloudDesktopOnce('${acc.id}', '${escapeHtml(iid)}', '${escapeHtml(d.machineName || '')}')" title="使用本机移动云电脑组件真实进入；连接成功约 10 秒后自动断开，不关机">🚪 进入后退出</button>
                        <button type="button" class="pill-toggle-btn ${d.heldConnected ? 'pill-on-keepalive' : 'pill-off-keepalive'}" id="pill-hold-${acc.id}-${escapeHtml(iid)}" onclick="toggleEcloudHeldDesktop('${acc.id}', '${escapeHtml(iid)}', '${escapeHtml(d.machineName || '')}')" title="手动进入并保持连接；再次点击只断开连接，不关闭云电脑">🚪保持进入: ${d.heldConnected ? '开' : '关'}</button>
                        <button type="button" class="pill-toggle-btn ${d.realEnterEnabled === true ? (isAutoEnterEnabled ? 'pill-on-keepalive' : 'pill-paused') : 'pill-off-keepalive'}" id="pill-real-enter-${acc.id}-${escapeHtml(iid)}" onclick="toggleVmFeature('${acc.id}', '${escapeHtml(iid)}', 'realEnterEnabled', ${d.realEnterEnabled !== true})" title="单机自动进入需账号级「自动进入」同时开启；约每 20 小时真实进入一次，连接成功后自动断开，不关机">🕒自动进入: ${d.realEnterEnabled === true ? (isAutoEnterEnabled ? '开' : '待命(总关)') : '关'}</button>
                      ` : ''}
                    </div>
                    <div style="font-size: 10px; color: ${serviceExpiryValid && serviceExpiryMs <= Date.now() ? '#dc2626' : '#64748b'}; padding-top: 4px;" title="平台返回的云电脑服务有效期；北京时间，与开机状态无关">服务到期：${serviceExpiryValid ? `${escapeHtml(serviceExpiryText)}${serviceExpiryMs <= Date.now() ? '（已到期）' : ''}` : '未提供'}</div>
                    <div style="font-size: 10px; color: #64748b; padding-top: 2px;">${escapeHtml(lastRealEnterText)}</div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      desktopsHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">暂未拉取到名下云主机，点击下方「同步桌面」自动拉取</div>`;
    }

    // 【2026-09-25 用户要求·第七轮】本栏目已更名为「名下云主机」，与移动爱家列表标题统一口径
    //（旧名见 git 历史，此处不再复述，避免注释措辞撞到"不得出现旧名"的反向断言）。
    // 说明留在 JS 注释里、不进 HTML 模板 —— 放进模板会变成真实 HTML 注释混在 DOM 中，
    // 也会让"反向断言扫到散文注释"的老问题复现（见回归网教训：注释措辞会撞自己的静态断言）。
    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <div class="account-name-row">
              <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
                <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
                <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
              </span>
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30">
            </div>
            <div class="account-phone">
              <span>${fullPhone}</span>
              <span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">移动公众</span>
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑移动公众账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <div class="ecloud-search-bar">
        <label for="ecloud-search-${acc.id}">🔎 搜索设备</label>
        <input id="ecloud-search-${acc.id}" type="search" placeholder="输入客户端名称或云电脑名称" value="${escapeHtml(ecloudDeviceSearch.get(acc.id) || '')}" oninput="filterEcloudDevices('${acc.id}', this.value)" autocomplete="off">
        <span class="ecloud-search-count"></span>
      </div>
      <div class="ecloud-search-empty" hidden>没有匹配的设备</div>

      <!-- 🖥️ 名下云主机列表 -->
      ${desktopsHtml}

      <!-- 📡 移动公众专属：逐台保活监视（原先的 L1/L2/L3 分层总览条已按用户要求移入日志流） -->
      <!-- 【2026-09-24 用户要求·第三轮】账号级「保活在线」徽章已删除，
           本板块改为**可点击收起/展开**，折叠状态按账号持久化（与其它折叠盒同机制）。 -->
      <!-- 【2026-09-25 用户要求·第七轮】标题尾部那条「· xxx」后缀已按用户要求删掉，只留
           平台名 + 板块名，与移动爱家标题风格对齐（旧后缀原文见 git 历史与测试注释，此处不复述，
           否则会撞到"后缀必须删除"的反向断言）。删的只是**标题后缀文字**，
           "分层明细走日志流"这条事实与实现完全不变。 -->
      <details class="features-box ecloud-monitor-panel" ${isDetailsOpen(acc.id, 'ec-monitor') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'ec-monitor', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="color: #0369a1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">📡 移动公众 保活监视</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 8px;">
          <div id="acc-ec-mon-actions-${acc.id}" class="ecloud-monitor-grid ${desktops.length > 9 ? 'ecloud-list-scroll' : ''}">
            ${buildEcloudDesktopMonitorHtml(acc)}
          </div>
          <div id="acc-active-info-${acc.id}" style="font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b></div>
          <!-- 【2026-09-24 用户要求】原卡片底部的免责说明框已删除（卡片只留逐台状态）。
               口径前移到日志流：ecloud_client.js 的 _logLayerSummary() 每轮都会附带
               「说明: L1/L2 是 HTTP 层探针，成功不代表云电脑不会被关机」。 -->
        </div>
      </details>

      <!-- ⚙️ 分层自动化保活开关（独立于另两平台的分层命名） -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 分层自动化保活开关</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <!-- 【2026-09-28 用户要求】🛡️ 自动开机守护置于最前且**默认开启**：
               平台存在约 48 小时强制关机策略（真机实证两次），HTTP 保活拦不住 —— 拦不住就自动恢复。
               双开关（本开关 + 单机「🛡️守护」，均默认开启）+ 同机 10 分钟冷却。
               ⚠️ 口径一刀切默认开（与 ecloud_client 的 !== false 同源，公众版无底座分叉）；
               本区**不得**引用移动爱家的 _ydpcVendors —— 该变量只在爱家分支内声明，
               在此求值会 ReferenceError 中断整张卡片渲染（2026-09-28 修复）。 -->
          <div class="feature-row">
            <span title="被平台强制关机后自动拉起（双开关：本开关 + 单机「🛡️守护」；同机 10 分钟冷却）。平台存在约 48 小时强制关机策略，HTTP 保活无法阻止，本守护负责自动恢复。默认开启，不需要可关闭。">🛡️ 自动开机守护</span>
            <label class="switch">
              <input type="checkbox" ${f.autoBoot !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoBoot', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="账号级保活总开关：关闭后本账号 L1/L2 全部分层保活暂停">⚡ 账号级保活总开关</span>
            <label class="switch">
              <input type="checkbox" ${f.keepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'keepAlive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="L1 账号态保活：USER_GET_INFO / USER_GET_DEVICE_INFO / PROBE_QKK_BATCHPUSH（三态，未判定时不重登）">🧩 L1 账号态保活</span>
            <label class="switch">
              <input type="checkbox" ${f.ecloudL1AccountKeep !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'ecloudL1AccountKeep', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="L2 桌面登记保活：desktopUptime 逐台登记">🧩 L2 桌面登记保活</span>
            <label class="switch">
              <input type="checkbox" ${f.ecloudL2DesktopReg !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'ecloudL2DesktopReg', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span title="开启后为名下支持进入的云电脑启用单机自动进入；约每 20 小时依次真实进入，连接成功后自动退出，不关机。可在上方逐台关闭。仅在本机面板运行且账号保活开启时执行。">🚪 自动进入</span>
            <label class="switch">
              <input type="checkbox" id="auto-enter-${acc.id}" ${isAutoEnterEnabled ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoEnter', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 快捷操作区 -->
      <div class="card-actions">
        <div class="card-action-tools" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
          <button class="btn btn-tool" onclick="triggerEcloudKeepalive('${acc.id}')" title="立即执行一次 L1 + L2 保活巡检（与自动巡检同一条代码路径）">💓 立即保活</button>
          <button class="btn btn-tool" onclick="syncEcloudDesktops('${acc.id}')" title="重新拉取名下云主机列表">🔄 同步桌面</button>
          <button class="btn btn-tool" onclick="switchPlatformFilter('ecloud'); showToast('已切换到移动公众独立日志流', 'info')" title="只查看移动公众自己的日志流（与另两平台隔离）">📄 看本平台日志</button>
        </div>
      </div>
    `;
    applyEcloudDeviceFilter(card, ecloudDeviceSearch.get(acc.id) || '');

    return card;
  }

  if (isYdpc) {
    // ====================================================
    // 📱 移动云电脑专属卡片呈现
    // ====================================================
    const typeBadge = acc.accountType === 'sub'
      ? `<span class="badge" style="background:#f1f5f9;color:#475569;border:1px solid #cbd5e1;">独立子账号</span>`
      : `<span class="badge" style="background:#fef3c7;color:#b45309;border:1px solid #fde68a;">和家亲主账号</span>`;

    const vms = acc.vms || m.vms || [];

    // ══════════════════════════════════════════════════════════════════════════
    // 【2026-09-26】底座画像：SCG（深信服）与 ZTE 是**两条不同的保活底座**
    // ══════════════════════════════════════════════════════════════════════════
    // 为什么必须分叉：SCG 的材料里**没有** cagIp / connectStr，它走的是
    // firm-auth 的 scgIp/scgTcpPort/scAuthCode → 裸 TCP → auth 包 → 同 socket 升 TLS
    // → trunk 帧 + SPICE 通道认证。由此产生两条**不能再用 ZTE 文案盖过去**的事实：
    //   ① SCG 开机走 **CEM 官方通道**（2026-09-26 真机验证通过：getConnectInfo 触发开机
    //      + readyStatus 轮询；与保活的 CEM 控制面同一套已获批端点与材料）；
    //   ② SCG 不走 CAG 握手（它没有 cagIp）⇒ 控制面保活对 SCG 只剩 SOHO 心跳。
    // 判据只用后端 refreshVms 已持久化的 vm.vendor / vm.vendorName，前端**不自行嗅探**
    // （猜测过的代价见 app/ydpc/product_route.js 的注释：真 SCG 机被硬判成 ZTE 盲拨）。
    // 混挂多底座时一律降级为中性文案 —— 宁可少说，不可说错。
    const _ydpcVendors = Array.from(new Set(
      vms.map(v => String((v && v.vendor) || '').toUpperCase()).filter(Boolean)
    ));
    const _ydpcAllScg = vms.length > 0 && _ydpcVendors.length === 1 && _ydpcVendors[0] === 'SCG';
    const _ydpcAllZte = vms.length > 0 && _ydpcVendors.length === 1 && _ydpcVendors[0] === 'ZTE';
    const _ydpcMixedBase = _ydpcVendors.length > 1;
    const _ydpcBaseLabel = _ydpcAllScg ? '深信服 SCG'
      : (_ydpcAllZte ? '中兴 ZTE' : (_ydpcMixedBase ? '混合底座（逐台判定）' : '底座未判定'));
    const _ydpcBaseChipStyle = _ydpcAllScg
      ? 'background:#f0fdfa;color:#0f766e;border:1px solid #99f6e4;'
      : (_ydpcAllZte
        ? 'background:#f5f3ff;color:#6d28d9;border:1px solid #ddd6fe;'
        : 'background:#f1f5f9;color:#64748b;border:1px solid #cbd5e1;');
    const _ydpcBaseNote = _ydpcAllScg
      ? 'SCG 数据面：裸 TCP → auth 包 → 同 socket 升 TLS → trunk 帧 + SPICE 通道认证（材料取自 firm-auth 的 scgIp/scAuthCode；无 cagIp / connectStr）'
      : (_ydpcAllZte
        ? 'ZTE 数据面：按内层主机地址族分流 —— IPv6 走 raw ZTEC，IPv4 走 TLS+CAGMux+SPICE'
        : '各机底座不同，数据面通道**逐台**判定（见下方每台机器行）');
    /** 单机是否 SCG 底座（只读后端已持久化的 vendor，不外推） */
    const _isScgVm = (v) => String((v && v.vendor) || '').toUpperCase() === 'SCG';

    const vmsCountText = vms.length > 0 ? `名下云主机 (${vms.length}台)` : '云主机';

    const isAllYdpcChannelsOff = f.controlPlaneKeepalive === false && f.mqttKeepAlive === false && f.dataPlaneKeepalive === false;
    const isGlobalKeepAliveOff = f.keepAlive === false || isAllYdpcChannelsOff;

    let ydpcMultiStatusBadge = '';
    if (isGlobalKeepAliveOff) {
      ydpcMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
    } else {
      const anyKeepOn = vms.some(v => v.keepaliveEnabled !== false);
      const allKeepOn = vms.every(v => v.keepaliveEnabled !== false);
      if (allKeepOn && vms.length > 1) {
        ydpcMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
      } else if (anyKeepOn) {
        ydpcMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
      } else {
        ydpcMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
      }
    }

    let vmsHtml = '';
    if (vms.length > 0) {

      vmsHtml = `
        <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px;">
          <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
            <span>🖥️ ${vmsCountText}</span>
            <span id="acc-multi-status-${acc.id}">${ydpcMultiStatusBadge}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${vms.map(vm => {
              const statusStr = String(vm.vmStatus || vm.vmStatusShow || '');
              const isRunning = statusStr.includes('运行') || vm.vmStatus === 1 || vm.vmStatusCode === 1;
              const cpuClean = vm.cpu ? String(vm.cpu).replace(/核+$/g, '') : '';
              const memClean = vm.memory ? String(vm.memory).replace(/[Gg]+$/g, '') : '';
              const specSuffix = (cpuClean && memClean) ? ` · ${cpuClean}核/${memClean}G` : (cpuClean ? ` · ${cpuClean}核` : (memClean ? ` · ${memClean}G` : ''));
              const isKeepaliveOn = vm.keepaliveEnabled !== false;
              const usid = String(vm.userServiceId || '');

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="vm-item-${acc.id}-${usid}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${escapeHtml(vm.vmName || '移动云电脑')}</span>
                        ${vm.vendorName ? `<span class="badge" style="background:#f0fdf4;color:#166534;border:1px solid #bbf7d0;font-size:9.5px;padding:0 5px;line-height:1.3;">${escapeHtml(vm.vendorName)}</span>` : ''}
                      </div>
                      <span style="font-size: 11px; color: #64748b;">USID: ${usid}${specSuffix}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
                      <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                      <span style="font-size: 11.5px; font-weight: 600; color: ${vm.durationMode === 'limited' ? '#b45309' : '#059669'};">${vm.remainText || '♾️ 永久'}</span>
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${usid}" onclick="toggleVmFeature('${acc.id}', '${usid}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关">⚡保活: ${keepText}</button>
                      <select class="pill-select" id="pill-interval-${acc.id}-${usid}" onchange="changeVmInterval('${acc.id}', '${usid}', this.value)" title="单台云电脑独立保活周期设置">
                        <option value="" ${!vm.keepaliveInterval ? 'selected' : ''}>⏱️继承默认</option>
                        <option value="300" ${vm.keepaliveInterval == 300 ? 'selected' : ''}>⏱️5分钟</option>
                        <option value="600" ${vm.keepaliveInterval == 600 ? 'selected' : ''}>⏱️10分钟</option>
                        <option value="900" ${vm.keepaliveInterval == 900 ? 'selected' : ''}>⏱️15分钟</option>
                        <option value="1800" ${vm.keepaliveInterval == 1800 ? 'selected' : ''}>⏱️30分钟</option>
                        <option value="3600" ${vm.keepaliveInterval == 3600 ? 'selected' : ''}>⏱️60分钟</option>
                      </select>
                      <!-- 【2026-09-23 新增】单机自动开机守护开关：与账号级 features.autoBoot 构成双重把关 -->
                      <!-- 【2026-09-26 恢复】SCG（深信服）底座开机已真机打通（CEM 通道：getConnectInfo 触发开机
                           + readyStatus 轮询，见 app/ydpc/scg_keepalive.js 的 cemBootVm），守护/开机控件恢复渲染。 -->
                      <button type="button" class="pill-toggle-btn ${(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm)) ? 'pill-on-keepalive' : 'pill-off-keepalive'}" id="pill-autoboot-${acc.id}-${usid}" onclick="toggleVmFeature('${acc.id}', '${usid}', 'autoBootEnabled', ${!(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm))})" title="单台云电脑独立自动开机守护（需账号级开关同时开启；SCG 机默认开、走 CEM 通道，ZTE 机默认关、走 CAG 通道）">🛡️守护: ${(vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : _isScgVm(vm)) ? '开' : '关'}</button>
                      ${!isRunning ? `<button type="button" class="pill-toggle-btn pill-action-boot" id="pill-boot-${acc.id}-${usid}" onclick="bootYdpcVm('${acc.id}', '${usid}', '${escapeHtml(vm.vmName || '')}')" title="${_isScgVm(vm) ? '通过 CEM 官方通道拉起这台云电脑（深信服底座 · 已真机验证）' : '通过 CAG 官方通道拉起这台云电脑'}">🖥️开机</button>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      `;
    } else {
      vmsHtml = `<div style="font-size: 12px; color: var(--text-muted); text-align: center; padding: 8px; background:#f8fafc; border-radius:6px; border:1px solid #e2e8f0;">暂未拉取到名下云主机，点击下方心跳或握手自动同步</div>`;
    }

    const primaryUsid = vms[0]?.userServiceId || '';

    card.innerHTML = `
      <div class="card-top">
        <div class="account-main-info">
          <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
          <div class="account-name-block">
            <div class="account-name-row">
              <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
                <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
                <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
              </span>
              <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30">
            </div>
            <div class="account-phone">
              <span>${fullPhone}</span>
              <span class="badge" style="background:#e0f2fe;color:#0369a1;border:1px solid #bae6fd;">移动爱家</span>
              ${typeBadge}
            </div>
          </div>
        </div>
        <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
          <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑移动爱家账号">✏️</button>
          <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
        </div>
      </div>

      <!-- 🖥️ 名下云主机列表 -->
      ${vmsHtml}

      <!-- 📡 移动云专属 CAG 握手与心跳监视 -->
      <!-- 【2026-09-24 用户要求·第三轮】账号级「保活在线」徽章已删除；本板块改为可点击收起/展开。 -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'yd-monitor') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'yd-monitor', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="color: #0369a1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${_ydpcAllScg ? '📡 移动爱家 SCG 数据面监视' : '📡 移动爱家 ZTEC 握手与心跳监视'}</span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 3px;">
          <!-- 【2026-09-23 按主机维度】原先是单行账号级"当前动作"，多机（如ZTE样本主号下 2 台）
               状态不同时无法区分，且运行中时该文案永不刷新 → 长期停在「保活巡检待命中」。
               现改为逐台主机渲染，状态由后端 describeVmKeepAlive 统一下发。 -->
          <div id="acc-vm-actions-${acc.id}" style="display: flex; flex-direction: column;">
            ${buildYdpcVmMonitorHtml(acc)}
          </div>
          <div id="acc-active-info-${acc.id}" style="font-size: 11.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b></div>
        </div>
      </details>

      <!-- 专属功能开关 (精致折叠设计，状态持久化) -->
      <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
        <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
          <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 自动化保活开关<span class="badge" style="margin-left:6px;${_ydpcBaseChipStyle}" title="${escapeHtml(_ydpcBaseNote)}">${escapeHtml(_ydpcBaseLabel)}</span></span>
          <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
        </summary>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
          <!-- 【2026-09-23 修订】「🛡️ 自动开机守护」开关已恢复。
               ZTE 底座开机走 CAG HTTPS 干净通道（app/ydpc/cag_boot.js）：账号自有 firm-auth 凭据、
               RSA 公钥动态获取、保留 TLS 证书校验，全程走官方通道、不伪造客户端身份。
               【2026-09-26 恢复】SCG（深信服）底座开机已真机打通，走 CEM 官方通道
               （app/ydpc/scg_keepalive.js 的 cemBootVm）：OAuth → getConnectInfo 触发开机 →
               getVmReadyStatus 轮询至就绪。两端共用同一套账号自有凭据与已获批 CEM 材料。
               默认开启（2026-09-28 用户拍板），不需要可显式关闭。 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcMixedBase ? '检测到机器关机时自动拉起（默认开启）。本账号混挂多底座：ZTE 机走 CAG 通道，SCG 机走 CEM 通道，各自使用账号自有凭据' : '检测到机器关机时自动拉起（默认开启）。ZTE 机走 CAG 通道，SCG 机走 CEM 通道')}">${_ydpcMixedBase ? '🛡️ 自动开机守护（CAG/CEM 通道 · 按底座自动分流）' : (_ydpcAllScg ? '🛡️ 自动开机守护（CEM 通道）' : '🛡️ 自动开机守护（CAG 通道）')}</span>
            <!-- 【2026-09-28 修复】默认口径按底座分叉（与后端 _autoBootArmed 同源）：含 SCG 的账号默认勾选；
                 纯 ZTE 账号默认不勾（ZTE 开机走 CAG 会真实消耗限时套餐时长，需显式开启）。
                 本表达式依赖 _ydpcVendors，只能在移动爱家分支内使用。 -->
            <label class="switch">
              <input type="checkbox" ${(f.autoBoot !== undefined ? f.autoBoot !== false : _ydpcVendors.includes('SCG')) ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoBoot', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <!-- 【2026-09-23 新增】数据面保活：官方客户端同款 raw ZTEC 数据面，唯一被证实能真保活的方式。
               开启后，已开启「⚡保活」的运行中机器自动改走数据面，并抑制其 SOHO 心跳/CAG 握手（冗余）。
               ⚠️ 数据面是独占桌面会话，官方 App 可能无法同时接入该机器。 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcAllScg ? 'SCG 数据面保活（官方同款原生传输的另一套实现）：裸 TCP → auth 包 → 同 socket 升 TLS → trunk 帧 + SPICE 通道认证。开启后单机「⚡保活」开着的运行中机器自动改走数据面，并抑制其控制面保活。⚠️ 会占用桌面会话，官方 App 可能无法同时接入。⚠️ 本通道尚未被证明有效（显示面是否真的出图只能在真机观察）' : (_ydpcAllZte ? '官方客户端同款原生协议数据面保活（真保活）。开启后单机「⚡保活」开着的运行中机器自动改走数据面，并抑制其控制面保活。⚠️ 会占用桌面会话，官方 App 可能无法同时接入' : '原生协议数据面保活。各机按自身底座走对应通道（ZTE：raw ZTEC / TLS+SPICE；SCG：trunk+SPICE）。⚠️ 会占用桌面会话，官方 App 可能无法同时接入。⚠️ 是否真保活以实跑为准，本项目不作"保活已被证明"的声明'))}">${_ydpcAllScg ? '📡 数据面保活（SCG · trunk+SPICE）' : (_ydpcAllZte ? '📡 数据面保活（raw ZTEC / TLS+SPICE · 真保活）' : '📡 数据面保活（原生协议 · 逐台判定）')}</span>
            <label class="switch">
              <input type="checkbox" ${f.dataPlaneKeepalive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'dataPlaneKeepalive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <!-- 【2026-09-23 合并】ZTEC CAG 握手 与 SOHO 心跳 共用同一周期，合并为一个"控制面保活"开关 -->
          <div class="feature-row">
            <span title="${escapeHtml(_ydpcAllScg ? 'SCG 底座**没有** CAG 握手（firm-auth 材料里只有 scgIp/scAuthCode，没有 cagIp）—— 因此本开关在 SCG 机器上只驱动 SOHO 心跳（它同时也是 SCG 会话慢平面的同一路心跳），不发起任何 CAG 握手' : 'ZTEC CAG TCP 握手 + SOHO 心跳（共用同一周期，默认 10 分钟，可单机覆盖）。⚠️ 对 SCG 底座机器只走 SOHO 心跳——SCG 没有 cagIp')}">${_ydpcAllScg ? '🔄 控制面保活（SOHO 心跳 · SCG 无 CAG 握手）' : '🔄 控制面保活（CAG 握手 + SOHO 心跳）'}</span>
            <label class="switch">
              <input type="checkbox" ${f.controlPlaneKeepalive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'controlPlaneKeepalive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
          <div class="feature-row">
            <span>📡 官方 MQTT 3.1.1 链路长连保活</span>
            <label class="switch">
              <input type="checkbox" ${f.mqttKeepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'mqttKeepAlive', this.checked)">
              <span class="slider"></span>
            </label>
          </div>
        </div>
      </details>

      <!-- 快捷操作区 -->
      <div class="card-actions">
        <div class="card-action-tools" style="grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));">
          <button class="btn btn-tool" onclick="pingYdpcCag('${acc.id}')" title="立即向中兴 CAG 发起 TCP 握手保活">🔄 CAG 握手</button>
          <button class="btn btn-tool" onclick="heartbeatYdpc('${acc.id}')" title="立即发送一次 SOHO 活跃心跳">💓 发送心跳</button>
          <button class="btn btn-tool" onclick="verifyYdpcKeepAlive('${acc.id}')" title="用独立轮询验证保活是否真的有效（默认监控 60 秒）">🔍 独立验证</button>
        </div>
      </div>
    `;

    return card;
  }

  // ====================================================
  // ☁️ 天翼云电脑专属卡片呈现
  // ====================================================
  let sessionBadge = '';
  if (acc.sessionExpired) {
    sessionBadge = `<span class="badge badge-danger" style="cursor:pointer;" onclick="editAccount('${acc.id}')">${!acc.password ? '⚠️ 待扫码授权' : '⚠️ 会话失效'}</span>`;
  }

  const boundBadgeHtml = acc.bound
    ? `<span class="badge badge-online">已绑设备</span>`
    : `<span class="badge badge-warning" style="cursor: pointer;" onclick="openSmsModal('${acc.id}')">⚠️ 待绑定</span>`;

  const officialTaskHtml = buildOfficialTasksHtml(m);

  // 云电脑设备列表渲染
  let desktopsHtml = '';
  const dList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : [{
    desktopId: m.desktopId || acc.stats?.desktopId || '',
    desktopCode: acc.stats?.desktopId ? String(acc.stats.desktopId).slice(-6) : '',
    desktopName: m.desktopName || '天翼云电脑',
    useStatusText: (acc.stats?.keepAliveStatus === 'online' || m.status === 'online') ? '运行中' : '就绪',
    flavorName: '标准版'
  }];

  let ctyunMultiStatusBadge = '';
  if (f.keepAlive === false) {
    ctyunMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
  } else {
    const anyKeepOn = dList.some(d => d.keepaliveEnabled !== false);
    const allKeepOn = dList.every(d => d.keepaliveEnabled !== false);
    if (allKeepOn && dList.length > 1) {
      ctyunMultiStatusBadge = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
    } else if (anyKeepOn) {
      ctyunMultiStatusBadge = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
    } else {
      ctyunMultiStatusBadge = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
    }
  }

  if (dList.length > 0) {
    const isGlobalKeepAliveOff = f.keepAlive === false;
    const isGlobalTasksOff = f.cloudHang === false && f.autoSign === false && f.aiChat === false;

    // 【2026-09-25·第七轮补】用户要求三平台口径统一：本卡片栏目名也改成「名下云主机」。
    // 注意：源码注释里**不得复述旧名**，否则会撞"旧栏目名已全平台废弃"的反向断言（模板串内的 HTML 注释剥不掉）。
    desktopsHtml = `
      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
        <div style="font-size: 12px; font-weight: 700; color: #334155; margin-bottom: 6px; display: flex; justify-content: space-between;">
          <span>🖥️ 名下云主机 (${dList.length}台)</span>
          <span id="acc-multi-status-${acc.id}">${ctyunMultiStatusBadge}</span>
        </div>
          <div style="display: flex; flex-direction: column; gap: 6px;">
            ${dList.map(d => {
              const idText = d.desktopCode || d.desktopId || d.objId || '主设备';
              const isRunning = (d.useStatusText || '').includes('运行') || d.useStatus === 1 || d.useStatus === 0;
              // 前端规格解析 (完全对齐 ctyun-pro parseDesktopSpec 策略)
              const flavor = d.flavorName || '';
              const name = d.desktopName || '';
              let cpuClean = d.cpu ? String(d.cpu).replace(/核+$/g, '') : '';
              let memClean = d.memory ? String(d.memory).replace(/[Gg]+$/g, '') : '';
              if (!cpuClean || !memClean) {
                const explicit = (flavor.match(/(\d+)C(\d+)G/i) || name.match(/(\d+)C(\d+)G/i));
                if (explicit) {
                  cpuClean = cpuClean || explicit[1];
                  memClean = memClean || explicit[2];
                } else {
                  const cn = (flavor + ' ' + name).match(/(\d+)\s*核\s*[/]?\s*(\d+)\s*G/i);
                  if (cn) {
                    cpuClean = cpuClean || cn[1];
                    memClean = memClean || cn[2];
                  }
                }
              }
              // 版本名智能映射兜底 (旗舰16C32G / 尊享·精英8C16G / 标准4C8G / 其余8C16G)
              if (!cpuClean || !memClean) {
                let spec = '8C16G';
                if (name.includes('旗舰版') || flavor.includes('旗舰版')) spec = '16C32G';
                else if (name.includes('尊享版') || flavor.includes('尊享版') || name.includes('精英版') || flavor.includes('精英版')) spec = '8C16G';
                else if (name.includes('标准版') || flavor.includes('标准版')) spec = '4C8G';
                const m2 = spec.match(/(\d+)C(\d+)G/);
                cpuClean = cpuClean || m2[1];
                memClean = memClean || m2[2];
              }
              const specSuffix = ` · ${cpuClean}核/${memClean}G`;
              const isKeepaliveOn = d.keepaliveEnabled !== false;
              const isTaskOn = d.taskEnabled !== false;
              const targetId = String(d.desktopId || d.objId || idText);

              let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
              let keepText = isKeepaliveOn ? '开' : '关';
              if (isGlobalKeepAliveOff && isKeepaliveOn) {
                keepClass = 'pill-paused';
                keepText = '待命(总关)';
              }

              let taskClass = isTaskOn ? 'pill-on-task' : 'pill-off-task';
              let taskText = isTaskOn ? '开' : '关';
              if (isGlobalTasksOff && isTaskOn) {
                taskClass = 'pill-paused';
                taskText = '待命(总关)';
              }

              return `
                <div class="vm-device-item" id="desktop-item-${acc.id}-${targetId}">
                  <div class="vm-device-header">
                    <div style="display: flex; flex-direction: column; min-width: 0; flex: 1; overflow: hidden;">
                      <div style="display: flex; align-items: center; gap: 6px; overflow: hidden; white-space: nowrap;">
                        <span title="${escapeHtml(d.desktopName || '天翼云电脑')}" style="color: #0f172a; font-weight: 700; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; cursor: help;">${escapeHtml(d.desktopName || '天翼云电脑')}</span>
                        ${d.flavorName ? `<span style="font-size: 10.5px; background: #eff6ff; color: #2563eb; padding: 1px 6px; border-radius: 4px; flex-shrink: 0; white-space: nowrap;">${escapeHtml(d.flavorName)}</span>` : ''}
                      </div>
                      <span style="font-size: 11px; color: #64748b; margin-top: 1px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;" title="设备ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}">ID: ${escapeHtml(idText)}${escapeHtml(specSuffix)}</span>
                    </div>
                    <div style="display: flex; align-items: center; gap: 6px; flex-shrink: 0; white-space: nowrap;">
                      <span class="badge ${isRunning ? 'badge-online' : 'badge-offline'}">${isRunning ? '运行中' : '已关机'}</span>
                      <button class="btn btn-sm btn-primary" style="padding: 2px 7px; font-size: 11px; flex-shrink: 0; white-space: nowrap;" onclick="launchWebDesktop('${acc.id}', '${d.desktopId || d.objId}')">🚀 打开</button>
                    </div>
                  </div>
                  <div class="vm-device-footer">
                    <div class="pill-btn-group">
                      <button type="button" class="pill-toggle-btn ${keepClass}" id="pill-keep-${acc.id}-${targetId}" onclick="toggleVmFeature('${acc.id}', '${targetId}', 'keepaliveEnabled', ${!isKeepaliveOn})" title="单台云电脑独立保活开关 (脉冲长连保活)">⚡保活: ${keepText}</button>
                      <button type="button" class="pill-toggle-btn ${taskClass}" id="pill-task-${acc.id}-${targetId}" onclick="toggleVmFeature('${acc.id}', '${targetId}', 'taskEnabled', ${!isTaskOn})" title="单台云电脑独立任务开关 (控制打卡/AI对话/1小时挂机任务)">🎯任务: ${taskText}</button>
                      <select class="pill-select" id="pill-interval-${acc.id}-${targetId}" onchange="changeVmInterval('${acc.id}', '${targetId}', this.value)" title="单台云电脑独立脉冲周期设置">
                        <option value="" ${!d.keepaliveInterval ? 'selected' : ''}>⏱️继承默认</option>
                        <option value="15" ${d.keepaliveInterval == 15 ? 'selected' : ''}>⏱️15s脉冲</option>
                        <option value="30" ${d.keepaliveInterval == 30 ? 'selected' : ''}>⏱️30s脉冲</option>
                        <option value="60" ${d.keepaliveInterval == 60 ? 'selected' : ''}>⏱️1分钟脉冲</option>
                        <option value="120" ${d.keepaliveInterval == 120 ? 'selected' : ''}>⏱️2分钟脉冲</option>
                        <option value="300" ${d.keepaliveInterval == 300 ? 'selected' : ''}>⏱️5分钟脉冲</option>
                      </select>
                    </div>
                    <div style="display: flex; gap: 4px; align-items: center;">
                      ${!isRunning ? `<button type="button" class="pill-toggle-btn pill-action-boot" onclick="bootCtyunVm('${acc.id}', '${targetId}')" title="单独对此台天翼云电脑下发开机">🖥️ 开机</button>` : ''}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
      </div>
    `;
  }

  const targetDeviceDisplay = dList.length > 1 
    ? `名下 ${dList.length} 台云电脑 (全量多机守护)` 
    : `${escapeHtml(m.desktopName || dList[0]?.desktopName || '云电脑')} (${escapeHtml(m.currentHost || '已就绪')})`;

  card.innerHTML = `
    <div class="card-top">
      <div class="account-main-info">
        <div class="account-avatar" id="acc-avatar-${acc.id}">${(displayName)[0].toUpperCase()}</div>
        <div class="account-name-block">
          <div class="account-name-row">
            <span class="account-name-text ${isEditingThis ? 'hidden' : ''}" id="acc-name-text-${acc.id}" onclick="startInlineEditName('${acc.id}')" title="点击直接修改账号备注">
              <span class="name-label" id="acc-name-val-${acc.id}">${escapeHtml(displayName)}</span>
              <span class="name-edit-icon" title="点击直接修改备注">✏️</span>
            </span>
            <input type="text" class="inline-name-input ${isEditingThis ? '' : 'hidden'}" id="acc-name-input-${acc.id}" value="${escapeHtml(displayName)}" onkeydown="handleInlineNameKey(event, '${acc.id}')" onblur="saveInlineName('${acc.id}')" maxlength="30" placeholder="账号备注名">
          </div>
          <div class="account-phone">
            <span>${fullPhone}</span>
            <span class="badge" style="background:#eef2ff;color:#4338ca;border:1px solid #c7d2fe;">天翼云</span>
            ${boundBadgeHtml}
            ${sessionBadge}
          </div>
        </div>
      </div>
      <div style="display: flex; gap: 4px; align-items: center; flex-shrink: 0;">
        <button class="btn btn-sm" onclick="editAccount('${acc.id}')" title="编辑账号与重新验证">✏️</button>
        <button class="btn btn-sm btn-danger" onclick="deleteAccount('${acc.id}')" title="删除账号">🗑️</button>
      </div>
    </div>

    <!-- 🖥️ 名下云主机列表 -->
    ${desktopsHtml}

    <!-- 📡 真实 WebSocket 保活心跳状态监视 -->
    <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; font-size: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; gap: 6px; flex-wrap: wrap;">
        <span style="color: #2563eb; font-weight: 700; flex-shrink: 0;">📡 状态与心跳监视</span>
        <span id="acc-countdown-${acc.id}" style="color: var(--text-muted); font-size: 11px; text-align: right; flex-shrink: 1;">${m.isTaskHanging ? `模式: <b style="color:#d97706;">定时挂机中</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)` : `脉冲周期: <b>${buildIntervalOverviewText(acc)}</b> (倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`}</span>
      </div>
      <div style="color: #475569; line-height: 1.7; display: flex; flex-direction: column; gap: 3px;">
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">目标设备:</span>
          <span id="acc-host-${acc.id}" title="${targetDeviceDisplay}" style="color: #0f172a; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; min-width: 0; cursor: help;">${targetDeviceDisplay}</span>
        </div>
        <div style="display: flex; align-items: baseline; gap: 4px; overflow: hidden; white-space: nowrap; min-width: 0;">
          <span style="flex-shrink: 0; font-size: 11.5px; color: #64748b;">当前动作:</span>
          <span id="acc-hb-text-${acc.id}" title="${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}" style="font-size: 11.5px; color: ${(m.lastHeartbeatResult || '').includes('避让') ? '#d97706' : '#16a34a'}; font-weight: 600; text-overflow: ellipsis; overflow: hidden; white-space: nowrap; flex: 1; min-width: 0; cursor: help;">${escapeHtml(m.lastHeartbeatResult || '正在建立心跳通道...')}</span>
        </div>
        <div style="font-size: 11.5px; color: #475569;">当日成功轮次: <span id="acc-success-count-${acc.id}" style="color: #2563eb; font-weight: 600;">${m.successCount || 0} 轮</span></div>
      </div>
    </div>

    <!-- 🏆 天翼云官方真实任务看板 (精致可折叠设计，状态持久化) -->
    <details class="card-collapse-box" ${isDetailsOpen(acc.id, 'tasks') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'tasks', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-weight: 700; user-select: none; gap: 6px;">
        <span style="color: #b45309; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">🏆 官方任务进度 (总分: <b id="acc-points-val-${acc.id}" style="color:#16a34a;">${m.userPoints || 0}</b>)</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
      </summary>
      <div id="acc-tasks-list-${acc.id}" style="display: flex; flex-direction: column; gap: 6px; margin-top: 8px;">
        ${officialTaskHtml}
      </div>
    </details>

    <!-- 功能开关 (精致折叠设计，状态持久化) -->
    <details class="features-box" ${isDetailsOpen(acc.id, 'features') ? 'open' : ''} ontoggle="saveDetailsState('${acc.id}', 'features', this.open)">
      <summary style="display: flex; justify-content: space-between; align-items: center; cursor: pointer; font-size: 12.5px; font-weight: 700; color: #334155; user-select: none; gap: 6px;">
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">⚙️ 自动化任务与保活开关</span>
        <span style="font-size: 11px; color: var(--text-muted); font-weight: normal; flex-shrink: 0; white-space: nowrap;">点击收起/展开</span>
      </summary>
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">
        <div class="feature-row">
          <span>📡 启用云电脑保活</span>
          <label class="switch">
            <input type="checkbox" ${f.keepAlive !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'keepAlive', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>📅 每日自动签到打卡</span>
          <label class="switch">
            <input type="checkbox" ${f.autoSign !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'autoSign', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🤖 AI 智能对话任务 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.aiChat !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'aiChat', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>⏱️ 云电脑挂机1小时 (每日100分)</span>
          <label class="switch">
            <input type="checkbox" ${f.cloudHang !== false ? 'checked' : ''} onchange="toggleFeature('${acc.id}', 'cloudHang', this.checked)">
            <span class="slider"></span>
          </label>
        </div>
        <div class="feature-row">
          <span>🎁 自动兑换/抽奖 (${acc.redeemConfig?.enabled ? '<b style=\"color:#16a34a\">已开</b>' : '未开'})</span>
          <button class="btn btn-sm btn-warning" onclick="openRedeemModal('${acc.id}')" style="flex-shrink:0;padding:3px 8px;font-size:11.5px;">⚙️ 奖品设置</button>
        </div>
      </div>
    </details>

    <!-- 快捷操作按钮 -->
    <div class="card-actions">
      ${acc.sessionExpired ? `
        <button class="btn btn-danger btn-launch-full" onclick="editAccount('${acc.id}')" style="margin-bottom:6px;">
          <span>${!acc.password ? '📱 重新扫码授权' : '🔑 重新验证登录'}</span>
          <span class="btn-subtext">${!acc.password ? '手机 App 扫码一键恢复 ➔' : '输验证码恢复 ➔'}</span>
        </button>
      ` : ''}
      <div class="card-action-tools">
        <button class="btn btn-tool" onclick="syncAccountTasks('${acc.id}')" title="一键极速执行今日全部任务 (打卡/AI对话/挂机)">🔄 一键同步任务</button>
        <button class="btn btn-tool" onclick="openPowerModal('${acc.id}')" title="云电脑电源管理 (开机/重启/关机)">⚡ 电源管理</button>
        <button class="btn btn-tool" onclick="openManualRedeemModal('${acc.id}')" title="根据当前积分手动兑换商品或抽奖">🎁 积分商城</button>
      </div>
      ${!acc.bound ? `<button class="btn btn-sm btn-warning" style="width:100%;margin-top:2px;" onclick="openSmsModal('${acc.id}')">📲 短信二次安全绑定</button>` : ''}
    </div>
  `;

  return card;
}

// 原地静默增量局部数据更新 (100% 杜绝 DOM 结构重绘与滚动条跳跃)
function updateAccountsInPlace(filteredAccounts) {
  filteredAccounts.forEach(acc => {
    const card = document.getElementById(`acc-card-${acc.id}`);
    if (!card) return;

    const isYdpc = acc.platform === 'ydpc';
    const isEcloud = acc.platform === 'ecloud';
    const m = acc.liveMetrics || {};
    const f = acc.features || {};

    // 1.【2026-09-24 用户要求·第三轮】账号级「保活在线/离线待机」徽章已从卡片删除，
    //    原先在此处就地覆写该徽章元素的整段逻辑一并移除（元素已不存在，保留即死代码）。
    //    在线口径改由日志流承载；卡片上的监视板块改为可折叠标题。

    // 2. 更新心跳/动作文本（天翼云：账号级单行；移动两平台走下方按主机渲染）
    if (!isYdpc && !isEcloud) {
      const hbTextEl = document.getElementById(`acc-hb-text-${acc.id}`);
      if (hbTextEl) {
        const hbResult = m.lastHeartbeatResult || '正在建立心跳通道...';
        hbTextEl.innerText = hbResult;
        hbTextEl.title = hbResult;
        hbTextEl.style.color = hbResult.includes('避让') ? '#d97706' : '#16a34a';
      }
    }

    // 2b.【2026-09-23 按主机维度】移动云逐台刷新"当前动作"区：
    //     一个账号下多台主机的状态可以完全不同，必须按主机呈现。
    if (isYdpc) {
      const vmActionsEl = document.getElementById(`acc-vm-actions-${acc.id}`);
      if (vmActionsEl) {
        vmActionsEl.innerHTML = buildYdpcVmMonitorHtml(acc);
      }
    }

    // 2c.【2026-09-23】移动公众逐台刷新（**独立元素与独立渲染函数**，不与移动爱家共用）：
    //     只刷新逐台"当前动作"区（倒计时/最近动作每轮都在变）。
    //     分层总览条已按用户要求移入日志流，此处不再有对应的 DOM 节点。
    if (isEcloud) {
      const ecMonEl = document.getElementById(`acc-ec-mon-actions-${acc.id}`);
      if (ecMonEl) ecMonEl.innerHTML = buildEcloudDesktopMonitorHtml(acc);
      applyEcloudDeviceFilter(card, ecloudDeviceSearch.get(acc.id) || '');
      // 【2026-09-28】逐台同步「🛡️守护」胶囊（按元素存在性过滤，绝不留无元素可写的幽灵控件）
      for (const d of (acc.desktops || [])) {
        const iid2 = String(d.instanceId || '');
        const pHold = document.getElementById(`pill-hold-${acc.id}-${iid2}`);
        if (pHold && !pHold.disabled) {
          pHold.className = `pill-toggle-btn ${d.heldConnected ? 'pill-on-keepalive' : 'pill-off-keepalive'}`;
          pHold.innerText = `🚪保持进入: ${d.heldConnected ? '开' : '关'}`;
        }
        const pAuto = document.getElementById(`pill-autoboot-${acc.id}-${iid2}`);
        if (!pAuto) continue;
        const on = d.autoBootEnabled !== false;
        pAuto.className = `pill-toggle-btn ${on ? 'pill-on-keepalive' : 'pill-off-keepalive'}`;
        pAuto.innerText = `🛡️守护: ${on ? '开' : '关'}`;
      }
    }

    // 3. 更新倒计时与轮次 (天翼云)
    const cdEl = document.getElementById(`acc-countdown-${acc.id}`);
    if (cdEl) {
      cdEl.innerHTML = m.isTaskHanging
        ? `模式: <b style="color:#d97706;">定时挂机中</b> (剩余: <b style="color:#2563eb;">${m.cycleCountdown || 0}s</b>)`
        : `脉冲周期: <b>${buildIntervalOverviewText(acc)}</b> (倒计时: <b style="color:#16a34a;">${m.cycleCountdown || 30}s</b>)`;
    }

    const successEl = document.getElementById(`acc-success-count-${acc.id}`);
    if (successEl) {
      successEl.innerText = `${m.successCount || 0} 轮`;
    }

    // 4. 更新移动两平台账号级汇总与周期概览（逐台状态已在 2b / 2c 刷新）
    if (isYdpc || isEcloud) {
      const activeInfoEl = document.getElementById(`acc-active-info-${acc.id}`);
      if (activeInfoEl) {
        activeInfoEl.innerHTML = `账号汇总: <b style="color: #0f172a;">${escapeHtml(m.lastHeartbeatResult || '保活巡检待命')}</b> · 周期: <b>${buildIntervalOverviewText(acc)}</b>`;
      }
    }

    // 5. 更新官方任务积分与列表 (天翼云)
    const pointsValEl = document.getElementById(`acc-points-val-${acc.id}`);
    if (pointsValEl) {
      pointsValEl.innerText = m.userPoints || 0;
    }

    const tasksListEl = document.getElementById(`acc-tasks-list-${acc.id}`);
    if (tasksListEl && m.officialTasks && m.officialTasks.length > 0) {
      tasksListEl.innerHTML = buildOfficialTasksHtml(m);
    }

    // 6. 原地增量更新单机独立保活与开机/任务胶囊开关状态与总状态徽章
    const multiStatusEl = document.getElementById(`acc-multi-status-${acc.id}`);
    if (isYdpc && acc.vms) {
      const isAllYdpcChannelsOff = f.controlPlaneKeepalive === false && f.mqttKeepAlive === false && f.dataPlaneKeepalive === false;
      const isGlobalKeepAliveOff = f.keepAlive === false || isAllYdpcChannelsOff;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.vms.some(v => v.keepaliveEnabled !== false);
          const allKeepOn = acc.vms.every(v => v.keepaliveEnabled !== false);
          if (allKeepOn && acc.vms.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.vms.forEach(vm => {
        const usid = String(vm.userServiceId || '');
        const isKeepaliveOn = vm.keepaliveEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${usid}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${usid}`);
        if (pInterval && document.activeElement !== pInterval) {
          pInterval.value = vm.keepaliveInterval ? String(vm.keepaliveInterval) : '';
        }
        // 【2026-09-23 新增】同步单机自动开机守护胶囊
        // 【2026-09-26 恢复】SCG 机器的守护/开机控件已恢复渲染，此处按元素存在性同步
        // （元素不存在时 getElementById 返回 null 天然跳过，不会造幽灵控件）。
        const pAutoBoot = document.getElementById(`pill-autoboot-${acc.id}-${usid}`);
        if (pAutoBoot) {
          const vmIsScg = String((vm && vm.vendor) || '').toUpperCase() === 'SCG';
          const on = vm.autoBootEnabled !== undefined ? vm.autoBootEnabled !== false : vmIsScg;
          pAutoBoot.className = `pill-toggle-btn ${on ? 'pill-on-keepalive' : 'pill-off-keepalive'}`;
          pAutoBoot.innerText = `🛡️守护: ${on ? '开' : '关'}`;
        }
        // 【2026-09-23 新增】同步"运行中则隐藏 🖥️开机 按钮"（整卡片重绘会处理新增，这里只处理隐藏）
        const statusStr = String(vm.vmStatus || vm.vmStatusShow || '');
        const isRunningNow = statusStr.includes('运行') || vm.vmStatus === 1 || vm.vmStatusCode === 1;
        if (isRunningNow) {
          const pBoot = document.getElementById(`pill-boot-${acc.id}-${usid}`);
          if (pBoot) pBoot.remove();
        }
      });
    } else if (isEcloud && acc.desktops) {
      // 【2026-09-24】移动公众：主键是 instanceId，胶囊 id 与移动爱家/天翼云不同前缀无关，
      // 但此处必须走 ecloud 自己的分支，避免误用 desktopId/objId 导致元素永远匹配不上。
      const isGlobalKeepAliveOff = f.keepAlive === false;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.desktops.some(d => d.keepaliveEnabled !== false);
          const allKeepOn = acc.desktops.every(d => d.keepaliveEnabled !== false);
          if (allKeepOn && acc.desktops.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.desktops.forEach(d => {
        const iid = String(d.instanceId || '');
        const isKeepaliveOn = d.keepaliveEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${iid}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${iid}`);
        if (pInterval && document.activeElement !== pInterval) {
          pInterval.value = d.keepaliveInterval ? String(d.keepaliveInterval) : '';
        }
      });
    } else if (!isYdpc && !isEcloud && acc.desktops) {
      const isGlobalKeepAliveOff = f.keepAlive === false;
      const isGlobalTasksOff = f.cloudHang === false && f.autoSign === false && f.aiChat === false;

      if (multiStatusEl) {
        if (isGlobalKeepAliveOff) {
          multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 全局保活已关闭</span>`;
        } else {
          const anyKeepOn = acc.desktops.some(d => d.keepaliveEnabled !== false);
          const allKeepOn = acc.desktops.every(d => d.keepaliveEnabled !== false);
          if (allKeepOn && acc.desktops.length > 1) {
            multiStatusEl.innerHTML = `<span style="color: #10b981; font-weight: 600;">🟢 全量多机保活已激活</span>`;
          } else if (anyKeepOn) {
            multiStatusEl.innerHTML = `<span style="color: #0284c7; font-weight: 600;">🟡 按单机策略保活中</span>`;
          } else {
            multiStatusEl.innerHTML = `<span style="color: #94a3b8; font-weight: 600;">⚪ 单机保活已全关</span>`;
          }
        }
      }

      acc.desktops.forEach(d => {
        const targetId = String(d.desktopId || d.objId || d.desktopCode || '');
        const isKeepaliveOn = d.keepaliveEnabled !== false;
        const isTaskOn = d.taskEnabled !== false;
        const pKeep = document.getElementById(`pill-keep-${acc.id}-${targetId}`);
        if (pKeep) {
          let keepClass = isKeepaliveOn ? 'pill-on-keepalive' : 'pill-off-keepalive';
          let keepText = isKeepaliveOn ? '开' : '关';
          if (isGlobalKeepAliveOff && isKeepaliveOn) {
            keepClass = 'pill-paused';
            keepText = '待命(总关)';
          }
          pKeep.className = `pill-toggle-btn ${keepClass}`;
          pKeep.innerText = `⚡保活: ${keepText}`;
        }
        const pTask = document.getElementById(`pill-task-${acc.id}-${targetId}`);
        if (pTask) {
          let taskClass = isTaskOn ? 'pill-on-task' : 'pill-off-task';
          let taskText = isTaskOn ? '开' : '关';
          if (isGlobalTasksOff && isTaskOn) {
            taskClass = 'pill-paused';
            taskText = '待命(总关)';
          }
          pTask.className = `pill-toggle-btn ${taskClass}`;
          pTask.innerText = `🎯任务: ${taskText}`;
        }
        const pInterval = document.getElementById(`pill-interval-${acc.id}-${targetId}`);
        if (pInterval && document.activeElement !== pInterval) {
          pInterval.value = d.keepaliveInterval ? String(d.keepaliveInterval) : '';
        }
      });
    }
  });
}

// 账号卡片 HTML 模板生成
function renderAccounts(isSilent = false) {
  const container = document.getElementById("accounts-container");
  if (!container) return;

  // 1. 如果用户正在拖拽卡片或正在行内编辑备注名，跳过重绘避免打断交互
  if (draggedAccId || activeEditingAccId) return;

  // 如果未登录，严格阻断访客查看云电脑信息，只显示登录注册引导
  if (!currentUser) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 48px 24px; background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border); box-shadow: var(--shadow);">
        <div style="font-size: 40px; margin-bottom: 12px;">🔒</div>
        <h3 style="font-size: 17px; font-weight: 700; color: #0f172a; margin-bottom: 8px;">请登录后查看与管理云电脑</h3>
        <p style="font-size: 13.5px; color: var(--text-muted); max-width: 500px; margin: 0 auto 20px auto;">
          为保障账号隐私安全与多用户隔离，未登录访客无法查看或添加云电脑。请登录已有账号，或免费注册新账号开启独立后台。
        </p>
        <div style="display: flex; gap: 12px; justify-content: center;">
          <button class="btn btn-primary" onclick="openAuthModal('login')">🔑 立即登录</button>
          <button class="btn" onclick="openAuthModal('register')">✨ 免费注册新用户</button>
        </div>
      </div>
    `;
    return;
  }

  // 智能切换平台视图 Tab 栏：只有同时存在 >=2 个平台（天翼云 / 移动爱家 / 移动公众）时才显示，
  // 单一平台时自动隐藏；同时按"实际出现的平台"逐个显隐各自按钮，避免出现点了没内容的空 Tab。
  const presentPlatforms = getPresentPlatforms();
  const viewTabsGroup = document.getElementById("account-view-tabs-group");
  if (viewTabsGroup) {
    if (presentPlatforms.size >= 2) {
      viewTabsGroup.style.display = "flex";
    } else {
      viewTabsGroup.style.display = "none";
      activeAccountViewTab = 'all'; // 自动还原
    }
  }
  const tabBtnMap = { ctyun: 'view-tab-ctyun', ydpc: 'view-tab-ydpc', ecloud: 'view-tab-ecloud' };
  for (const [pf, btnId] of Object.entries(tabBtnMap)) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    const present = presentPlatforms.has(pf);
    btn.style.display = present ? '' : 'none';
    if (!present && activeAccountViewTab === pf) activeAccountViewTab = 'all';
  }

  // 根据当前视图过滤账号
  const filteredAccounts = getFilteredAccounts();
  container.classList.toggle('accounts-grid--ecloud-only',
    filteredAccounts.length > 0 && filteredAccounts.every(acc => acc.platform === 'ecloud'));

  if (!filteredAccounts || filteredAccounts.length === 0) {
    const tabNameMap = { ydpc: '移动爱家', ctyun: '天翼云电脑', ecloud: '移动公众' };
    const tabName = tabNameMap[activeAccountViewTab] || '云电脑';
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-muted); background: var(--bg-secondary); border-radius: var(--radius); border: 1px dashed var(--border);">
        <p style="font-size: 15px; margin-bottom: 12px;">当前暂未配置【${tabName}】设备</p>
        <button class="btn btn-primary" onclick="openAddAccountModal()">➕ 立即添加云电脑</button>
      </div>
    `;
    return;
  }

  const cols = getGridColumns();
  const slots = loadGridSlots(filteredAccounts, cols);

  // 2. 检查是否可无感局部原地更新 (In-Place Update)
  // 如果现有的 DOM 卡片结构和 slots 一致，直接更新动态文本与指标，100% 避免销毁 DOM 和触发表单/滚动条复位！
  if (isSilent) {
    const existingChildren = container.children;
    let matchExact = existingChildren.length === slots.length;
    if (matchExact) {
      for (let i = 0; i < slots.length; i++) {
        const expectedAccId = slots[i];
        const el = existingChildren[i];
        if (!expectedAccId) {
          if (!el.classList.contains("grid-empty-slot")) { matchExact = false; break; }
        } else {
          if (!el.classList.contains("account-card") || el.dataset.accId !== expectedAccId) { matchExact = false; break; }
        }
      }
    }

    if (matchExact) {
      updateAccountsInPlace(filteredAccounts);
      return;
    }
  }

  // 3. 结构发生变动时的平滑重绘：锁定高度与滚动位置
  const prevScrollY = window.scrollY || window.pageYOffset || 0;
  const currentHeight = container.offsetHeight;
  if (currentHeight > 0) {
    container.style.minHeight = `${currentHeight}px`;
  }

  const fragment = document.createDocumentFragment();

  slots.forEach((accId, slotIndex) => {
    if (!accId) {
      const emptySlot = document.createElement("div");
      emptySlot.className = "grid-empty-slot";
      emptySlot.dataset.slot = slotIndex;
      emptySlot.innerHTML = "";
      emptySlot.addEventListener("dragover", handleSlotDragOver);
      emptySlot.addEventListener("dragleave", handleSlotDragLeave);
      emptySlot.addEventListener("drop", handleSlotDrop);
      fragment.appendChild(emptySlot);
      return;
    }

    const acc = filteredAccounts.find(a => a.id === accId);
    if (!acc) return;

    const card = buildAccountCardElement(acc, slotIndex);
    fragment.appendChild(card);
  });

  container.innerHTML = "";
  container.appendChild(fragment);

  // 渲染完成释放高度并确保滚动位置绝对稳定
  requestAnimationFrame(() => {
    container.style.minHeight = "";
    if (Math.abs(window.scrollY - prevScrollY) > 2) {
      window.scrollTo({ top: prevScrollY, behavior: "instant" });
    }
  });
}

// ==========================================
// 卡片自由网格插槽拖拽交互与持久化
// ==========================================
let draggedCardEl = null;
let draggedAccId = null;
let draggedSlotIndex = null;

function handleCardDragStart(e) {
  draggedCardEl = this;
  draggedAccId = this.dataset.accId;
  draggedSlotIndex = parseInt(this.dataset.slot, 10);
  this.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", draggedAccId);

  // 激活所有可放置空位插槽的高亮
  document.querySelectorAll(".grid-empty-slot").forEach(s => s.classList.add("droppable"));
}

function handleCardDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  if (this !== draggedCardEl) {
    this.classList.add("drag-over");
  }
}

function handleCardDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  this.classList.add("drag-over");
}

function handleSlotDragLeave(e) {
  this.classList.remove("drag-over");
}

function handleSlotDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 移动卡片到目标空位插槽
  slots[draggedSlotIndex] = null;
  slots[targetSlot] = draggedAccId;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDrop(e) {
  e.preventDefault();
  this.classList.remove("drag-over");
  const targetSlot = parseInt(this.dataset.slot, 10);
  if (isNaN(targetSlot) || isNaN(draggedSlotIndex) || targetSlot === draggedSlotIndex || !draggedAccId) return;

  const cols = getGridColumns();
  const currentAccs = getFilteredAccounts();
  const slots = loadGridSlots(currentAccs, cols);

  // 互换两个插槽的内容
  const temp = slots[targetSlot];
  slots[targetSlot] = draggedAccId;
  slots[draggedSlotIndex] = temp;

  saveGridSlots(slots);
  renderAccounts();
  saveAccountsOrderFromSlots(slots);
}

function handleCardDragEnd(e) {
  this.classList.remove("dragging");
  draggedCardEl = null;
  draggedAccId = null;
  draggedSlotIndex = null;
  document.querySelectorAll(".account-card, .grid-empty-slot").forEach(c => {
    c.classList.remove("drag-over");
    c.classList.remove("droppable");
  });
}

function saveAccountsOrderFromSlots(slots) {
  const orderedIds = slots.filter(Boolean);
  for (const a of accounts) {
    if (!orderedIds.includes(a.id)) orderedIds.push(a.id);
  }
  accounts.sort((a, b) => {
    const idxA = orderedIds.indexOf(a.id);
    const idxB = orderedIds.indexOf(b.id);
    return (idxA === -1 ? 999 : idxA) - (idxB === -1 ? 999 : idxB);
  });
  saveAccountsOrder();
}

async function saveAccountsOrder() {
  const orderedIds = accounts.map(a => a.id);
  try {
    await authFetch("/api/accounts/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderedIds })
    });
  } catch (e) {}
}

// 账号备注名即点即改 (Inline Edit)
function startInlineEditName(accId) {
  activeEditingAccId = accId;
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  if (!textEl || !inputEl) return;
  textEl.classList.add("hidden");
  inputEl.classList.remove("hidden");
  inputEl.focus();
  inputEl.select();
}

function handleInlineNameKey(e, accId) {
  if (e.key === "Enter") {
    e.preventDefault();
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl) inputEl.blur();
  } else if (e.key === "Escape") {
    e.preventDefault();
    activeEditingAccId = null;
    const acc = accounts.find(a => a.id === accId);
    const textEl = document.getElementById(`acc-name-text-${accId}`);
    const inputEl = document.getElementById(`acc-name-input-${accId}`);
    if (inputEl && textEl) {
      inputEl.value = acc ? (acc.name || acc.user) : inputEl.value;
      inputEl.classList.add("hidden");
      textEl.classList.remove("hidden");
    }
  }
}

async function saveInlineName(accId) {
  const acc = accounts.find(a => a.id === accId);
  const textEl = document.getElementById(`acc-name-text-${accId}`);
  const inputEl = document.getElementById(`acc-name-input-${accId}`);
  const labelEl = document.getElementById(`acc-name-val-${accId}`);
  if (!acc || !inputEl || !textEl) {
    activeEditingAccId = null;
    return;
  }

  const newName = inputEl.value.trim();
  const oldName = acc.name || acc.user;
  activeEditingAccId = null;

  // 切回展示态
  inputEl.classList.add("hidden");
  textEl.classList.remove("hidden");

  // 如果内容没变或为空则还原
  if (!newName || newName === oldName) {
    inputEl.value = oldName;
    return;
  }

  // 响应式即时渲染 (Optimistic UI)
  const previousName = acc.name;
  acc.name = newName;
  if (labelEl) labelEl.textContent = newName;

  // 响应式更新头像字母
  const avatarEl = document.getElementById(`acc-avatar-${accId}`);
  if (avatarEl) avatarEl.textContent = (newName || acc.user)[0].toUpperCase();

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName })
    });
    if (res.ok) {
      showToast(`账号备注已成功修改为 "${newName}"`, "success");
    } else {
      const err = await res.json();
      showToast("修改失败: " + (err.error || "未知错误"), "error");
      acc.name = previousName;
      if (labelEl) labelEl.textContent = previousName || acc.user;
      inputEl.value = previousName || acc.user;
      if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    acc.name = previousName;
    if (labelEl) labelEl.textContent = previousName || acc.user;
    inputEl.value = previousName || acc.user;
    if (avatarEl) avatarEl.textContent = (previousName || acc.user)[0].toUpperCase();
  }
}

// 快速切换开关
async function toggleFeature(accId, featureKey, checked) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  acc.features = acc.features || {};
  const previousValue = acc.features[featureKey];
  acc.features[featureKey] = checked;

  // 立即刷新卡片视图以联动反映单机与全局层叠状态
  renderAccounts();

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ features: acc.features })
    });
    if (res.ok) {
      if (acc.platform === 'ecloud' && featureKey === 'autoEnter') {
        const updated = await res.json();
        acc.desktops = updated.desktops || acc.desktops;
        renderAccounts();
      }
      showToast(`已${checked ? '开启' : '关闭'}该功能`, "success");
    } else {
      showToast("更新失败", "error");
      // 更新失败则还原界面的复选状态
      if (previousValue === undefined) delete acc.features[featureKey];
      else acc.features[featureKey] = previousValue;
      renderAccounts();
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    if (previousValue === undefined) delete acc.features[featureKey];
    else acc.features[featureKey] = previousValue;
    renderAccounts();
  }
}

// 单台云电脑独立特性开关切换 (优化为原地乐观更新与异步上报)
async function toggleVmFeature(accId, vmKey, featureName, nextVal) {
  // 【2026-09-23 修订】移动云"自动开机守护"开关已恢复放行，开机走 CAG HTTPS 干净通道
  // （账号自有 firm-auth 凭据 + RSA 公钥动态获取 + 保留 TLS 证书校验）。
  // 伪造身份 / 硬编码第三方凭据 / 关证书 等红线仍被回归组 7 机械拦截。
  // 支持的单机开关：keepaliveEnabled / taskEnabled / autoBootEnabled / realEnterEnabled / keepaliveInterval

  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  if (isYdpc) {
    acc.vms = acc.vms || [];
    const targetVm = acc.vms.find(v => String(v.userServiceId) === String(vmKey));
    if (targetVm) targetVm[featureName] = nextVal;
  } else if (isEcloud) {
    // 移动公众：单机主键为 instanceId（与 ydpc 的 userServiceId、天翼云的 desktopId 各自独立）
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.instanceId) === String(vmKey));
    if (targetD) targetD[featureName] = nextVal;
  } else {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.desktopId || d.objId) === String(vmKey));
    if (targetD) targetD[featureName] = nextVal;
  }

  // 1. 立即乐观更新 DOM 按钮状态
  let prefixKey = '';
  let onClass = '';
  let offClass = '';
  let labelPrefix = '';
  if (featureName === 'keepaliveEnabled') {
    prefixKey = 'pill-keep-';
    onClass = 'pill-on-keepalive';
    offClass = 'pill-off-keepalive';
    labelPrefix = '⚡保活: ';
  } else if (featureName === 'taskEnabled') {
    prefixKey = 'pill-task-';
    onClass = 'pill-on-task';
    offClass = 'pill-off-task';
    labelPrefix = '🎯任务: ';
  } else if (featureName === 'autoBootEnabled') {
    // 【2026-09-23 新增】单机自动开机守护胶囊（移动云卡片行内）
    prefixKey = 'pill-autoboot-';
    onClass = 'pill-on-keepalive';
    offClass = 'pill-off-keepalive';
    labelPrefix = '🛡️守护: ';
  } else if (featureName === 'realEnterEnabled') {
    prefixKey = 'pill-real-enter-';
    onClass = 'pill-on-keepalive';
    offClass = 'pill-off-keepalive';
    labelPrefix = '🕒自动进入: ';
  }

  const pillBtn = prefixKey ? document.getElementById(prefixKey + accId + '-' + vmKey) : null;
  if (pillBtn) {
    const pausedByAccount = isEcloud && featureName === 'realEnterEnabled'
      && nextVal && acc.features?.autoEnter === false;
    pillBtn.classList.remove(onClass, offClass);
    pillBtn.classList.remove('pill-paused');
    pillBtn.classList.add(pausedByAccount ? 'pill-paused' : (nextVal ? onClass : offClass));
    pillBtn.innerText = labelPrefix + (pausedByAccount ? '待命(总关)' : (nextVal ? '开' : '关'));
    pillBtn.onclick = () => toggleVmFeature(accId, vmKey, featureName, !nextVal);
  }

  const featureCn = featureName === 'keepaliveEnabled' ? '单机独立保活'
    : featureName === 'taskEnabled' ? '单机自动化任务'
    : featureName === 'autoBootEnabled' ? '单机自动开机守护'
    : featureName === 'realEnterEnabled' ? '定时进入后退出'
    : featureName;
  try {
    const res = await authFetch(`/api/accounts/${accId}/vm-feature`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: vmKey, desktopId: vmKey, feature: featureName, value: nextVal })
    });
    if (res.ok) {
      if (isEcloud && featureName === 'realEnterEnabled' && acc.features?.autoEnter === undefined) {
        const master = document.getElementById(`auto-enter-${acc.id}`);
        if (master) master.checked = acc.desktops.some(d => d.realEnterEnabled === true);
      }
      showToast(`已${nextVal ? '开启' : '关闭'}${featureCn}`, "success");
    } else {
      const data = await res.json();
      showToast(data.error || "更新失败", "error");
      await loadAccounts(true);
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    await loadAccounts(true);
  }
}

// 单台云电脑独立保活周期调整
async function changeVmInterval(accId, vmKey, value) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const numVal = parseInt(value);
  const finalVal = (!isNaN(numVal) && numVal > 0) ? numVal : null;

  const isYdpc = acc.platform === 'ydpc';
  const isEcloud = acc.platform === 'ecloud';
  if (isYdpc) {
    acc.vms = acc.vms || [];
    const targetVm = acc.vms.find(v => String(v.userServiceId) === String(vmKey));
    if (targetVm) targetVm.keepaliveInterval = finalVal;
  } else if (isEcloud) {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.instanceId) === String(vmKey));
    if (targetD) targetD.keepaliveInterval = finalVal;
  } else {
    acc.desktops = acc.desktops || [];
    const targetD = acc.desktops.find(d => String(d.desktopId || d.objId) === String(vmKey));
    if (targetD) targetD.keepaliveInterval = finalVal;
  }

  // 立即刷新卡片以联动反映多机周期概览
  renderAccounts();

  try {
    const res = await authFetch(`/api/accounts/${accId}/vm-feature`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vmId: vmKey, desktopId: vmKey, feature: 'keepaliveInterval', value: finalVal })
    });
    if (res.ok) {
      showToast(`已将该主机保活周期调整为: ${finalVal ? ((isYdpc || isEcloud) ? Math.round(finalVal / 60) + '分钟' : finalVal + '秒') : '继承账号默认'}`, "success");
    } else {
      const data = await res.json();
      showToast(data.error || "更新失败", "error");
      await loadAccounts(true);
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
    await loadAccounts(true);
  }
}

// 单台天翼云电脑快捷开机
async function bootCtyunVm(accId, desktopId) {
  showToast("正在向天翼云下发开机指令...", "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron?desktopId=${encodeURIComponent(desktopId)}`, {
      method: "POST"
    });
    const data = await res.json();
    if (res.ok) {
      showToast(data.msg || "🎉 开机指令下发成功，云电脑正在启动中！", "success");
      setTimeout(() => loadAccounts(true), 3000);
    } else {
      showToast(data.error || "开机指令下发失败", "error");
    }
  } catch (e) {
    showToast("网络异常: " + e.message, "error");
  }
}

// 3. 添加/编辑账号
async function refreshModalCaptcha() {
  const user = document.getElementById("acc-user").value.trim() || '13800000000';
  let devCode = document.getElementById("acc-device-code").value.trim();
  const imgEl = document.getElementById("acc-captcha-img");
  const loadingEl = document.getElementById("acc-captcha-loading");

  loadingEl.style.display = "inline";
  loadingEl.innerText = "获取中...";
  imgEl.style.display = "none";

  try {
    const res = await authFetch(`/api/captcha/${encodeURIComponent(user)}?deviceCode=${encodeURIComponent(devCode)}`);
    const data = await res.json();
    if (res.ok && data.success) {
      currentCaptchaChallenge = data;
      document.getElementById("acc-challenge-id").value = data.challengeId;
      document.getElementById("acc-challenge-code").value = data.challengeCode;
      if (data.deviceCode) {
        document.getElementById("acc-device-code").value = data.deviceCode;
      }
      imgEl.src = data.captchaImage;
      imgEl.style.display = "block";
      loadingEl.style.display = "none";
    } else {
      loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    loadingEl.innerText = "网络异常，点击重试";
  }
}

function switchAccountLoginTab(tab) {
  const btnQr = document.getElementById("tab-btn-qrcode");
  const btnPwd = document.getElementById("tab-btn-pwd");
  const panelQr = document.getElementById("login-panel-qrcode");
  const panelPwd = document.getElementById("login-panel-pwd");
  const btnSave = document.getElementById("btn-save-account-pwd");

  if (tab === 'qrcode') {
    if (btnQr) { btnQr.className = "btn btn-sm btn-primary"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm"; }
    if (panelQr) panelQr.classList.remove("hidden");
    if (panelPwd) panelPwd.classList.add("hidden");
    if (btnSave) btnSave.style.display = "none";
    loadQrCodeForModal();
  } else {
    if (btnQr) { btnQr.className = "btn btn-sm"; }
    if (btnPwd) { btnPwd.className = "btn btn-sm btn-primary"; }
    if (panelQr) panelQr.classList.add("hidden");
    if (panelPwd) panelPwd.classList.remove("hidden");
    if (btnSave) btnSave.style.display = "inline-block";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    setTimeout(refreshModalCaptcha, 200);
  }
}

async function loadQrCodeForModal() {
  if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
  const imgEl = document.getElementById("acc-qrcode-img");
  const loadingEl = document.getElementById("acc-qrcode-loading");
  const hintEl = document.getElementById("acc-qrcode-hint");

  if (imgEl) imgEl.style.display = "none";
  if (loadingEl) { loadingEl.style.display = "flex"; loadingEl.innerText = "正在生成官方二维码..."; }
  if (hintEl) { hintEl.innerText = "等待扫码确认中..."; hintEl.style.color = "#2563eb"; }

  try {
    const res = await authFetch("/api/account/qrcode/generate", { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success && data.qrUrl) {
      currentQrCodeId = data.qrCodeId;
      // 使用快速 QR 渲染引擎
      const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(data.qrUrl)}`;
      if (imgEl) {
        imgEl.src = qrApiUrl;
        imgEl.onload = () => {
          imgEl.style.display = "block";
          if (loadingEl) loadingEl.style.display = "none";
        };
      }

      // 启动 2 秒轮询看门狗 (每次轮询动态读取用户实时填写的账号备注名与目标重登账号ID)
      const currentAccId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
      const accIdParam = currentAccId ? `&accId=${encodeURIComponent(currentAccId)}` : "";
      qrPollingTimer = setInterval(async () => {
        try {
          const currentNameVal = document.getElementById("qrcode-acc-name") ? document.getElementById("qrcode-acc-name").value.trim() : "";
          const sRes = await authFetch(`/api/account/qrcode/status?qrCodeId=${encodeURIComponent(currentQrCodeId)}&deviceCode=${encodeURIComponent(data.deviceCode)}&accountName=${encodeURIComponent(currentNameVal)}${accIdParam}`);
          const sData = await sRes.json();
          if (sData.success) {
            if (sData.codeStatus === 'scaned') {
              if (hintEl) { hintEl.innerText = "📱 手机端已扫描，请在手机上点击【确认登录】..."; hintEl.style.color = "#16a34a"; }
            } else if (sData.codeStatus === 'authorize') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              showToast(sData.isReAuth ? "🎉 官方扫码重新授权成功！已恢复在线保活！" : "🎉 官方扫码授权成功！云电脑已上线！", "success");
              closeModal("account-modal");
              loadAccounts();
            } else if (sData.codeStatus === 'expire') {
              if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
              if (hintEl) { hintEl.innerText = "⚠️ 二维码已失效，点击刷新重试"; hintEl.style.color = "#ef4444"; }
              if (imgEl) imgEl.style.display = "none";
              if (loadingEl) {
                loadingEl.style.display = "flex";
                loadingEl.innerHTML = `<button class="btn btn-sm btn-primary" onclick="loadQrCodeForModal()">🔄 刷新二维码</button>`;
              }
            }
          }
        } catch (e) {}
      }, 2000);
    } else {
      if (loadingEl) loadingEl.innerText = "获取二维码失败: " + (data.error || '接口异常');
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "网络异常，点击重试";
  }
}

function openAddAccountModal() {
  document.getElementById("acc-id").value = "";
  document.getElementById("acc-name").value = "";
  document.getElementById("acc-user").value = "";
  document.getElementById("acc-password").value = "";
  document.getElementById("acc-captcha-code").value = "";
  document.getElementById("acc-device-code").value = "";
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = "";
  const ydNameEl = document.getElementById("ydpc-name");
  if (ydNameEl) ydNameEl.value = "";
  const ydUserEl = document.getElementById("ydpc-user");
  if (ydUserEl) ydUserEl.value = "";
  const ydPwdEl = document.getElementById("ydpc-password");
  if (ydPwdEl) ydPwdEl.value = "";
  const ydCaptchaCode = document.getElementById("ydpc-captcha-code");
  if (ydCaptchaCode) ydCaptchaCode.value = "";
  const ydRandomCode = document.getElementById("ydpc-random-code");
  if (ydRandomCode) ydRandomCode.value = "";
  const ydImg = document.getElementById("ydpc-captcha-img");
  if (ydImg) ydImg.style.display = "none";
  const ydLoading = document.getElementById("ydpc-captcha-loading");
  if (ydLoading) {
    ydLoading.style.display = "inline";
    ydLoading.innerText = "点击获取验证码";
  }

  // 移动公众：清空字段并收起短信验证区、丢弃上一轮待定登录
  pendingEcloudLogin = null;
  const ecName = document.getElementById("ecloud-name");
  if (ecName) ecName.value = "";
  const ecUser = document.getElementById("ecloud-user");
  if (ecUser) ecUser.value = "";
  const ecPwd = document.getElementById("ecloud-password");
  if (ecPwd) ecPwd.value = "";
  const ecCode = document.getElementById("ecloud-sms-code");
  if (ecCode) ecCode.value = "";
  const ecInterval = document.getElementById("ecloud-interval");
  if (ecInterval) ecInterval.value = "300";
  resetEcloudSmsGroup();

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "flex";

  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "flex";

  openModal("account-modal");
  switchAddAccountPlatform('ctyun');
}

async function refreshYdpcModalCaptcha() {
  const imgEl = document.getElementById("ydpc-captcha-img");
  const loadingEl = document.getElementById("ydpc-captcha-loading");
  const randomCodeEl = document.getElementById("ydpc-random-code");

  if (loadingEl) {
    loadingEl.style.display = "inline";
    loadingEl.innerText = "获取中...";
  }
  if (imgEl) imgEl.style.display = "none";

  try {
    const res = await authFetch('/api/ydpc/captcha');
    const data = await res.json();
    if (res.ok && data.success && data.image) {
      if (randomCodeEl) randomCodeEl.value = data.randomCode || '';
      if (imgEl) {
        imgEl.src = data.image;
        imgEl.style.display = "block";
      }
      if (loadingEl) loadingEl.style.display = "none";
    } else {
      if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerText = "获取失败，点击重试";
  }
}

function switchAddAccountPlatform(platform) {
  currentAddPlatform = platform;
  const tabCt = document.getElementById("platform-tab-ctyun");
  const tabYd = document.getElementById("platform-tab-ydpc");
  const tabEc = document.getElementById("platform-tab-ecloud");
  const panelCt = document.getElementById("panel-add-ctyun");
  const panelYd = document.getElementById("panel-add-ydpc");
  const panelEc = document.getElementById("panel-add-ecloud");
  const btnSaveCt = document.getElementById("btn-save-account-pwd");
  const btnSaveYd = document.getElementById("btn-save-account-ydpc");
  const btnSaveEc = document.getElementById("btn-save-account-ecloud");
  const loginTabs = document.getElementById("acc-login-tabs");
  const modalTitle = document.getElementById("modal-account-title");
  const isNew = !document.getElementById("acc-id").value;

  // 先统一收起全部面板/按钮，再按平台单独展开（三平台各自独立，不互相污染）
  if (tabCt) tabCt.className = "btn btn-sm";
  if (tabYd) tabYd.className = "btn btn-sm";
  if (tabEc) tabEc.className = "btn btn-sm";
  if (panelCt) panelCt.classList.add("hidden");
  if (panelYd) panelYd.classList.add("hidden");
  if (panelEc) panelEc.classList.add("hidden");
  if (btnSaveCt) btnSaveCt.style.display = "none";
  if (btnSaveYd) btnSaveYd.style.display = "none";
  if (btnSaveEc) btnSaveEc.style.display = "none";

  if (platform === 'ydpc') {
    if (tabYd) tabYd.className = "btn btn-sm btn-primary";
    if (panelYd) panelYd.classList.remove("hidden");
    if (btnSaveYd) btnSaveYd.style.display = "inline-block";
    if (modalTitle) modalTitle.innerText = "添加移动爱家账号";
    if (loginTabs) loginTabs.style.display = "none";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    return;
  }

  if (platform === 'ecloud') {
    // 移动公众：登录 UI **独立设计** —— 不使用天翼云扫码、不使用移动爱家图形验证码，
    // 而是「账号+密码」→（按需）进入短信验证的两段式。
    if (tabEc) tabEc.className = "btn btn-sm btn-primary";
    if (panelEc) panelEc.classList.remove("hidden");
    if (btnSaveEc) btnSaveEc.style.display = "inline-block";
    if (modalTitle) modalTitle.innerText = pendingEcloudLogin ? "移动公众账号 · 短信验证" : "添加移动公众账号";
    if (loginTabs) loginTabs.style.display = "none";
    if (qrPollingTimer) { clearInterval(qrPollingTimer); qrPollingTimer = null; }
    return;
  }

  // 天翼云
  if (tabCt) tabCt.className = "btn btn-sm btn-primary";
  if (panelCt) panelCt.classList.remove("hidden");
  if (modalTitle && isNew) modalTitle.innerText = "添加天翼云电脑账号";
  if (isNew) {
    if (loginTabs) loginTabs.style.display = "flex";
    switchAccountLoginTab('qrcode');
  }
}

async function saveYdpcAccount() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  const name = document.getElementById("ydpc-name") ? document.getElementById("ydpc-name").value.trim() : "";
  const user = document.getElementById("ydpc-user") ? document.getElementById("ydpc-user").value.trim() : "";
  const password = document.getElementById("ydpc-password") ? document.getElementById("ydpc-password").value.trim() : "";
  const accountType = document.getElementById("ydpc-account-type") ? document.getElementById("ydpc-account-type").value : "main";
  const keepaliveInterval = document.getElementById("ydpc-interval") ? parseInt(document.getElementById("ydpc-interval").value) || 600 : 600;
  const verificationCode = document.getElementById("ydpc-captcha-code") ? document.getElementById("ydpc-captcha-code").value.trim() : "";
  const randomCode = document.getElementById("ydpc-random-code") ? document.getElementById("ydpc-random-code").value.trim() : "";

  if (!user || !password) {
    showToast("请输入移动爱家手机号和密码", "error");
    return;
  }

  if (accId) {
    // 编辑修改模式
    showToast("正在保存移动爱家账号修改并重新同步...", "info");
    try {
      const existingAcc = accounts.find(a => a.id === accId) || {};
      const features = {
        controlPlaneKeepalive: existingAcc.features?.controlPlaneKeepalive !== false,
        mqttKeepAlive: existingAcc.features?.mqttKeepAlive !== false,
        dataPlaneKeepalive: existingAcc.features?.dataPlaneKeepalive !== false,
        autoBoot: existingAcc.features?.autoBoot !== false,
        keepAlive: existingAcc.features?.keepAlive !== false
      };

      const res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name || user,
          user,
          password,
          accountType,
          keepaliveInterval,
          features
        })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("🎉 移动爱家账号修改已保存！", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "更新失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  // 新增模式
  showToast("正在向中国移动 SOHO 中心验证并拉取云电脑...", "info");
  try {
    const res = await authFetch("/api/accounts/ydpc/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, user, password, accountType, keepaliveInterval, verificationCode, randomCode })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 移动爱家添加成功！已自动开启保活守护", "success");
      closeModal("account-modal");
      await loadAccounts(true);
    } else {
      const errMsg = data.error || "添加移动爱家失败";
      showToast(errMsg, "error");
      if (errMsg.includes("验证码")) {
        // 自动拉取图形验证码并聚焦
        refreshYdpcModalCaptcha();
        const codeInput = document.getElementById("ydpc-captcha-code");
        if (codeInput) {
          codeInput.focus();
          codeInput.select();
        }
      }
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// ====================================================
// 📡 移动公众：两段式登录 + 卡片快捷操作
// ----------------------------------------------------
// 与天翼云（扫码 / 图形验证码）和移动爱家（图形验证码）**登录 UI 完全区分**：
// 移动公众是「账号 + 密码」→ 若服务端要求设备信任 / 双因素 → 就地进入短信验证。
// 第一段 POST /api/accounts/ecloud/add   → 直接成功则落库；需短信返回 pendingId
// 第二段 POST /api/accounts/ecloud/login → 带 pendingId + code 完成并落库
// ====================================================
function showEcloudSmsGroup(info) {
  const group = document.getElementById("ecloud-sms-group");
  if (group) group.classList.remove("hidden");
  const hint = document.getElementById("ecloud-sms-hint");
  if (hint) {
    const mobile = info && info.mobile ? String(info.mobile) : '';
    const masked = mobile.length >= 7 ? `${mobile.slice(0, 3)}****${mobile.slice(-4)}` : (mobile || '该账号绑定手机号');
    // 诚实陈述：只有后端确认发送成功才敢说"已下发"。
    // 这里曾经无条件写死"已发送"，而后端当时根本没有发码 —— 属于本项目最忌的"假成功"。
    if (info && info.smsSent === false) {
      hint.innerHTML = `<b style="color:#b91c1c">验证码未发送成功</b>：${escapeHtml(info.smsError || '未知原因')}。请点「重新发送」重试。`;
    } else {
      hint.innerHTML = `已向 <b>${escapeHtml(masked)}</b> 下发短信验证码，请输入收到的验证码完成绑定。`;
    }
  }
  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  const resendBtn = document.getElementById("btn-ecloud-sms-resend");
  if (resendBtn) { resendBtn.disabled = false; resendBtn.innerText = "重新发送"; }
  const codeInput = document.getElementById("ecloud-sms-code");
  if (codeInput) { codeInput.value = ""; codeInput.focus(); }
}

// 重新下发验证码（走 pendingId 复用已有会话，不再走密码登录，避开限流）
async function resendEcloudSmsCode() {
  if (!pendingEcloudLogin || !pendingEcloudLogin.pendingId) {
    showToast("没有待完成的短信验证，请重新添加账号", "error");
    return;
  }
  const btn = document.getElementById("btn-ecloud-sms-resend");
  if (btn) { btn.disabled = true; btn.innerText = "发送中..."; }
  try {
    const res = await authFetch("/api/accounts/ecloud/resend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingId: pendingEcloudLogin.pendingId,
        mobile: pendingEcloudLogin.mobile || ""
      })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      if (data.mobile) pendingEcloudLogin.mobile = data.mobile;
      showEcloudSmsGroup({ mobile: data.mobile || pendingEcloudLogin.mobile, smsSent: true });
      showToast("📲 验证码已重新发送，请查收", "success");
    } else {
      showToast(data.error || "验证码重新发送失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "重新发送"; }
  }
}

function resetEcloudSmsGroup() {
  const group = document.getElementById("ecloud-sms-group");
  if (group) group.classList.add("hidden");
  const codeInput = document.getElementById("ecloud-sms-code");
  if (codeInput) codeInput.value = "";
  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  const resendBtn = document.getElementById("btn-ecloud-sms-resend");
  if (resendBtn) { resendBtn.disabled = false; resendBtn.innerText = "重新发送"; }
  const saveBtn = document.getElementById("btn-save-account-ecloud");
  if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = "保存移动公众账号"; }
}

async function saveEcloudAccount() {
  const accId = document.getElementById("acc-id") ? document.getElementById("acc-id").value : "";
  const name = document.getElementById("ecloud-name") ? document.getElementById("ecloud-name").value.trim() : "";
  const user = document.getElementById("ecloud-user") ? document.getElementById("ecloud-user").value.trim() : "";
  const password = document.getElementById("ecloud-password") ? document.getElementById("ecloud-password").value.trim() : "";
  const keepaliveInterval = document.getElementById("ecloud-interval") ? (parseInt(document.getElementById("ecloud-interval").value) || 300) : 300;

  // 已进入第二段（等验证码）时，本按钮等同于「提交验证」
  if (!accId && pendingEcloudLogin) {
    return submitEcloudSmsCode();
  }

  if (!user || !password) {
    showToast("请输入移动公众账号与密码", "error");
    return;
  }

  if (accId) {
    // 编辑模式：只改账号信息与默认周期，分层开关由卡片上的开关单独维护
    showToast("正在保存移动公众账号修改并重新同步桌面...", "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || user, user, password, keepaliveInterval })
      });
      const data = await res.json();
      if (res.ok) {
        showToast("🎉 移动公众账号修改已保存！", "success");
        closeModal("account-modal");
        await loadAccounts(true);
      } else {
        showToast(data.error || "更新失败", "error");
      }
    } catch (e) {
      showToast("网络请求异常: " + e.message, "error");
    }
    return;
  }

  // 新增模式 · 第一段
  showToast("正在通过移动公众协议侧车验证账号...", "info");
  const saveBtn = document.getElementById("btn-save-account-ecloud");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.innerText = "验证中..."; }
  try {
    const res = await authFetch("/api/accounts/ecloud/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, user, password, keepaliveInterval })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.success) {
      pendingEcloudLogin = null;
      showToast(`🎉 移动公众添加成功！已发现 ${(data.desktops || []).length} 台云电脑并启动独立保活守护`, "success");
      closeModal("account-modal");
      await loadAccounts(true);
      return;
    }

    if (data.needVerification && data.pendingId) {
      pendingEcloudLogin = {
        pendingId: data.pendingId,
        branch: data.branch || '',
        mobile: data.mobile || '',
        smsSent: data.smsSent !== false,
        name, user, password, keepaliveInterval
      };
      showEcloudSmsGroup(data);
      const titleEl = document.getElementById("modal-account-title");
      if (titleEl) titleEl.innerText = "移动公众账号 · 短信验证";
      // 本按钮此刻的作用是「提交验证码」（与上方按钮一致），不再谎称自己是"重新发送"。
      // 必须显式复位 disabled：它在本次调用开头被置为"验证中..."，若不复位，
      // 下面的 finally 因 pendingEcloudLogin 已存在而不会接管，按钮会永久卡在禁用态。
      if (saveBtn) { saveBtn.disabled = false; saveBtn.innerText = "提交验证码"; }
      showToast(
        data.message || (data.smsSent === false ? "验证码下发失败，请点「重新发送」重试" : "该账号登录需要短信验证，请输入收到的验证码"),
        data.smsSent === false ? "error" : "warning"
      );
      return;
    }

    showToast(data.error || `添加移动公众账号失败（HTTP ${res.status}）`, "error");
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (saveBtn && !pendingEcloudLogin) { saveBtn.disabled = false; saveBtn.innerText = "保存移动公众账号"; }
  }
}

async function submitEcloudSmsCode() {
  if (!pendingEcloudLogin || !pendingEcloudLogin.pendingId) {
    showToast("没有待完成的短信验证，请重新添加账号", "error");
    return;
  }
  const codeEl = document.getElementById("ecloud-sms-code");
  const code = codeEl ? codeEl.value.trim() : "";
  if (!code) {
    showToast("请输入收到的短信验证码", "error");
    return;
  }

  const btn = document.getElementById("btn-ecloud-sms-submit");
  if (btn) { btn.disabled = true; btn.innerText = "验证中..."; }

  try {
    const res = await authFetch("/api/accounts/ecloud/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pendingId: pendingEcloudLogin.pendingId,
        code,
        mobile: pendingEcloudLogin.mobile || ""
      })
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.success) {
      pendingEcloudLogin = null;
      resetEcloudSmsGroup();
      showToast(`🎉 短信验证通过！已发现 ${(data.desktops || []).length} 台云电脑并启动独立保活守护`, "success");
      closeModal("account-modal");
      await loadAccounts(true);
      return;
    }

    showToast(data.error || "短信验证未通过，请检查验证码", "error");
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = "提交验证"; }
  }
}

// 立即执行一次移动公众分层保活（与自动巡检同一条代码路径）
async function triggerEcloudKeepalive(accId) {
  showToast("正在执行一次移动公众分层保活巡检（L1 + L2）...", "info");
  try {
    const res = await authFetch("/api/accounts/ecloud/keepalive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accountId: accId })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) {
      const l1 = data.result && data.result.l1;
      const l2n = (data.result && data.result.l2) ? data.result.l2.length : 0;
      const l1Text = l1 ? (l1.ok === true ? 'L1 探针通过' : (l1.ok === false ? 'L1 token 失效（已按纪律处理）' : 'L1 未判定（不重登）')) : 'L1 已跳过';
      showToast(`巡检完成：${l1Text} · L2 执行 ${l2n} 台`, "success");
    } else {
      showToast("保活巡检失败: " + (data.error || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

// 重新拉取名下云主机列表（复用账号更新路由触发的 refreshDesktops）
async function syncEcloudDesktops(accId) {
  showToast("正在重新同步移动公众桌面列表...", "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast(`🔄 桌面列表已同步（${(data.desktops || []).length} 台）`, "success");
    } else {
      showToast("同步失败: " + (data.error || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

function editAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("acc-id").value = acc.id;

  const platformTabs = document.getElementById("platform-tabs-container");
  if (platformTabs) platformTabs.style.display = "none"; // 编辑模式锁定平台

  if (acc.platform === 'ecloud') {
    document.getElementById("modal-account-title").innerText = `编辑移动公众账号 [${acc.name || acc.user}]`;
    const ecNameEl = document.getElementById("ecloud-name");
    const ecUserEl = document.getElementById("ecloud-user");
    const ecPwdEl = document.getElementById("ecloud-password");
    const ecIntEl = document.getElementById("ecloud-interval");
    if (ecNameEl) ecNameEl.value = acc.name || "";
    if (ecUserEl) ecUserEl.value = acc.user || "";
    if (ecPwdEl) ecPwdEl.value = acc.password || "";
    if (ecIntEl) {
      const want = String(acc.keepaliveInterval || 300);
      const exists = Array.prototype.some.call(ecIntEl.options, o => o.value === want);
      ecIntEl.value = exists ? want : "300";
    }
    // 编辑态不进入两段式登录（重置短信区，避免误提交上一轮的 pendingId）
    pendingEcloudLogin = null;
    resetEcloudSmsGroup();

    openModal("account-modal");
    switchAddAccountPlatform('ecloud');
    return;
  }

  if (acc.platform === 'ydpc') {
    document.getElementById("modal-account-title").innerText = "编辑移动爱家账号";
    const nameEl = document.getElementById("ydpc-name");
    const userEl = document.getElementById("ydpc-user");
    const pwdEl = document.getElementById("ydpc-password");
    const typeEl = document.getElementById("ydpc-account-type");
    const intEl = document.getElementById("ydpc-interval");

    if (nameEl) nameEl.value = acc.name || "";
    if (userEl) userEl.value = acc.user || "";
    if (pwdEl) pwdEl.value = acc.password || "";
    if (typeEl) typeEl.value = acc.accountType || "main";
    if (intEl) intEl.value = String(acc.keepaliveInterval || 600);

    openModal("account-modal");
    switchAddAccountPlatform('ydpc');
  } else {
    const isQrAccount = !acc.password;
    if (isQrAccount) {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `📱 重新扫码授权天翼云账号 [${acc.name || acc.user}]` 
        : `📱 重新扫码授权 [${acc.name || acc.user}]`;
      const qrNameEl = document.getElementById("qrcode-acc-name");
      if (qrNameEl) qrNameEl.value = acc.name || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('qrcode');
    } else {
      document.getElementById("modal-account-title").innerText = acc.sessionExpired 
        ? `⚠️ 重新验证天翼云账号 [${acc.name || acc.user}]` 
        : `编辑天翼云账号 [${acc.name || acc.user}]`;
      document.getElementById("acc-name").value = acc.name || "";
      document.getElementById("acc-user").value = acc.user || "";
      document.getElementById("acc-password").value = acc.password || "";
      document.getElementById("acc-captcha-code").value = "";
      document.getElementById("acc-device-code").value = acc.deviceCode || "";
      const tabContainer = document.getElementById("acc-login-tabs");
      if (tabContainer) tabContainer.style.display = "none";
      openModal("account-modal");
      switchAddAccountPlatform('ctyun');
      switchAccountLoginTab('pwd');
      setTimeout(refreshModalCaptcha, 300);
    }
  }
}

// 【2026-09-23 修订】移动云单机开机入口。
// 路径：本函数 → /api/accounts/:id/power/poweron → server.js → ydpc_client.bootVmViaCag()
//       → app/ydpc/cag_boot.js（CAG HTTPS 干净通道）
// 注：上一版曾误以为"电源管理弹窗已足以覆盖移动云"，但移动云卡片当时并未渲染
//     ⚡ 电源管理 按钮（该按钮只在 天翼云 分支），导致开机入口在 UI 上缺失。
//     现于每台云主机行内直接提供 🖥️开机 按钮，与 per-VM 保活开关同一排。
async function bootYdpcVm(accId, userServiceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  showToast(`正在通过 CAG 通道拉起 ${label}，请留意日志...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: String(userServiceId) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      showToast(data.message || data.msg || `🎉 已下发开机指令，${label}正在启动`, "success");
    } else {
      showToast("开机失败: " + (data.error || data.message || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("开机请求异常: " + e.message, "error");
  }
  // 无论成败都刷新，让卡片状态与日志同步
  await loadAccounts(true);
}

// 【2026-09-28】移动公众（大众版）开机：走平台官方 operate 通道（available=开机）。
// 措辞纪律：受理 ≠ 已开机 —— toast 只说"平台已受理"，最终以状态徽章变"运行中"为准。
async function bootEcloudDesktop(accId, instanceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  showToast(`正在通过平台通道拉起 ${label}，请留意日志...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/power/poweron`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: String(instanceId) })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && !data.error) {
      showToast(data.message || `🎉 已下发开机指令，${label}正在启动`, "success");
    } else {
      showToast("开机失败: " + (data.error || data.message || `HTTP ${res.status}`), "error");
    }
  } catch (e) {
    showToast("开机请求异常: " + e.message, "error");
  }
  await loadAccounts(true);
}

async function requestEcloudDesktopWithReauth(path, accId, instanceId, extra = {}) {
    const payload = { accountId: accId, instanceId, ...extra };
    let res = await authFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    let data = await res.json().catch(() => ({}));
    if (!res.ok && /缺少连接票据|登录令牌已失效|需要短信验证/.test(String(data.error || ''))) {
      showToast('正在重新验证移动公众账号', 'info');
      const loginRes = await authFetch('/api/accounts/ecloud/reauth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: accId })
      });
      const loginData = await loginRes.json().catch(() => ({}));
      if (loginData.needVerification) {
        if (!loginData.smsSent) throw new Error(loginData.smsError || '验证码下发失败');
        const code = window.prompt(`验证码已发送至 ${loginData.mobile || '绑定手机'}。请输入短信验证码：`);
        if (!code || !code.trim()) throw new Error('已取消短信验证，本次未进入云电脑');
        const verifyRes = await authFetch('/api/accounts/ecloud/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pendingId: loginData.pendingId, code: code.trim(), mobile: loginData.mobile })
        });
        const verifyData = await verifyRes.json().catch(() => ({}));
        if (!verifyRes.ok || !verifyData.success) throw new Error(verifyData.error || '短信验证失败');
      } else if (!loginRes.ok || !loginData.success) {
        throw new Error(loginData.error || '连接票据刷新失败');
      }
      res = await authFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      data = await res.json().catch(() => ({}));
    }
    return { res, data };
}

async function enterEcloudDesktopOnce(accId, instanceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  const button = document.getElementById(`pill-enter-${accId}-${instanceId}`);
  if (button) { button.disabled = true; button.innerText = '连接中…'; }
  showToast(`正在进入 ${label}，连接成功约 10 秒后自动退出`, 'info');
  try {
    const { res, data } = await requestEcloudDesktopWithReauth('/api/accounts/ecloud/enter-once', accId, instanceId);
    if (res.ok && data.success) showToast(data.message, 'success');
    else showToast(data.error || `进入失败（HTTP ${res.status}）`, 'error');
  } catch (e) {
    showToast(`进入请求失败：${e.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.innerText = '🚪 进入后退出'; }
    await loadAccounts(true);
  }
}

async function toggleEcloudHeldDesktop(accId, instanceId, vmName = '') {
  const label = vmName ? `「${vmName}」` : '该云电脑';
  const acc = accounts.find(a => a.id === accId);
  const desktop = (acc?.desktops || []).find(d => String(d.instanceId) === String(instanceId));
  const action = desktop?.heldConnected ? 'disconnect' : 'connect';
  const button = document.getElementById(`pill-hold-${accId}-${instanceId}`);
  if (button) { button.disabled = true; button.innerText = action === 'connect' ? '连接中…' : '断开中…'; }
  showToast(action === 'connect' ? `正在进入 ${label}，成功后将保持连接` : `正在退出 ${label} 的连接`, 'info');
  try {
    const { res, data } = await requestEcloudDesktopWithReauth('/api/accounts/ecloud/hold', accId, instanceId, { action });
    if (res.ok && data.success) showToast(data.message, 'success');
    else showToast(data.error || `连接操作失败（HTTP ${res.status}）`, 'error');
  } catch (e) {
    showToast(`连接操作失败：${e.message}`, 'error');
  } finally {
    if (button) button.disabled = false;
    await loadAccounts(true);
  }
}

// 【2026-09-26】"机器没开机 ⇒ 本次压根没执行"必须与真失败分开渲染。
// 后端在机关机时返回 { success:false, message:'云电脑处于关机状态' }；SCG 机 / 未下发 cagIp 的机器则返回「无 CAG 通道 / 未发起握手」——同属"本次没做事"。
// 若按失败渲染会给出「异常/失败」——把"待命"渲染成"报错"，
// 与"把待命渲染成成功"是同一种失真（诚实性红线两侧都要守）。
function isVmOffSkipResult(data) {
  return !!data && data.success === false && !data.error &&
    /关机|未开机|未运行|未发起|无 CAG 通道/.test(String(data.message || ''));
}

async function pingYdpcCag(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在向中兴 CAG 发起三阶段 TCP 握手...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/cag-ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🟢 ZTEC CAG 握手成功！网关返回 200 OK", "success");
      await loadAccounts(true);
    } else if (isVmOffSkipResult(data)) {
      showToast("云电脑未开机，本次未发起 CAG 握手（开机后会自动继续）", "info");
    } else {
      showToast("CAG 握手失败: " + (data.error || "超时"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function verifyYdpcKeepAlive(accId) {
  showToast("正在启动独立状态验证（监控 60 秒，请稍候）...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/verify-keepalive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ durationSec: 60, intervalSec: 15 })
    });
    const data = await res.json();
    if (res.ok) {
      const detail = `持续 ${data.durationSeconds}s / 采样 ${data.snapshots?.length || 0} 次` +
        (data.firstOffSeconds !== null && data.firstOffSeconds !== undefined ? ` / 首次离线于 ${data.firstOffSeconds}s` : "");
      if (data.ok) {
        showToast(`✅ 独立验证通过：机器全程在线（${detail}）`, "success");
      } else {
        showToast(`⚠️ 独立验证未通过：${data.stopReason || "存在异常"}（${detail}）`, "error");
      }
      await loadAccounts(true);
    } else {
      showToast("验证请求失败: " + (data.error || "未知错误"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function heartbeatYdpc(accId, userServiceId) {
  const acc = accounts.find(a => a.id === accId);
  const targetUsid = userServiceId || (acc?.vms?.[0]?.userServiceId) || (acc?.desktops?.[0]?.userServiceId);
  showToast("正在发送 SOHO 心跳保持...", "info");
  try {
    const res = await authFetch(`/api/ydpc/${accId}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userServiceId: targetUsid })
    });
    const data = await res.json();
    if (res.ok && (data.code === 2000 || data.code === 0 || data.success)) {
      showToast("💓 SOHO 心跳保持成功！", "success");
      await loadAccounts(true);
    } else if (isVmOffSkipResult(data)) {
      showToast("云电脑未开机，本次未发送心跳（开机后会自动继续）", "info");
    } else {
      showToast("心跳异常: " + (data.msg || data.error || "失败"), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function generateNewDeviceCode() {
  try {
    const res = await authFetch("/api/device/generate", { method: "POST" });
    const data = await res.json();
    if (data && data.deviceCode) {
      document.getElementById("acc-device-code").value = data.deviceCode;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    } else {
      // 前端本地生成 32 位标准 web_ 设备码作为即时兜底
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let code = 'web_';
      for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
      document.getElementById("acc-device-code").value = code;
      showToast("已重新生成设备码", "info");
      refreshModalCaptcha();
    }
  } catch (e) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let code = 'web_';
    for (let i = 0; i < 32; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    document.getElementById("acc-device-code").value = code;
    showToast("已重新生成设备码", "info");
    refreshModalCaptcha();
  }
}

async function saveAccount() {
  const accId = document.getElementById("acc-id").value;
  const name = document.getElementById("acc-name").value.trim();
  const user = document.getElementById("acc-user").value.trim();
  const password = document.getElementById("acc-password").value.trim();
  const deviceCode = document.getElementById("acc-device-code").value.trim();
  const captchaCode = document.getElementById("acc-captcha-code").value.trim();
  const challengeId = document.getElementById("acc-challenge-id").value.trim();
  const challengeCode = document.getElementById("acc-challenge-code").value.trim();

  if (!user || !password) {
    showToast("手机号/账号与密码不能为空", "error");
    return;
  }

  // 新增账号或重登验证时，强制要求输入验证码
  if (!accId || (accId && captchaCode)) {
    if (!captchaCode) {
      showToast("请输入图形验证码", "error");
      document.getElementById("acc-captcha-code").focus();
      return;
    }
  }

  showToast("正在向天翼云发起真实登录验证，请稍候...", "info");

  const payload = {
    name: name || user,
    user,
    password,
    deviceCode,
    captchaCode,
    challengeId,
    challengeCode
  };

  try {
    let res;
    if (accId) {
      res = await authFetch(`/api/accounts/${accId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    } else {
      res = await authFetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
    }

    const data = await res.json();
    if (res.ok) {
      closeModal("account-modal");
      showToast(accId ? "账号更新成功！" : "🎉 账号真实验证成功，已添加并启动保活！", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("❌ 操作未通过: " + (data.error || "验证码或密码错误"), "error");
      refreshModalCaptcha();
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteAccount(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!confirm(`确定要删除账号 [${acc?.name || acc?.user}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/accounts/${accId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("账号已删除", "success");
      checkCurrentUser();
      loadAccounts();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("网络异常", "error");
  }
}

// 4. 短信验证码绑定设备 (含官方图形验证码前置校验链路)
function openSmsModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("sms-acc-id").value = acc.id;
  document.getElementById("sms-phone").value = acc.user;
  document.getElementById("sms-code").value = "";
  document.getElementById("sms-captcha-code").value = "";
  document.getElementById("sms-captcha-key").value = "";
  openModal("sms-modal");
  refreshSmsCaptcha();
}

// 方案 B：从短信弹窗一键切换到手机 App 扫码授信 (免短信，官方 App 扫码即自动信任设备)
function openQrTrustFromSms() {
  const accId = document.getElementById("sms-acc-id").value;
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  closeModal("sms-modal");

  // 复用天翼云官方扫码重授权链路：指定目标账号 ID，扫码确认后官方自动将该设备码标记为永久信任
  document.getElementById("acc-id").value = acc.id;
  const titleEl = document.getElementById("modal-account-title");
  if (titleEl) titleEl.innerText = `📱 扫码一键信任设备 [${acc.name || acc.user}] (免短信)`;
  const qrNameEl = document.getElementById("qrcode-acc-name");
  if (qrNameEl) qrNameEl.value = acc.name || "";
  const tabContainer = document.getElementById("acc-login-tabs");
  if (tabContainer) tabContainer.style.display = "none";

  openModal("account-modal");
  switchAddAccountPlatform('ctyun');
  switchAccountLoginTab('qrcode');
}

// 拉取天翼云官方短信流程图形验证码 (点击图片亦可刷新)
async function refreshSmsCaptcha() {
  const accId = document.getElementById("sms-acc-id").value;
  if (!accId) return;
  const imgEl = document.getElementById("sms-captcha-img");
  const loadingEl = document.getElementById("sms-captcha-loading");
  if (imgEl) imgEl.style.display = "none";
  if (loadingEl) loadingEl.style.display = "flex";
  try {
    const res = await authFetch(`/api/accounts/${accId}/sms-captcha`);
    const data = await res.json();
    if (res.ok && data.success) {
      document.getElementById("sms-captcha-key").value = data.captchaKey || "";
      if (imgEl) {
        imgEl.src = data.captchaImage;
        imgEl.style.display = "block";
      }
      if (loadingEl) loadingEl.style.display = "none";
    } else {
      if (loadingEl) loadingEl.innerHTML = `<span style="color:#ef4444; font-size:11px;">加载失败<br>点击重试</span>`;
      loadingEl && (loadingEl.onclick = () => refreshSmsCaptcha());
    }
  } catch (e) {
    if (loadingEl) loadingEl.innerHTML = `<span style="color:#ef4444; font-size:11px;">网络异常<br>点击重试</span>`;
    loadingEl && (loadingEl.onclick = () => refreshSmsCaptcha());
  }
}

async function sendSmsCode() {
  const accId = document.getElementById("sms-acc-id").value;
  const btn = document.getElementById("btn-send-sms");
  const captchaCode = document.getElementById("sms-captcha-code").value.trim();
  const captchaKey = document.getElementById("sms-captcha-key").value.trim();

  if (smsCountdown > 0) return;
  if (!captchaCode) {
    showToast("请先输入图形验证码", "error");
    return;
  }

  btn.innerText = "发送中...";
  btn.disabled = true;

  try {
    const res = await authFetch(`/api/accounts/${accId}/send-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captchaCode, captchaKey })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("验证码发送成功，请查收手机短信", "success");
      smsCountdown = 60;
      const timer = setInterval(() => {
        smsCountdown--;
        if (smsCountdown <= 0) {
          clearInterval(timer);
          btn.innerText = "获取验证码";
          btn.disabled = false;
        } else {
          btn.innerText = `重新获取(${smsCountdown}s)`;
        }
      }, 1000);
    } else {
      showToast("发送短信失败: " + (data.message || data.error), "error");
      btn.innerText = "获取验证码";
      btn.disabled = false;
      // 图验校验失败后自动刷新图形验证码以便重试
      refreshSmsCaptcha();
      document.getElementById("sms-captcha-code").value = "";
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
    btn.innerText = "获取验证码";
    btn.disabled = false;
  }
}

async function submitSmsBind() {
  const accId = document.getElementById("sms-acc-id").value;
  const code = document.getElementById("sms-code").value.trim();

  if (!code) {
    showToast("请输入短信验证码", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/accounts/${accId}/bind-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verificationCode: code })
    });
    const data = await res.json();
    if (res.ok) {
      showToast("设备绑定成功！保活已就绪", "success");
      closeModal("sms-modal");
      loadAccounts();
    } else {
      showToast("绑定失败: " + (data.message || data.error), "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 5. 自动兑换与抽奖设置
async function openRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("redeem-acc-id").value = acc.id;

  const cfg = acc.redeemConfig || {};
  document.getElementById("redeem-enabled").checked = !!cfg.enabled;
  document.getElementById("redeem-enabled-label").innerText = cfg.enabled ? "已启用自动兑换" : "未启用";

  document.getElementById("redeem-target-type").value = cfg.targetType || "redeem";
  document.getElementById("redeem-schedule-type").value = cfg.scheduleType || "monthly_days";
  document.getElementById("redeem-monthly-days").value = (cfg.monthlyDays || [-1]).join(",");
  document.getElementById("redeem-interval-days").value = cfg.intervalDays || 1;
  document.getElementById("redeem-max-times").value = cfg.maxRedeemTimes || 0;

  onScheduleTypeChange();
  onTargetTypeChange();

  await loadProductList(cfg.prodId);
  loadAccountDesktops(accId, cfg.desktopId);

  openModal("redeem-modal");
}

document.getElementById("redeem-enabled")?.addEventListener("change", (e) => {
  document.getElementById("redeem-enabled-label").innerText = e.target.checked ? "已启用自动兑换" : "未启用";
});

async function loadProductList(selectedProdId) {
  const select = document.getElementById("redeem-product-select");
  select.innerHTML = "<option value=''>正在连接天翼云商城拉取最新奖品...</option>";

  try {
    const res = await authFetch("/api/rewards");
    availableRewards = await res.json();

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      if (selectedProdId && Number(selectedProdId) === Number(r.prodId)) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  } catch (e) {
    select.innerHTML = "<option value='17023101'>8C16G升配包1天 (500积分)</option>";
  }
}

async function loadAccountDesktops(accId, selectedDesktopId) {
  const select = document.getElementById("redeem-desktop-select");
  select.innerHTML = "<option value=''>正在获取绑定的云电脑...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '云电脑'})`;
          if (selectedDesktopId && String(selectedDesktopId) === String(d.desktopId)) {
            opt.selected = true;
          }
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='default'>默认主云电脑</option>";
}

function onTargetTypeChange() {
  const type = document.getElementById("redeem-target-type").value;
  const desktopGroup = document.getElementById("group-desktop-select");
  if (type === "lottery") {
    desktopGroup.classList.add("hidden");
  } else {
    desktopGroup.classList.remove("hidden");
  }
}

function onScheduleTypeChange() {
  const type = document.getElementById("redeem-schedule-type").value;
  document.getElementById("group-monthly-days").classList.toggle("hidden", type !== "monthly_days");
  document.getElementById("group-interval-days").classList.toggle("hidden", type !== "interval_days");
}

async function saveRedeemConfig() {
  const accId = document.getElementById("redeem-acc-id").value;
  const enabled = document.getElementById("redeem-enabled").checked;
  const targetType = document.getElementById("redeem-target-type").value;
  const prodSelect = document.getElementById("redeem-product-select");
  const selectedOpt = prodSelect.options[prodSelect.selectedIndex];

  const desktopSelect = document.getElementById("redeem-desktop-select");
  const desktopId = desktopSelect.value;
  const desktopName = desktopSelect.options[desktopSelect.selectedIndex]?.innerText || "";

  const scheduleType = document.getElementById("redeem-schedule-type").value;
  const monthlyStr = document.getElementById("redeem-monthly-days").value.trim();
  const monthlyDays = monthlyStr.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
  const intervalDays = parseInt(document.getElementById("redeem-interval-days").value) || 1;
  const maxTimes = parseInt(document.getElementById("redeem-max-times").value) || 0;

  const redeemConfig = {
    enabled,
    targetType,
    prodId: selectedOpt ? parseInt(selectedOpt.value) : 17023101,
    prodName: selectedOpt ? selectedOpt.dataset.name : "8C16G升配包1天",
    prodType: selectedOpt ? selectedOpt.dataset.type : "pointstplupgrade",
    costPoints: selectedOpt ? parseInt(selectedOpt.dataset.points) : 500,
    desktopId,
    desktopName,
    scheduleType,
    monthlyDays: monthlyDays.length > 0 ? monthlyDays : [-1],
    intervalDays,
    maxRedeemTimes: maxTimes
  };

  try {
    const res = await authFetch(`/api/accounts/${accId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        features: { autoRedeem: enabled },
        redeemConfig
      })
    });
    if (res.ok) {
      showToast("自动兑换与抽奖配置已保存！", "success");
      closeModal("redeem-modal");
      loadAccounts();
    } else {
      showToast("保存配置失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// ==========================================
// 手动积分兑换 / 幸运抽奖
// ==========================================
async function openManualRedeemModal(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("manual-acc-id").value = acc.id;
  document.getElementById("manual-acc-name").innerText = acc.name || acc.user;
  const pts = acc.liveMetrics?.userPoints || acc.stats?.points || 0;
  document.getElementById("manual-user-points").innerText = pts;
  document.getElementById("manual-order-times").value = 1;

  await loadManualProductList();
  await loadManualDesktops(accId);
  updateManualTotalCost();

  openModal("manual-redeem-modal");
}

async function loadManualProductList() {
  const select = document.getElementById("manual-prod-select");
  select.innerHTML = "<option value=''>加载天翼云商城最新商品...</option>";

  try {
    if (!availableRewards || availableRewards.length === 0) {
      const res = await authFetch("/api/rewards");
      availableRewards = await res.json();
    }

    select.innerHTML = "";
    availableRewards.forEach(r => {
      const opt = document.createElement("option");
      opt.value = r.prodId;
      opt.innerText = `${r.prodName} (${r.costPoints} 积分)`;
      opt.dataset.name = r.prodName;
      opt.dataset.points = r.costPoints;
      opt.dataset.type = r.prodType;
      opt.dataset.desc = r.description || "";
      select.appendChild(opt);
    });
    onManualProductChange();
  } catch (e) {
    select.innerHTML = "<option value='17023101' data-name='8C16G升配包1天' data-points='500' data-type='pointstplupgrade' data-desc='升级云电脑配置'>8C16G升配包1天 (500 积分)</option>";
    onManualProductChange();
  }
}

function onManualProductChange() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt) {
    document.getElementById("manual-prod-desc").innerText = selectedOpt.dataset.desc || "";
    // 如果是升配包（pointstplupgrade），需要选择云电脑；数据盘、智库等直发型商品无需强制选择设备
    const prodType = selectedOpt.dataset.type;
    const desktopGroup = document.getElementById("group-manual-desktop");
    if (desktopGroup) {
      desktopGroup.style.display = (prodType === 'pointstplupgrade') ? 'block' : 'none';
    }
  }
  updateManualTotalCost();
}

async function loadManualDesktops(accId) {
  const select = document.getElementById("manual-desktop-select");
  select.innerHTML = "<option value='0'>正在获取云电脑设备...</option>";

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list.length > 0) {
        select.innerHTML = "";
        list.forEach(d => {
          const opt = document.createElement("option");
          opt.value = d.desktopId;
          opt.dataset.prodInstId = d.prodInstId || "";
          opt.innerText = `${d.desktopName || d.desktopCode} (${d.useStatusText || '运行中'})`;
          select.appendChild(opt);
        });
        return;
      }
    }
  } catch (e) {}

  select.innerHTML = "<option value='0'>主云电脑 (默认)</option>";
}

function updateManualTotalCost() {
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  const unitCost = selectedOpt ? (parseInt(selectedOpt.dataset.points) || 0) : 0;
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const total = unitCost * times;
  document.getElementById("manual-cost-tip").innerText = `单价: ${unitCost}分 | 数量: ${times} | 预计消耗: ${total} 积分`;
}

async function submitManualRedeemOrder() {
  const accId = document.getElementById("manual-acc-id").value;
  const select = document.getElementById("manual-prod-select");
  const selectedOpt = select.options[select.selectedIndex];
  if (!selectedOpt) {
    showToast("请选择要兑换的商品", "error");
    return;
  }

  const prodId = parseInt(selectedOpt.value);
  const prodName = selectedOpt.dataset.name;
  const prodType = selectedOpt.dataset.type;
  const costPoints = parseInt(selectedOpt.dataset.points) || 0;
  const desktopSelect = document.getElementById("manual-desktop-select");
  const desktopId = parseInt(desktopSelect.value) || 0;
  const prodInstId = desktopSelect.options[desktopSelect.selectedIndex]?.dataset.prodInstId || "";
  const times = Math.max(1, parseInt(document.getElementById("manual-order-times").value) || 1);
  const totalCost = costPoints * times;

  const currentPts = parseInt(document.getElementById("manual-user-points").innerText) || 0;
  if (currentPts < totalCost) {
    showToast(`积分不足：当前拥有 ${currentPts} 分，本次兑换需要 ${totalCost} 分！`, "error");
    return;
  }

  if (!confirm(`确认消耗 ${totalCost} 积分立即兑换【${prodName} x${times}】吗？`)) {
    return;
  }

  const btn = document.getElementById("btn-manual-order-submit");
  btn.disabled = true;
  btn.innerText = "正在下单兑换...";

  try {
    const res = await authFetch(`/api/accounts/${accId}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prodId, prodName, prodType, costPoints, desktopId, times })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `🎉 成功兑换 ${prodName} x${times}！`, data.partial ? "warning" : "success");
      closeModal("manual-redeem-modal");
      await loadAccounts();
    } else {
      const errDetail = data.reason ? `${data.error}\n\n🔍 原因分析: ${data.reason}` : (data.error || "兑换下单失败");
      showToast(data.error || "兑换下单失败", "error");
      alert(errDetail);
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  } finally {
    // 防风控纪律：兑换后按钮强制 10 秒冷却，杜绝连续点击触发天翼云反欺诈
    let cooldown = 10;
    btn.innerText = `冷却中 (${cooldown}s)`;
    const timer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        clearInterval(timer);
        btn.disabled = false;
        btn.innerText = "立即确认兑换";
      } else {
        btn.innerText = `冷却中 (${cooldown}s)`;
      }
    }, 1000);
  }
}

// ==========================================
// 云电脑电源管理 (开机 / 重启 / 关机)
// ==========================================
// 【2026-09-23 修订】移动云"开机 / 唤醒"已恢复，走 CAG HTTPS 干净通道，故电源管理弹窗
// 中重新显示该按钮；天翼云不受影响。
function setPowerBootButtonEnabled(enabled) {
  const btn = document.getElementById("power-btn-boot");
  if (!btn) return;
  btn.style.display = enabled ? "" : "none";
  btn.disabled = !enabled;
}

async function openPowerModal(accId, desktopId = '', desktopName = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;
  document.getElementById("power-acc-id").value = acc.id;
  currentPowerDesktopId = desktopId || '';

  const select = document.getElementById("power-desktop-select");
  select.innerHTML = "<option value=''>正在获取名下云主机...</option>";
  document.getElementById("power-desktop-status").innerHTML = `<span style="color: #64748b;">检测中...</span>`;
  openModal("power-modal");

  if (acc.platform === 'ydpc') {
    // 2026-09-23：开机能力已恢复（CAG 干净通道），重新显示开机按钮
    setPowerBootButtonEnabled(true);
    const vms = (acc.vms && acc.vms.length > 0) ? acc.vms : (acc.desktops || []);
    const localList = vms.map(v => ({
      desktopId: String(v.userServiceId),
      desktopName: v.vmName || '中国移动云电脑',
      useStatusText: v.vmStatus || '未知',
      flavorName: v.cpu ? `${v.cpu}核/${v.memory}G` : ''
    }));
    renderPowerDesktopSelect(localList, desktopId);
    return;
  }

  // 天翼云
  setPowerBootButtonEnabled(true);
  const localList = (acc.desktops && acc.desktops.length > 0) ? acc.desktops : (acc.liveMetrics?.desktopName ? [{
    desktopId: acc.liveMetrics?.desktopId || acc.stats?.desktopId || '0',
    desktopName: acc.liveMetrics?.desktopName,
    useStatusText: '运行中',
    flavorName: ''
  }] : []);

  renderPowerDesktopSelect(localList, desktopId);

  try {
    const res = await authFetch(`/api/accounts/${accId}/desktops`);
    if (res.ok) {
      const list = await res.json();
      if (list && list.length > 0) {
        currentPowerAccountDesktops = list;
        renderPowerDesktopSelect(list, desktopId || currentPowerDesktopId);
      }
    }
  } catch (e) {}
}

function renderPowerDesktopSelect(list, targetDesktopId) {
  const select = document.getElementById("power-desktop-select");
  if (!select) return;
  if (!list || list.length === 0) {
    select.innerHTML = "<option value=''>默认主云电脑</option>";
    onPowerDesktopChange();
    return;
  }

  currentPowerAccountDesktops = list;
  select.innerHTML = "";
  list.forEach((d, idx) => {
    const opt = document.createElement("option");
    opt.value = d.desktopId;
    opt.dataset.status = d.useStatusText || '运行中';
    const flavor = d.flavorName ? ` [${d.flavorName}]` : '';
    opt.innerText = `🖥️ ${d.desktopName || '云电脑'}${flavor} - (${d.useStatusText || '运行中'})`;
    
    // 如果指定了 targetDesktopId，或者首项匹配
    if (targetDesktopId && String(targetDesktopId) === String(d.desktopId)) {
      opt.selected = true;
    } else if (!targetDesktopId && idx === 0) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  onPowerDesktopChange();
}

function onPowerDesktopChange() {
  const select = document.getElementById("power-desktop-select");
  const statusEl = document.getElementById("power-desktop-status");
  if (!select || !statusEl) return;

  currentPowerDesktopId = select.value || '';
  const selectedOpt = select.options[select.selectedIndex];
  if (selectedOpt && selectedOpt.dataset.status) {
    const st = selectedOpt.dataset.status;
    const isRunning = st.includes('运行');
    statusEl.innerHTML = `<span style="color: ${isRunning ? '#16a34a' : '#d97706'}; font-weight:700;">${isRunning ? '🟢 ' : '⚪ '}${st}</span>`;
  } else {
    statusEl.innerHTML = `<span style="color: #64748b;">就绪</span>`;
  }
}

async function executePowerAction(action) {
  const accId = document.getElementById("power-acc-id").value;
  const acc = accounts.find(a => a.id === accId);
  const actionNames = { poweron: '开机 / 唤醒', reboot: '重启', shutdown: '关机' };
  const actionName = actionNames[action] || action;

  if (action === 'shutdown' || action === 'reboot') {
    if (!confirm(`确认要对云电脑下达【${actionName}】指令吗？未保存的数据可能会丢失。`)) {
      return;
    }
  }

  if (acc && acc.platform === 'ydpc') {
    // 【2026-09-23 修订】移动云"开机 / 唤醒"已恢复，走 CAG HTTPS 干净通道；
    // 关机 / 重启仍走官方 SOHO 接口。
    showToast(`正在向移动爱家下发【${actionName}】指令...`, "info");
    try {
      const res = await authFetch(`/api/accounts/${accId}/power/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userServiceId: currentPowerDesktopId })
      });
      const data = await res.json();
      if (res.ok && (data.success || data.code === 2000)) {
        showToast(data.message || `【${actionName}】指令已生效！`, "success");
        closeModal("power-modal");
        await loadAccounts(true);
      } else {
        showToast(`操作未成功: ${data.error || data.msg || '网关拒绝'}`, "error");
      }
    } catch (e) {
      showToast("请求异常: " + e.message, "error");
    }
    return;
  }

  // 天翼云
  showToast(`正在向天翼云下发【${actionName}】指令...`, "info");
  try {
    const query = currentPowerDesktopId ? `?desktopId=${encodeURIComponent(currentPowerDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/power/${action}${query}`, { method: "POST" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || `【${actionName}】指令下达成功！`, "success");
      closeModal("power-modal");
      await loadAccounts(true);
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast(data.error || `操作失败: ${data.message || '网关拒绝'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// ==========================================
// 弹窗浏览器免密直达访问云电脑 (自动匹配设定的分辨率与缩放，手机端全屏横向沉浸)
// ==========================================
async function launchWebDesktop(accId, targetDesktopId = '') {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  showToast(`正在获取 [${acc.name || acc.user}] 的云电脑直达访问会话...`, "info");

  try {
    const query = targetDesktopId ? `?desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const res = await authFetch(`/api/accounts/${accId}/web-launch${query}`);
    const data = await res.json();
    if (!res.ok || !data.success) {
      showToast(data.error || "获取访问会话失败", "error");
      return;
    }

    const token = currentAuthToken || localStorage.getItem('ctyun_auth_token') || sessionStorage.getItem('ctyun_auth_token') || '';
    const directViewParam = targetDesktopId ? `&desktopId=${encodeURIComponent(targetDesktopId)}` : '';
    const launchUrl = data.directViewUrl || `/desktop-view?accId=${accId}&token=${encodeURIComponent(token)}${directViewParam}`;

    // 智能设备检测：手机/移动端 (屏幕宽度 <= 768 或触屏移动设备)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;

    if (isMobile) {
      // 移动端：直接全屏沉浸式在新标签页/全屏视图打开，充分利用手机全部横向像素！
      const mobileWin = window.open(launchUrl, '_blank');
      if (mobileWin) {
        showToast(`📱 正在全屏打开【${data.desktopName}】操作界面！建议将手机横屏使用以获得最佳体验。`, "success");
      } else {
        window.location.href = launchUrl;
      }
    } else {
      // 桌面端：居中独立无边框弹窗
      const winWidth = Math.min(window.screen.availWidth || 1920, 1920);
      const winHeight = Math.min(window.screen.availHeight || 1080, 1080);
      const left = Math.max(0, Math.round((window.screen.availWidth - winWidth) / 2));
      const top = Math.max(0, Math.round((window.screen.availHeight - winHeight) / 2));
      const windowFeatures = `width=${winWidth},height=${winHeight},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes`;

      const popup = window.open(launchUrl, `ctyun_desktop_${accId}_${targetDesktopId || 'main'}`, windowFeatures);

      if (popup) {
        popup.focus();
        showToast(`已为您直达打开【${data.desktopName}】云电脑操作界面！已自动完成免密鉴权。`, "success");
      } else {
        showToast("弹窗被浏览器拦截，请在地址栏右侧允许本站点弹出窗口！", "warning");
        window.open(launchUrl, '_blank');
      }
    }
  } catch (e) {
    showToast("访问请求异常: " + e.message, "error");
  }
}

// 6. 手动触发任务与一键全量任务同步
async function syncAccountTasks(accId) {
  const acc = accounts.find(a => a.id === accId);
  if (!acc) return;

  const f = acc.features || {};
  showToast(`正在为【${acc.name || acc.user}】执行已开启项任务即时同步...`, "info");
  
  const tasksToRun = [];
  if (f.autoSign !== false) tasksToRun.push({ type: 'sign', name: '登录打卡' });
  if (f.aiChat !== false) tasksToRun.push({ type: 'aiChat', name: 'AI对话' });
  if (f.cloudHang !== false) tasksToRun.push({ type: 'hang', name: '挂机守护' });
  if (f.autoRedeem) tasksToRun.push({ type: 'redeem', name: '兑换检查' });

  if (tasksToRun.length === 0) {
    showToast(`【${acc.name || acc.user}】未开启任何自动化任务选项，无需同步。`, "warning");
    return;
  }

  try {
    for (const t of tasksToRun) {
      await authFetch(`/api/accounts/${accId}/run/${t.type}`, { method: "POST" });
    }

    showToast(`🎉【${acc.name || acc.user}】已开启任务（${tasksToRun.map(t=>t.name).join('/')}）已即时完成同步！`, "success");
    setTimeout(() => loadAccounts(true), 1200);
  } catch (e) {
    showToast("任务同步异常: " + e.message, "error");
  }
}

async function triggerTask(accId, taskType) {
  const acc = accounts.find(a => a.id === accId);
  const taskNames = { sign: "签到打卡", aiChat: "AI智能对话", hang: "云电脑挂机", redeem: "自动兑换检查" };
  const name = taskNames[taskType] || taskType;

  showToast(`正在向天翼云下发 [${acc?.name}] 的${name}指令并同步真实进度...`, "info");
  try {
    const res = await authFetch(`/api/accounts/${accId}/run/${taskType}`, { method: "POST" });
    const data = await res.json();
    if (res.ok) {
      showToast(data.message || `[${name}] 执行成功，官方状态已刷新！`, "success");
      setTimeout(() => loadAccounts(true), 1500);
    } else {
      showToast("触发失败: " + (data.error || "未知异常"), "error");
    }
  } catch (e) {
    showToast("网络异常: " + e.message, "error");
  }
}

// 7. 重启保活守护
async function restartKeeper() {
  if (!confirm("确定要平滑重置所有云电脑保活守护通道吗？")) return;
  showToast("正在重置保活通道...", "info");
  try {
    await authFetch("/api/keeper/restart", { method: "POST" });
    showToast("指令已发送，保活长连接已重新建立", "success");
  } catch (e) {
    showToast("发送指令失败", "error");
  }
}

// 8. 全局系统与平台调度设置 (仅管理员)
async function openSettingsModal() {
  try {
    const res = await authFetch("/api/settings");
    if (!res.ok) {
      if (res.status === 403) {
        showToast("权限不足：仅管理员可访问全局系统设置", "error");
        return;
      }
      showToast("获取系统设置失败", "error");
      return;
    }
    const settings = await res.json();

    const c = settings.cron || {};
    if (document.getElementById("set-system-title")) {
      document.getElementById("set-system-title").value = settings.systemTitle || "天翼云 / 移动爱家 保活签到中心";
    }
    if (document.getElementById("set-system-subtitle")) {
      document.getElementById("set-system-subtitle").value = settings.systemSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机";
    }
    if (document.getElementById("cron-task-time")) {
      document.getElementById("cron-task-time").value = c.executeTime || "01:20";
    }
    const enableSub = c.enableSubCron === true;
    if (document.getElementById("cron-enable-sub")) {
      document.getElementById("cron-enable-sub").checked = enableSub;
    }
    if (document.getElementById("cron-sign")) document.getElementById("cron-sign").value = c.signCron || "";
    if (document.getElementById("cron-aichat")) document.getElementById("cron-aichat").value = c.aiChatCron || "";
    if (document.getElementById("cron-hang")) document.getElementById("cron-hang").value = c.cloudHangCron || "";
    if (document.getElementById("cron-redeem")) document.getElementById("cron-redeem").value = c.redeemCron || "";
    toggleSubCronInputs(enableSub);

    if (document.getElementById("set-allow-reg")) {
      document.getElementById("set-allow-reg").checked = settings.allowRegistration === true;
    }
    if (document.getElementById("set-default-quota")) {
      document.getElementById("set-default-quota").value = settings.defaultQuota || 2;
    }

    openModal("settings-modal");
  } catch (e) {
    showToast("获取设置失败: " + e.message, "error");
  }
}

function toggleSubCronInputs(enabled) {
  const container = document.getElementById("sub-cron-inputs-container");
  if (!container) return;
  const inputs = container.querySelectorAll("input");
  inputs.forEach(input => {
    input.disabled = !enabled;
    input.style.opacity = enabled ? "1" : "0.55";
    input.style.background = enabled ? "#ffffff" : "#f1f5f9";
  });
}

async function saveSettings() {
  const customTitle = document.getElementById("set-system-title") ? document.getElementById("set-system-title").value.trim() : "";
  const customSubtitle = document.getElementById("set-system-subtitle") ? document.getElementById("set-system-subtitle").value.trim() : "";
  const payload = {
    systemTitle: customTitle || "天翼云 / 移动爱家 保活签到中心",
    systemSubtitle: customSubtitle || "多账号长连接保活守护 · 多运营商支持 · 每日签到打卡 · 智能挂机",
    keepAliveSeconds: 60,
    pulseIntervalSeconds: 30,
    allowRegistration: document.getElementById("set-allow-reg") ? document.getElementById("set-allow-reg").checked : false,
    defaultQuota: document.getElementById("set-default-quota") ? parseInt(document.getElementById("set-default-quota").value) || 2 : 2,
    cron: {
      executeTime: document.getElementById("cron-task-time") ? document.getElementById("cron-task-time").value.trim() : "01:20",
      enableSubCron: document.getElementById("cron-enable-sub") ? document.getElementById("cron-enable-sub").checked : false,
      signCron: document.getElementById("cron-sign") ? document.getElementById("cron-sign").value.trim() : "",
      aiChatCron: document.getElementById("cron-aichat") ? document.getElementById("cron-aichat").value.trim() : "",
      cloudHangCron: document.getElementById("cron-hang") ? document.getElementById("cron-hang").value.trim() : "",
      redeemCron: document.getElementById("cron-redeem") ? document.getElementById("cron-redeem").value.trim() : ""
    }
  };

  try {
    const res = await authFetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      showToast("全局系统设置已成功更新！调度已即时热重载", "success");
      closeModal("settings-modal");
      if (payload.systemTitle) {
        const titleEl = document.getElementById("main-system-title");
        if (titleEl) titleEl.innerText = payload.systemTitle;
        document.title = `${payload.systemTitle} - 多账号保活控制台`;
      }
      if (payload.systemSubtitle) {
        const subtitleEl = document.querySelector(".title-group p");
        if (subtitleEl) subtitleEl.innerText = payload.systemSubtitle;
      }
    } else {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 8.5 个人消息通知推送设置 (所有用户通用)
async function openUserNotifyModal() {
  try {
    const res = await authFetch("/api/user/notify");
    if (!res.ok) {
      showToast("获取个人通知设置失败", "error");
      return;
    }
    const notify = await res.json();

    if (document.getElementById("user-notify-enabled")) {
      document.getElementById("user-notify-enabled").checked = !!notify.enabled;
    }
    if (document.getElementById("user-notify-channel")) {
      document.getElementById("user-notify-channel").value = notify.channel || "webhook";
    }
    if (document.getElementById("user-notify-token")) {
      document.getElementById("user-notify-token").value = notify.webhookUrl || "";
    }
    if (document.getElementById("user-notify-secret")) {
      document.getElementById("user-notify-secret").value = notify.secret || "";
    }
    if (document.getElementById("user-notify-title-tpl")) {
      document.getElementById("user-notify-title-tpl").value = notify.customTitleTemplate || "";
    }
    if (document.getElementById("user-notify-content-tpl")) {
      document.getElementById("user-notify-content-tpl").value = notify.customContentTemplate || "";
    }
    onUserNotifyChannelChange(false);
    openModal("user-notify-modal");
  } catch (e) {
    showToast("获取个人通知设置失败: " + e.message, "error");
  }
}

function onUserNotifyChannelChange(isUserSwitch = true) {
  const channelEl = document.getElementById("user-notify-channel");
  const label = document.getElementById("user-notify-token-label");
  const input = document.getElementById("user-notify-token");
  const secretGroup = document.getElementById("group-user-notify-secret");
  const secretInput = document.getElementById("user-notify-secret");
  const secretHint = document.getElementById("user-notify-secret-hint");
  if (!channelEl || !label || !input) return;

  const channel = channelEl.value;
  const currentVal = input.value.trim();

  // 控制加签密钥输入框的显隐
  if (secretGroup) {
    if (channel === "dingtalk" || channel === "feishu") {
      secretGroup.classList.remove("hidden");
      if (channel === "dingtalk") {
        document.getElementById("user-notify-secret-label").innerText = "钉钉机器人加签密钥 (Secret / 选填)";
        secretInput && (secretInput.placeholder = "例如 SECxxxxxxxx (如未开启加签请留空)");
        secretHint && (secretHint.innerText = "若机器人在钉钉中开启了【加签】安全设置，请填写以 SEC 开头的密钥；若仅使用关键词请留空。");
      } else {
        document.getElementById("user-notify-secret-label").innerText = "飞书机器人签名密钥 (Secret / 选填)";
        secretInput && (secretInput.placeholder = "例如 vQoxxxxxxxxx (如未开启签名校验请留空)");
        secretHint && (secretHint.innerText = "若飞书机器人在安全设置中开启了【签名校验】，请在此填写密钥；如未开启请留空。");
      }
    } else {
      secretGroup.classList.add("hidden");
    }
  }

  // 若用户主动在下拉列表中切换通道类型，且当前输入框中残留了其他通道的特征链接，自动清空避免跨渠道残留
  if (isUserSwitch && currentVal) {
    const isOtherChannelUrl = 
      (channel !== "feishu" && currentVal.includes("open.feishu.cn")) ||
      (channel !== "qywx" && currentVal.includes("qyapi.weixin.qq.com")) ||
      (channel !== "dingtalk" && currentVal.includes("oapi.dingtalk.com")) ||
      (channel !== "bark" && currentVal.includes("api.day.app")) ||
      (channel !== "pushplus" && currentVal.includes("pushplus.plus")) ||
      (channel !== "serverchan" && currentVal.includes("ftqq.com")) ||
      (channel !== "telegram" && currentVal.includes("api.telegram.org"));
    if (isOtherChannelUrl) {
      input.value = "";
      if (secretInput) secretInput.value = "";
    }
  }

  if (channel === "qywx") {
    label.innerText = "企业微信机器人 Webhook 地址";
    input.placeholder = "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxx";
  } else if (channel === "dingtalk") {
    label.innerText = "钉钉机器人 Webhook 地址 (或仅输入 Token)";
    input.placeholder = "https://oapi.dingtalk.com/robot/send?access_token=xxxx";
  } else if (channel === "feishu") {
    label.innerText = "飞书机器人 Webhook 地址";
    input.placeholder = "https://open.feishu.cn/open-apis/bot/v2/hook/xxxx";
  } else if (channel === "serverchan") {
    label.innerText = "Server酱 SendKey";
    input.placeholder = "请输入 SendKey (SCTxxxx)";
  } else if (channel === "pushplus") {
    label.innerText = "PushPlus Token";
    input.placeholder = "请输入 PushPlus Token";
  } else if (channel === "bark") {
    label.innerText = "Bark 推送完整 URL";
    input.placeholder = "例如 https://api.day.app/你的Key";
  } else if (channel === "telegram") {
    label.innerText = "TG BotToken (格式: token@chatId)";
    input.placeholder = "BotToken@ChatId";
  } else {
    label.innerText = "自定义 Webhook URL";
    input.placeholder = "https://example.com/webhook";
  }
}

async function testUserNotify() {
  const channel = document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook";
  const webhookUrl = document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "";
  const secret = document.getElementById("user-notify-secret") ? document.getElementById("user-notify-secret").value.trim() : "";
  const customTitleTemplate = document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "";
  const customContentTemplate = document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : "";

  if (!webhookUrl) {
    showToast("请先输入推送地址或 Token", "error");
    return;
  }

  showToast("正在发送测试推送...", "info");
  try {
    const res = await authFetch("/api/user/notify/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ channel, webhookUrl, secret, customTitleTemplate, customContentTemplate })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("🎉 推送成功！已向您的专属通道发送测试卡片", "success");
    } else {
      showToast(`推送失败: ${data.message || '网络无法连通或已被系统安全拦截'}`, "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function saveUserNotify() {
  const payload = {
    enabled: document.getElementById("user-notify-enabled") ? document.getElementById("user-notify-enabled").checked : false,
    channel: document.getElementById("user-notify-channel") ? document.getElementById("user-notify-channel").value : "webhook",
    webhookUrl: document.getElementById("user-notify-token") ? document.getElementById("user-notify-token").value.trim() : "",
    secret: document.getElementById("user-notify-secret") ? document.getElementById("user-notify-secret").value.trim() : "",
    customTitleTemplate: document.getElementById("user-notify-title-tpl") ? document.getElementById("user-notify-title-tpl").value.trim() : "",
    customContentTemplate: document.getElementById("user-notify-content-tpl") ? document.getElementById("user-notify-content-tpl").value.trim() : ""
  };

  try {
    const res = await authFetch("/api/user/notify", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("个人通知设置已成功保存！", "success");
      closeModal("user-notify-modal");
    } else {
      showToast(data.error || "保存失败", "error");
    }
  } catch (e) {
    showToast("网络请求异常: " + e.message, "error");
  }
}

// 9. 实时控制台日志与分类过滤 (三维绝对隔离：平台筛选 + 业务事件)
function switchPlatformFilter(platform) {
  activePlatformFilter = platform;
  const pAll = document.getElementById('tab-platform-all');
  const pCt = document.getElementById('tab-platform-ctyun');
  const pYd = document.getElementById('tab-platform-ydpc');
  const pEc = document.getElementById('tab-platform-ecloud');
  if (pAll) pAll.className = platform === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pCt) pCt.className = platform === 'ctyun' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pYd) pYd.className = platform === 'ydpc' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (pEc) pEc.className = platform === 'ecloud' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

function switchLogFilter(filterType) {
  activeLogFilter = filterType;
  const tTasks = document.getElementById('tab-tasks');
  const tHeart = document.getElementById('tab-heartbeat');
  const tAll = document.getElementById('tab-all');
  if (tTasks) tTasks.className = filterType === 'tasks' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tHeart) tHeart.className = filterType === 'heartbeat' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  if (tAll) tAll.className = filterType === 'all' ? 'btn btn-sm btn-primary' : 'btn btn-sm';
  renderFilteredLogs();
}

// 统一日志可见性判定引擎 (双维过滤：平台隔离 + 业务类型)
function shouldDisplayLogItem(item) {
  if (!item) return false;

  // 1. 平台维度绝对隔离（三平台各自成流：天翼云 / 移动爱家 / 移动公众）
  const isSystemOrAuth = item.source === 'System' || item.source === 'Auth' || item.source === 'Admin' || item.source === 'Notify';
  if (!isSystemOrAuth) {
    if (activePlatformFilter === 'ctyun' && item.platform !== 'ctyun') return false;
    if (activePlatformFilter === 'ydpc' && item.platform !== 'ydpc') return false;
    if (activePlatformFilter === 'ecloud' && item.platform !== 'ecloud') return false;
  }

  // 2. 业务事件维度过滤 (心跳/长连保活 vs 业务任务)
  //    【2026-09-23】CAGRAW（数据面保活）与 MQTT（官方长连链路）同属心跳保活类，
  //    此前漏配导致它们被误归入「任务」分类。
  //    【2026-09-24】ECLOUD（移动公众协议侧车）同属保活类；日志源独立于 SOHO/CAG，互不混流。
  const isHeartbeat = item.source === 'Heartbeat' || item.source === 'CAG' || item.source === 'CAGRAW'
    || item.source === 'KeepAlive' || item.source === 'SOHO' || item.source === 'MQTT'
    || item.source === 'ECLOUD';
  if (activeLogFilter === 'heartbeat' && !isHeartbeat) return false;
  if (activeLogFilter === 'tasks' && isHeartbeat) return false;
  return true;
}

/**
 * 日志行的稳定身份键：优先用服务端 id；无 id 时退化为"来源+平台+账号+文本"。
 * 折叠更新会保持 id 不变，所以同一件事的新旧快照拿到的是**同一个键**。
 */
function logLineKey(item) {
  if (!item) return '';
  if (item.id) return 'id:' + item.id;
  return 'k:' + (item.source || '') + '|' + (item.platform || '') + '|' + (item.accountName || '') + '|' + (item.message || '');
}

/**
 * 内存日志数组的**幂等插入**：同一身份键只保留一条，就地替换为最新快照并排到末尾。
 *
 * 【为什么必须幂等 · 用户 2026-09-25 第六轮】
 * 服务端每次 SSE 连接都会重发最近 80 条历史。旧逻辑里这些历史走"无条件 push + appendChild"，
 * 于是每重连一次，同一件事就多出一行，且各自带着**当时那一刻**的 xN 快照
 * （用户看到 x3353 / x3354 / x3355 … 连续递增地铺了一屏，就是这么来的）。
 * 改为按身份键就地更新后，重发多少次都只有一行，且始终显示最新计数。
 */
function upsertLogList(list, item) {
  const key = logLineKey(item);
  const idx = list.findIndex(l => logLineKey(l) === key);
  if (idx !== -1) {
    list[idx] = item;
    if (idx !== list.length - 1) {
      list.splice(idx, 1);
      list.push(item);
    }
    return 'updated';
  }
  list.push(item);
  return 'inserted';
}

function logLineInnerHtml(item) {
  const repeatBadge = (item.repeatCount && item.repeatCount > 1)
    ? `<span class="badge-repeat">x${item.repeatCount}</span>`
    : '';
  return `<span class="log-time">[${item.timestamp}]</span><span class="log-source">[${item.source}]</span><span class="log-text">${escapeHtml(item.message)}</span>${repeatBadge}`;
}

function createLogLineElement(item) {
  const line = document.createElement("div");
  line.className = `log-line log-level-${item.level || 'info'}`;
  if (item.id) line.dataset.logId = item.id;
  line.dataset.logKey = logLineKey(item);
  line.innerHTML = logLineInnerHtml(item);
  return line;
}

/** 渲染行数上限：与内存数组 3000 上限同源，避免长期运行后 DOM 无界增长 */
const MAX_RENDERED_LOG_LINES = 2000;

/**
 * 把一条日志（新增 或 折叠更新）**幂等**地落到 DOM 上。
 * 新增与更新走同一条路径 —— 这是"重连重发历史导致整屏翻倍"的根治点。
 */
function upsertLogLine(logBox, item) {
  if (!logBox) return;
  const key = logLineKey(item);
  const existing = renderedLogLines.get(key);

  if (!shouldDisplayLogItem(item)) {
    // 不符合当前平台/类型过滤：已渲染的要从 DOM 移除，避免切过滤后留下幽灵行
    if (existing) {
      existing.remove();
      renderedLogLines.delete(key);
    }
    return;
  }

  if (existing && existing.isConnected) {
    existing.className = `log-line log-level-${item.level || 'info'}`;
    existing.innerHTML = logLineInnerHtml(item);
    existing.classList.remove('log-flash');
    void existing.offsetWidth;
    existing.classList.add('log-flash');
    // appendChild 对已存在的节点是"移动"而非"复制"，保证最新一行始终在末尾
    logBox.appendChild(existing);
    return;
  }

  const emptyEl = logBox.querySelector('.log-line');
  if (emptyEl && emptyEl.innerText.includes('[暂无此类日志]')) emptyEl.remove();
  const line = createLogLineElement(item);
  logBox.appendChild(line);
  renderedLogLines.set(key, line);

  while (renderedLogLines.size > MAX_RENDERED_LOG_LINES) {
    const oldest = logBox.firstElementChild;
    if (!oldest) break;
    const oldestKey = oldest.dataset.logKey;
    if (oldestKey) renderedLogLines.delete(oldestKey);
    oldest.remove();
  }
}

function renderFilteredLogs() {
  const logBox = document.getElementById("log-content");
  if (!logBox) return;
  logBox.innerHTML = "";
  // 整表重建 ⇒ 注册表必须同步清空重建，否则会残留指向已销毁节点的引用
  renderedLogLines.clear();

  const filtered = allReceivedLogs.filter(shouldDisplayLogItem);

  if (filtered.length === 0) {
    logBox.innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[暂无此类日志]</div>`;
    return;
  }

  filtered.forEach(item => {
    const line = createLogLineElement(item);
    logBox.appendChild(line);
    renderedLogLines.set(logLineKey(item), line);
  });

  if (autoScroll) logBox.scrollTop = logBox.scrollHeight;
}

async function initLogStream() {
  const statusSpan = document.getElementById("log-status");

  // 未登录时直接不连接日志，保持静默
  if (!currentAuthToken) {
    statusSpan.innerText = "未登录";
    statusSpan.className = "badge badge-offline";
    return;
  }

  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // 仅通过单一的 SSE 流实时推送与初始化历史日志，彻底消除“历史请求+初始流”造成的二次重复！
  const sseUrl = `/api/logs/stream?token=${encodeURIComponent(currentAuthToken)}`;
  eventSource = new EventSource(sseUrl);

  eventSource.onopen = () => {
    statusSpan.innerText = "已连接";
    statusSpan.className = "badge badge-online";
  };

  eventSource.onmessage = (e) => {
    try {
      const item = JSON.parse(e.data);
      const logBox = document.getElementById("log-content");

      // 【2026-09-25 用户要求·第六轮】新增 与 折叠更新 走**同一条幂等路径**。
      //
      // 旧逻辑有两个致命缺口，合起来就是用户看到的"同一件事 x3353、x3354、x3355 … 铺一屏"：
      //   ① isUpdate 分支用 `l.id === item.id || 同 source+account` 在数组里找条目 ——
      //      后半句会把**同源同账号的其它条目**误当作自己，于是数组越换越乱；
      //   ② 非 isUpdate 分支（也就是服务端每次连接都会重发的最近 80 条历史）**无条件 push
      //      与 appendChild** —— 每重连一次就整批再画一遍，且每条都带着"当时那一刻"的 xN 快照。
      // 现在统一为：数组按身份键就地 upsert，DOM 也按身份键就地 upsert。
      upsertLogList(allReceivedLogs, item);
      if (allReceivedLogs.length > 3000) {
        const dropped = allReceivedLogs.shift();
        // 内存淘汰同步反映到 DOM，避免两处视图长期不一致
        const droppedKey = logLineKey(dropped);
        const droppedLine = renderedLogLines.get(droppedKey);
        if (droppedLine) {
          droppedLine.remove();
          renderedLogLines.delete(droppedKey);
        }
      }

      upsertLogLine(logBox, item);
      if (autoScroll && logBox) logBox.scrollTop = logBox.scrollHeight;
    } catch (err) {}
  };

  eventSource.onerror = (err) => {
    // 区分是未登录还是网络暂时断开
    if (!currentUser) {
      statusSpan.innerText = "未登录";
      statusSpan.style.color = "#64748b";
    } else {
      statusSpan.innerText = "心跳保持正常 (网络待命中)";
      statusSpan.style.color = "#16a34a";
    }
  };
}

async function clearLogs() {
  allReceivedLogs = [];
  renderedLogLines.clear();
  document.getElementById("log-content").innerHTML = `<div class="log-line" style="color: #64748b; padding: 12px 0; text-align: center;">[日志已彻底清空]</div>`;
  
  // 联动后端持久化清空
  try {
    const res = await authFetch('/api/logs/clear', { method: 'POST' });
    if (res.ok) {
      showToast("控制台与后台历史日志已全部一键清空", "success");
    } else {
      showToast("前端已清屏", "info");
    }
  } catch (e) {
    showToast("前端已清屏", "info");
  }
}

function toggleAutoScroll() {
  autoScroll = !autoScroll;
  document.getElementById("btn-autoscroll").innerText = `自动滚动: ${autoScroll ? '开' : '关'}`;
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast("设备码已复制到剪贴板", "success");
  }).catch(() => {
    showToast("复制失败，请手动复制", "error");
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * 【2026-09-25 用户要求】把渲染用的 HTML 片段转成能放进 title 属性的纯文本。
 *
 * 为什么不能直接塞 HTML：title 属性不解析标签，`<b>` 会原样显示成字面量。
 * 为什么还要反转义：这些片段里的用户可见文本已经过 escapeHtml（&amp;/&lt;/&quot;），
 * 再去标签后必须先还原成原字符，否则 escapeHtml 会二次转义、悬停看到 `&amp;` 这类乱码。
 * 注意 `&amp;` 必须最后还原 —— 否则 `&amp;lt;` 会被错解成 `<`。
 */
function htmlToPlainTitle(html) {
  return String(html == null ? '' : html)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

// ==========================================
// 配置备份与还原 (JSON 导入/导出)
// ==========================================
function openReleaseNotesModal() {
  if (!currentUser && !currentAuthToken) {
    showToast("请先登录账号后再查看版本更新介绍！", "warning");
    openAuthModal();
    return;
  }
  openModal("release-notes-modal");
}

function openBackupModal() {
  if (!currentAuthToken) {
    showToast("请先登录后再进行配置备份与还原", "error");
    openAuthModal();
    return;
  }
  document.getElementById("import-file-name").innerText = "未选择文件";
  document.getElementById("import-file-input").value = "";
  openModal("backup-modal");
}

async function exportConfigJson() {
  try {
    showToast("正在导出配置...", "info");
    const res = await authFetch("/api/config/export");
    if (!res.ok) throw new Error("导出失败");
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ctyun_config_backup_${new Date().toISOString().substring(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast("🎉 配置备份文件已成功下载！", "success");
  } catch (e) {
    showToast("导出失败: " + e.message, "error");
  }
}

function handleFileSelected(input) {
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  document.getElementById("import-file-name").innerText = file.name;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const json = JSON.parse(e.target.result);
      if (!json.accounts || !Array.isArray(json.accounts)) {
        showToast("文件格式错误：未找到 accounts 账号列表", "error");
        return;
      }
      const mode = document.getElementById("import-mode-select").value;
      const count = json.accounts.length;
      if (!confirm(`检测到文件中包含 ${count} 个云电脑账号，确认使用【${mode === 'merge' ? '增量合并' : '完全覆盖'}】模式导入吗？`)) {
        return;
      }

      showToast("正在解析并导入账号配置...", "info");
      const res = await authFetch("/api/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...json, mode })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || "导入成功！已自动上线长连接保活", "success");
        closeModal("backup-modal");
        await loadAccounts();
      } else {
        showToast("导入失败: " + (data.error || "未知异常"), "error");
      }
    } catch (err) {
      showToast("JSON 解析失败: " + err.message, "error");
    }
  };
  reader.readAsText(file);
}

// ==========================================
// 多用户系统与管理员配额控制
// ==========================================
function openAuthModal() {
  document.getElementById("auth-username").value = "";
  document.getElementById("auth-password").value = "";
  switchAuthMode("login");
  openModal("auth-modal");
  setTimeout(() => {
    const input = document.getElementById("auth-username");
    if (input) input.focus();
  }, 100);
}

function switchAuthMode(mode) {
  authMode = mode;
  const isLogin = mode === "login";
  document.getElementById("auth-modal-title").innerText = isLogin ? "用户登录" : "新用户注册";
  document.getElementById("btn-auth-tab-login").className = isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-tab-reg").className = !isLogin ? "btn btn-sm btn-primary" : "btn btn-sm";
  document.getElementById("btn-auth-submit").innerText = isLogin ? "立即登录" : "立即注册并登录";
  const tipEle = document.getElementById("auth-tip");
  if (tipEle) {
    tipEle.innerHTML = "";
  }
}

async function submitAuth() {
  const username = document.getElementById("auth-username").value.trim();
  const password = document.getElementById("auth-password").value.trim();

  if (!username || !password) {
    showToast("请输入用户名和密码", "error");
    return;
  }

  const endpoint = authMode === "login" ? "/api/auth/login" : "/api/auth/register";
  // 【2026-09-28】30 天免登录：勾选 ⇒ 会话落盘（服务端）+ localStorage（浏览器侧）；
  // 不勾选 ⇒ 仅 sessionStorage（关闭浏览器即失效）+ 服务端内存会话（容器重启即失效）。
  const rememberEl = document.getElementById("auth-remember");
  const remember = !!(rememberEl && rememberEl.checked);

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, remember })
    });
    const data = await res.json();

    if (res.ok && data.success) {
      currentAuthToken = data.token;
      try {
        if (remember) {
          localStorage.setItem("ctyun_auth_token", data.token);
          sessionStorage.removeItem("ctyun_auth_token");
        } else {
          sessionStorage.setItem("ctyun_auth_token", data.token);
          localStorage.removeItem("ctyun_auth_token");
        }
      } catch (e) { /* 隐私模式等存储不可用时仅内存生效 */ }
      showToast(authMode === "login" ? `欢迎回来，${data.user.username}！` : `注册成功，欢迎加入！`, "success");
      closeModal("auth-modal");
      // 立即前端就地置为已登录，彻底消除任何 DOM 刷新等待延迟！
      currentUser = data.user;
      const isAdmin = currentUser.role === "admin";
      const initial = (currentUser.username || "A")[0].toUpperCase();
      const headerAvatar = document.getElementById("header-avatar");
      const dropdownUsername = document.getElementById("dropdown-username");
      const menuAdminUsers = document.getElementById("menu-admin-users");
      const authBtn = document.getElementById("btn-auth-action");
      const loggedActionsGroup = document.getElementById("logged-actions-group");
      const statsGrid = document.getElementById("main-stats-grid");
      const sectionHeader = document.getElementById("main-section-header");
      const logPanel = document.getElementById("main-log-panel");

      if (headerAvatar) headerAvatar.innerText = initial;
      if (dropdownUsername) dropdownUsername.innerText = `${currentUser.username} (${isAdmin ? '管理员' : '普通用户'})`;
      if (menuAdminUsers) menuAdminUsers.classList.toggle("hidden", !isAdmin);
      if (authBtn) authBtn.classList.add("hidden");
      if (loggedActionsGroup) loggedActionsGroup.classList.remove("hidden");
      if (statsGrid) statsGrid.classList.remove("hidden");
      if (sectionHeader) sectionHeader.classList.remove("hidden");
      if (logPanel) logPanel.classList.remove("hidden");

      const versionBadge = document.getElementById("footer-version-badge");
      if (versionBadge) {
        versionBadge.style.color = "var(--accent)";
        versionBadge.style.cursor = "pointer";
        versionBadge.style.textDecoration = "underline";
        versionBadge.title = "点击查看版本更新说明";
        versionBadge.onclick = openReleaseNotesModal;
      }

      checkCurrentUser();
      loadAccounts();
    } else {
      showToast(data.error || "操作失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
}

function logoutUser() {
  // 【2026-09-28】退出必须**显式吊销服务端会话**：免登录会话已落盘，
  // 只清浏览器存储的话，容器重启后旧 token 依然有效（等于"退不掉"）。
  const token = currentAuthToken || localStorage.getItem("ctyun_auth_token") || sessionStorage.getItem("ctyun_auth_token") || "";
  if (token) {
    fetch("/api/auth/logout", { method: "POST", headers: { "Authorization": "Bearer " + token } }).catch(() => {});
  }
  currentAuthToken = "";
  localStorage.removeItem("ctyun_auth_token");
  sessionStorage.removeItem("ctyun_auth_token");
  currentUser = null;
  if (eventSource) {
    try { eventSource.close(); } catch (e) {}
    eventSource = null;
  }
  allReceivedLogs = [];
  renderedLogLines.clear();
  const logBox = document.getElementById("log-content");
  if (logBox) logBox.innerHTML = '<div class="log-line"><span class="log-time">[系统]</span> 未登录状态，日志已隐藏</div>';
  showToast("已安全退出登录", "info");
  checkCurrentUser();
  loadAccounts();
}

// 打开管理员用户配额管理模态框
async function openAdminUsersModal() {
  const tbody = document.getElementById("admin-users-tbody");
  tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:12px; color:var(--text-muted);">正在加载用户列表...</td></tr>`;
  openModal("admin-users-modal");

  try {
    const res = await authFetch("/api/admin/users");
    if (!res.ok) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">权限不足或获取用户列表失败</td></tr>`;
      return;
    }
    const users = await res.json();
    tbody.innerHTML = "";

    users.forEach(u => {
      const tr = document.createElement("tr");
      tr.style.borderBottom = "1px solid var(--border)";
      const isAdmin = u.role === "admin";

      tr.innerHTML = `
        <td style="padding: 10px 8px; font-weight: 600; white-space: nowrap;">${escapeHtml(u.username)}</td>
        <td style="padding: 10px 8px; white-space: nowrap;">
          <span class="badge ${isAdmin ? 'badge-online' : 'badge-offline'}">${isAdmin ? '超级管理员' : '普通用户'}</span>
        </td>
        <td style="padding: 10px 8px; font-weight: 600; color: #38bdf8; white-space: nowrap;">${u.accountsCount || 0} 台</td>
        <td style="padding: 10px 8px; white-space: nowrap;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="number" class="form-control" style="width: 70px; padding: 4px 6px; font-size: 12px;" id="quota-input-${u.id}" value="${u.maxQuota || 2}" min="0">
            <button class="btn btn-sm btn-primary" onclick="saveUserQuota('${u.id}')" style="white-space: nowrap; padding: 4px 8px;">保存配额</button>
          </div>
        </td>
        <td style="padding: 10px 8px; white-space: nowrap; text-align: right;">
          <div style="display: flex; gap: 4px; justify-content: flex-end;">
            <button class="btn btn-sm" onclick="openAdminSetPwdModal('${u.id}', '${u.username}')" style="white-space: nowrap; padding: 4px 8px;">修改密码</button>
            ${!isAdmin ? `<button class="btn btn-sm btn-danger" onclick="deleteUserAccount('${u.id}', '${u.username}')" style="white-space: nowrap; padding: 4px 8px;">删除</button>` : ''}
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--danger); padding:12px;">加载异常: ${e.message}</td></tr>`;
  }
}

async function saveUserQuota(userId) {
  const input = document.getElementById(`quota-input-${userId}`);
  const quota = parseInt(input.value) || 0;

  try {
    const res = await authFetch(`/api/admin/users/${userId}/quota`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxQuota: quota })
    });
    if (res.ok) {
      showToast(`已成功将该用户的云电脑添加配额设置为 ${quota} 台！`, "success");
      checkCurrentUser();
    } else {
      showToast("设置配额失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function deleteUserAccount(userId, username) {
  if (!confirm(`确定要删除普通用户 [${username}] 吗？`)) return;

  try {
    const res = await authFetch(`/api/admin/users/${userId}`, { method: "DELETE" });
    if (res.ok) {
      showToast("用户已删除", "success");
      openAdminUsersModal();
    } else {
      showToast("删除失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 修改个人密码/修改管理员用户名
function openChangePwdModal() {
  document.getElementById("new-user-pwd").value = "";
  document.getElementById("confirm-user-pwd").value = "";
  
  // 回显头像设置
  if (document.getElementById("custom-user-avatar")) {
    document.getElementById("custom-user-avatar").value = currentUser?.avatar || "";
  }
  updateAvatarPreview(currentUser?.avatar || (currentUser?.username || "A")[0].toUpperCase());

  const adminGroup = document.getElementById("admin-change-username-group");
  if (adminGroup) {
    const isAdmin = currentUser && currentUser.role === "admin";
    adminGroup.classList.toggle("hidden", !isAdmin);
    if (isAdmin) {
      document.getElementById("new-admin-username").value = currentUser.username || "admin";
    }
  }
  openModal("change-pwd-modal");
}

function selectPresetAvatar(emoji) {
  const input = document.getElementById("custom-user-avatar");
  if (input) input.value = emoji;
  updateAvatarPreview(emoji);
}

function updateAvatarPreview(text) {
  const preview = document.getElementById("current-avatar-preview");
  if (!preview) return;
  const val = (text || '').trim();
  preview.innerText = val ? val.slice(0, 2) : ((currentUser?.username || "A")[0].toUpperCase());
}

async function submitChangeAvatar() {
  const customAvatar = document.getElementById("custom-user-avatar") ? document.getElementById("custom-user-avatar").value.trim() : "";
  if (!customAvatar) {
    showToast("请输入或选择一个头像内容", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-avatar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ avatar: customAvatar })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (currentUser) currentUser.avatar = customAvatar;
      const headerAvatar = document.getElementById("header-avatar");
      if (headerAvatar) headerAvatar.innerText = customAvatar.slice(0, 2);
      showToast("🎉 头像个性化设置已保存！", "success");
    } else {
      showToast(data.error || "头像设置失败", "error");
    }
  } catch (e) {
    showToast("请求网络异常: " + e.message, "error");
  }
}

async function submitChangeUsername() {
  const newName = document.getElementById("new-admin-username").value.trim();
  if (!newName) {
    showToast("用户名不能为空", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-username", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newUsername: newName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`管理员用户名已成功修改为: ${newName}！`, "success");
      await checkCurrentUser();
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

async function submitChangePassword() {
  const p1 = document.getElementById("new-user-pwd").value.trim();
  const p2 = document.getElementById("confirm-user-pwd").value.trim();

  if (!p1 || p1.length < 5) {
    showToast("新密码长度不能少于5位", "error");
    return;
  }
  if (p1 !== p2) {
    showToast("两次输入的新密码不一致", "error");
    return;
  }

  try {
    const res = await authFetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword: p1 })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("密码修改成功，请牢记新密码！", "success");
      closeModal("change-pwd-modal");
    } else {
      showToast(data.error || "修改失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 管理员修改其他用户密码
function openAdminSetPwdModal(userId, username) {
  document.getElementById("admin-edit-user-id").value = userId;
  document.getElementById("admin-edit-username").value = username;
  document.getElementById("admin-set-new-pwd").value = "";
  openModal("admin-user-pwd-modal");
}

async function submitAdminUserPassword() {
  const userId = document.getElementById("admin-edit-user-id").value;
  const newPassword = document.getElementById("admin-set-new-pwd").value.trim();

  if (!newPassword || newPassword.length < 5) {
    showToast("密码长度至少5位", "error");
    return;
  }

  try {
    const res = await authFetch(`/api/admin/users/${userId}/password`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newPassword })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("指定用户密码已成功更新！", "success");
      closeModal("admin-user-pwd-modal");
    } else {
      showToast(data.error || "更新失败", "error");
    }
  } catch (e) {
    showToast("请求异常: " + e.message, "error");
  }
}

// 响应式窗口缩放防抖自动重新排版
let resizeGridTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeGridTimer);
  resizeGridTimer = setTimeout(() => {
    if (currentUser) renderAccounts();
  }, 250);
});

