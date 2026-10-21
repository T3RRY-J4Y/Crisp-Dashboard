const state = {
  password: localStorage.getItem("crisp_dash_password") || "",
  conversations: [],
  range: null,
  statusFilter: "all",
  sortKey: "updated_at",
  sortDir: "desc",
  page: 1,
  pageSize: 25,
  loading: false,
  imported: null,
};

const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="ico" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// ---------- Theme ----------
// Chart colours are read from the CSS custom properties so light/dark stay
// in sync with the stylesheet; charts are re-rendered when the theme flips.
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function palette() {
  return {
    resolved: cssVar("--resolved"),
    pending: cssVar("--pending"),
    unresolved: cssVar("--unresolved"),
    ink: cssVar("--ink-3"),
    grid: cssVar("--grid"),
    surface: cssVar("--surface"),
    tooltip: cssVar("--tooltip"),
  };
}

function isDark() {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function syncThemeButton() {
  $("themeToggle").setAttribute("aria-label", isDark() ? "Switch to light theme" : "Switch to dark theme");
}

function toggleTheme() {
  const next = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("crisp_dash_theme", next);
  } catch {}
  syncThemeButton();
  renderCharts();
}
$("themeToggle").addEventListener("click", toggleTheme);
$("loginThemeToggle").addEventListener("click", toggleTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (!document.documentElement.dataset.theme) {
    syncThemeButton();
    renderCharts();
  }
});
syncThemeButton();

if (window.Chart) {
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.font.size = 12;
}

function tooltipOptions(p) {
  return {
    backgroundColor: p.tooltip,
    padding: 10,
    cornerRadius: 8,
    titleFont: { weight: "600" },
    boxPadding: 4,
    usePointStyle: true,
  };
}

// ---------- API ----------
function apiHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.password) h["x-app-password"] = state.password;
  return h;
}

async function api(pathAndQuery) {
  const res = await fetch(pathAndQuery, { headers: apiHeaders() });
  if (res.status === 401) {
    showLogin(true);
    throw new Error("unauthorized");
  }
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(json.reason || "Request failed");
  return json;
}

// ---------- Streaming scan with progress ----------
// /api/scan streams one JSON object per line: {type:"progress",...} while
// pages are still loading, then a final {type:"done",...} with the result.
async function scanWithProgress(pathAndQuery, onProgress, init = {}) {
  const res = await fetch(pathAndQuery, { headers: apiHeaders(), ...init });
  if (res.status === 401) {
    showLogin(true);
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error("Request failed");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result = null;

  const handleLine = (line) => {
    if (!line.trim()) return;
    const msg = JSON.parse(line);
    if (msg.type === "progress") onProgress(msg);
    else if (msg.type === "done") result = msg;
    else if (msg.type === "error") throw new Error(msg.reason || "Request failed");
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
    }
  }
  if (buffer.trim()) handleLine(buffer);

  if (!result) throw new Error("No data received");
  return result;
}

// Crisp's API doesn't expose a total conversation count up front, so we
// can't compute an exact percentage. This maps pages-fetched-so-far onto
// a curve that climbs quickly at first and eases toward a 92% ceiling -
// staying visibly short of "done" no matter how many pages a scan turns
// out to need, until the final response actually arrives and we jump to 100%.
// Tuned around the ~400-page (20,000-conversation) safety cap so the bar
// keeps climbing meaningfully across a full large scan instead of flattening
// out in the first few dozen pages.
function progressFromPageCount(page) {
  return 92 * (1 - Math.exp(-page / 100));
}

function showProgress() {
  $("progressWrap").classList.remove("hidden");
  setProgress(0);
}
function hideProgress() {
  $("progressWrap").classList.add("hidden");
}
function setProgress(pct) {
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  $("progressFill").style.width = pct + "%";
  $("progressPct").textContent = pct + "%";
  $("progressBar").setAttribute("aria-valuenow", pct);
}

function setNote(text, isError) {
  $("fetchNote").textContent = text;
  $("fetchNote").classList.toggle("error", !!isError);
}

function setButtonLoading(btn, loading) {
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading;
}

let toastTimer = null;
function toast(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2200);
}

// ---------- Login ----------
function showLogin(errored) {
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginError").classList.toggle("hidden", !errored);
  $("loginPassword").setAttribute("aria-invalid", errored ? "true" : "false");
  if (errored) {
    const form = $("loginForm");
    form.classList.remove("shake");
    void form.offsetWidth; // restart the animation on repeated failures
    form.classList.add("shake");
    $("loginPassword").select();
  }
  setTimeout(() => $("loginPassword").focus(), 0);
}
function showApp() {
  $("loginScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
}

async function tryLogin(password) {
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const json = await res.json();
  if (json.ok) {
    state.password = password;
    localStorage.setItem("crisp_dash_password", password);
    showApp();
    return true;
  }
  return false;
}

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginBtn");
  setButtonLoading(btn, true);
  try {
    const ok = await tryLogin($("loginPassword").value.trim());
    if (!ok) {
      showLogin(true);
    } else {
      $("loginPassword").value = "";
      $("loginPassword").type = "password";
      $("pwToggle").setAttribute("aria-pressed", "false");
      showEmptyState();
    }
  } catch {
    showLogin(true);
  } finally {
    setButtonLoading(btn, false);
  }
});

$("pwToggle").addEventListener("click", () => {
  const input = $("loginPassword");
  const show = input.type === "password";
  input.type = show ? "text" : "password";
  $("pwToggle").setAttribute("aria-pressed", show);
  $("pwToggle").setAttribute("aria-label", show ? "Hide password" : "Show password");
  input.focus();
});

["keydown", "keyup"].forEach((evt) =>
  $("loginPassword").addEventListener(evt, (e) => {
    if (e.getModifierState) $("capsHint").classList.toggle("hidden", !e.getModifierState("CapsLock"));
  })
);
$("loginPassword").addEventListener("input", () => {
  if ($("loginPassword").getAttribute("aria-invalid") === "true") {
    $("loginPassword").setAttribute("aria-invalid", "false");
    $("loginError").classList.add("hidden");
  }
});

$("logoutBtn").addEventListener("click", () => {
  state.password = "";
  localStorage.removeItem("crisp_dash_password");
  closeModal();
  showLogin(false);
});

// Attempt silent login with any stored password on load; if that fails
// (or none stored) fall back to the login screen. If the server has no
// password configured, /api/login always returns ok.
(async function init() {
  const ok = await tryLogin(state.password).catch(() => false);

  if (!ok) {
    showLogin(false);
  }
  showEmptyState();
})();

// ---------- Default view: nothing loaded until a date range is fetched ----------
// We deliberately don't auto-fetch conversations on load (or on reset) -
// scanning is expensive and the user should choose a date range first.
// Looking up a specific session by ID (below) bypasses this entirely, since
// it hits Crisp directly for that one conversation.
function showEmptyState() {
  state.conversations = [];
  state.range = null;
  state.page = 1;
  renderStats([]);
  renderTable();
  renderCharts();
  $("exportBtn").disabled = true;
  $("rangeSummary").textContent = "Choose a date range to load conversations.";
  if (typeof resetInsights === "function") resetInsights();
  setNote("");
}

