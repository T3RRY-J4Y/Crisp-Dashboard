// CSV import: loads conversations from a CSV file instead of Crisp, then
// renders them through the same charts, KPIs and table as a live fetch.
//
// Works with the dashboard's own "Export CSV" output and with other files
// that have similar columns - headers are matched loosely (case, spaces and
// punctuation ignored, common aliases accepted). The file is parsed in the
// browser and never sent to the server.

// ---------- Parsing ----------
// RFC 4180-style parser: quoted fields, escaped quotes (""), newlines inside
// quotes, CRLF line endings and a leading BOM. The delimiter is detected from
// the header line, since Excel in some locales saves with semicolons.
function parseCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delim = [",", ";", "\t"].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ",");

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((v) => v.trim() !== ""));
}

// ---------- Column mapping ----------
const normKey = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

const COLUMN_ALIASES = {
  session_id: ["sessionid", "session", "recordid", "conversationid", "id"],
  state: ["state", "status", "conversationstate"],
  created_at: ["createdat", "created", "started", "startedat", "date", "startdate", "timestamp", "datecreated"],
  updated_at: ["updatedat", "updated", "ended", "endedat", "lastactivity", "lastupdated"],
  nickname: ["nickname", "name", "visitor", "visitorname", "fullname"],
  email: ["email", "emailaddress"],
  phone: ["phone", "phonenumber", "mobile", "cell", "cellphone", "msisdn"],
  last_message: ["lastmessage", "message", "excerpt", "preview"],
  channel: ["channel", "platform", "medium"],
  source: ["source", "acquisition", "whatsappsourcetype"],
  consent: ["consent", "popiaconsent", "popia"],
  age: ["age", "userage", "agegroup", "ageband", "agerange"],
  gender: ["gender", "usergender", "sex"],
  province: ["province", "userprovince", "location", "region"],
  path: ["path", "userpath", "journey"],
  dmpa_choice: ["dmpachoice", "dmpa"],
  reminder_optin: ["reminderoptin", "reminder", "optin"],
};
const COLUMN_LABELS = {
  session_id: "session ID", state: "status", created_at: "start date", updated_at: "last activity",
  nickname: "name", email: "email", phone: "phone", last_message: "last message", channel: "channel",
  source: "source", consent: "consent", age: "age", gender: "gender", province: "province", path: "path",
  dmpa_choice: "DMPA choice", reminder_optin: "reminder opt-in",
};

function mapColumns(header) {
  const keys = header.map(normKey);
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    // Exact alias first, in alias order, so "date" doesn't steal "updated".
    for (const a of aliases) {
      const idx = keys.indexOf(a);
      if (idx >= 0 && !Object.values(map).includes(idx)) {
        map[field] = idx;
        break;
      }
    }
  }
  return map;
}

// ---------- Value cleaning ----------
// Mirrors the server's extractProfile rules so imported data is counted the
// same way as live Crisp data.
const PROVINCE_ALIASES = {
  kzn: "KwaZulu-Natal", kwazulunatal: "KwaZulu-Natal", gp: "Gauteng", wc: "Western Cape", ec: "Eastern Cape",
  fs: "Free State", nw: "North West", northwest: "North West", nc: "Northern Cape", lp: "Limpopo", mp: "Mpumalanga",
  outsidesa: "Outside SA", outsidesouthafrica: "Outside SA",
};

function pickFrom(raw, allowed) {
  const v = (raw || "").trim();
  if (!v) return null;
  if (/^skip(ped)?$/i.test(v)) return "Skipped";
  return allowed.find((a) => normKey(a) === normKey(v)) || null;
}

function cleanAge(v) {
  return pickFrom(v, AGE_ORDER);
}
function cleanGender(v) {
  const s = (v || "").trim().toLowerCase();
  if (s === "f" || s === "woman") return "Female";
  if (s === "m" || s === "man") return "Male";
  return pickFrom(v, ["Female", "Male", "Other"]);
}
function cleanProvince(v) {
  return PROVINCE_ALIASES[normKey(v || "")] || pickFrom(v, PROVINCE_ORDER);
}
function cleanChannel(v) {
  const s = normKey(v || "");
  if (!s) return null;
  if (s.includes("whatsapp")) return "WhatsApp";
  if (s.includes("messenger") || s === "facebook" || s === "fb") return "Messenger";
  if (s.includes("instagram") || s === "ig") return "Instagram";
  if (s.includes("web") || s.includes("chat") || s.includes("site")) return "Web chat";
  return null;
}
function cleanSource(v) {
  const s = normKey(v || "");
  if (s === "ad" || s === "ads" || s.includes("advert")) return "Ad";
  if (s.includes("post")) return "Social post";
  return null;
}
const truthy = (v) => /^(yes|y|true|1|i agree|agree|agreed)$/i.test((v || "").trim());
function cleanState(v) {
  const s = (v || "").trim().toLowerCase();
  return ["resolved", "pending", "unresolved"].includes(s) ? s : s || "unknown";
}

