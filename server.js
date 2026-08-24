// Crisp Conversations Dashboard - backend
//
// This runs server-side, so it talks to the Crisp REST API directly
// (server-to-server requests aren't subject to browser CORS rules).
// The frontend only ever talks to this server, never to Crisp directly.

const express = require("express");
const path = require("path");
const fs = require("fs");
const ExcelJS = require("exceljs");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CRISP_WEBSITE_ID = process.env.CRISP_WEBSITE_ID;
const CRISP_TOKEN_ID = process.env.CRISP_TOKEN_ID;
const CRISP_TOKEN_KEY = process.env.CRISP_TOKEN_KEY;
// Optional but strongly recommended. Accepts multiple passwords separated
// by commas (e.g. "letmein,supersecret2") so more than one person can have
// their own password.
const APP_PASSWORDS = (process.env.APP_PASSWORD || "")
  .split(",")
  .map((p) => p.trim())
  .filter(Boolean);

if (!CRISP_WEBSITE_ID || !CRISP_TOKEN_ID || !CRISP_TOKEN_KEY) {
  console.warn(
    "WARNING: CRISP_WEBSITE_ID / CRISP_TOKEN_ID / CRISP_TOKEN_KEY are not fully set. " +
      "Set them as environment variables before deploying for real use."
  );
}
if (!APP_PASSWORDS.length) {
  console.warn(
    "WARNING: APP_PASSWORD is not set. Anyone with the URL will be able to read your " +
      "Crisp conversations. Set APP_PASSWORD as an environment variable to lock this down."
  );
}

const CRISP_API = "https://api.crisp.chat/v1";

function authHeader() {
  const token = Buffer.from(`${CRISP_TOKEN_ID}:${CRISP_TOKEN_KEY}`).toString("base64");
  return {
    Authorization: `Basic ${token}`,
    "X-Crisp-Tier": "website",
    "Content-Type": "application/json",
  };
}

// Retries on 429 with exponential backoff (honoring Retry-After when Crisp
// sends one), since large scans can run into rate limiting across many pages.
async function crispGet(pathSuffix, maxRetries = 6) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${CRISP_API}${pathSuffix}`, { headers: authHeader() });
    if (res.ok) return res.json();

    const body = await res.text().catch(() => "");
    if (res.status === 429 && attempt < maxRetries) {
      const retryAfter = parseFloat(res.headers.get("retry-after"));
      const delayMs = !isNaN(retryAfter) ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 20000);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    const err = new Error(`Crisp API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
}

// ---- Data collection sheet lookup ----
// Coders manually review conversations and log them (by session ID) into a
// separate Excel workbook. We read it straight off disk and join on session
// ID so that data shows up next to the conversation when someone looks it
// up. The workbook lives outside git (see .gitignore) since it holds
// program data - drop your own copy at data/sister-unathi-collection-sheet.xlsx.
const COLLECTION_SHEET_PATH = path.join(__dirname, "data", "sister-unathi-collection-sheet.xlsx");
const COLLECTION_SHEET_NAME = "Sister Unathi Capture";

let collectionSheetCache = { mtimeMs: 0, bySessionId: new Map() };

function normalizeSessionId(id) {
  return (id || "")
    .toString()
    .trim()
    .toLowerCase()
    .replace(/^session_/, "");
}

// Reads a formula cell's cached result (Excel computes this on save), a
// hyperlink's display text, or returns undefined - we have no formula
// engine to compute one ourselves.
function cellValue(cell) {
  let value = cell.value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (value && typeof value === "object") {
    if (value.result !== undefined && value.result !== null && typeof value.result !== "object") return value.result;
    if (value.text !== undefined) return value.text;
    return undefined;
  }
  return value;
}

