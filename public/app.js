// ───────── 常量 ─────────
const LABELS = {
  preflight: "预检中",
  preflight_blocked: "预检未通过",
  running: "执行中",
  paused: "已暂停",
  completed: "已完成",
  needs_attention: "等待人工处理",
  queued: "排队",
  waiting: "等待重试",
  held: "挂起",
  succeeded: "成功",
  skipped: "跳过",
  importing: "导入中",
  failed: "失败",
  uncertain: "中断未知",
};
const ERR_KINDS = {
  auth: "认证/密钥",
  parameter: "参数错误",
  quota: "余额不足",
  rate: "触发限流",
  content: "内容审核",
  output: "输出异常",
  interrupted: "连接中断",
  transient: "上游临时故障",
  unsent: "网络未发送",
  configuration: "证书/配置",
  unknown: "未知错误",
};
const ACTION_LABELS = {
  retry: "手动重试",
  skip: "手动跳过",
  manual_refusal: "标记拒答",
  bulk_patch_retry: "批量改配并重试",
  bulk_patch_config: "批量改配",
  pause: "暂停任务",
  resume: "恢复任务",
};
const COLORS = {
  succeeded: "var(--ok)",
  skipped: "var(--idle)",
  running: "var(--run)",
  queued: "var(--border)",
  waiting: "var(--wait)",
  held: "var(--bad)",
};
const ACTIONABLE = new Set(["held", "waiting", "skipped"]);
const FILTERS = ["", "held", "waiting", "running", "queued", "succeeded", "skipped"];
const PAGE_SIZE = 100;
const SYSTEMONE_MODELS = new Set(["gemini-decision-1", "jev-1.13"]);

// ───────── 工具 ─────────
const $ = (id) => document.getElementById(id);
const label = (s) => LABELS[s] || s;
const kindLabel = (k) => ERR_KINDS[k] || k || "异常";
const fmtN = (n) => (n || 0).toLocaleString();
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : "");
const fmtCompact = (n) => {
  const v = Number(n || 0);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toLocaleString();
};
const fmtDuration = (ms) => {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
};
const tryJSON = (raw) => {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return raw; }
};
const errObj = (raw) => {
  if (!raw) return null;
  const parsed = tryJSON(raw);
  return parsed && typeof parsed === "object" ? parsed : { message: String(raw) };
};
const errMsg = (raw) => {
  const obj = errObj(raw);
  return obj ? obj.message ?? JSON.stringify(obj) : "";
};
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const money = (cost, digits = 4) =>
  Object.entries(cost || {})
    .filter(([, n]) => Number.isFinite(n))
    .map(([c, n]) => `${c} ${n.toFixed(digits)}`)
    .join(" / ") || "—";

const ago = (t) => {
  if (!t) return "—";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  if (m < 1440) return `${Math.round(m / 60)} 小时前`;
  return `${Math.round(m / 1440)} 天前`;
};

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...children.flat().filter((c) => c != null && c !== false));
  return el;
}

const badge = (s, extraCls = "") =>
  h("span", { class: `badge ${extraCls}`.trim(), dataset: { s } }, label(s));

const stackBar = (c, cls = "") => {
  const total = sum(c);
  return h(
    "div",
    { class: `stack ${cls}`.trim() },
    ...Object.keys(COLORS).map((k) =>
      h("span", {
        style: `width:${total ? ((c[k] || 0) / total) * 100 : 0}%;background:${COLORS[k]}`,
        title: `${label(k)} ${fmtN(c[k] || 0)}`,
      }),
    ),
  );
};

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok) throw Error(data.error || res.statusText);
  return data;
}
const post = (path, body = {}) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

function toast(msg, kind = "info") {
  const el = h("div", { class: `toast ${kind}` }, msg?.message || String(msg));
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 7000 : 3500);
}
const fail = (e) => toast(e, "error");
const guard = (fn) => (...a) => Promise.resolve(fn(...a)).catch(fail);

async function copyText(str, msg = "已复制到剪贴板") {
  try {
    await navigator.clipboard.writeText(str);
    toast(msg);
  } catch {
    toast("复制失败，请手动选中复制", "error");
  }
}

// ───────── 主题切换 ─────────
const THEME_MODES = [
  ["auto", "◐ 跟随系统"],
  ["light", "☀ 浅色"],
  ["dark", "☾ 深色"],
];
function getSavedTheme() {
  try { return localStorage.getItem("llm-jobs-theme") || "auto"; } catch { return "auto"; }
}
function applyTheme(mode) {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  try { localStorage.setItem("llm-jobs-theme", mode); } catch { /* ignore */ }
  const item = THEME_MODES.find(([m]) => m === mode) || THEME_MODES[0];
  $("theme-toggle").textContent = item[1];
}
applyTheme(getSavedTheme());
$("theme-toggle").onclick = () => {
  const cur = getSavedTheme();
  const next = THEME_MODES[(THEME_MODES.findIndex(([m]) => m === cur) + 1) % THEME_MODES.length][0];
  applyTheme(next);
};

// ───────── 状态 ─────────
const state = {
  view: "overview",
  jobId: null,
  summary: null,
  globalStream: null,
  jobStream: null,
  includeArchived: false,
  jobSearch: "",
  overview: {
    jobs: [],
    totals: { counts: {}, cost: {} },
    hiddenCount: 0,
    status: { controls: {}, active: 0, globalMax: 128, fatal: null },
  },
  filter: "",
  batchFilter: "",
  itemSearch: "",
  after: 0,
  cursorStack: [],
  pageNum: 1,
  rows: [],
  chosen: new Set(),
  current: null,
  overrideMessages: false,
  bulkBusy: false,
  fatal: null,
  itemsSig: "",
  sidebarSig: "",
  cfgScope: null,
};
const controls = () => state.overview.status?.controls || {};

let connected = true;
function setConnection(ok) {
  if (ok === connected) return;
  connected = ok;
  $("connection").dataset.ok = ok;
  $("connection").lastElementChild.textContent = ok ? "" : "连接中断，正在重连…";
  $("connection").title = ok ? "实时连接正常" : "";
}

function updateBanner() {
  const text = state.fatal ? `服务已停止派发：${state.fatal}` : "";
  $("banner").hidden = !text;
  $("banner").textContent = text;
}