// ---------- Formatting ----------
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function fmtDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}
function fmtRelative(ts) {
  if (!ts) return "";
  const diff = (Date.now() - ts) / 1000;
  if (diff < 45) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), "hour");
  if (diff < 86400 * 30) return rtf.format(-Math.round(diff / 86400), "day");
  return fmtDay(ts);
}
function fmtNum(n) {
  return (n || 0).toLocaleString();
}
function pct(n, total) {
  return total ? Math.round((n / total) * 100) : 0;
}

function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Stable per-name colour so the same visitor gets the same avatar everywhere.
const AVATAR_COLORS = ["#127582", "#0F6699", "#143840", "#178CCC", "#17A3AB", "#8A6B1F", "#0E795B", "#5B4B8A"];
function avatarFor(name) {
  const clean = (name || "").trim();
  const initials = clean
    ? clean
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0])
        .join("")
        .toUpperCase()
    : "?";
  let h = 0;
  for (const ch of clean) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { initials, color: AVATAR_COLORS[h % AVATAR_COLORS.length] };
}
function avatarHtml(name, cls = "") {
  const a = avatarFor(name);
  return `<span class="avatar ${cls}" style="--av:${a.color}" aria-hidden="true">${escapeHtml(a.initials)}</span>`;
}

// ---------- Profile helpers ----------
// Each conversation carries a server-cleaned `profile` (see extractProfile in
// server.js): null means the bot never captured that answer, "Skipped" means
// the visitor chose Skip.
const AGE_ORDER = ["Below 13", "13-17", "14-24", "18-24", "25-30", "31-37", "38-44", "45-49", "50+"];
const GENDER_SERIES = [
  { key: "Female", color: "--cat-1" },
  { key: "Male", color: "--cat-2" },
  { key: "Other", color: "--cat-3" },
  { key: null, label: "Not given", color: "--cat-none" },
];
// Colour follows the channel everywhere it appears.
const CHANNEL_SERIES = [
  { key: "WhatsApp", color: "--cat-1" },
  { key: "Messenger", color: "--cat-2" },
  { key: "Instagram", color: "--cat-3" },
  { key: "Web chat", color: "--cat-4" },
];
const PROVINCE_ORDER = [
  "Gauteng", "KwaZulu-Natal", "Western Cape", "Eastern Cape", "Limpopo",
  "Mpumalanga", "North West", "Free State", "Northern Cape", "Outside SA",
];

const prof = (c) => c.profile || {};
const answered = (v) => v && v !== "Skipped";

function countBy(conversations, getter) {
  const counts = new Map();
  let skipped = 0;
  let missing = 0;
  for (const c of conversations) {
    const v = getter(c);
    if (v === "Skipped") skipped += 1;
    else if (!v) missing += 1;
    else counts.set(v, (counts.get(v) || 0) + 1);
  }
  const answeredTotal = [...counts.values()].reduce((a, b) => a + b, 0);
  return { counts, skipped, missing, answeredTotal };
}

function coverageText(r, total, noun = "answered") {
  if (!total) return null;
  const parts = [`${fmtNum(r.answeredTotal)} of ${fmtNum(total)} ${noun}`];
  if (r.skipped) parts.push(`${fmtNum(r.skipped)} skipped`);
  return parts.join(" · ");
}

// ---------- Daily series ----------
function dayKey(ts) {
  return isoDate(new Date(ts));
}

// Every day in the fetched range gets a slot, so quiet days show as zero
// instead of silently disappearing from the axis.
function rangeDays(conversations) {
  const days = new Set();
  if (state.range) {
    const d = new Date(state.range.start + "T00:00:00");
    const end = new Date(state.range.end + "T00:00:00");
    while (d <= end && days.size < 400) {
      days.add(isoDate(d));
      d.setDate(d.getDate() + 1);
    }
  }
  for (const c of conversations) if (c.created_at) days.add(dayKey(c.created_at));
  return [...days].sort();
}

function dailyCounts(conversations, days, test) {
  const byDay = new Map(days.map((k) => [k, 0]));
  for (const c of conversations) {
    if (!c.created_at || !test(c)) continue;
    const k = dayKey(c.created_at);
    byDay.set(k, (byDay.get(k) || 0) + 1);
  }
  return days.map((k) => byDay.get(k) || 0);
}

function dayLabels(days) {
  return days.map((k) => new Date(k + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }));
}

// An imported CSV may simply not have a column; say so instead of showing 0.
function notInFile(...fields) {
  return !!(state.imported && fields.some((f) => !state.imported.fields.includes(f)));
}
const NOT_IN_FILE = "Not in this file";

