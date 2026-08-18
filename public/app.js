const state = {
  password: localStorage.getItem("crisp_dash_password") || "",
  conversations: [],
  sortKey: "updated_at",
  sortDir: "desc",
  page: 1,
  pageSize: 25,
};

const $ = (id) => document.getElementById(id);

// ---------- Brand palette (Sister Unathi) ----------
const BRAND = {
  tealLight: "#17A3AB",
  tealMid: "#127582",
  tealDark: "#143840",
  blueLight: "#178CCC",
  blueMid: "#0F6699",
  blueDark: "#031F33",
  grey: "#B2B8BF",
  gold: "#B08B2F",
  alert: "#C4573F",
  safeGreen: "#0E795B",
  safeRed: "#D43F3A",
};

if (window.Chart) {
  Chart.defaults.font.family = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
  Chart.defaults.color = "#4C6373";
  Chart.defaults.borderColor = "#EAF1F2";
}

const ICONS = {
  total: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>`,
  resolved: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>`,
  pending: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>`,
  unresolved: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a1.6 1.6 0 001.4 2.4h17.6a1.6 1.6 0 001.4-2.4L13.7 3.9a1.6 1.6 0 00-2.8 0z"/><path d="M12 9v4"/><path d="M12 16.5h.01"/></svg>`,
};

let volumeChart = null;
let statusChart = null;

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
async function scanWithProgress(pathAndQuery, onProgress) {
  const res = await fetch(pathAndQuery, { headers: apiHeaders() });
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
function progressFromPageCount(page) {
  return 92 * (1 - Math.exp(-page / 6));
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
}

// ---------- Login ----------
function showLogin(errored) {
  $("app").classList.add("hidden");
  $("loginScreen").classList.remove("hidden");
  $("loginError").classList.toggle("hidden", !errored);
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

$("loginBtn").addEventListener("click", async () => {
  const ok = await tryLogin($("loginPassword").value.trim());
  if (!ok) {
    showLogin(true);
  } else {
    loadFullHistory();
  }
});
$("loginPassword").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("loginBtn").click();
});

// Attempt silent login with any stored password on load; if that fails
// (or none stored) fall back to the login screen. If the server has no
// password configured, /api/login always returns ok.
(async function init() {
  const ok = await tryLogin(state.password);

  if (!ok) {
    showLogin(false);
    renderVolumeChart([]);
    renderStatusChart({ resolved: 0, pending: 0, unresolved: 0 }, 0);
    renderWeekdayChart([]);
    renderHourChart([]);
    return;
  }

  loadFullHistory();
})();

// ---------- Default view: everything since we started using Crisp ----------
async function loadFullHistory() {
  const note = $("fetchNote");
  note.textContent = "Loading complete history since you started using Crisp...";
  showProgress();
  try {
    const json = await scanWithProgress(`/api/scan?maxPages=200`, (p) => {
      setProgress(progressFromPageCount(p.page));
      note.textContent = `Loading... ${p.loaded} conversations found so far.`;
    });
    setProgress(100);
    state.conversations = json.conversations;
    state.page = 1;
    renderStats(json.stats, json.total);
    renderTable();
    renderVolumeChart(state.conversations);
    renderStatusChart(json.stats, json.total);
    renderWeekdayChart(state.conversations);
    renderHourChart(state.conversations);
    $("exportBtn").disabled = state.conversations.length === 0;
    note.textContent = json.hitCap
      ? `Showing all-time data: ${json.total} conversations (hit the safety cap - narrow your date range and fetch to see a specific window).`
      : `Showing all-time data: ${json.total} conversations since you started using Crisp. Pick a date range and fetch to narrow this down.`;
  } catch (e) {
    note.textContent = "Error loading history: " + e.message;
  } finally {
    hideProgress();
  }
}

// ---------- Fetch conversations ----------
function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function renderStats(stats, total) {
  const row = $("statsRow");
  const card = (cls, label, num, icon) => `
    <div class="stat-card ${cls}">
      <div class="top-row">
        <div class="num">${num}</div>
        <div class="icon">${icon}</div>
      </div>
      <div class="label">${label}</div>
    </div>`;
  row.innerHTML =
    card("total", "Total", total, ICONS.total) +
    card("resolved", "Resolved", stats.resolved, ICONS.resolved) +
    card("pending", "Pending", stats.pending, ICONS.pending) +
    card("unresolved", "Unresolved", stats.unresolved, ICONS.unresolved);
}

// ---------- Charts ----------
function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