// ───────── 路由与全局数据流 ─────────
function route() {
  const m = location.hash.match(/^#job\/(.+)$/);
  if (!m) return openOverview();
  const [rawId, qs] = m[1].split("?");
  const params = new URLSearchParams(qs || "");
  openJob(decodeURIComponent(rawId), {
    state: params.get("state") || "",
    batch: params.get("batch") || "",
  }).catch(fail);
}
window.addEventListener("hashchange", route);
$("nav-overview").onclick = () => { location.hash = ""; };

function openOverview() {
  state.view = "overview";
  state.jobId = null;
  state.jobStream?.close();
  state.jobStream = null;
  state.summary = null;
  $("overview").hidden = false;
  $("detail").hidden = true;
  renderAll();
}

function connectStream() {
  state.globalStream?.close();
  const url = state.includeArchived ? "/api/stream?all=1" : "/api/stream";
  const es = new EventSource(url);
  state.globalStream = es;
  es.onopen = () => setConnection(true);
  es.onerror = () => setConnection(false);
  es.onmessage = (e) => {
    setConnection(true);
    state.overview = JSON.parse(e.data);
    state.fatal = state.overview.status?.fatal || null;
    renderAll();
  };
}

async function reloadOverviewNow() {
  const url = state.includeArchived ? "/api/overview?all=1" : "/api/overview";
  state.overview = await api(url);
  state.fatal = state.overview.status?.fatal || null;
  renderAll();
}

function renderAll() {
  renderSidebar();
  updateBanner();
  if (state.view === "overview") renderOverview();
  else if (state.summary) renderBatchesTable(state.summary);
}

// ───────── 侧栏 ─────────
$("job-search").oninput = (e) => {
  state.jobSearch = e.target.value.trim().toLowerCase();
  renderSidebar();
};
$("toggle-archived").onclick = () => {
  state.includeArchived = !state.includeArchived;
  state.sidebarSig = "";
  connectStream();
  renderSidebar();
};

function isAttentionJob(j) {
  const c = j.counts || {};
  return (c.held || 0) + (c.waiting || 0) > 0 || !["running", "completed"].includes(j.state);
}

function renderSidebar() {
  const { jobs = [], hiddenCount = 0 } = state.overview;
  $("nav-overview").classList.toggle("selected", state.view === "overview");
  const attnCount = jobs.filter(isAttentionJob).length;
  $("nav-attention-count").hidden = attnCount === 0;
  $("nav-attention-count").textContent = String(attnCount);

  $("side-scope").textContent = state.includeArchived ? `全部 (${jobs.length})` : "近 3 天活跃";
  const toggleBtn = $("toggle-archived");
  toggleBtn.setAttribute("aria-pressed", String(state.includeArchived));
  if (state.includeArchived) {
    toggleBtn.textContent = "仅看近 3 天活跃";
    toggleBtn.disabled = false;
  } else {
    toggleBtn.textContent = `显示历史任务 (${hiddenCount})`;
    toggleBtn.disabled = hiddenCount === 0;
  }

  const q = state.jobSearch;
  const filtered = q
    ? jobs.filter(
        (j) =>
          j.name.toLowerCase().includes(q) ||
          j.id.toLowerCase().includes(q) ||
          (j.models || []).some((m) => m.toLowerCase().includes(q)),
      )
    : jobs;

  const sig = JSON.stringify([
    state.jobId,
    state.view,
    q,
    filtered.map((j) => [j.id, j.name, j.state, j.counts, j.lastActivity]),
  ]);
  $("jobs-empty").hidden = filtered.length > 0;
  $("jobs-empty").textContent = q ? "没有匹配的任务" : "暂无活跃任务";
  if (sig === state.sidebarSig) return;
  state.sidebarSig = sig;

  const listEl = $("jobs");
  const prevScroll = listEl.scrollTop;
  listEl.replaceChildren(
    ...filtered.map((j) => {
      const c = j.counts || {};
      const total = sum(c);
      const done = (c.succeeded || 0) + (c.skipped || 0);
      return h(
        "li",
        {},
        h(
          "button",
          {
            type: "button",
            class: "job" + (j.id === state.jobId && state.view === "job" ? " selected" : ""),
            onclick: () => { location.hash = `#job/${encodeURIComponent(j.id)}`; },
          },
          h("span", { class: "job-title" }, j.name),
          stackBar(c, "mini"),
          h(
            "div",
            { class: "meta" },
            h("div", { class: "row" }, badge(j.state, "sm"), c.held ? h("span", { class: "tag bad" }, `${c.held} 挂起`) : null),
            h("span", { class: "meta-counts" }, `${fmtN(done)}/${fmtN(total)} · ${ago(j.lastActivity)}`),
          ),
        ),
      );
    }),
  );
  listEl.scrollTop = prevScroll;
}

// ───────── 总览 ─────────
const kpi = (title, value, sub, cls = "", valueTitle = "") =>
  h(
    "div",
    { class: `kpi ${cls}`.trim() },
    h("span", {}, title),
    h("strong", { title: valueTitle || null }, value),
    sub && h("small", { class: "muted" }, sub),
  );

function renderOverview() {
  const { jobs = [], totals = { counts: {}, cost: {} }, hiddenCount = 0, status = {} } = state.overview;
  const c = totals.counts || {};
  const total = sum(c);
  const done = (c.succeeded || 0) + (c.skipped || 0);
  const pending = (c.held || 0) + (c.waiting || 0);
  const runningJobs = jobs.filter((j) => j.state === "running" || j.state === "preflight").length;
  const attnJobs = jobs.filter(isAttentionJob);
  const doneJobs = jobs.filter((j) => j.state === "completed").length;

  $("overview-subtitle").textContent = state.includeArchived
    ? `显示全部 ${jobs.length} 个任务`
    : `统计范围：近 3 天活跃的 ${jobs.length} 个任务${hiddenCount ? `（已自动隐藏 ${hiddenCount} 个历史任务）` : ""}`;

  const totalTokens = (totals.inputTokens || 0) + (totals.outputTokens || 0);
  $("kpis").replaceChildren(
    kpi("可见任务", fmtN(jobs.length), `${runningJobs} 执行中 · ${attnJobs.length} 需关注 · ${doneJobs} 完成`),
    kpi("整体完成度", total ? `${Math.round((done / total) * 100)}%` : "—", `${fmtN(done)} / ${fmtN(total)} 条请求`),
    kpi("在途并发", `${fmtN(status.active)} / ${fmtN(status.globalMax || 128)}`, "全局实时在途请求"),
    kpi(
      "待处理异常",
      fmtN(pending),
      `${fmtN(c.held)} 挂起 · ${fmtN(c.waiting)} 等待重试`,
      c.held ? "warn" : "",
    ),
    kpi("累计费用", money(totals.cost), `${fmtN(totals.attempts)} 次已结算尝试`),
    kpi(
      "累计 Token",
      fmtCompact(totalTokens),
      `入 ${fmtCompact(totals.inputTokens)} · 出 ${fmtCompact(totals.outputTokens)}`,
      "",
      `精确总计 ${fmtN(totalTokens)} (输入 ${fmtN(totals.inputTokens)} / 输出 ${fmtN(totals.outputTokens)})`,
    ),
  );

  $("attention-sub").textContent = attnJobs.length ? `${attnJobs.length} 个任务需要关注或处置` : "";
  $("attention").replaceChildren(
    ...(attnJobs.length
      ? attnJobs.map(attentionRow)
      : [h("p", { class: "empty-row" }, "一切正常，当前没有需要处理的异常任务")]),
  );

  const ctlEntries = Object.entries(controls());
  $("overview-controls").replaceChildren(
    ctlEntries.length
      ? controlsTable(ctlEntries.map(([key, ctl]) => ({ name: key, ctl })))
      : h("p", { class: "empty-row" }, "尚无 Provider 并发控制记录"),
  );
}

function attentionRow(j) {
  const c = j.counts || {};
  const total = sum(c);
  const done = (c.succeeded || 0) + (c.skipped || 0);
  const issueText = j.topError
    ? `[${kindLabel(j.topError.kind)}] ${j.topError.message}（${j.topError.count} 条）`
    : j.error
      ? errMsg(j.error)
      : [c.held && `${c.held} 挂起`, c.waiting && `${c.waiting} 等待重试`, c.queued && `${c.queued} 排队`]
          .filter(Boolean)
          .join(" · ");

  const canDelete = (c.running || 0) === 0 && (c.succeeded || 0) === 0;
  const canResume = ["paused", "preflight_blocked", "needs_attention"].includes(j.state);

  return h(
    "div",
    {
      class: "attn-row",
      onclick: () => { location.hash = `#job/${encodeURIComponent(j.id)}`; },
    },
    h(
      "div",
      { class: "attn-main" },
      h(
        "div",
        { class: "attn-title" },
        h("b", {}, j.name),
        badge(j.state),
        ...(j.models || []).slice(0, 3).map((m) => h("span", { class: "tag" }, m)),
        (j.models || []).length > 3 ? h("span", { class: "tag" }, `+${j.models.length - 3}`) : null,
      ),
      issueText ? h("div", { class: "attn-err", title: issueText }, issueText) : null,
    ),
    h(
      "div",
      { class: "attn-prog" },
      stackBar(c, "mini"),
      h("div", { class: "attn-prog-meta" }, h("span", {}, `${fmtN(done)} / ${fmtN(total)}`), h("span", {}, ago(j.lastActivity))),
    ),
    h(
      "div",
      { class: "attn-actions", onclick: (e) => e.stopPropagation() },
      c.held > 0 &&
        h(
          "button",
          {
            type: "button",
            class: "btn sm",
            onclick: () => { location.hash = `#job/${encodeURIComponent(j.id)}?state=held`; },
          },
          `定位挂起 (${c.held})`,
        ),
      canResume &&
        h(
          "button",
          {
            type: "button",
            class: "btn sm",
            onclick: guard(async () => {
              await post(`/api/jobs/${encodeURIComponent(j.id)}/resume`);
              toast("任务已恢复派发。");
              await reloadOverviewNow();
            }),
          },
          "恢复",
        ),
      canDelete &&
        h(
          "button",
          {
            type: "button",
            class: "btn sm danger-ghost",
            onclick: guard(async () => {
              if (!confirm(`确认删除废弃任务「${j.name}」？所有关联配置和请求记录将被永久删除。`)) return;
              await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: "DELETE" });
              toast("任务已删除。");
              await reloadOverviewNow();
            }),
          },
          "删除",
        ),
    ),
  );
}