// ---------- KPIs ----------
function sparkline(values) {
  if (values.length < 2) return "";
  const w = 96;
  const h = 36;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - (v / max) * (h - 6)]);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
    <path class="area" d="${line}L${w},${h}L0,${h}Z"/><path class="line" d="${line}"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="3"/></svg>`;
}

function renderStats(conversations) {
  const total = conversations.length;
  const days = total ? rangeDays(conversations) : [];
  const isConsent = (c) => prof(c).consent;
  const isComplete = (c) => {
    const p = prof(c);
    return answered(p.age) && answered(p.gender) && answered(p.province);
  };
  const isAd = (c) => prof(c).source === "Ad";
  const whatsapp = conversations.filter((c) => prof(c).channel === "WhatsApp").length;

  const card = (cls, label, iconName, test, base, foot, needs = []) => {
    if (notInFile(...needs)) {
      return `
    <article class="card stat ${cls}">
      <div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon">${icon(iconName)}</span></div>
      <div class="stat-body"><div class="stat-num" style="color:var(--ink-3)">–</div></div>
      <div class="stat-foot"><span>${NOT_IN_FILE}</span></div>
    </article>`;
    }
    const num = conversations.filter(test).length;
    return `
    <article class="card stat ${cls}">
      <div class="stat-top">
        <span class="stat-label">${label}</span>
        <span class="stat-icon">${icon(iconName)}</span>
      </div>
      <div class="stat-body">
        <div class="stat-num">${fmtNum(num)}</div>
        ${sparkline(dailyCounts(conversations, days, test))}
      </div>
      <div class="stat-foot">
        ${base === null ? "" : `<span class="stat-pct">${base ? pct(num, base) + "%" : "–"}</span>`}<span>${foot}</span>
      </div>
    </article>`;
  };
  $("statsRow").innerHTML =
    card("total", "Total conversations", "chat", () => true, null, total ? "per day across the range" : "no range loaded") +
    card("consent", "POPIA consent given", "check", isConsent, total, "of all conversations", ["consent"]) +
    card("profile", "Full profile captured", "grid", isComplete, total, "age, gender and province", ["age", "gender", "province"]) +
    card("ads", "Came from ads", "arrow-right", isAd, whatsapp, "of WhatsApp conversations", ["source", "channel"]);
}

// ---------- HTML charts ----------
// Breakdowns are drawn as HTML so every label and value is real,
// selectable text (identity is never colour-only, works with screen readers).
function emptyBlock(text) {
  return `<div class="barlist-empty">${text}</div>`;
}

function renderBarList(elId, rows, opts = {}) {
  const el = $(elId);
  if (!rows.length || rows.every((r) => !r.value)) {
    el.innerHTML = emptyBlock(opts.emptyText || "No data loaded yet");
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const base = opts.base || rows.reduce((a, r) => a + r.value, 0);
  el.innerHTML = `<ul class="barlist">${rows
    .map(
      (r) => `<li title="${escapeHtml(r.label)}: ${fmtNum(r.value)} (${pct(r.value, base)}%)">
        <span class="bl-label">${escapeHtml(r.label)}</span>
        <span class="bl-track"><i style="width:${(r.value / max) * 100}%;background:var(${r.color || "--cat-1"})"></i></span>
        <span class="bl-val">${fmtNum(r.value)}<small>${pct(r.value, base)}%</small></span>
      </li>`
    )
    .join("")}</ul>`;
}

// One 100% bar split into parts, with the headline numbers underneath.
function renderSplit(elId, parts, emptyText) {
  const el = $(elId);
  const sum = parts.reduce((a, p) => a + p.value, 0);
  if (!sum) {
    el.innerHTML = emptyBlock(emptyText);
    return;
  }
  el.innerHTML = `
    <div class="split-bar" role="img" aria-label="${parts.map((p) => `${p.label} ${pct(p.value, sum)}%`).join(", ")}">
      ${parts.filter((p) => p.value).map((p) => `<i style="flex-grow:${p.value};background:var(${p.color})" title="${escapeHtml(p.label)}: ${fmtNum(p.value)}"></i>`).join("")}
    </div>
    <div class="split-keys">
      ${parts
        .map(
          (p) => `<div class="split-key"><div class="k"><i style="background:var(${p.color})"></i>${escapeHtml(p.label)}</div>
          <div class="v">${pct(p.value, sum)}%<small>${fmtNum(p.value)}</small></div></div>`
        )
        .join("")}
    </div>`;
}

function renderFunnel(elId, steps, total) {
  const el = $(elId);
  if (!total) {
    el.innerHTML = emptyBlock("No data loaded yet");
    return;
  }
  el.innerHTML = steps
    .map((s, i) => {
      const prev = i ? steps[i - 1].value : null;
      // Steps aren't strictly nested (the bot doesn't always ask in order), so
      // only show a step-to-step rate when it's a genuine drop-off.
      const drop =
        i === 0
          ? ""
          : `<div class="f-drop">${prev && s.value <= prev ? `${icon("chevron-right")}${pct(s.value, prev)}% continued` : ""}</div>`;
      return `${drop}<div class="f-step">
        <div class="f-row"><span class="l">${s.label}</span><span class="v">${fmtNum(s.value)}<small>${pct(s.value, total)}%</small></span></div>
        <div class="f-bar"><i style="width:${Math.max((s.value / total) * 100, 1)}%;background:var(--ord-${steps.length - i})"></i></div>
      </div>`;
    })
    .join("");
}

function renderLollipop(elId, rows, emptyText) {
  const el = $(elId);
  if (!rows.length) {
    el.innerHTML = emptyBlock(emptyText);
    return;
  }
  const max = Math.max(...rows.map((r) => r.value), 1);
  const base = rows.reduce((a, r) => a + r.value, 0);
  el.innerHTML =
    rows
      .map((r) => {
        const x = (r.value / max) * 100;
        return `<span class="lp-label" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>
        <span class="lp-track" title="${escapeHtml(r.label)}: ${fmtNum(r.value)}"><span class="lp-stem" style="width:${x}%"></span><span class="lp-dot" style="left:${x}%"></span></span>
        <span class="lp-val">${fmtNum(r.value)}<small>${pct(r.value, base)}%</small></span>`;
      })
      .join("") + `<div class="lp-axis"><span>0</span><span>${fmtNum(max)}</span></div>`;
}

function setSub(id, text, fallback) {
  $(id).textContent = text || fallback;
}

// ---------- Canvas charts ----------
const charts = {};

function toggleChartEmpty(canvasId, isEmpty) {
  $(canvasId).classList.toggle("hidden", isEmpty);
  $(canvasId + "Empty").classList.toggle("hidden", !isEmpty);
}

function legendHtml(series) {
  return series.map((s) => `<span><i class="dot" style="background:var(${s.color})"></i>${escapeHtml(s.label || s.key)}</span>`).join("");
}

function renderVolumeChart(conversations) {
  if (charts.volume) charts.volume.destroy();
  // Imported files may have no channel column: show one total series then.
  const byChannel = !conversations.length || conversations.some((c) => prof(c).channel);
  const seriesDefs = byChannel ? CHANNEL_SERIES : [{ key: "All conversations", color: "--cat-1" }];
  const inSeries = (c, s) => !byChannel || (prof(c).channel || "Web chat") === s.key;
  $("volumeLegend").innerHTML = legendHtml(seriesDefs);
  $("volumeSub").textContent = byChannel ? "New conversations per day, stacked by channel" : "New conversations per day";
  toggleChartEmpty("volumeChart", !conversations.length);
  if (!conversations.length) return;

  const p = palette();
  const days = rangeDays(conversations);
  charts.volume = new Chart($("volumeChart").getContext("2d"), {
    type: "line",
    data: {
      labels: dayLabels(days),
      datasets: seriesDefs.map((s, i) => {
        const color = cssVar(s.color);
        return {
          label: s.key,
          data: dailyCounts(conversations, days, (c) => inSeries(c, s)),
          borderColor: color,
          backgroundColor: color + "40",
          fill: i === 0 ? "origin" : "-1",
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: color,
          pointHoverBorderColor: p.surface,
          pointHoverBorderWidth: 2,
          tension: 0.3,
          cubicInterpolationMode: "monotone",
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(p), callbacks: { footer: (items) => `Total: ${fmtNum(items.reduce((a, i) => a + i.raw, 0))}` } },
      },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: p.ink, maxRotation: 0, autoSkipPadding: 16 } },
        y: { stacked: true, beginAtZero: true, border: { display: false }, ticks: { precision: 0, color: p.ink, padding: 8 }, grid: { color: p.grid } },
      },
    },
  });
}

function renderDonut(key, canvasId, prefix, parts, total, centerLabel) {
  if (charts[key]) charts[key].destroy();
  const sum = parts.reduce((a, x) => a + x.value, 0);
  toggleChartEmpty(canvasId, !sum);
  $(prefix + "Center").classList.toggle("hidden", !sum);
  $(prefix + "Legend").innerHTML = sum
    ? parts
        .map((x) => `<li><span class="dot" style="background:var(${x.color})"></span>${escapeHtml(x.label)}<span class="v">${fmtNum(x.value)}</span><span class="p">${pct(x.value, sum)}%</span></li>`)
        .join("")
    : "";
  if (!sum) return;
  $(prefix + "Total").textContent = fmtNum(total);

  const p = palette();
  charts[key] = new Chart($(canvasId).getContext("2d"), {
    type: "doughnut",
    data: {
      labels: parts.map((x) => x.label),
      datasets: [
        {
          data: parts.map((x) => x.value),
          backgroundColor: parts.map((x) => cssVar(x.color)),
          borderColor: p.surface,
          borderWidth: 2,
          hoverOffset: 4,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "74%",
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(p), callbacks: { label: (ctx) => ` ${ctx.label}: ${fmtNum(ctx.raw)} (${pct(ctx.raw, sum)}%)` } },
      },
    },
  });
}

// Population pyramid: female to the left (as negative values), male to the
// right, youngest band at the bottom.
function renderPyramid(conversations) {
  if (charts.pyramid) charts.pyramid.destroy();
  const series = GENDER_SERIES.filter((s) => s.key === "Female" || s.key === "Male");
  $("pyramidLegend").innerHTML = legendHtml(series);

  const ageCounts = countBy(conversations, (c) => prof(c).age);
  const both = conversations.filter((c) => answered(prof(c).age) && (prof(c).gender === "Female" || prof(c).gender === "Male"));
  toggleChartEmpty("pyramidChart", !both.length);
  const otherCount = conversations.filter((c) => answered(prof(c).age) && !(prof(c).gender === "Female" || prof(c).gender === "Male")).length;
  setSub(
    "pyramidSub",
    conversations.length
      ? `${coverageText(ageCounts, conversations.length)}${otherCount ? ` · ${fmtNum(otherCount)} other or no gender not shown` : ""}`
      : null,
    "Population pyramid of visitors who answered"
  );
  if (!both.length) return;

  const bands = AGE_ORDER.filter((b) => b !== "14-24" || ageCounts.counts.has(b)).reverse();
  const count = (band, g) => both.filter((c) => prof(c).age === band && prof(c).gender === g).length;
  const p = palette();
  const female = bands.map((b) => -count(b, "Female"));
  const male = bands.map((b) => count(b, "Male"));
  const max = Math.max(1, ...female.map(Math.abs), ...male);

  charts.pyramid = new Chart($("pyramidChart").getContext("2d"), {
    type: "bar",
    data: {
      labels: bands,
      datasets: [
        { label: "Female", data: female, backgroundColor: cssVar("--cat-1"), borderRadius: 4, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.9, maxBarThickness: 24 },
        { label: "Male", data: male, backgroundColor: cssVar("--cat-2"), borderRadius: 4, borderSkipped: false, barPercentage: 0.72, categoryPercentage: 0.9, maxBarThickness: 24 },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false, axis: "y" },
      plugins: {
        legend: { display: false },
        tooltip: { ...tooltipOptions(p), callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${fmtNum(Math.abs(ctx.raw))}` } },
      },
      scales: {
        x: {
          stacked: true,
          min: -max,
          max,
          border: { display: false },
          grid: { color: (ctx) => (ctx.tick && ctx.tick.value === 0 ? p.ink : p.grid) },
          ticks: { color: p.ink, precision: 0, callback: (v) => fmtNum(Math.abs(v)) },
        },
        y: { stacked: true, grid: { display: false }, border: { display: false }, ticks: { color: p.ink } },
      },
    },
  });
}