function buildDailySeries(conversations) {
  const byDay = new Map();
  for (const c of conversations) {
    if (!c.created_at) continue;
    const key = dayKey(c.created_at);
    if (!byDay.has(key)) byDay.set(key, { resolved: 0, pending: 0, unresolved: 0 });
    const bucket = byDay.get(key);
    if (bucket[c.state] !== undefined) bucket[c.state] += 1;
  }
  const days = [...byDay.keys()].sort();
  return {
    labels: days.map((d) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric" })),
    resolved: days.map((d) => byDay.get(d).resolved),
    pending: days.map((d) => byDay.get(d).pending),
    unresolved: days.map((d) => byDay.get(d).unresolved),
  };
}

function renderVolumeChart(conversations) {
  const wrap = $("volumeChart").getContext("2d");
  const empty = $("volumeEmpty");
  if (volumeChart) volumeChart.destroy();

  if (!conversations.length) {
    $("volumeChart").classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  $("volumeChart").classList.remove("hidden");
  empty.classList.add("hidden");

  const s = buildDailySeries(conversations);
  const series = [
    { key: "resolved", label: "Resolved", color: BRAND.safeGreen },
    { key: "pending", label: "Pending", color: BRAND.gold },
    { key: "unresolved", label: "Unresolved", color: BRAND.safeRed },
  ];

  volumeChart = new Chart(wrap, {
    type: "line",
    data: {
      labels: s.labels,
      datasets: series.map((sr) => ({
        label: sr.label,
        data: s[sr.key],
        borderColor: sr.color,
        backgroundColor: sr.color + "18",
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: sr.color,
        borderWidth: 2.25,
        tension: 0.4,
        fill: true,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: BRAND.blueDark,
          padding: 10,
          cornerRadius: 8,
          titleFont: { weight: "600" },
          boxPadding: 4,
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10.5 } } },
        y: { beginAtZero: true, ticks: { precision: 0, font: { size: 10.5 } }, grid: { color: "#EAF1F2" } },
      },
    },
  });
}

// ---------- Weekday / hour-of-day breakdowns ----------
// Useful for staffing decisions: which days and hours actually see the traffic.
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function buildWeekdaySeries(conversations) {
  const buckets = WEEKDAY_LABELS.map(() => ({ resolved: 0, pending: 0, unresolved: 0 }));
  for (const c of conversations) {
    if (!c.created_at) continue;
    const day = new Date(c.created_at).getDay();
    if (buckets[day][c.state] !== undefined) buckets[day][c.state] += 1;
  }
  return {
    labels: WEEKDAY_LABELS,
    resolved: buckets.map((b) => b.resolved),
    pending: buckets.map((b) => b.pending),
    unresolved: buckets.map((b) => b.unresolved),
  };
}

function buildHourSeries(conversations) {
  const buckets = Array.from({ length: 24 }, () => ({ resolved: 0, pending: 0, unresolved: 0 }));
  for (const c of conversations) {
    if (!c.created_at) continue;
    const hour = new Date(c.created_at).getHours();
    if (buckets[hour][c.state] !== undefined) buckets[hour][c.state] += 1;
  }
  return {
    labels: buckets.map((_, h) => `${h}:00`),
    resolved: buckets.map((b) => b.resolved),
    pending: buckets.map((b) => b.pending),
    unresolved: buckets.map((b) => b.unresolved),
  };
}

const auxCharts = {};

function renderCategoryBarChart(canvasId, emptyId, key, conversations, buildSeries) {
  const wrap = $(canvasId).getContext("2d");
  const empty = $(emptyId);
  if (auxCharts[key]) auxCharts[key].destroy();

  if (!conversations.length) {
    $(canvasId).classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }
  $(canvasId).classList.remove("hidden");
  empty.classList.add("hidden");

  const s = buildSeries(conversations);
  const series = [
    { key: "resolved", label: "Resolved", color: BRAND.safeGreen },
    { key: "pending", label: "Pending", color: BRAND.gold },
    { key: "unresolved", label: "Unresolved", color: BRAND.safeRed },
  ];

  auxCharts[key] = new Chart(wrap, {
    type: "bar",
    data: {
      labels: s.labels,
      datasets: series.map((sr) => ({
        label: sr.label,
        data: s[sr.key],
        backgroundColor: sr.color,
        borderRadius: 4,
        maxBarThickness: 28,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: BRAND.blueDark, padding: 10, cornerRadius: 8 },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { stacked: true, beginAtZero: true, ticks: { precision: 0, font: { size: 10.5 } }, grid: { color: "#EAF1F2" } },
      },
    },
  });
}

function renderWeekdayChart(conversations) {
  renderCategoryBarChart("weekdayChart", "weekdayEmpty", "weekday", conversations, buildWeekdaySeries);
}

function renderHourChart(conversations) {
  renderCategoryBarChart("hourChart", "hourEmpty", "hour", conversations, buildHourSeries);
}

function renderStatusChart(stats, total) {
  const wrap = $("statusChart").getContext("2d");
  const center = $("donutCenter");
  const empty = $("statusEmpty");
  const legend = $("statusLegend");
  if (statusChart) statusChart.destroy();

  if (!total) {
    $("statusChart").classList.add("hidden");
    center.classList.add("hidden");
    empty.classList.remove("hidden");
    legend.innerHTML = "";
    return;
  }
  $("statusChart").classList.remove("hidden");
  center.classList.remove("hidden");
  empty.classList.add("hidden");
  $("donutTotal").textContent = total;

  const parts = [
    { label: "Resolved", value: stats.resolved, color: BRAND.safeGreen },
    { label: "Pending", value: stats.pending, color: BRAND.gold },
    { label: "Unresolved", value: stats.unresolved, color: BRAND.safeRed },
  ];

  statusChart = new Chart(wrap, {
    type: "doughnut",
    data: {
      labels: parts.map((p) => p.label),
      datasets: [
        {
          data: parts.map((p) => p.value),
          backgroundColor: parts.map((p) => p.color),
          borderColor: "#FFFFFF",
          borderWidth: 3,
          hoverOffset: 6,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "72%",
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: BRAND.blueDark,
          padding: 10,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => `${ctx.label}: ${ctx.raw} (${((ctx.raw / total) * 100).toFixed(0)}%)`,
          },
        },
      },
    },
  });

  legend.innerHTML = parts
    .map(
      (p) => `<div class="legend-item"><span class="legend-dot" style="background:${p.color}"></span>${p.label} · ${p.value}</div>`
    )
    .join("");
}

function getVisibleRows() {
  const q = $("filterBox").value.trim().toLowerCase();
  let rows = state.conversations;
  if (q) {
    rows = rows.filter((c) =>
      [c.nickname, c.email, c.phone, c.session_id, c.last_message].join(" ").toLowerCase().includes(q)
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

function renderTable() {
  const body = $("convBody");
  const all = getVisibleRows();
  const totalPages = Math.max(1, Math.ceil(all.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const startIdx = (state.page - 1) * state.pageSize;
  const rows = all.slice(startIdx, startIdx + state.pageSize);

  $("tableCount").textContent = all.length ? `(${all.length})` : "";

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No conversations match.</td></tr>`;
  } else {
    body.innerHTML = rows
      .map(
        (c) => `
    <tr>
      <td>${escapeHtml((c.session_id || "").replace("session_", "").slice(0, 8))}…</td>
      <td><span class="badge ${c.state}">${c.state}</span></td>
      <td>${fmtDate(c.created_at)}</td>
      <td>${fmtDate(c.updated_at)}</td>
      <td>${escapeHtml(c.nickname || "Unknown")}</td>
      <td>${escapeHtml(c.phone || "")}</td>
      <td class="excerpt" title="${escapeHtml(c.last_message || "")}">${escapeHtml(c.last_message || "")}</td>
      <td><span class="view-link" data-session="${escapeHtml(c.session_id)}">View</span></td>
    </tr>
  `
      )
      .join("");

    body.querySelectorAll(".view-link").forEach((el) => {
      el.addEventListener("click", () => openConversation(el.dataset.session));
    });
  }

  renderPagination(all.length, totalPages);
  renderSortIndicators();
}

function renderPagination(totalRows, totalPages) {
  const el = $("pagination");
  if (!totalRows) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `
    <button id="pagePrev" ${state.page <= 1 ? "disabled" : ""}>← Prev</button>
    <span class="page-info">Page ${state.page} of ${totalPages}</span>
    <button id="pageNext" ${state.page >= totalPages ? "disabled" : ""}>Next →</button>
  `;
  $("pagePrev").addEventListener("click", () => {
    state.page -= 1;
    renderTable();
  });
  $("pageNext").addEventListener("click", () => {
    state.page += 1;
    renderTable();
  });
}

function renderSortIndicators() {
  document.querySelectorAll("#convTable th.sortable").forEach((th) => {
    const active = th.dataset.key === state.sortKey;
    th.classList.toggle("sort-asc", active && state.sortDir === "asc");
    th.classList.toggle("sort-desc", active && state.sortDir === "desc");
  });
}

document.querySelectorAll("#convTable th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const key = th.dataset.key;
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

function escapeHtml(s) {
  return (s || "").toString().replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

$("fetchBtn").addEventListener("click", async () => {
  const start = $("startDate").value;
  const end = $("endDate").value;
  const note = $("fetchNote");
  $("fetchBtn").disabled = true;
  showProgress();
  note.textContent = "Fetching… this can take a while for large date ranges.";
  try {
    const json = await scanWithProgress(`/api/scan?start=${start}&end=${end}`, (p) => {
      setProgress(progressFromPageCount(p.page));
      note.textContent = `Fetching... ${p.loaded} conversations found so far.`;
    });
    setProgress(100);
    state.conversations = json.conversations;
    state.page = 1;
    renderStats(json.stats, json.total);
    renderTable();
    renderVolumeChart(state.conversations);
    renderStatusChart(json.stats, json.total);
    renderWeekdayChart(state.conversations);
    renderHourChart(state.conversations);
    $("exportBtn").disabled = state.conversations.length === 0;
    note.textContent = json.hitCap
      ? `Loaded ${json.total} conversations (hit the safety cap - narrow your date range to see more).`
      : `Loaded ${json.total} conversations.`;
  } catch (e) {
    note.textContent = "Error: " + e.message;
  } finally {
    $("fetchBtn").disabled = false;
    hideProgress();
  }
});

$("resetBtn").addEventListener("click", () => {
  $("filterBox").value = "";
  $("jumpSession").value = "";
  $("startDate").value = "";
  $("endDate").value = "";

  state.sortKey = "updated_at";
  state.sortDir = "desc";
  state.page = 1;

  loadFullHistory();
});

$("filterBox").addEventListener("input", () => {
  state.page = 1;
  renderTable();
});

// ---------- CSV export ----------
$("exportBtn").addEventListener("click", () => {
  const rows = state.conversations;
  if (!rows.length) return;
  const headers = ["session_id", "state", "created_at", "updated_at", "nickname", "email", "phone", "last_message"];
  const csvLines = [headers.join(",")];
  for (const r of rows) {
    const line = headers
      .map((h) => {
        let v = r[h] ?? "";
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
});

// ---------- Jump to a single session ----------
$("jumpBtn").addEventListener("click", () => {
  const id = $("jumpSession").value.trim();
  if (id) openConversation(id);
});
$("jumpSession").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("jumpBtn").click();
});

// ---------- Conversation reader modal ----------
async function openConversation(sessionId) {
  $("modal").classList.remove("hidden");
  $("modalMeta").innerHTML = "Loading…";
  $("modalThread").innerHTML = "";
  try {
    const json = await api(`/api/conversation/${encodeURIComponent(sessionId)}`);
    const conv = json.conversation || {};
    const msgs = json.messages || [];
    const nickname = conv.meta && conv.meta.nickname;
    const email = conv.meta && conv.meta.email;
    const phone = conv.meta && conv.meta.phone;

    $("modalMeta").innerHTML = `
      <span><b>${escapeHtml(nickname || "Unknown visitor")}</b></span>
      ${email ? `<span>${escapeHtml(email)}</span>` : ""}
      ${phone ? `<span>${escapeHtml(phone)}</span>` : ""}
      <span>state: <b>${escapeHtml(conv.state || "")}</b></span>
      <span>started: <b>${fmtDate(conv.created_at) || "unknown"}</b></span>
      <span>ended: <b>${fmtDate(conv.updated_at) || "unknown"}</b></span>
      <span>${msgs.length} message${msgs.length === 1 ? "" : "s"}</span>
    `;

    if (!msgs.length) {
      $("modalThread").innerHTML = `<div class="note">No messages in this conversation yet.</div>`;
      return;
    }

    $("modalThread").innerHTML = msgs
      .map((m) => {
        const who = m.from === "operator" ? "operator" : "visitor";
        const name = who === "operator" ? (m.user && m.user.nickname) || "Operator" : nickname || "Visitor";
        let body;
        if (m.type === "text" || typeof m.content === "string") body = escapeHtml(m.content);
        else if (m.type === "file") body = `📎 ${escapeHtml((m.content && m.content.name) || "file")}`;
        else body = escapeHtml(JSON.stringify(m.content));
        return `
          <div class="msg ${who}">
            <div class="who">${escapeHtml(name)} <span>${fmtDate(m.timestamp)}</span></div>
            <div class="body">${body}</div>
          </div>
        `;
      })
      .join("");
  } catch (e) {
    $("modalMeta").innerHTML = `<span style="color:var(--bad)">Error: ${escapeHtml(e.message)}</span>`;
  }
}

$("modalClose").addEventListener("click", closeModal);
$("modalBackdrop").addEventListener("click", closeModal);
function closeModal() {
  $("modal").classList.add("hidden");
}