function controlsTable(rows) {
  const now = Date.now();
  return h(
    "div",
    { class: "table-wrap" },
    h(
      "table",
      { class: "grid-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "控制范围 / 模型"),
          h("th", {}, "并发占用"),
          h("th", {}, "限流模式"),
          h("th", { class: "num" }, "派发间隔"),
          h("th", {}, "冷却与状态"),
        ),
      ),
      h(
        "tbody",
        {},
        ...rows.map(({ name, ctl }) => {
          const pct = ctl.cap ? Math.min(100, ((ctl.inFlight || 0) / ctl.cap) * 100) : 0;
          const cooling = ctl.cooldown > now;
          return h(
            "tr",
            {},
            h("td", {}, h("b", {}, name)),
            h(
              "td",
              { class: "conc" },
              h(
                "div",
                { class: "conc-cell" },
                h("div", { class: "meter" }, h("span", { style: `width:${pct}%` })),
                h("span", { class: "mono" }, `${ctl.inFlight || 0} / ${ctl.cap || "?"}`),
              ),
            ),
            h(
              "td",
              {},
              ctl.mode === "adaptive"
                ? h("span", { class: "tag ok", title: ctl.observed ? `触及 429 时在途 ${ctl.observed}` : null }, `自适应上限 ${ctl.cap}`)
                : h("span", { class: "tag" }, `探测中 (上限 ${ctl.cap || 64})`),
            ),
            h("td", { class: `num ${ctl.interval > 50 ? "cool" : ""}` }, `${ctl.interval || 0} ms`),
            h(
              "td",
              { class: cooling ? "cool" : "muted" },
              cooling ? `冷却至 ${new Date(ctl.cooldown).toLocaleTimeString()}` : "正常",
            ),
          );
        }),
      ),
    ),
  );
}

// ───────── 任务详情 ─────────
async function openJob(id, opts = {}) {
  state.view = "job";
  state.jobId = id;
  state.after = 0;
  state.cursorStack = [];
  state.pageNum = 1;
  state.filter = opts.state || "";
  state.batchFilter = opts.batch || "";
  state.itemSearch = "";
  $("item-search").value = "";
  state.itemsSig = "";
  state.chosen.clear();
  $("bulk-scope").value = "selected";
  state.jobStream?.close();
  $("overview").hidden = true;
  $("detail").hidden = false;
  $("diagnosis").hidden = true;
  $("diagnosis").replaceChildren();
  $("export").href = `/api/jobs/${encodeURIComponent(id)}/export`;
  state.summary = null;
  renderSidebar();

  const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
  state.jobStream = es;
  es.onmessage = (e) => {
    if (state.jobId !== id) return;
    renderSummary(JSON.parse(e.data));
    loadItems().catch(fail);
  };
  es.onerror = () => {
    // 尝试拉一次以获取精确错误（如 Job 已被删除）
    if (state.jobId === id && !state.summary) {
      api(`/api/jobs/${encodeURIComponent(id)}`).then(renderSummary).catch((err) => {
        fail(err);
        location.hash = "";
      });
    }
  };
}

function renderSummary(j) {
  state.summary = j;
  $("name").textContent = j.name;
  const st = $("state");
  st.textContent = label(j.state);
  st.dataset.s = j.state;
  updateBanner();

  const metaParts = [
    h("button", { type: "button", class: "copy-pill", title: "点击复制完整 Job ID", onclick: () => copyText(j.id, "已复制 Job ID") }, `ID: ${j.id.slice(0, 8)}…`),
    j.submission_key &&
      h("button", { type: "button", class: "copy-pill", title: "点击复制 submissionKey", onclick: () => copyText(j.submission_key, "已复制 submissionKey") }, `Key: ${j.submission_key}`),
    h("span", {}, `创建于 ${fmtTime(j.created)}`),
    h("span", {}, `最近活动 ${ago(j.lastActivity)}`),
  ];
  $("job-meta").replaceChildren(...metaParts.filter(Boolean));

  const c = j.counts || {};
  const total = sum(c);
  const done = (c.succeeded || 0) + (c.skipped || 0);
  $("progress-text").textContent = `${total ? Math.round((done / total) * 100) : 0}%`;
  $("progress-sub").textContent = `${fmtN(done)} / ${fmtN(total)}`;
  $("progress").replaceChildren(...stackBar(c).children);
  $("counts").replaceChildren(
    ...Object.keys(COLORS)
      .filter((k) => c[k])
      .map((k) =>
        h(
          "button",
          {
            type: "button",
            class: `legend-btn ${state.filter === k ? "active" : ""}`,
            onclick: () => setFilter(state.filter === k ? "" : k),
          },
          h("i", { style: `background:${COLORS[k]}` }),
          label(k),
          " ",
          h("b", {}, fmtN(c[k])),
        ),
      ),
  );

  $("pause").disabled = !["preflight", "running", "preflight_blocked", "needs_attention"].includes(j.state);
  $("resume").disabled = ["completed", "importing"].includes(j.state);
  $("delete-job").disabled = (c.running || 0) > 0;

  // 同步批次下拉列表
  const batches = j.batches || [];
  if (state.batchFilter && !batches.some((b) => b.batch === state.batchFilter)) {
    state.batchFilter = "";
  }
  $("batch-filter").replaceChildren(
    h("option", { value: "" }, `全部批次 (${batches.length})`),
    ...batches.map((b) => h("option", { value: b.batch }, `${b.batch} (${b.config.model})`)),
  );
  $("batch-filter").value = state.batchFilter;
  $("batch-filter").hidden = batches.length <= 1;

  renderDiagnosis(j);
  renderFilters();
  renderBatchesTable(j);
}

function renderDiagnosis(j) {
  const groups = j.errorGroups || [];
  const box = $("diagnosis");
  if (!j.error && !groups.length) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;
  const children = [
    h(
      "div",
      { class: "diag-head" },
      h("strong", {}, groups.length ? `异常诊断与快捷修复（共 ${groups.length} 类）` : "任务阻塞异常"),
      j.state === "preflight_blocked" && h("span", { class: "tag bad" }, "预检失败阻塞，修复或跳过样本后自动继续"),
    ),
  ];

  if (groups.length) {
    children.push(
      h(
        "div",
        { class: "diag-list" },
        ...groups.map((g) => {
          const batchObj = (j.batches || []).find((b) => b.batch === g.batch);
          const rawBody = g.error?.body ? tryJSON(g.error.body) : null;
          return h(
            "div",
            { class: "diag-item" },
            h(
              "div",
              { class: "diag-info" },
              h(
                "div",
                { class: "row" },
                h("span", { class: "tag" }, g.batch),
                badge(g.state, "sm"),
                h("span", { class: "tag bad" }, kindLabel(g.error?.kind)),
                g.error?.status ? h("span", { class: "tag" }, `HTTP ${g.error.status}`) : null,
                h("b", {}, `${fmtN(g.count)} 条`),
              ),
              h("div", { class: "diag-msg" }, g.error?.message || "未知错误"),
              rawBody &&
                h(
                  "details",
                  { class: "diag-body" },
                  h("summary", {}, "查看上游响应详情"),
                  h("pre", {}, typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody, null, 2)),
                ),
            ),
            h(
              "div",
              { class: "row" },
              h(
                "button",
                {
                  type: "button",
                  class: "btn sm",
                  onclick: () => {
                    state.batchFilter = g.batch;
                    $("batch-filter").value = g.batch;
                    setFilter(g.state);
                    $("items-section").scrollIntoView({ behavior: "smooth" });
                  },
                },
                "筛选查看",
              ),
              batchObj &&
                (() => {
                  const bc = batchObj.counts || {};
                  const totalPending = (bc.queued || 0) + (bc.held || 0) + (bc.waiting || 0);
                  const parts = [
                    bc.held && `${fmtN(bc.held)} 挂起`,
                    bc.waiting && `${fmtN(bc.waiting)} 等待`,
                    bc.queued && `${fmtN(bc.queued)} 排队`,
                  ]
                    .filter(Boolean)
                    .join("、");
                  return h(
                    "button",
                    {
                      type: "button",
                      class: "btn sm primary",
                      onclick: () =>
                        openConfigModal({
                          title: `修复批次「${g.batch}」配置`,
                          scopeText: `将修改批次「${g.batch}」中全部未完成请求（共 ${fmtN(totalPending)} 条：${parts}）的配置并重新预检。`,
                          config: batchObj.config,
                          scope: { batch: g.batch },
                        }),
                    },
                    "改配并重试",
                  );
                })(),
            ),
          );
        }),
      ),
    );
  } else if (j.error) {
    children.push(h("div", { class: "diag-msg" }, errMsg(j.error)));
  }
  box.replaceChildren(...children);
}