// Re-parses the workbook only when its mtime changes, so edits made in
// Excel/Sheets show up on the next lookup without restarting the server.
async function loadCollectionSheet() {
  let stat;
  try {
    stat = fs.statSync(COLLECTION_SHEET_PATH);
  } catch {
    collectionSheetCache = { mtimeMs: 0, bySessionId: new Map() };
    return collectionSheetCache;
  }
  if (stat.mtimeMs === collectionSheetCache.mtimeMs) return collectionSheetCache;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(COLLECTION_SHEET_PATH);
  const bySessionId = new Map();

  const sheet = workbook.getWorksheet(COLLECTION_SHEET_NAME);
  if (sheet) {
    const headers = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, colNumber) => {
      headers[colNumber] = (cell.value || "").toString().trim();
    });
    const sessionCol = headers.findIndex(
      (h) => h && /record id|session id/i.test(h)
    );

    if (sessionCol > 0) {
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        const rawId = row.getCell(sessionCol).value;
        const key = normalizeSessionId(rawId && rawId.toString());
        if (!key) return;

        const fields = [];
        headers.forEach((label, colNumber) => {
          if (!label || colNumber === sessionCol) return;
          const value = cellValue(row.getCell(colNumber));
          if (value === null || value === undefined || value === "") return;
          fields.push({ label, value: value.toString() });
        });
        if (fields.length) bySessionId.set(key, fields);
      });
    }
  }

  collectionSheetCache = { mtimeMs: stat.mtimeMs, bySessionId };
  return collectionSheetCache;
}

async function getCollectionRecord(sessionId) {
  const { bySessionId } = await loadCollectionSheet();
  return bySessionId.get(normalizeSessionId(sessionId)) || null;
}

// ---- Coding suggestions (columns J-W) ----
// These are the analytical fields a human coder fills in by reading the
// conversation (as opposed to A-I, which are mostly objective/demographic).
// This is a free, local keyword scan - no external API, no cost. It's a
// rough starting point for the coder, not a substitute for actually reading
// the conversation: it can only recognize phrasing it has a keyword for.
//
// Each field lists candidate values in priority order; the first one whose
// keywords appear anywhere in the transcript wins. `fallback` is used when
// nothing matches - preferring the sheet's own "Not applicable" / "Unknown/
// Not available" values (present on almost every list) over inventing one.
const KEYWORD_RULES = {
  "Primary Enquiry Category": {
    fallback: "Other",
    options: {
      "HIV prevention": ["prep", "pre-exposure", "prevent hiv", "cab-la", "cabotegravir", "lenacapavir", " len ", "pep "],
      "HIV testing": ["hiv test", "hiv status", "get tested for hiv"],
      STI: ["sti", "std", "sexually transmitted", "gonorrhea", "chlamydia", "syphilis", "herpes"],
      Contraception: ["contracept", "birth control", "family planning", "the pill", "iud", "implant"],
      Pregnancy: ["pregnan", "am i pregnant", "missed my period"],
      "Service access/navigation": ["nearest clinic", "find a clinic", "operating hours", "book an appointment", "mobile clinic"],
      "General SRH": ["sexual health", "reproductive health"],
    },
  },
  "HIV Prevention Method": {
    fallback: "Not applicable",
    options: {
      "Oral PrEP": ["oral prep", "prep pill", "daily prep", "truvada", "prep tablet"],
      "CAB-LA": ["cab-la", "cab la", "cabotegravir", "injectable prep", "bimonthly injection"],
      "Lenacapavir (LEN)": ["lenacapavir", "len injection", " len ", "six-monthly injection", "twice yearly injection", "twice-yearly injection"],
      PEP: ["pep ", "post-exposure prophylaxis", "post exposure"],
      Condoms: ["condom"],
      "HIV testing": ["hiv test", "hiv status"],
    },
  },
  "SRH Topic": {
    fallback: "Not applicable",
    options: {
      "STI information/testing": ["sti", "std", "sexually transmitted", "gonorrhea", "chlamydia", "syphilis", "herpes"],
      "Emergency contraception": ["emergency contracept", "morning after pill", "plan b"],
      Contraception: ["contracept", "birth control", "family planning", "the pill", "iud", "implant"],
      Pregnancy: ["pregnan"],
      "HIV testing": ["hiv test"],
      Condoms: ["condom"],
      "Sexual health": ["sexual health", "reproductive health"],
    },
  },
  "Service Enquiry Type": {
    fallback: "Not applicable",
    options: {
      "Nearest clinic": ["nearest clinic", "closest clinic"],
      "Service finder": ["find a clinic", "find a service", "service finder"],
      "Clinic availability": ["is the clinic open", "clinic availability"],
      "Operating hours": ["operating hours", "opening hours", "what time"],
      Appointment: ["appointment", "book a"],
      "Mobile clinic": ["mobile clinic", "mobile service"],
      "Provider request": ["speak to a nurse", "speak to a doctor", "talk to someone"],
      "PrEP access": ["get prep", "access prep", "where can i get prep"],
      "HIV testing service": ["where can i get tested", "hiv testing service"],
      "STI service": ["sti service", "sti clinic"],
      "Contraception service": ["get contraception", "contraception service"],
    },
  },
  "Referral Type": {
    fallback: "Not applicable",
    options: {
      "Facility/clinic referral": ["visit your nearest clinic", "go to a clinic", "referred to a clinic", "visit a clinic"],
      "Service Finder": ["service finder", "find a clinic near you"],
      "Healthcare provider/human agent": ["speak to a nurse", "speak to a counsellor", "connect you with", "human agent"],
      "Mobile service": ["mobile clinic", "mobile service"],
    },
  },
  "LEN Information Need": {
    fallback: "Not applicable",
    options: {
      "What LEN is / general information": ["what is len", "what len is", "lenacapavir is"],
      Eligibility: ["eligib", "qualify for len", "can i get len"],
      Availability: ["is len available", "len availability"],
      "Where to access": ["where can i get len", "where to access len"],
      "Dosing / six-monthly schedule": ["six-monthly", "every six months", "twice a year"],
      Effectiveness: ["how effective is len", "len effective"],
      Safety: ["is len safe", "len safety"],
      "Side effects": ["side effect"],
      Cost: ["how much does len cost", "len cost", "len price"],
      "Switching to LEN": ["switch to len", "change to len"],
    },
  },
  // Shared by Primary/Secondary Information Need - generic across topics.
  "Information Need": {
    fallback: "Not applicable",
    options: {
      "What it is / general information": ["what is", "what it is", "general information", "tell me about"],
      "Eligibility / suitability": ["eligib", "can i take", "suitable", "qualify"],
      Effectiveness: ["effective", "how well does", "success rate"],
      Safety: ["is it safe", "safety concern", " risk"],
      "Side effects": ["side effect"],
      "How to use / dosing": ["how to use", "how do i take", "dosage", "dose"],
      Adherence: ["adher", "miss a dose", "forget to take"],
      "Switching methods": ["switch method", "change method", "change from"],
      Availability: ["available", "in stock", "do you have"],
      "Where to access": ["where can i", "where do i get", "where to find"],
      Cost: ["cost", "price", "how much", "free of charge"],
      "Duration / protection period": ["how long does it last", "protection period", "duration"],
      "Drug interactions": ["interact", "interaction with", "mix with"],
      "Pregnancy / breastfeeding": ["pregnan", "breastfeed"],
      "Missed dose / injection": ["missed my", "forgot my injection", "late for my shot", "missed dose"],
    },
  },
};