// Accepts ISO dates, epoch milliseconds, Excel serial numbers and
// day-first dates (DD/MM/YYYY), which is how South African Excel saves them.
function parseDate(v) {
  const s = (v || "").trim();
  if (!s) return null;
  if (/^\d{12,14}$/.test(s)) return Number(s);
  if (/^\d{4,5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) return Math.round((serial - 25569) * 86400000);
  }
  const dmy = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (dmy) {
    const [, d, m, y, hh = 0, mm = 0, ss = 0] = dmy;
    const t = new Date(+y, +m - 1, +d, +hh, +mm, +ss).getTime();
    return isNaN(t) ? null : t;
  }
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function rowsToConversations(rows) {
  const [header, ...body] = rows;
  const map = mapColumns(header);
  const get = (r, f) => (map[f] === undefined ? "" : r[map[f]] ?? "");
  let skipped = 0;
  const conversations = [];

  body.forEach((r, i) => {
    const created = parseDate(get(r, "created_at"));
    if (map.created_at !== undefined && !created) {
      skipped += 1; // a dated file with an unreadable date can't be charted
      return;
    }
    const sid = get(r, "session_id").trim();
    conversations.push({
      session_id: sid || `csv_row_${i + 2}`,
      state: cleanState(get(r, "state")),
      created_at: created,
      updated_at: parseDate(get(r, "updated_at")) || created,
      nickname: get(r, "nickname").trim(),
      email: get(r, "email").trim(),
      phone: get(r, "phone").trim(),
      last_message: get(r, "last_message").trim(),
      imported: true,
      profile: {
        channel: cleanChannel(get(r, "channel")) || (map.channel === undefined ? null : "Web chat"),
        source: cleanSource(get(r, "source")),
        consent: truthy(get(r, "consent")),
        age: cleanAge(get(r, "age")),
        gender: cleanGender(get(r, "gender")),
        province: cleanProvince(get(r, "province")),
        path: get(r, "path").trim() || null,
        dmpa_choice: get(r, "dmpa_choice").trim() || null,
        reminder_optin: truthy(get(r, "reminder_optin")),
      },
    });
  });
  return { conversations, skipped, map };
}

// ---------- Loading into the dashboard ----------
async function importCsvFile(file) {
  if (!file) return;
  if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
    setNote(`"${file.name}" isn't a CSV file. Save it as CSV (comma separated) and try again.`, true);
    return;
  }
  if (file.size > 50 * 1024 * 1024) {
    setNote("That file is over 50 MB, which is too large to import in the browser.", true);
    return;
  }

  let parsed;
  try {
    const rows = parseCsv(await file.text());
    if (rows.length < 2) throw new Error("The file has no data rows.");
    parsed = rowsToConversations(rows);
    const recognised = Object.keys(parsed.map);
    if (!recognised.length) {
      throw new Error("None of the columns were recognised. Expected headers like Date, Age, Gender, Province or Channel.");
    }
    if (!parsed.conversations.length) throw new Error("No rows had a readable date.");
  } catch (e) {
    setNote("Couldn't import: " + e.message, true);
    return;
  }

  const { conversations, skipped, map } = parsed;
  const dates = conversations.map((c) => c.created_at).filter(Boolean).sort((a, b) => a - b);
  const start = dates.length ? isoDate(new Date(dates[0])) : null;
  const end = dates.length ? isoDate(new Date(dates[dates.length - 1])) : null;

  closeModal();
  clearPresetHighlight();
  $("filterBox").value = "";
  $("startDate").value = start || "";
  $("endDate").value = end || "";

  state.conversations = conversations;
  state.range = start && end ? { start, end } : null;
  state.page = 1;
  state.loading = false;
  state.imported = { name: file.name, rows: conversations.length, fields: Object.keys(map) };

  renderStats(state.conversations);
  resetInsights();
  renderTable();
  renderCharts();
  $("exportBtn").disabled = false;

  const missing = ["created_at", "age", "gender", "province", "channel"].filter((f) => map[f] === undefined);
  $("rangeSummary").textContent =
    `${fmtNum(conversations.length)} conversations imported from ${file.name}` +
    (start ? `, ${fmtDay(start + "T00:00:00")} to ${fmtDay(end + "T00:00:00")}.` : ".");
  $("importTitle").textContent = `Showing ${file.name}`;
  $("importDetail").textContent =
    `${fmtNum(conversations.length)} rows imported` +
    (skipped ? `, ${fmtNum(skipped)} skipped (unreadable date)` : "") +
    `. Recognised: ${Object.keys(map).map((f) => COLUMN_LABELS[f]).join(", ")}.` +
    (missing.length ? ` Not in file: ${missing.map((f) => COLUMN_LABELS[f]).join(", ")}.` : "");
  $("importBanner").classList.remove("hidden");
  setNote("");
  toast(`Imported ${fmtNum(conversations.length)} rows`);
}