function renderFilters() {
  const c = state.summary?.counts || {};
  $("filters").replaceChildren(
    ...FILTERS.filter((f) => !f || c[f] || f === state.filter).map((f) =>
      h(
        "button",
        {
          type: "button",
          class: "tab",
          role: "tab",
          "aria-selected": String(state.filter === f),
          onclick: () => setFilter(f),
        },
        f ? label(f) : "全部",
        h("em", {}, fmtN(f ? c[f] : sum(c))),
      ),
    ),
  );
}

function configChips(cfg) {
  const chips = [];
  if (cfg.protocol) chips.push(`协议:${cfg.protocol}`);
  if (cfg.thinking !== undefined) {
    const t = typeof cfg.thinking === "string" ? cfg.thinking : cfg.thinking?.enabled === false ? "off" : `budget:${cfg.thinking?.budget || cfg.thinking?.effort || "on"}`;
    chips.push(`thinking:${t}`);
  }
  if (cfg.maxOutputTokens !== undefined) chips.push(`maxTok:${cfg.maxOutputTokens}`);
  if (cfg.temperature !== undefined) chips.push(`temp:${cfg.temperature}`);
  if (cfg.logprobs) chips.push(`logprobs${cfg.topLogprobs != null ? `:${cfg.topLogprobs}` : ""}`);
  if (cfg.questions) chips.push(`${Object.keys(cfg.questions).length}道决策题`);
  return chips.map((c) => h("span", { class: "tag" }, c));
}

function renderBatchesTable(j) {
  const batches = j.batches || [];
  const allControls = controls();
  const now = Date.now();

  if (!batches.length) {
    $("providers").replaceChildren(h("p", { class: "empty-row" }, "暂无批次配置"));
    return;
  }

  const rows = batches.map((b) => {
    const cfg = b.config || {};
    const c = b.counts || {};
    const u = b.usage || {};
    const total = sum(c);
    const done = (c.succeeded || 0) + (c.skipped || 0);
    const pendingEdit = (c.queued || 0) + (c.held || 0) + (c.waiting || 0);
    const ctlKey = cfg.provider === "opencode" ? `opencode:${cfg.model}` : cfg.provider;
    const ctl = allControls[ctlKey] || {};
    const pct = ctl.cap ? Math.min(100, ((ctl.inFlight || 0) / ctl.cap) * 100) : 0;
    const cooling = ctl.cooldown > now;

    const costIncomplete = u.attempts > 0 && u.costAttempts < u.attempts;
    const tokIncomplete = u.attempts > 0 && u.tokenAttempts < u.attempts;
    const totalTok = (u.inputTokens || 0) + (u.outputTokens || 0);

    return h(
      "tr",
      {},
      h(
        "td",
        { class: "batch-col" },
        h(
          "div",
          { class: "batch-name" },
          h("b", {}, b.batch),
          b.checked
            ? h("span", { class: "tag ok" }, "✓ 已预检")
            : h("span", { class: "tag wait" }, "⏳ 待预检"),
        ),
        h(
          "div",
          { class: "batch-chips" },
          h("span", { class: "tag" }, `${cfg.provider} · ${cfg.model}`),
          ...configChips(cfg),
        ),
      ),
      h(
        "td",
        {
          style: "min-width:150px;cursor:pointer",
          title: "点击按此批次筛选请求明细",
          onclick: () => {
            state.batchFilter = b.batch;
            $("batch-filter").value = b.batch;
            setFilter(c.held ? "held" : "");
            $("items-section").scrollIntoView({ behavior: "smooth" });
          },
        },
        stackBar(c, "mini"),
        h(
          "div",
          { class: "row", style: "justify-content:space-between;margin-top:4px;font-size:11.5px" },
          h("span", { class: "muted mono" }, `${fmtN(done)}/${fmtN(total)}`),
          c.held ? h("span", { class: "tag bad" }, `${c.held} 挂起`) : null,
        ),
      ),
      h(
        "td",
        { class: "conc" },
        h(
          "div",
          { class: "conc-cell" },
          h("div", { class: "meter" }, h("span", { style: `width:${pct}%` })),
          h("span", { class: "mono" }, `${ctl.inFlight || 0} / ${ctl.cap || "?"}`),
        ),
        h(
          "div",
          { class: cooling ? "cool" : "muted", style: "font-size:11.5px;margin-top:2px" },
          `${ctl.interval || 0} ms · ${
            cooling
              ? `冷却至 ${new Date(ctl.cooldown).toLocaleTimeString()}`
              : ctl.mode === "adaptive"
                ? "自适应"
                : "探测中"
          }`,
        ),
      ),
      h("td", { class: "num" }, fmtDuration(u.avgDurationMs)),
      h(
        "td",
        {
          class: "num",
          title: costIncomplete ? `仅 ${u.costAttempts}/${u.attempts} 次尝试返回金额` : null,
        },
        u.costAttempts ? money(u.cost) + (costIncomplete ? " *" : "") : "—",
      ),
      h(
        "td",
        {
          class: "num",
          title: tokIncomplete
            ? `仅 ${u.tokenAttempts}/${u.attempts} 次返回 Token（入 ${fmtN(u.inputTokens)} / 出 ${fmtN(u.outputTokens)}）`
            : `输入 ${fmtN(u.inputTokens)} / 输出 ${fmtN(u.outputTokens)}`,
        },
        u.tokenAttempts
          ? `${fmtCompact(u.inputTokens)} / ${fmtCompact(u.outputTokens)}${tokIncomplete ? " *" : ""}`
          : totalTok
            ? `${fmtCompact(u.inputTokens)} / ${fmtCompact(u.outputTokens)}`
            : "—",
      ),
      h(
        "td",
        { class: "num" },
        h(
          "button",
          {
            type: "button",
            class: "btn sm",
            disabled: pendingEdit === 0,
            title: pendingEdit === 0 ? "该批次无待执行或异常条目" : "修改该批次未完成请求的配置",
            onclick: () =>
              openConfigModal({
                title: `修改批次「${b.batch}」配置`,
                scopeText: `将更新批次「${b.batch}」中所有未成功/非执行中（共 ${fmtN(pendingEdit)} 条）的配置。`,
                config: cfg,
                scope: { batch: b.batch },
              }),
          },
          "修改配置",
        ),
      ),
    );
  });

  $("providers").replaceChildren(
    h(
      "div",
      { class: "table-wrap" },
      h(
        "table",
        { class: "grid-table" },
        h(
          "thead",
          {},
          h(
            "tr",
            {},
            h("th", {}, "批次 / 模型配置"),
            h("th", {}, "批次进度"),
            h("th", {}, "并发与限流"),
            h("th", { class: "num" }, "平均耗时"),
            h("th", { class: "num" }, "费用"),
            h("th", { class: "num" }, "Token (入 / 出)"),
            h("th", { class: "num" }, "操作"),
          ),
        ),
        h("tbody", {}, ...rows),
      ),
    ),
  );
}

// ───────── 请求明细 ─────────
function resetPagination() {
  state.itemsSig = "";
  state.after = 0;
  state.cursorStack = [];
  state.pageNum = 1;
  state.chosen.clear();
  $("bulk-scope").value = "selected";
}