// ---------- Render everything ----------
function renderCharts() {
  const convs = state.conversations;
  const total = convs.length;

  renderVolumeChart(convs);

  const ch = countBy(convs, (c) => prof(c).channel);
  renderDonut(
    "channel",
    "channelChart",
    "channel",
    CHANNEL_SERIES.map((s) => ({ label: s.key, value: ch.counts.get(s.key) || 0, color: s.color })),
    total
  );

  renderPyramid(convs);

  const g = countBy(convs, (c) => prof(c).gender);
  renderSplit(
    "genderSplit",
    GENDER_SERIES.filter((s) => s.key).map((s) => ({ label: s.key, value: g.counts.get(s.key) || 0, color: s.color })),
    notInFile("gender") ? NOT_IN_FILE : total ? "No gender answers in this range" : "No data loaded yet"
  );
  setSub("genderSub", coverageText(g, total), "How visitors identify");

  const PATH_COLORS = { "General SRH and PrEP": "--cat-1", "DMPA-SC/SI": "--cat-2" };
  const pa = countBy(convs, (c) => prof(c).path);
  renderSplit(
    "pathSplit",
    [...pa.counts]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({ label, value, color: PATH_COLORS[label] || `--cat-${Math.min(3 + i, 4)}` })),
    notInFile("path") ? NOT_IN_FILE : total ? "No path choices in this range" : "No data loaded yet"
  );
  setSub("pathSub", coverageText(pa, total, "chose one"), "Which journey visitors picked");

  // Province, largest first; Outside SA always last.
  const pv = countBy(convs, (c) => prof(c).province);
  renderBarList(
    "provinceList",
    PROVINCE_ORDER.map((x) => ({ label: x, value: pv.counts.get(x) || 0 }))
      .filter((r) => r.value)
      .sort((a, b) => (a.label === "Outside SA") - (b.label === "Outside SA") || b.value - a.value),
    { emptyText: notInFile("province") ? NOT_IN_FILE : total ? "No province answers in this range" : undefined }
  );
  setSub("provinceSub", coverageText(pv, total), "Visitors by province, ranked");

  const steps = [
    ["Started a chat", () => true],
    ["Gave POPIA consent", (p) => p.consent],
    ["Answered age", (p) => answered(p.age)],
    ["Answered gender", (p) => answered(p.gender)],
    ["Answered location", (p) => answered(p.province)],
  ].map(([label, test]) => ({ label, value: convs.filter((c) => test(prof(c))).length }));
  renderFunnel("funnelChart", steps, total);

  const dm = countBy(convs, (c) => prof(c).dmpa_choice);
  renderLollipop(
    "dmpaChart",
    [...dm.counts].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value),
    notInFile("dmpa_choice") ? NOT_IN_FILE : total ? "No DMPA choices in this range" : "No data loaded yet"
  );
  const optins = convs.filter((c) => prof(c).reminder_optin).length;
  setSub("dmpaSub", total ? `${coverageText(dm, total, "chose one")} · ${fmtNum(optins)} reminder opt-in${optins === 1 ? "" : "s"}` : null, "What DMPA-SC/SI visitors asked for");

  const wa = convs.filter((c) => prof(c).channel === "WhatsApp");
  const src = countBy(wa, (c) => prof(c).source || "Direct / organic");
  renderSplit(
    "sourceSplit",
    [
      { label: "Ad", value: src.counts.get("Ad") || 0, color: "--cat-1" },
      { label: "Social post", value: src.counts.get("Social post") || 0, color: "--cat-2" },
      { label: "Direct", value: src.counts.get("Direct / organic") || 0, color: "--cat-3" },
    ],
    notInFile("source") ? NOT_IN_FILE : total ? "No WhatsApp conversations in this range" : "No data loaded yet"
  );
  setSub("sourceSub", wa.length ? `${fmtNum(wa.length)} WhatsApp conversations` : null, "How WhatsApp visitors found the service");
}

function profileTags(p) {
  const tags = [p.gender, p.age, p.province].filter(answered);
  return tags.length ? tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("") : `<span class="tag none">Not captured</span>`;
}

// ---------- Table ----------
function getVisibleRows() {
  const q = $("filterBox").value.trim().toLowerCase();
  let rows = state.conversations;
  if (state.statusFilter !== "all") rows = rows.filter((c) => c.state === state.statusFilter);
  if (q) {
    rows = rows.filter((c) =>
      [c.nickname, c.email, c.phone, c.session_id, c.last_message, ...Object.values(prof(c))].join(" ").toLowerCase().includes(q)
    );
  }

  const key = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  const isDate = key === "created_at" || key === "updated_at";
  rows = [...rows].sort((a, b) => {
    let av = a[key];
    let bv = b[key];
    if (isDate) {
      av = av || 0;
      bv = bv || 0;
    } else {
      av = (av || "").toString().toLowerCase();
      bv = (bv || "").toString().toLowerCase();
    }
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });

  return rows;
}