const EMERGING_THEME_FLAGS = {
  "Possible GBV-related content mentioned - flag for review.": ["gender-based violence", "gender based violence", " gbv ", "abuse", "assault", "rape"],
  "Possible self-harm/crisis content mentioned - flag for review.": ["suicide", "self-harm", "self harm", "kill myself", "end my life"],
};

// Finds the first matching option's keyword anywhere in the transcript
// (messages checked in order), returning the matched value plus a short
// quote of the message it came from. Falls back when nothing matches.
function matchKeywords(messagesLower, rule) {
  for (const msg of messagesLower) {
    for (const [value, keywords] of Object.entries(rule.options)) {
      const hit = keywords.find((kw) => msg.text.includes(kw));
      if (hit) {
        const snippet = msg.text.length > 100 ? msg.text.slice(0, 100) + "…" : msg.text;
        return { value, note: `Matched "${hit.trim()}" in ${msg.who}: "${snippet}"` };
      }
    }
  }
  return { value: rule.fallback, note: "" };
}

function classifyConversation(messages) {
  const messagesLower = (messages || []).map((m) => {
    const who = m.from === "operator" ? "the bot" : "the visitor";
    let text;
    if (m.type === "text" || typeof m.content === "string") text = m.content || "";
    else text = "";
    return { who, text: ` ${text.toLowerCase()} ` };
  });
  // Topic fields (what the visitor is actually asking about) only scan the
  // visitor's own words. Sister Unathi's fixed opening message lists nearly
  // every topic it covers ("...PrEP, family planning, STIs, HIV treatment,
  // GBV...") - scanning bot text here would false-match that boilerplate on
  // almost every single conversation regardless of what was actually asked.
  const visitorLower = messagesLower.filter((m) => m.who === "the visitor");

  const primaryEnquiry = matchKeywords(visitorLower, KEYWORD_RULES["Primary Enquiry Category"]);
  const hivMethod = matchKeywords(visitorLower, KEYWORD_RULES["HIV Prevention Method"]);
  const srhTopic = matchKeywords(visitorLower, KEYWORD_RULES["SRH Topic"]);
  const lenNeed = matchKeywords(visitorLower, KEYWORD_RULES["LEN Information Need"]);
  // Service/referral/escalation reflect what the bot actually did, so these
  // scan the full transcript (bot text is the primary signal here).
  const serviceType = matchKeywords(messagesLower, KEYWORD_RULES["Service Enquiry Type"]);
  const referralType = matchKeywords(messagesLower, KEYWORD_RULES["Referral Type"]);

  // Primary/secondary information need: first two *distinct* matches found,
  // scanning message-by-message rather than stopping at the first message.
  const infoNeeds = [];
  for (const msg of visitorLower) {
    for (const [value, keywords] of Object.entries(KEYWORD_RULES["Information Need"].options)) {
      if (infoNeeds.some((n) => n.value === value)) continue;
      const hit = keywords.find((kw) => msg.text.includes(kw));
      if (hit) {
        const snippet = msg.text.length > 100 ? msg.text.slice(0, 100) + "…" : msg.text;
        infoNeeds.push({ value, note: `Matched "${hit.trim()}" in ${msg.who}: "${snippet}"` });
      }
      if (infoNeeds.length >= 2) break;
    }
    if (infoNeeds.length >= 2) break;
  }
  const primaryNeed = infoNeeds[0] || { value: "Not applicable", note: "" };
  const secondaryNeed = infoNeeds[1] || { value: "Not applicable", note: "" };

  const yesNo = (matched, notApplicableValue) => {
    if (matched.value === notApplicableValue || matched.value === "Other") return { value: "Unknown/Not available", note: "" };
    return { value: "Yes", note: matched.note };
  };
  const longActing = (() => {
    if (hivMethod.value === "CAB-LA" || hivMethod.value === "Lenacapavir (LEN)") return { value: "Yes", note: hivMethod.note };
    if (hivMethod.value === "Not applicable") return { value: "Unknown/Not available", note: "" };
    return { value: "No", note: hivMethod.note };
  })();
  const lenSpecific = (() => {
    if (hivMethod.value === "Lenacapavir (LEN)") return { value: "Yes", note: hivMethod.note };
    if (hivMethod.value === "Not applicable") return { value: "Unknown/Not available", note: "" };
    return { value: "No", note: hivMethod.note };
  })();
  const escalation = matchKeywords(messagesLower, {
    fallback: "Unknown/Not available",
    options: {
      Yes: ["connect you with a counsellor", "connect you to a nurse", "human agent", "our team will contact you", "escalate", "speak to a real person"],
    },
  });

  // Visitor-only, same reasoning as the topic fields above - the bot's own
  // fixed menu message name-drops "gender-based violence (GBV)" as a topic
  // it covers, which would otherwise false-flag every single conversation.
  const emergingTheme = (() => {
    for (const msg of visitorLower) {
      for (const [flag, keywords] of Object.entries(EMERGING_THEME_FLAGS)) {
        const hit = keywords.find((kw) => msg.text.includes(kw));
        if (hit) {
          const snippet = msg.text.length > 100 ? msg.text.slice(0, 100) + "…" : msg.text;
          return { value: flag, note: `Matched "${hit.trim()}" in ${msg.who}: "${snippet}"` };
        }
      }
    }
    return { value: "", note: "" };
  })();

  return [
    { label: "Primary Enquiry Category", ...primaryEnquiry },
    { label: "HIV Prevention Method", ...hivMethod },
    { label: "Primary Information Need", ...primaryNeed },
    { label: "Secondary Information Need", ...secondaryNeed },
    { label: "SRH Topic", ...srhTopic },
    { label: "Service-related Enquiry?", ...yesNo(serviceType, "Not applicable") },
    { label: "Service Enquiry Type", ...serviceType },
    { label: "Referral Requested/Provided?", ...yesNo(referralType, "Not applicable") },
    { label: "Referral Type", ...referralType },
    { label: "Long-acting PrEP Enquiry?", ...longActing },
    { label: "LEN-specific Enquiry?", ...lenSpecific },
    { label: "LEN Information Need", ...lenNeed },
    { label: "Human Support/Escalation?", ...escalation },
    { label: "Other / Emerging Theme", ...emergingTheme },
  ].map((f) => ({ label: f.label, value: f.value || "", note: f.note || "" }));
}