function setFilter(f) {
  state.filter = f;
  resetPagination();
  renderFilters();
  if (state.summary) renderSummaryCountsActive();
  loadItems().catch(fail);
}

function renderSummaryCountsActive() {
  for (const btn of $("counts").querySelectorAll(".legend-btn")) {
    btn.classList.toggle("active", btn.textContent.includes(label(state.filter)) && Boolean(state.filter));
  }
}

$("batch-filter").onchange = () => {
  state.batchFilter = $("batch-filter").value;
  resetPagination();
  loadItems().catch(fail);
};

let searchTimer = null;
$("item-search").oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.itemSearch = $("item-search").value.trim();
    resetPagination();
    loadItems().catch(fail);
  }, 240);
};

async function loadItems() {
  if (!state.jobId) return;
  const { jobId, after, filter, batchFilter, itemSearch } = state;
  const qs = new URLSearchParams({ after: String(after) });
  if (filter) qs.set("state", filter);
  if (batchFilter) qs.set("batch", batchFilter);
  if (itemSearch) qs.set("q", itemSearch);

  const page = await api(`/api/jobs/${encodeURIComponent(jobId)}/items?${qs}`);
  if (
    jobId !== state.jobId ||
    after !== state.after ||
    filter !== state.filter ||
    batchFilter !== state.batchFilter ||
    itemSearch !== state.itemSearch
  )
    return;

  state.rows = page;
  $("prev").disabled = state.cursorStack.length === 0;
  $("next").disabled = page.length < PAGE_SIZE;
  $("first").disabled = state.after === 0;
  $("page-info").textContent = `第 ${state.pageNum} 页 · ${page.length} 条`;

  const sig = JSON.stringify(page);
  if (sig === state.itemsSig) {
    updateBulk();
    return;
  }
  state.itemsSig = sig;
  const eligible = new Set(page.filter((r) => ACTIONABLE.has(r.state)).map((r) => r.id));
  for (const id of state.chosen) if (!eligible.has(id)) state.chosen.delete(id);
  $("items-empty").hidden = page.length > 0;
  $("items").replaceChildren(...page.map(itemRow));
  updateBulk();
}

function itemRow(r) {
  const checkbox = h("input", {
    type: "checkbox",
    disabled: !ACTIONABLE.has(r.state),
    checked: state.chosen.has(r.id),
    "aria-label": `选择 ${r.query_id}`,
    dataset: { itemId: r.id },
    onchange: () => {
      checkbox.checked ? state.chosen.add(r.id) : state.chosen.delete(r.id);
      updateBulk();
    },
  });

  const multiBatch = (state.summary?.batches?.length || 0) > 1;
  const queryCell = h(
    "td",
    { class: "id" },
    h("div", {}, r.query_id),
    multiBatch && r.batch ? h("span", { class: "tag", style: "margin-top:3px" }, r.batch) : null,
  );

  const stateCell = h(
    "td",
    {},
    h(
      "div",
      { class: "row", style: "gap:4px" },
      badge(r.state),
      r.contentFiltered ? h("span", { class: "tag wait" }, "审核拦截") : null,
      r.manualRefusal ? h("span", { class: "tag" }, "人工拒答") : null,
    ),
  );

  const attemptCell = h(
    "td",
    { title: "限流/未发送不计入尝试次数" },
    h("div", { class: "mono" }, `${r.attempts}/3`, r.durationMs != null ? h("small", {}, ` · ${fmtDuration(r.durationMs)}`) : null),
    r.free_failures ? h("small", {}, `限流/未发 ${r.free_failures}`) : null,
  );

  const tokStr =
    r.inputTokens != null || r.outputTokens != null
      ? `${fmtN(r.inputTokens)} / ${fmtN(r.outputTokens)}`
      : null;
  const costStr = r.cost != null ? `${r.currency || ""} ${Number(r.cost).toFixed(5)}`.trim() : null;
  const usageCell = h(
    "td",
    { class: "num" },
    tokStr ? h("div", { class: "mono", style: "font-size:12px" }, tokStr) : h("span", { class: "muted" }, "—"),
    costStr ? h("small", { class: "mono" }, costStr) : null,
  );

  let previewNode;
  if (r.error) {
    const eo = errObj(r.error);
    previewNode = h(
      "div",
      {},
      h("div", { class: "preview-err" }, `[${kindLabel(eo?.kind)}] ${eo?.message || r.error}`),
      r.state === "waiting" ? h("div", { class: "preview-wait" }, `下次重试：${fmtTime(r.next)}`) : null,
    );
  } else if (r.preview) {
    previewNode = h(
      "div",
      {},
      r.hasReasoning ? h("span", { class: "tag", style: "margin-bottom:3px" }, "含思考过程") : null,
      h("div", { class: "preview-text", title: r.preview }, r.preview),
    );
  } else {
    previewNode = h("span", { class: "muted" }, "—");
  }

  return h(
    "tr",
    {},
    h("td", { class: "chk" }, checkbox),
    queryCell,
    stateCell,
    attemptCell,
    usageCell,
    h("td", { class: "preview" }, previewNode),
    h(
      "td",
      { class: "num" },
      h(
        "button",
        {
          type: "button",
          class: "btn sm",
          onclick: guard(() => openItem(r.id)),
        },
        ACTIONABLE.has(r.state) ? "处置" : "详情",
      ),
    ),
  );
}

function updateBulk() {
  const eligible = state.rows.filter((r) => ACTIONABLE.has(r.state));
  const filteredScope = ACTIONABLE.has(state.filter);
  $("bulk").hidden = !eligible.length && !state.chosen.size && !filteredScope;
  $("bulk-filtered-option").disabled = !filteredScope;
  $("bulk-filtered-option").textContent = state.batchFilter && filteredScope
    ? `批次「${state.batchFilter}」的「${label(state.filter)}」全部`
    : filteredScope
      ? `当前「${label(state.filter)}」全部（跨页）`
      : "当前筛选全部（跨页）";

  if (!filteredScope && $("bulk-scope").value === "filtered") $("bulk-scope").value = "selected";
  $("selected-count").textContent = `已选 ${state.chosen.size} 条`;

  const all = $("select-page");
  all.disabled = !eligible.length;
  all.checked = eligible.length > 0 && eligible.every((r) => state.chosen.has(r.id));
  all.indeterminate = state.chosen.size > 0 && !all.checked;

  const isFiltered = $("bulk-scope").value === "filtered";
  const hasSelection = isFiltered ? filteredScope : state.chosen.size > 0;
  // bulkAction (retry/skip) 不支持按 batch 过滤，仅在未选 batchFilter 或按 ids 时可用
  const canRetrySkip = !state.bulkBusy && hasSelection && !(isFiltered && state.batchFilter);
  const canBatchOps = !state.bulkBusy && hasSelection;

  $("bulk-retry").disabled = $("bulk-skip").disabled = !canRetrySkip;
  $("bulk-retry").title = $("bulk-skip").title =
    isFiltered && state.batchFilter ? "按批次筛选时请勾选条目，或在批次表中操作" : "";
  $("bulk-patch").disabled = $("bulk-refuse").disabled = !canBatchOps;
}

$("select-page").onchange = () => {
  for (const r of state.rows.filter((r) => ACTIONABLE.has(r.state)))
    $("select-page").checked ? state.chosen.add(r.id) : state.chosen.delete(r.id);
  for (const box of $("items").querySelectorAll("input[data-item-id]"))
    box.checked = state.chosen.has(Number(box.dataset.itemId));
  updateBulk();
};
$("bulk-scope").onchange = updateBulk;

for (const action of ["retry", "skip"]) {
  $(`bulk-${action}`).onclick = guard(async () => {
    const jobId = state.jobId;
    const filtered = $("bulk-scope").value === "filtered";
    const n = filtered ? state.summary.counts[state.filter] || 0 : state.chosen.size;
    const verb = action === "retry" ? "重试（可能再次计费）" : "跳过";
    if (!confirm(`确认批量${verb} ${n} 条请求？`)) return;
    const body = filtered ? { action, state: state.filter } : { action, ids: [...state.chosen] };
    state.bulkBusy = true;
    updateBulk();
    try {
      const result = await post(`/api/jobs/${encodeURIComponent(jobId)}/items/bulk`, body);
      if (jobId !== state.jobId) return;
      state.chosen.clear();
      toast(`已批量${action === "retry" ? "重试" : "跳过"} ${result.count} 条，保留原始尝试历史。`);
      await refreshJob();
    } finally {
      state.bulkBusy = false;
      updateBulk();
    }
  });
}