function emptyRow(title, text, iconName = "inbox") {
  return `<tr><td colspan="8"><div class="empty-state">
    <div class="empty-icon">${icon(iconName)}</div>
    <strong>${title}</strong><p>${text}</p>
  </div></td></tr>`;
}

function skeletonRows(n = 6) {
  const cell = (w) => `<td><span class="skel" style="width:${w}"></span></td>`;
  return Array.from({ length: n }, () =>
    `<tr class="skeleton-row">${cell("70%")}${cell("60px")}${cell("120px")}${cell("85%")}${cell("80px")}${cell("80px")}${cell("70px")}<td></td></tr>`
  ).join("");
}

function renderTable() {
  const body = $("convBody");
  if (state.loading) {
    body.innerHTML = skeletonRows();
    $("pagination").innerHTML = "";
    return;
  }

  const all = getVisibleRows();
  const totalPages = Math.max(1, Math.ceil(all.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const startIdx = (state.page - 1) * state.pageSize;
  const rows = all.slice(startIdx, startIdx + state.pageSize);

  $("tableCount").textContent = state.conversations.length
    ? all.length === state.conversations.length
      ? fmtNum(all.length)
      : `${fmtNum(all.length)} of ${fmtNum(state.conversations.length)}`
    : "";

  if (!state.conversations.length) {
    body.innerHTML = emptyRow("No conversations loaded", "Pick a date range above and fetch to see conversations here.", "calendar");
  } else if (!rows.length) {
    body.innerHTML = emptyRow("No matches", "Try a different search or status filter.", "search");
  } else {
    body.innerHTML = rows
      .map((c) => {
        const shortId = (c.session_id || "").replace("session_", "").slice(0, 8);
        const name = c.nickname || "Unknown visitor";
        return `
    <tr class="row" data-session="${escapeHtml(c.session_id)}">
      <td>
        <div class="cell-visitor">
          ${avatarHtml(c.nickname)}
          <div><div class="name">${escapeHtml(name)}</div>${c.phone ? `<div class="phone">${escapeHtml(c.phone)}</div>` : ""}</div>
        </div>
      </td>
      <td><span class="badge ${escapeHtml(c.state)}">${escapeHtml(c.state)}</span></td>
      <td><div class="profile-cell">${profileTags(prof(c))}</div></td>
      <td class="excerpt" title="${escapeHtml(c.last_message || "")}">${escapeHtml(c.last_message || "—")}</td>
      <td class="date">${c.created_at ? `${fmtDay(c.created_at)}<span class="t">${fmtTime(c.created_at)}</span>` : "—"}</td>
      <td class="date" title="${escapeHtml(fmtDate(c.updated_at))}">${c.updated_at ? `${fmtRelative(c.updated_at)}<span class="t">${fmtTime(c.updated_at)}</span>` : "—"}</td>
      <td><button type="button" class="copy-btn mono" data-copy="${escapeHtml(c.session_id)}" aria-label="Copy session ID ${escapeHtml(shortId)}" title="Copy full session ID">${escapeHtml(shortId)}${icon("copy")}</button></td>
      <td><button type="button" class="open-btn" data-open="${escapeHtml(c.session_id)}" aria-label="Open conversation with ${escapeHtml(name)}">${icon("arrow-right")}</button></td>
    </tr>`;
      })
      .join("");
  }

  renderPagination(all.length, totalPages, startIdx, rows.length);
  renderSortIndicators();
}

// One delegated listener for row clicks, open buttons, and copy buttons.
$("convBody").addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast("Session ID copied");
    } catch {
      toast("Couldn't copy to clipboard");
    }
    return;
  }
  const row = e.target.closest("tr.row");
  if (row) openConversation(row.dataset.session, e.target.closest("button") || row.querySelector(".open-btn"));
});

function renderPagination(totalRows, totalPages, startIdx, shown) {
  const el = $("pagination");
  if (!totalRows) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <span class="page-info">Showing <b>${fmtNum(startIdx + 1)}–${fmtNum(startIdx + shown)}</b> of <b>${fmtNum(totalRows)}</b></span>
    <div class="pager">
      <label class="page-size">Rows
        <select id="pageSize">
          ${[10, 25, 50, 100].map((n) => `<option value="${n}" ${n === state.pageSize ? "selected" : ""}>${n}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="btn btn-secondary" id="pagePrev" ${state.page <= 1 ? "disabled" : ""} aria-label="Previous page">${icon("chevron-left")}</button>
      <span class="page-info">${state.page} / ${totalPages}</span>
      <button type="button" class="btn btn-secondary" id="pageNext" ${state.page >= totalPages ? "disabled" : ""} aria-label="Next page">${icon("chevron-right")}</button>
    </div>
  `;
  $("pagePrev").addEventListener("click", () => {
    state.page -= 1;
    renderTable();
  });
  $("pageNext").addEventListener("click", () => {
    state.page += 1;
    renderTable();
  });
  $("pageSize").addEventListener("change", (e) => {
    state.pageSize = parseInt(e.target.value, 10);
    state.page = 1;
    renderTable();
  });
}

function renderSortIndicators() {
  document.querySelectorAll("#convTable th.sortable").forEach((th) => {
    const active = th.dataset.key === state.sortKey;
    th.classList.toggle("sort-asc", active && state.sortDir === "asc");
    th.classList.toggle("sort-desc", active && state.sortDir === "desc");
    th.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

document.querySelectorAll("#convTable th.sortable > button").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.parentElement.dataset.key;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = key === "created_at" || key === "updated_at" ? "desc" : "asc";
    }
    state.page = 1;
    renderTable();
  });
});

$("statusFilter").addEventListener("click", (e) => {
  const seg = e.target.closest(".seg");
  if (!seg) return;
  state.statusFilter = seg.dataset.status;
  document.querySelectorAll("#statusFilter .seg").forEach((s) => {
    const on = s === seg;
    s.classList.toggle("active", on);
    s.setAttribute("aria-pressed", on);
  });
  state.page = 1;
  renderTable();
});

$("filterBox").addEventListener("input", () => {
  state.page = 1;
  renderTable();
});

// ---------- Date range ----------
function isoDate(d) {
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function clearPresetHighlight() {
  document.querySelectorAll("#presets .chip").forEach((c) => c.classList.remove("active"));
}

$("presets").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const today = new Date();
  let start;
  if (chip.dataset.preset === "month") {
    start = new Date(today.getFullYear(), today.getMonth(), 1);
  } else {
    start = new Date(today);
    start.setDate(start.getDate() - (parseInt(chip.dataset.preset, 10) - 1));
  }
  $("startDate").value = isoDate(start);
  $("endDate").value = isoDate(today);
  clearPresetHighlight();
  chip.classList.add("active");
});
["startDate", "endDate"].forEach((id) => $(id).addEventListener("input", clearPresetHighlight));