// ---- simple password gate for our own API (not Crisp's) ----
function requireAppPassword(req, res, next) {
  if (!APP_PASSWORDS.length) return next(); // no password configured -> open (not recommended)
  const provided = req.get("x-app-password");
  if (provided && APP_PASSWORDS.includes(provided)) return next();
  res.status(401).json({ error: true, reason: "bad_password" });
}

app.post("/api/login", (req, res) => {
  if (!APP_PASSWORDS.length) return res.json({ ok: true });
  const { password } = req.body || {};
  if (password && APP_PASSWORDS.includes(password)) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// ---- Fetch a single conversation (meta + messages) ----
app.get("/api/conversation/:sessionId", requireAppPassword, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const [convRes, msgRes, record] = await Promise.all([
      crispGet(`/website/${CRISP_WEBSITE_ID}/conversation/${sessionId}`),
      crispGet(`/website/${CRISP_WEBSITE_ID}/conversation/${sessionId}/messages`),
      getCollectionRecord(sessionId).catch(() => null),
    ]);
    res.json({ conversation: convRes.data, messages: msgRes.data || [], record });
  } catch (e) {
    res.status(e.status || 500).json({ error: true, reason: e.message });
  }
});

// ---- Coding suggestion for one conversation ----
// Takes the messages the frontend already fetched (avoids a second Crisp
// round trip) and keyword-scans them to propose codes for columns J-W.
// Free and local - no external API call. Read-only - nothing here writes
// to the spreadsheet.
app.post("/api/coding/:sessionId", requireAppPassword, (req, res) => {
  const { messages } = req.body || {};
  const suggestion = classifyConversation(Array.isArray(messages) ? messages : []);
  res.json({ suggestion });
});