$("bulk-refuse").onclick = guard(async () => {
  const jobId = state.jobId;
  const filtered = $("bulk-scope").value === "filtered";
  const batchObj = state.batchFilter && state.summary?.batches?.find((b) => b.batch === state.batchFilter);
  const n = filtered
    ? batchObj
      ? batchObj.counts[state.filter] || 0
      : state.summary?.counts[state.filter] || 0
    : state.chosen.size;
  if (!confirm(`确认将 ${n} 条请求批量标记为拒答并算作成功？（不会重发请求，保留原始历史）`)) return;
  const body = filtered
    ? { action: "refuse", state: state.filter, ...(state.batchFilter ? { batch: state.batchFilter } : {}) }
    : { action: "refuse", ids: [...state.chosen] };
  state.bulkBusy = true;
  updateBulk();
  try {
    const result = await post(`/api/jobs/${encodeURIComponent(jobId)}/batch-ops`, body);
    if (jobId !== state.jobId) return;
    state.chosen.clear();
    toast(`已批量标记拒答 ${result.count} 条。`);
    await refreshJob();
  } finally {
    state.bulkBusy = false;
    updateBulk();
  }
});

$("bulk-patch").onclick = guard(async () => {
  const filtered = $("bulk-scope").value === "filtered";
  const batches = state.summary?.batches || [];
  let initialConfig = batches[0]?.config || {};
  let scope;
  let scopeText;

  if (filtered) {
    const bObj = state.batchFilter ? batches.find((b) => b.batch === state.batchFilter) : null;
    if (bObj) initialConfig = bObj.config;
    const count = bObj ? bObj.counts[state.filter] || 0 : state.summary?.counts[state.filter] || 0;
    scope = { state: state.filter, ...(state.batchFilter ? { batch: state.batchFilter } : {}) };
    scopeText = state.batchFilter
      ? `将修改批次「${state.batchFilter}」中状态为「${label(state.filter)}」的 ${fmtN(count)} 条请求配置。`
      : `将修改当前「${label(state.filter)}」全部 ${fmtN(count)} 条请求的配置。`;
  } else {
    const ids = [...state.chosen];
    const firstRow = state.rows.find((r) => r.id === ids[0]);
    const matchedBatch = firstRow && batches.find((b) => b.batch === firstRow.batch);
    if (matchedBatch) initialConfig = matchedBatch.config;
    const multi = new Set(ids.map((id) => state.rows.find((r) => r.id === id)?.batch).filter(Boolean)).size > 1;
    scope = { ids };
    scopeText = `将修改已勾选的 ${ids.length} 条请求配置${multi ? "（提示：所选条目跨越多个批次，提交后将统一应用此配置）" : ""}。`;
  }

  openConfigModal({
    title: "批量修改配置",
    scopeText,
    config: initialConfig,
    scope,
  });
});

$("first").onclick = () => {
  resetPagination();
  loadItems().catch(fail);
};
$("prev").onclick = () => {
  if (!state.cursorStack.length) return;
  state.chosen.clear();
  state.itemsSig = "";
  state.after = state.cursorStack.pop();
  state.pageNum = Math.max(1, state.pageNum - 1);
  loadItems().catch(fail);
};
$("next").onclick = () => {
  if (state.rows.length < PAGE_SIZE) return;
  state.chosen.clear();
  state.itemsSig = "";
  state.cursorStack.push(state.after);
  state.after = state.rows.at(-1).id;
  state.pageNum++;
  loadItems().catch(fail);
};

async function refreshJob() {
  if (!state.jobId) return;
  state.itemsSig = "";
  renderSummary(await api(`/api/jobs/${encodeURIComponent(state.jobId)}`));
  await loadItems();
}

// ───────── 快捷配置联动器（单条 & 批量共用） ─────────
function bindConfigEditor({ jsonEl, modelEl, thinkingEl, maxEl, tempEl, presetContainer }) {
  const isSystemOneCfg = (cfg) =>
    cfg?.provider === "opencode" && (cfg?.protocol === "systemone" || SYSTEMONE_MODELS.has(cfg?.model));

  function syncToInputs() {
    let cfg;
    try { cfg = JSON.parse(jsonEl.value); } catch { return; }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) return;
    const sysOne = isSystemOneCfg(cfg);
    thinkingEl.disabled = sysOne;
    maxEl.disabled = sysOne;
    tempEl.disabled = sysOne;
    for (const btn of presetContainer.querySelectorAll("button")) btn.disabled = sysOne;

    modelEl.value = cfg.model ?? "";
    if (cfg.thinking === undefined) thinkingEl.value = "__default__";
    else if (typeof cfg.thinking === "string" && [...thinkingEl.options].some((o) => o.value === cfg.thinking))
      thinkingEl.value = cfg.thinking;
    else thinkingEl.value = "__custom__";

    maxEl.value = cfg.maxOutputTokens ?? "";
    tempEl.value = cfg.temperature ?? "";
  }

  function applyPatch(updater) {
    let cfg;
    try { cfg = JSON.parse(jsonEl.value); } catch {
      toast("当前配置 JSON 格式有误，请先修正 JSON", "error");
      return;
    }
    updater(cfg);
    jsonEl.value = JSON.stringify(cfg, null, 2);
    syncToInputs();
  }

  modelEl.oninput = () => applyPatch((c) => { c.model = modelEl.value.trim(); });
  thinkingEl.onchange = () =>
    applyPatch((c) => {
      if (thinkingEl.value === "__default__") delete c.thinking;
      else if (thinkingEl.value !== "__custom__") c.thinking = thinkingEl.value;
    });
  maxEl.oninput = () =>
    applyPatch((c) => {
      if (maxEl.value === "") delete c.maxOutputTokens;
      else c.maxOutputTokens = Number(maxEl.value);
    });
  tempEl.oninput = () =>
    applyPatch((c) => {
      if (tempEl.value === "") delete c.temperature;
      else c.temperature = Number(tempEl.value);
    });
  presetContainer.onclick = (e) => {
    const btn = e.target.closest("button[data-val]");
    if (!btn || btn.disabled) return;
    const val = Number(btn.dataset.val);
    maxEl.value = String(val);
    applyPatch((c) => { c.maxOutputTokens = val; });
  };
  jsonEl.oninput = syncToInputs;

  return { syncToInputs };
}

const itemEditor = bindConfigEditor({
  jsonEl: $("config"),
  modelEl: $("item-cfg-model"),
  thinkingEl: $("item-cfg-thinking"),
  maxEl: $("item-cfg-max"),
  tempEl: $("item-cfg-temp"),
  presetContainer: document.querySelector('.preset-row[data-target="item"]'),
});

const batchEditor = bindConfigEditor({
  jsonEl: $("cfg-json"),
  modelEl: $("batch-cfg-model"),
  thinkingEl: $("batch-cfg-thinking"),
  maxEl: $("batch-cfg-max"),
  tempEl: $("batch-cfg-temp"),
  presetContainer: document.querySelector('.preset-row[data-target="batch"]'),
});

// ───────── 单条详情与处置 ─────────
function renderDecisionTable(decision) {
  const answers = decision?.answers;
  if (!answers || typeof answers !== "object") return null;
  const rows = Object.entries(answers).map(([qid, ans]) => {
    const probs = Object.entries(ans.probabilities || {}).sort((a, b) => b[1] - a[1]);
    return h(
      "tr",
      {},
      h("td", { class: "mono" }, qid),
      h("td", {}, h("span", { class: "badge", dataset: { s: "completed" } }, ans.choice || "—")),
      h("td", { class: "num mono" }, ans.confidence != null ? `${(ans.confidence * 100).toFixed(1)}%` : "—"),
      h(
        "td",
        {},
        h(
          "div",
          { class: "prob-bar-wrap" },
          ...probs.map(([opt, p]) =>
            h(
              "span",
              { class: `prob-pill ${opt === ans.choice ? "picked" : ""}` },
              opt,
              h("b", {}, `${(p * 100).toFixed(1)}%`),
            ),
          ),
        ),
      ),
    );
  });

  return h(
    "div",
    { class: "decision-table" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, h("th", {}, "题目 ID"), h("th", {}, "选择"), h("th", { class: "num" }, "置信度"), h("th", {}, "选项概率分布"))),
      h("tbody", {}, ...rows),
    ),
  );
}