$("fetchBtn").addEventListener("click", async () => {
  const start = $("startDate").value;
  const end = $("endDate").value;
  if (!start || !end) {
    setNote("Pick both a start and end date before fetching.", true);
    (!start ? $("startDate") : $("endDate")).focus();
    return;
  }
  if (start > end) {
    setNote("The start date needs to be on or before the end date.", true);
    $("startDate").focus();
    return;
  }
  const btn = $("fetchBtn");
  setButtonLoading(btn, true);
  state.loading = true;
  renderTable();
  showProgress();
  setNote("Fetching… large date ranges can take a while.");
  try {
    const json = await scanWithProgress(`/api/scan?start=${start}&end=${end}`, (p) => {
      setProgress(progressFromPageCount(p.page));
      setNote(`Fetching… ${fmtNum(p.loaded)} conversations found so far.`);
    });
    setProgress(100);
    state.conversations = json.conversations;
    state.range = { start, end };
    state.page = 1;
    state.loading = false;
    renderStats(state.conversations);
    resetInsights();
    renderTable();
    renderCharts();
    $("exportBtn").disabled = state.conversations.length === 0;
    $("rangeSummary").textContent = `${fmtNum(json.total)} conversations from ${fmtDay(start + "T00:00:00")} to ${fmtDay(end + "T00:00:00")}.`;
    setNote(json.hitCap ? `Hit the safety cap at ${fmtNum(json.total)} conversations - narrow your date range to see everything.` : "");
  } catch (e) {
    state.loading = false;
    renderTable();
    setNote("Error: " + e.message, true);
  } finally {
    setButtonLoading(btn, false);
    hideProgress();
  }
});

$("resetBtn").addEventListener("click", () => {
  $("filterBox").value = "";
  $("jumpSession").value = "";
  $("startDate").value = "";
  $("endDate").value = "";
  clearPresetHighlight();

  state.imported = null;
  state.sortKey = "updated_at";
  state.sortDir = "desc";
  state.statusFilter = "all";
  state.page = 1;
  document.querySelectorAll("#statusFilter .seg").forEach((s) => {
    const on = s.dataset.status === "all";
    s.classList.toggle("active", on);
    s.setAttribute("aria-pressed", on);
  });

  showEmptyState();
});

// ---------- CSV export ----------
$("exportBtn").addEventListener("click", () => {
  const rows = getVisibleRows();
  if (!rows.length) return;
  const headers = ["session_id", "state", "created_at", "updated_at", "nickname", "email", "phone", "channel", "source", "consent", "age", "gender", "province", "path", "dmpa_choice", "reminder_optin", "last_message"];
  const PROFILE_COLS = new Set(["channel", "source", "consent", "age", "gender", "province", "path", "dmpa_choice", "reminder_optin"]);
  const csvLines = [headers.join(",")];
  for (const r of rows) {
    const line = headers
      .map((h) => {
        let v = (PROFILE_COLS.has(h) ? prof(r)[h] : r[h]) ?? "";
        if (typeof v === "boolean") v = v ? "yes" : "no";
        if (h === "created_at" || h === "updated_at") v = v ? new Date(v).toISOString() : "";
        v = String(v).replace(/"/g, '""');
        return `"${v}"`;
      })
      .join(",");
    csvLines.push(line);
  }
  const blob = new Blob([csvLines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `crisp-conversations-${$("startDate").value}-to-${$("endDate").value}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  toast(`Exported ${fmtNum(rows.length)} conversations`);
});

// ---------- View tabs ----------
function switchView(view) {
  const insights = view === "insights";
  [
    [$("tabOverview"), $("viewOverview"), !insights],
    [$("tabInsights"), $("viewInsights"), insights],
  ].forEach(([tab, panel, on]) => {
    tab.classList.toggle("active", on);
    tab.setAttribute("aria-selected", on);
    tab.tabIndex = on ? 0 : -1;
    panel.classList.toggle("hidden", !on);
  });
}
$("tabOverview").addEventListener("click", () => switchView("overview"));
$("tabInsights").addEventListener("click", () => switchView("insights"));
document.querySelector(".view-tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const toInsights = $("tabOverview").classList.contains("active");
  switchView(toInsights ? "insights" : "overview");
  (toInsights ? $("tabInsights") : $("tabOverview")).focus();
});

// ---------- Questions & needs ----------
// Runs on demand: the server fetches every loaded conversation's messages
// (one Crisp call each, cached server-side) and returns aggregates.
const insights = { data: null, shown: 20 };

function resetInsights() {
  insights.data = null;
  insights.shown = 20;
  $("insightsResults").classList.add("hidden");
  $("insightsProgress").classList.add("hidden");
  const n = state.conversations.length;
  $("insightsBtn").disabled = !n;
  $("insightsBtn").querySelector(".btn-label").textContent = "Analyse messages";
  $("insightsIntro").textContent = n
    ? `Analyse the visitors' messages in the ${fmtNum(n)} loaded conversations. This reads every conversation from Crisp, so large ranges take a few minutes the first time.`
    : "Load a date range first, then analyse the visitors' messages to see their most asked questions and what they wanted.";
}

function setInsightsProgress(pctDone) {
  const v = Math.max(0, Math.min(100, Math.round(pctDone)));
  $("insightsFill").style.width = v + "%";
  $("insightsPct").textContent = v + "%";
  $("insightsBar").setAttribute("aria-valuenow", v);
}

$("insightsBtn").addEventListener("click", async () => {
  const btn = $("insightsBtn");
  const convs = state.conversations.map((c) => ({ session_id: c.session_id, updated_at: c.updated_at }));
  if (!convs.length) return;
  setButtonLoading(btn, true);
  $("insightsProgress").classList.remove("hidden");
  setInsightsProgress(0);
  $("insightsIntro").textContent = `Reading messages… 0 of ${fmtNum(convs.length)} conversations.`;
  try {
    const json = await scanWithProgress(
      "/api/insights",
      (p) => {
        setInsightsProgress((p.done / p.total) * 100);
        $("insightsIntro").textContent = `Reading messages… ${fmtNum(p.done)} of ${fmtNum(p.total)} conversations.`;
      },
      { method: "POST", body: JSON.stringify({ conversations: convs }) }
    );
    insights.data = json;
    insights.shown = 20;
    renderInsights();
    btn.querySelector(".btn-label").textContent = "Refresh analysis";
    $("insightsIntro").textContent =
      `Based on ${fmtNum(json.analysed)} conversations in the loaded range.` +
      (json.failed ? ` ${fmtNum(json.failed)} couldn't be read from Crisp and were skipped.` : "") +
      " Topics and needs are keyword matches, so treat them as a guide.";
  } catch (e) {
    $("insightsIntro").textContent = "Error: " + e.message;
  } finally {
    setButtonLoading(btn, false);
    $("insightsProgress").classList.add("hidden");
  }
});

function renderInsights() {
  const d = insights.data;
  if (!d) return;
  $("insightsResults").classList.remove("hidden");

  const stat = (cls, label, iconName, num, pctText, foot) => `
    <article class="card stat ${cls}">
      <div class="stat-top"><span class="stat-label">${label}</span><span class="stat-icon">${icon(iconName)}</span></div>
      <div class="stat-num">${fmtNum(num)}</div>
      <div class="stat-foot">${pctText ? `<span class="stat-pct">${pctText}</span>` : ""}<span>${foot}</span></div>
    </article>`;
  $("insightsStats").innerHTML =
    stat("total", "Visitor messages", "chat", d.visitorMessages, "", `across ${fmtNum(d.analysed)} conversations`) +
    stat("consent", "Questions asked", "search", d.questionCount, "", `${fmtNum(d.questions.length)} distinct shown below`) +
    stat("profile", "Conversations with a question", "grid", d.convsWithQuestion, `${pct(d.convsWithQuestion, d.analysed)}%`, "of conversations") +
    stat("ads", "Flagged for review", "alert", d.flagged.length, "", "possible GBV or self-harm mentions");

  // "Other" means no topic keyword matched, so it goes last.
  const topics = d.topics
    .map((t) => ({ label: t.label === "Other" ? "Other / unclear" : t.label, value: t.value }))
    .sort((a, b) => (a.label === "Other / unclear") - (b.label === "Other / unclear") || b.value - a.value);
  renderBarList("topicList", topics, { base: d.analysed, emptyText: "No visitor messages in this range" });
  renderBarList("replyList", d.replies.slice(0, 10).map((r) => ({ label: r.label.charAt(0).toUpperCase() + r.label.slice(1), value: r.value, color: "--cat-3" })), {
    base: d.analysed,
    emptyText: "No short replies found",
  });
  renderLollipop("needsChart", d.needs, "No information needs detected");

  const flags = d.flagged;
  $("flagList").innerHTML = flags.length
    ? `<ul class="flag-list">${flags
        .slice(0, 8)
        .map(
          (f) => `<li><span class="flag-k">${icon("alert")}${escapeHtml(f.flags.join(", "))}</span>
          <button type="button" class="btn btn-secondary q-open" data-open-session="${escapeHtml(f.session_id)}">Open</button></li>`
        )
        .join("")}</ul>${flags.length > 8 ? `<p class="flag-more">+${fmtNum(flags.length - 8)} more. Search the conversation log for them.</p>` : ""}`
    : `<div class="flag-none">${icon("check")}No flagged mentions in this range.</div>`;

  renderQuestionList();
}

function renderQuestionList() {
  const d = insights.data;
  const q = $("questionFilter").value.trim().toLowerCase();
  const all = d.questions.filter((x) => !q || [x.question, ...x.examples, x.topic].join(" ").toLowerCase().includes(q));
  const rows = all.slice(0, insights.shown);
  const max = Math.max(1, ...d.questions.map((x) => x.count));
  $("questionCount").textContent = fmtNum(all.length);

  $("questionList").innerHTML = rows.length
    ? rows
        .map(
          (x, i) => `<li class="q-item">
        <span class="q-rank">${i + 1}</span>
        <div>
          <div class="q-text">${escapeHtml(x.question)}</div>
          <div class="q-meta">
            ${x.topic && x.topic !== "Other" ? `<span class="tag">${escapeHtml(x.topic)}</span>` : ""}
            ${x.variants > 1 ? `<span class="q-alt" title="${escapeHtml(x.examples.join(" · "))}">+${fmtNum(x.variants - 1)} similar phrasing${x.variants > 2 ? "s" : ""}</span>` : ""}
          </div>
        </div>
        <div class="q-side">
          <div class="q-count"><b>${fmtNum(x.count)}</b><span>conversation${x.count === 1 ? "" : "s"}</span><span class="q-bar"><i style="width:${(x.count / max) * 100}%"></i></span></div>
          <button type="button" class="btn btn-secondary q-open" data-open-session="${escapeHtml(x.session_id)}" aria-label="Open an example conversation">Open</button>
        </div>
      </li>`
        )
        .join("")
    : `<li class="empty-state"><div class="empty-icon">${icon("search")}</div><strong>No questions found</strong><p>${q ? "Try a different filter." : "Visitors in this range didn't ask any questions."}</p></li>`;

  $("questionFoot").innerHTML =
    all.length > insights.shown
      ? `<span class="page-info">Showing <b>${fmtNum(rows.length)}</b> of <b>${fmtNum(all.length)}</b></span><button type="button" class="btn btn-secondary" id="questionMore">Show more</button>`
      : "";
  if ($("questionMore"))
    $("questionMore").addEventListener("click", () => {
      insights.shown += 20;
      renderQuestionList();
    });
}

$("questionFilter").addEventListener("input", () => {
  insights.shown = 20;
  if (insights.data) renderQuestionList();
});

$("viewInsights").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-open-session]");
  if (btn) openConversation(btn.dataset.openSession, btn);
});

resetInsights();

// ---------- Jump to a single session ----------
$("jumpForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("jumpSession").value.trim();
  if (id) openConversation(id, $("jumpSession"));
});

