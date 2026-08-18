// Crisp Conversations Dashboard - backend
//
// This runs server-side, so it talks to the Crisp REST API directly
// (server-to-server requests aren't subject to browser CORS rules).
// The frontend only ever talks to this server, never to Crisp directly.

const express = require("express");
const path = require("path");

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

async function crispGet(pathSuffix) {
  const res = await fetch(`${CRISP_API}${pathSuffix}`, { headers: authHeader() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Crisp API ${res.status}: ${body}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
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
    const [convRes, msgRes] = await Promise.all([
      crispGet(`/website/${CRISP_WEBSITE_ID}/conversation/${sessionId}`),
      crispGet(`/website/${CRISP_WEBSITE_ID}/conversation/${sessionId}/messages`),
    ]);
    res.json({ conversation: convRes.data, messages: msgRes.data || [] });
  } catch (e) {
    res.status(e.status || 500).json({ error: true, reason: e.message });
  }
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
  const maxPages = Math.min(parseInt(req.query.maxPages, 10) || 100, 200);

  const filterStart = start ? `&filter_date_start=${encodeURIComponent(new Date(start + "T00:00:00.000Z").toISOString())}` : "";
  const filterEnd = end ? `&filter_date_end=${encodeURIComponent(new Date(end + "T23:59:59.999Z").toISOString())}` : "";

  let page = 1;
  let hitCap = false;
  const conversations = [];

  try {
    while (page <= maxPages) {
      let json;
      try {
        json = await crispGet(
          `/website/${CRISP_WEBSITE_ID}/conversations/${page}?per_page=50${filterStart}${filterEnd}&order_date_updated=1`
        );
      } catch (e) {
        // Basic backoff on rate limiting, then retry once.
        if (e.status === 429) {
          await new Promise((r) => setTimeout(r, 1500));
          json = await crispGet(
            `/website/${CRISP_WEBSITE_ID}/conversations/${page}?per_page=50${filterStart}${filterEnd}&order_date_updated=1`
          );
        } else {
          throw e;
        }
      }
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