function clearImport() {
  state.imported = null;
  $("importBanner").classList.add("hidden");
}

$("importBtn").addEventListener("click", () => $("csvInput").click());
$("csvInput").addEventListener("change", (e) => {
  importCsvFile(e.target.files[0]);
  e.target.value = ""; // allow re-importing the same file
});
$("importClear").addEventListener("click", () => $("resetBtn").click());
$("resetBtn").addEventListener("click", clearImport);
// A live fetch replaces whatever was imported.
$("fetchBtn").addEventListener("click", () => {
  if ($("startDate").value && $("endDate").value) clearImport();
});

// Drag and drop anywhere on the dashboard.
let dragDepth = 0;
const isFileDrag = (e) => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!isFileDrag(e) || $("app").classList.contains("hidden")) return;
  e.preventDefault();
  dragDepth += 1;
  $("dropOverlay").classList.remove("hidden");
});
window.addEventListener("dragover", (e) => {
  if (isFileDrag(e)) e.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropOverlay").classList.add("hidden");
});
window.addEventListener("drop", (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropOverlay").classList.add("hidden");
  if (!$("app").classList.contains("hidden")) importCsvFile(e.dataTransfer.files[0]);
});

// ---------- Viewing an imported row ----------
// Rows without a real Crisp session ID have no transcript to fetch, so the
// drawer shows the imported fields instead.
function openImportedRow(sessionId, returnFocus) {
  const c = state.conversations.find((x) => x.session_id === sessionId);
  if (!c) return;
  modalState.sessionId = sessionId;
  modalState.messages = [];
  modalState.conversationLoaded = true;
  modalState.coding = null;
  modalState.returnFocus = returnFocus || document.activeElement;
  switchModalTab("conversation");

  const modal = $("modal");
  modal.classList.remove("hidden", "closing");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
  $("drawerPanel").focus();

  const p = c.profile || {};
  $("modalTitle").textContent = c.nickname || "Unknown visitor";
  $("modalAvatar").outerHTML = avatarHtml(c.nickname).replace('class="avatar ', 'id="modalAvatar" class="avatar ');
  $("modalSub").innerHTML = `<span class="badge ${escapeHtml(c.state)}">${escapeHtml(c.state)}</span><span>Imported row</span>`;
  const item = (k, v) => (v ? `<div class="meta-item"><div class="k">${k}</div><div class="v">${escapeHtml(v)}</div></div>` : "");
  $("modalMeta").innerHTML =
    item("Email", c.email) + item("Phone", c.phone) + item("Channel", p.channel) + item("Age", p.age) +
    item("Gender", p.gender) + item("Province", p.province) + item("Path", p.path) +
    item("Started", c.created_at && fmtDate(c.created_at)) + item("Last activity", c.updated_at && fmtDate(c.updated_at));
  $("modalRecord").innerHTML = "";
  $("modalCoding").innerHTML = "";
  $("modalThread").innerHTML = `<div class="empty-state"><div class="empty-icon">${icon("file")}</div>
    <strong>Imported from CSV</strong>
    <p>${c.last_message ? `Last message: “${escapeHtml(c.last_message)}”` : "This row has no Crisp session ID, so there's no transcript to show."}</p></div>`;
}