// "/" focuses the session lookup from anywhere outside a text field.
document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.metaKey && !e.ctrlKey && !$("app").classList.contains("hidden") && $("modal").classList.contains("hidden")) {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    $("jumpSession").focus();
  }
});

// ---------- Conversation drawer ----------
// Tracks the currently open conversation so the "Suggested Coding" tab can
// reuse the already-fetched messages (no second Crisp round trip) and so
// switching tabs back and forth doesn't re-call the classifier each time.
const modalState = { sessionId: null, messages: [], conversationLoaded: false, coding: null, codingLoading: false, returnFocus: null };

function switchModalTab(tab) {
  const conv = tab === "conversation";
  [
    [$("modalTabConversation"), conv],
    [$("modalTabCoding"), !conv],
  ].forEach(([el, on]) => {
    el.classList.toggle("active", on);
    el.setAttribute("aria-selected", on);
    el.tabIndex = on ? 0 : -1;
  });
  $("modalPageConversation").classList.toggle("hidden", !conv);
  $("modalPageCoding").classList.toggle("hidden", conv);
  if (!conv) ensureCodingSuggestions();
}

$("modalTabConversation").addEventListener("click", () => switchModalTab("conversation"));
$("modalTabCoding").addEventListener("click", () => switchModalTab("coding"));
document.querySelector(".tabs").addEventListener("keydown", (e) => {
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const toCoding = $("modalTabConversation").classList.contains("active");
  switchModalTab(toCoding ? "coding" : "conversation");
  (toCoding ? $("modalTabCoding") : $("modalTabConversation")).focus();
});

function renderCodingStatus(html, isError) {
  $("modalCoding").innerHTML = `<div class="coding-status${isError ? " error" : ""}">${html}</div>`;
}

function renderCodingSuggestions(fields) {
  $("modalCoding").innerHTML = `
    <div class="callout">${icon("alert")}<span>Auto-suggested by scanning this conversation for keywords tied to each category. Always verify before entering values into the spreadsheet.</span></div>
    <div class="coding-grid">
      ${fields
        .map((f) => {
          const lowConfidence = !f.note;
          return `
            <div class="coding-field${lowConfidence ? "" : " matched"}">
              <div class="coding-label">${escapeHtml(f.label)}</div>
              <div class="coding-value${lowConfidence ? " not-discussed" : ""}">${escapeHtml(f.value || "—")}</div>
              ${f.note ? `<div class="coding-note">${escapeHtml(f.note)}</div>` : ""}
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

async function ensureCodingSuggestions() {
  if (modalState.coding || modalState.codingLoading) return;
  if (!modalState.conversationLoaded) {
    renderCodingStatus(`<span class="spinner" style="display:inline-block"></span>Loading conversation…`);
    return; // openConversation() calls back in here once messages are in
  }
  const sessionId = modalState.sessionId;
  modalState.codingLoading = true;
  renderCodingStatus(`<span class="spinner" style="display:inline-block"></span>Reading the conversation…`);
  try {
    const res = await fetch(`/api/coding/${encodeURIComponent(sessionId)}`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({ messages: modalState.messages }),
    });
    const json = await res.json();
    if (!res.ok || json.error) throw new Error(json.reason || "Request failed");
    if (modalState.sessionId !== sessionId) return; // drawer moved on to another conversation
    modalState.coding = json.suggestion;
    renderCodingSuggestions(modalState.coding);
  } catch (e) {
    if (modalState.sessionId !== sessionId) return;
    renderCodingStatus(
      `${escapeHtml(e.message)}<button type="button" class="btn btn-secondary" id="codingRetryBtn">Retry</button>`,
      true
    );
    $("codingRetryBtn").addEventListener("click", ensureCodingSuggestions);
  } finally {
    modalState.codingLoading = false;
  }
}