function renderLogprobs(logprobs) {
  const content = logprobs?.content;
  if (!Array.isArray(content) || !content.length) return null;
  return h(
    "details",
    {},
    h("summary", {}, `Token 对数概率可视化（共 ${content.length} tokens）`),
    h(
      "div",
      { class: "logprobs-flow" },
      ...content.map((entry) => {
        const prob = Math.exp(entry.logprob ?? 0);
        const pct = (prob * 100).toFixed(1);
        const hueColor = prob >= 0.8 ? "var(--ok)" : prob >= 0.4 ? "var(--wait)" : "var(--bad)";
        const alpha = Math.round((1 - Math.min(0.95, prob)) * 28 + 6);
        const topList = (entry.top_logprobs || [])
          .slice(0, 5)
          .map((t) => `${JSON.stringify(t.token)}: ${(Math.exp(t.logprob) * 100).toFixed(1)}% (${t.logprob.toFixed(3)})`)
          .join("\n");
        const tip = `Token: ${JSON.stringify(entry.token)}\n概率: ${pct}% (logprob ${Number(entry.logprob).toFixed(4)})${topList ? `\n\nTop 候选:\n${topList}` : ""}`;
        return h(
          "span",
          {
            class: "lp-tok",
            style: `background:color-mix(in srgb, ${hueColor} ${alpha}%, transparent)`,
            title: tip,
          },
          entry.token === "\n" ? "↵\n" : entry.token,
        );
      }),
    ),
  );
}

function renderOutcome(item) {
  const nodes = [];
  const err = errObj(item.error);
  if (err) {
    const bodyDecoded = err.body ? tryJSON(err.body) : null;
    nodes.push(
      h(
        "div",
        { class: "outcome-box err" },
        h(
          "div",
          { class: "outcome-head" },
          h(
            "div",
            { class: "row" },
            h("span", { class: "tag bad" }, kindLabel(err.kind)),
            err.status ? h("span", { class: "tag" }, `HTTP ${err.status}`) : null,
            err.code ? h("span", { class: "tag mono" }, err.code) : null,
          ),
          item.state === "waiting" && item.next ? h("small", {}, `下次重试：${fmtTime(item.next)}`) : null,
        ),
        h("div", { class: "diag-msg" }, err.message || JSON.stringify(err)),
        bodyDecoded &&
          h(
            "details",
            {},
            h("summary", {}, "展开上游完整错误体"),
            h("pre", {}, typeof bodyDecoded === "string" ? bodyDecoded : JSON.stringify(bodyDecoded, null, 2)),
          ),
      ),
    );
  }

  // 检查最近失败尝试是否有已生成的截断部分输出
  const lastPartialAttempt = [...(item.attemptHistory || [])]
    .reverse()
    .map((a) => ({ a, p: tryJSON(a.partial) }))
    .find(({ p }) => p && (p.text || p.reasoning));

  if (!item.result && lastPartialAttempt) {
    const { text, reasoning } = lastPartialAttempt.p;
    nodes.push(
      h(
        "div",
        { class: "outcome-box warn" },
        h(
          "div",
          { class: "outcome-head" },
          h("b", {}, "失败前已生成的部分输出"),
          h("button", { type: "button", class: "btn sm", onclick: () => copyText(text || reasoning) }, "复制部分输出"),
        ),
        reasoning &&
          h(
            "details",
            {},
            h("summary", {}, `截断前思考过程（${reasoning.length} 字符）`),
            h("pre", { class: "output-pre" }, reasoning),
          ),
        text && h("pre", { class: "output-pre" }, text),
      ),
    );
  }

  if (item.result) {
    const res = tryJSON(item.result) || {};
    const usage = res.usage || {};
    nodes.push(
      h(
        "div",
        { class: "outcome-box" },
        h(
          "div",
          { class: "outcome-head" },
          h(
            "div",
            { class: "row" },
            h("b", {}, "执行结果"),
            res.finishReason ? h("span", { class: "tag" }, `finish: ${res.finishReason}`) : null,
            res.contentFiltered ? h("span", { class: "tag wait" }, "内容审核拦截") : null,
            res.manualRefusal ? h("span", { class: "tag" }, "人工标记拒答") : null,
            usage.inputTokens != null || usage.outputTokens != null
              ? h("span", { class: "tag mono" }, `入 ${fmtN(usage.inputTokens)} / 出 ${fmtN(usage.outputTokens)}`)
              : null,
            res.cost != null ? h("span", { class: "tag mono" }, `${res.currency || ""} ${Number(res.cost).toFixed(6)}`.trim()) : null,
            res.requestId ? h("span", { class: "tag mono", title: "Request ID" }, res.requestId) : null,
          ),
          h("button", { type: "button", class: "btn sm", onclick: () => copyText(res.partial || JSON.stringify(res, null, 2)) }, "复制输出"),
        ),
        res.contentFiltered && res.contentFilter
          ? h("div", { class: "tag wait" }, `拦截原因：${res.contentFilter.message || res.contentFilter.reason || JSON.stringify(res.contentFilter)}`)
          : null,
        res.manualRefusal && res.manualRefusalReason
          ? h("div", { class: "muted", style: "font-size:12px" }, `人工标记拒答：${res.manualRefusalReason.reason || ""}`)
          : null,
        renderDecisionTable(res.decision),
        res.reasoning &&
          h(
            "details",
            {},
            h("summary", {}, `思考过程（${res.reasoning.length} 字符）`),
            h("pre", { class: "output-pre" }, res.reasoning),
          ),
        res.partial !== undefined && res.partial !== ""
          ? h("pre", { class: "output-pre" }, res.partial)
          : !res.decision && h("p", { class: "muted", style: "margin:0" }, "无文本输出"),
        renderLogprobs(res.logprobs),
      ),
    );
  }

  $("modal-outcome").replaceChildren(...nodes);
}

function renderInputSection(input) {
  state.overrideMessages = false;
  if (Array.isArray(input.messages)) {
    $("messages-view").hidden = false;
    $("messages-override-bar").hidden = false;
    $("prompt-wrap").hidden = true;
    $("prompt").value = "";
    $("format-prompt").hidden = true;
    $("toggle-prompt-override").textContent = "替换为纯 Prompt 覆盖重发";

    const cards = input.messages.map((m, idx) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content, null, 2);
      return h(
        "div",
        { class: "msg-card" },
        h(
          "div",
          { class: "msg-head" },
          h("div", { class: "row" }, h("span", { class: "tag" }, `#${idx + 1} · ${m.role}`), h("span", {}, `${fmtN(content.length)} 字符`)),
          h("button", { type: "button", class: "btn ghost sm", onclick: () => copyText(content) }, "复制"),
        ),
        h("pre", { class: "msg-content" }, content),
      );
    });
    if (input.metadata) {
      cards.push(
        h("details", {}, h("summary", {}, "Metadata"), h("pre", {}, JSON.stringify(input.metadata, null, 2))),
      );
    }
    $("messages-view").replaceChildren(...cards);
  } else {
    $("messages-view").hidden = true;
    $("messages-override-bar").hidden = true;
    $("prompt-wrap").hidden = false;
    $("prompt-label").textContent = "Prompt";
    $("prompt").value = input.prompt ?? "";
    const parsedPrompt = tryJSON($("prompt").value);
    $("format-prompt").hidden = !(parsedPrompt && typeof parsedPrompt === "object");
  }
}

$("toggle-prompt-override").onclick = () => {
  state.overrideMessages = !state.overrideMessages;
  $("prompt-wrap").hidden = !state.overrideMessages;
  $("prompt-label").textContent = "替换会话的新 Prompt（留空则保留原 messages）";
  $("toggle-prompt-override").textContent = state.overrideMessages ? "取消替换（保留原 messages）" : "替换为纯 Prompt 覆盖重发";
  if (state.overrideMessages) $("prompt").focus();
};