// ---- Scan conversations across a date range (paginated internally) ----
// Streams one JSON object per line (newline-delimited) so the frontend can
// show real progress while pages are still being fetched from Crisp, then
// a final "done" line with the full result. Crisp's API doesn't expose a
// total conversation count up front, so there's no way to know the true
// number of pages ahead of time.
app.get("/api/scan", requireAppPassword, async (req, res) => {
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");

  const { start, end } = req.query;
  const maxPages = Math.min(parseInt(req.query.maxPages, 10) || 400, 400);

  const filterStart = start ? `&filter_date_start=${encodeURIComponent(new Date(start + "T00:00:00.000Z").toISOString())}` : "";
  const filterEnd = end ? `&filter_date_end=${encodeURIComponent(new Date(end + "T23:59:59.999Z").toISOString())}` : "";

  let page = 1;
  let hitCap = false;
  const conversations = [];

  try {
    while (page <= maxPages) {
      const json = await crispGet(
        `/website/${CRISP_WEBSITE_ID}/conversations/${page}?per_page=50${filterStart}${filterEnd}&order_date_updated=1&filter_inbox_id=all`
      );
      const items = json.data || [];
      if (items.length === 0) break;
      conversations.push(...items);
      res.write(JSON.stringify({ type: "progress", page, maxPages, loaded: conversations.length }) + "\n");
      if (items.length < 50) break; // last page
      page += 1;
      if (page > maxPages) {
        hitCap = true;
        break;
      }
    }

    const stats = { resolved: 0, pending: 0, unresolved: 0 };
    for (const c of conversations) {
      if (stats[c.state] !== undefined) stats[c.state] += 1;
    }

    res.write(
      JSON.stringify({
        type: "done",
        total: conversations.length,
        stats,
        hitCap,
        conversations: conversations.map((c) => ({
          session_id: c.session_id,
          state: c.state,
          created_at: c.created_at,
          updated_at: c.updated_at,
          nickname: (c.meta && c.meta.nickname) || "",
          email: (c.meta && c.meta.email) || "",
          phone: (c.meta && c.meta.phone) || "",
          last_message: (c.preview_message && c.preview_message.excerpt) || c.last_message || "",
        })),
      }) + "\n"
    );
    res.end();
  } catch (e) {
    res.write(JSON.stringify({ type: "error", reason: e.message }) + "\n");
    res.end();
  }
});

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Crisp dashboard running on port ${PORT}`);
});