function renderThread(msgs, nickname) {
  let lastDay = null;
  let lastWho = null;
  let lastTs = 0;
  return msgs
    .map((m) => {
      const who = m.from === "operator" ? "operator" : "visitor";
      const name = who === "operator" ? (m.user && m.user.nickname) || "Operator" : nickname || "Visitor";
      let body;
      if (m.type === "text" || typeof m.content === "string") body = escapeHtml(m.content);
      else if (m.type === "file") body = `<span class="file">${icon("paperclip")}${escapeHtml((m.content && m.content.name) || "file")}</span>`;
      else body = escapeHtml(JSON.stringify(m.content));

      let sep = "";
      const day = m.timestamp ? fmtDay(m.timestamp) : null;
      if (day && day !== lastDay) {
        sep = `<div class="day-sep">${day}</div>`;
        lastDay = day;
        lastWho = null;
      }
      // Group consecutive messages from the same sender within 5 minutes.
      const cont = lastWho === who && m.timestamp - lastTs < 5 * 60 * 1000;
      lastWho = who;
      lastTs = m.timestamp || 0;
      return `${sep}
        <div class="msg ${who}${cont ? " cont" : ""}">
          <div class="who"><b>${escapeHtml(name)}</b><span>${m.timestamp ? fmtTime(m.timestamp) : ""}</span></div>
          <div class="body">${body}</div>
        </div>`;
    })
    .join("");
}

async function openConversation(sessionId, returnFocus) {
  // Imported CSV rows may not have a real Crisp session to fetch.
  if (!/^session_/.test(sessionId) && state.conversations.some((c) => c.session_id === sessionId && c.imported)) {
    return openImportedRow(sessionId, returnFocus);
  }
  modalState.sessionId = sessionId;
  modalState.messages = [];
  modalState.conversationLoaded = false;
  modalState.coding = null;
  modalState.codingLoading = false;
  modalState.returnFocus = returnFocus || document.activeElement;
  switchModalTab("conversation");

  const modal = $("modal");
  modal.classList.remove("hidden", "closing");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  $("drawerPanel").focus();

  $("modalTitle").textContent = "Loading conversation…";
  $("modalAvatar").outerHTML = `<span class="avatar" id="modalAvatar" aria-hidden="true">…</span>`;
  $("modalSub").innerHTML = `<span class="mono">${escapeHtml(sessionId)}</span>`;
  $("modalMeta").innerHTML = "";
  $("modalThread").innerHTML = `<div class="drawer-loading">${'<span class="skel"></span>'.repeat(6)}</div>`;
  $("modalRecord").innerHTML = "";
  $("modalCoding").innerHTML = "";
  try {
    const json = await api(`/api/conversation/${encodeURIComponent(sessionId)}`);
    if (modalState.sessionId !== sessionId) return;
    const conv = json.conversation || {};
    const msgs = json.messages || [];
    modalState.messages = msgs;
    modalState.conversationLoaded = true;
    if ($("modalTabCoding").classList.contains("active")) ensureCodingSuggestions();
    const record = json.record || null;
    const profile = json.profile || {};
    const nickname = conv.meta && conv.meta.nickname;
    const email = conv.meta && conv.meta.email;
    const phone = conv.meta && conv.meta.phone;

    $("modalTitle").textContent = nickname || "Unknown visitor";
    $("modalAvatar").outerHTML = avatarHtml(nickname).replace('class="avatar ', 'id="modalAvatar" class="avatar ');
    $("modalSub").innerHTML = `
      ${conv.state ? `<span class="badge ${escapeHtml(conv.state)}">${escapeHtml(conv.state)}</span>` : ""}
      <button type="button" class="copy-btn mono" id="modalCopy" title="Copy full session ID">${escapeHtml((sessionId || "").replace("session_", "").slice(0, 8))}${icon("copy")}</button>`;
    $("modalCopy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(sessionId);
        toast("Session ID copied");
      } catch {
        toast("Couldn't copy to clipboard");
      }
    });

    const metaItem = (k, v) => (v ? `<div class="meta-item"><div class="k">${k}</div><div class="v">${v}</div></div>` : "");
    $("modalMeta").innerHTML =
      metaItem("Email", escapeHtml(email)) +
      metaItem("Phone", escapeHtml(phone)) +
      metaItem("Channel", escapeHtml(profile.channel)) +
      metaItem("Age", escapeHtml(profile.age)) +
      metaItem("Gender", escapeHtml(profile.gender)) +
      metaItem("Province", escapeHtml(profile.province)) +
      metaItem("Path", escapeHtml(profile.path)) +
      metaItem("Started", fmtDate(conv.created_at) || "Unknown") +
      metaItem("Last activity", fmtDate(conv.updated_at) || "Unknown") +
      metaItem("Messages", fmtNum(msgs.length));

    $("modalRecord").innerHTML = record
      ? `
        <div class="section-title">Data collection record</div>
        <div class="record-grid">
          ${record
            .map(
              (f) => `<div class="record-field"><div class="record-label">${escapeHtml(f.label)}</div><div class="record-value">${escapeHtml(f.value)}</div></div>`
            )
            .join("")}
        </div>
      `
      : "";

    $("modalThread").innerHTML = msgs.length
      ? renderThread(msgs, nickname)
      : `<div class="empty-state"><div class="empty-icon">${icon("chat")}</div><strong>No messages yet</strong><p>This conversation doesn't have any messages.</p></div>`;
  } catch (e) {
    if (modalState.sessionId !== sessionId) return;
    $("modalTitle").textContent = "Couldn't load conversation";
    $("modalThread").innerHTML = `<div class="empty-state"><div class="empty-icon">${icon("alert")}</div><strong>Something went wrong</strong><p>${escapeHtml(e.message)}</p></div>`;
  }
}

function closeModal() {
  const modal = $("modal");
  if (modal.classList.contains("hidden")) return;
  modalState.sessionId = null;
  const back = modalState.returnFocus;
  if (back && document.contains(back)) back.focus();
  else document.activeElement.blur();
  modal.classList.add("closing");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  setTimeout(() => modal.classList.add("hidden"), reduced ? 0 : 170);
}

$("modalClose").addEventListener("click", closeModal);
$("modalBackdrop").addEventListener("click", closeModal);

// Escape closes; Tab is kept inside the drawer while it's open.
document.addEventListener("keydown", (e) => {
  if ($("modal").classList.contains("hidden")) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeModal();
    return;
  }
  if (e.key !== "Tab") return;
  const panel = $("drawerPanel");
  const focusable = [...panel.querySelectorAll('button:not([disabled]), [href], input, select, [tabindex]:not([tabindex="-1"])')].filter(
    (el) => el.offsetParent !== null
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});