$("format-prompt").onclick = () => {
  const parsed = tryJSON($("prompt").value);
  if (parsed && typeof parsed === "object") $("prompt").value = JSON.stringify(parsed, null, 2);
};

function renderTimeline(item) {
  const entries = [];
  for (const a of item.attemptHistory || []) {
    const usage = tryJSON(a.usage);
    const err = errObj(a.error);
    const partial = tryJSON(a.partial);
    const meta = [
      `${fmtTime(a.started)}${a.ended ? ` · 耗时 ${fmtDuration(a.ended - a.started)}` : ""}`,
      usage && (usage.inputTokens != null || usage.outputTokens != null)
        ? `入 ${fmtN(usage.inputTokens)} / 出 ${fmtN(usage.outputTokens)}`
        : null,
      a.cost != null ? `${a.currency || ""} ${Number(a.cost).toFixed(5)}`.trim() : null,
      a.request_id ? `req:${a.request_id}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    entries.push({
      time: a.started,
      node: h(
        "li",
        { dataset: { ok: a.state === "succeeded" ? "true" : err ? "false" : "" } },
        h(
          "div",
          { class: "row" },
          badge(a.state, "sm"),
          a.counted ? null : h("span", { class: "tag" }, "不计入重试次数"),
        ),
        h("div", { class: "when" }, meta),
        err ? h("div", { class: "preview-err" }, `[${kindLabel(err.kind)}] ${err.message || JSON.stringify(err)}`) : null,
        partial?.text &&
          h("details", {}, h("summary", {}, `部分输出 (${partial.text.length} 字符)`), h("pre", {}, partial.text)),
      ),
    });
  }
  for (const act of item.actions || []) {
    const detail = tryJSON(act.detail);
    entries.push({
      time: act.time,
      node: h(
        "li",
        {},
        h("div", { class: "row" }, h("span", { class: "tag" }, ACTION_LABELS[act.action] || act.action)),
        h("div", { class: "when" }, fmtTime(act.time)),
        detail && typeof detail === "object" && Object.keys(detail).length
          ? h("small", { class: "muted mono" }, JSON.stringify(detail))
          : null,
      ),
    });
  }
  entries.sort((a, b) => a.time - b.time);
  $("attempts").replaceChildren(
    ...(entries.length ? entries.map((e) => e.node) : [h("li", { class: "muted" }, "暂无尝试或操作记录")]),
  );
}

async function openItem(id) {
  const item = await api(`/api/items/${id}`);
  state.current = item;
  const input = JSON.parse(item.input);

  $("modal-title").replaceChildren(
    h("span", { class: "mono" }, item.query_id),
    item.batch ? h("span", { class: "tag" }, item.batch) : null,
    badge(item.state),
    h("button", { type: "button", class: "copy-pill", onclick: () => copyText(item.query_id, "已复制 Query ID") }, "复制 ID"),
  );

  const idx = state.rows.findIndex((r) => r.id === id);
  $("prev-item").disabled = idx <= 0;
  $("next-item").disabled = idx < 0 || idx >= state.rows.length - 1;

  renderOutcome(item);
  renderInputSection(input);

  $("config").value = JSON.stringify(item.configBody, null, 2);
  itemEditor.syncToInputs();

  const editable = ACTIONABLE.has(item.state);
  for (const b of ["retry", "skip", "refuse"]) $(b).disabled = !editable;

  renderTimeline(item);

  const decodedRaw = {
    ...item,
    input: tryJSON(item.input),
    error: tryJSON(item.error),
    result: tryJSON(item.result),
    attemptHistory: (item.attemptHistory || []).map((a) => ({
      ...a,
      error: tryJSON(a.error),
      usage: tryJSON(a.usage),
      partial: tryJSON(a.partial),
    })),
    actions: (item.actions || []).map((act) => ({
      ...act,
      detail: tryJSON(act.detail),
    })),
  };
  $("history").textContent = JSON.stringify(decodedRaw, null, 2);

  if (!$("modal").open) $("modal").showModal();
}

$("prev-item").onclick = guard(async () => {
  const idx = state.rows.findIndex((r) => r.id === state.current?.id);
  if (idx > 0) await openItem(state.rows[idx - 1].id);
});
$("next-item").onclick = guard(async () => {
  const idx = state.rows.findIndex((r) => r.id === state.current?.id);
  if (idx >= 0 && idx < state.rows.length - 1) await openItem(state.rows[idx + 1].id);
});
$("modal").addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
  if (e.key === "ArrowLeft" && !$("prev-item").disabled) $("prev-item").click();
  if (e.key === "ArrowRight" && !$("next-item").disabled) $("next-item").click();
});

$("retry").onclick = guard(async () => {
  const item = state.current;
  const input = JSON.parse(item.input);
  const patch = {};
  const config = JSON.parse($("config").value);
  if (JSON.stringify(config) !== JSON.stringify(item.configBody)) patch.config = config;
  if (Array.isArray(input.messages)) {
    if (state.overrideMessages && $("prompt").value !== "") patch.prompt = $("prompt").value;
  } else if ($("prompt").value !== (input.prompt ?? "")) {
    patch.prompt = $("prompt").value;
  }
  await post(`/api/items/${item.id}`, { action: "retry", patch });
  $("modal").close();
  toast("已排队重试，保留之前的尝试历史。");
  await refreshJob();
});

$("skip").onclick = guard(async () => {
  await post(`/api/items/${state.current.id}`, { action: "skip" });
  $("modal").close();
  toast("已跳过该条目。");
  await refreshJob();
});

$("refuse").onclick = guard(async () => {
  await post(`/api/items/${state.current.id}`, { action: "refuse" });
  $("modal").close();
  toast("已标记为拒答并算作成功，保留原始尝试历史，未重新发送请求。");
  await refreshJob();
});

$("close").onclick = () => $("modal").close();
$("modal").addEventListener("click", (e) => { if (e.target === $("modal")) $("modal").close(); });

// ───────── 批次 / 批量改配弹窗 ─────────
function openConfigModal({ title, scopeText, config, scope }) {
  state.cfgScope = scope;
  $("cfg-modal-title").textContent = title;
  $("cfg-scope-banner").textContent = scopeText;
  $("cfg-json").value = JSON.stringify(config, null, 2);
  $("cfg-retry").checked = true;
  batchEditor.syncToInputs();
  $("config-modal").showModal();
}

$("cfg-submit").onclick = guard(async () => {
  const jobId = state.jobId;
  const config = JSON.parse($("cfg-json").value);
  const retry = $("cfg-retry").checked;
  const result = await post(`/api/jobs/${encodeURIComponent(jobId)}/batch-ops`, {
    action: "patch_config",
    config,
    retry,
    ...state.cfgScope,
  });
  $("config-modal").close();
  if (jobId === state.jobId) {
    state.chosen.clear();
    toast(`已更新 ${result.count} 条请求配置${retry ? "并重新排队" : ""}。`);
    await refreshJob();
  }
});
$("cfg-cancel").onclick = () => $("config-modal").close();
$("cfg-close").onclick = () => $("config-modal").close();
$("config-modal").addEventListener("click", (e) => { if (e.target === $("config-modal")) $("config-modal").close(); });

// ───────── 任务操作 ─────────
for (const action of ["pause", "resume"])
  $(action).onclick = guard(async () => {
    await post(`/api/jobs/${encodeURIComponent(state.jobId)}/${action}`);
    toast(action === "resume" ? "任务已恢复，已解除相关模型/平台冷却和本任务等待。" : "任务已暂停。");
    await refreshJob();
  });

$("delete-job").onclick = guard(async () => {
  const j = state.summary;
  if (!j) return;
  if (!confirm(`确认永久删除任务「${j.name}」及其所有配置、请求和历史尝试？此操作不可撤销。`)) return;
  await api(`/api/jobs/${encodeURIComponent(j.id)}`, { method: "DELETE" });
  toast("任务已删除。");
  location.hash = "";
  await reloadOverviewNow();
});

connectStream();
route();
