// S-CUBUS Growth Studio — web server
// Instagram Graph API (competitors + own insights), Claude API (ideas & copy),
// Supabase (snapshots + idea history), password login.
"use strict";
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const cfg = {
  port: process.env.PORT || 3000,
  password: process.env.APP_PASSWORD || "",
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
  anthropicKey: process.env.ANTHROPIC_API_KEY || "",
  geminiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: process.env.GEMINI_MODEL || "gemini-flash-latest",
  model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
  igToken: process.env.IG_ACCESS_TOKEN || "",
  igUserId: process.env.IG_USER_ID || "",
  graph: "https://graph.facebook.com/" + (process.env.GRAPH_VERSION || "v23.0"),
  sbUrl: (process.env.SUPABASE_URL || "").replace(/\/$/, ""),
  sbKey: process.env.SUPABASE_ANON_KEY || "",
  storeSecret: process.env.STORE_SECRET || "",
  tickKey: process.env.TICK_KEY || "",
};
const HANDLES = (process.env.IG_HANDLES || "s_cubus_dwarka,physicswallah,allen_career_institute,aakasheducation")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "200kb" }));

/* ---------- login (signed cookie) ---------- */
const COOKIE = "gs_session";
const sign = (v) => crypto.createHmac("sha256", cfg.secret).update(v).digest("base64url");
function makeToken() { const exp = Date.now() + 30 * 864e5; const v = "u." + exp; return v + "." + sign(v); }
function validToken(t) {
  if (!t) return false; const i = t.lastIndexOf("."); if (i < 0) return false;
  const v = t.slice(0, i), s = t.slice(i + 1); const good = sign(v);
  if (s.length !== good.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(good))) return false;
  return Number(v.split(".")[1]) > Date.now();
}
function readCookie(req, name) {
  const h = req.headers.cookie || ""; for (const part of h.split(";")) { const [k, ...r] = part.trim().split("="); if (k === name) return decodeURIComponent(r.join("=")); } return null;
}
function authed(req) { return !cfg.password || validToken(readCookie(req, COOKIE)); }
const attempts = new Map();
app.post("/api/login", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?";
  const a = attempts.get(ip) || { n: 0, t: Date.now() }; if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 10) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
  const pw = String((req.body && req.body.password) || "");
  const ok = cfg.password && pw.length === cfg.password.length && crypto.timingSafeEqual(Buffer.from(pw), Buffer.from(cfg.password));
  if (!ok) { a.n++; attempts.set(ip, a); return res.status(401).json({ error: "Wrong password." }); }
  attempts.delete(ip);
  res.setHeader("Set-Cookie", `${COOKIE}=${encodeURIComponent(makeToken())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}`);
  res.json({ ok: true });
});
app.post("/api/logout", (req, res) => { res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0`); res.json({ ok: true }); });
app.get("/api/me", (req, res) => res.json({ authed: authed(req), passwordSet: !!cfg.password }));
app.get("/tick", async (req, res) => {
  if (!cfg.tickKey || req.query.key !== cfg.tickKey) return res.status(403).send("forbidden");
  res.json(await tick("cron"));
});
app.use("/api", (req, res, next) => authed(req) ? next() : res.status(401).json({ error: "Please sign in." }));

app.get("/api/status", (req, res) => res.json({
  instagram: !!(cfg.igToken && cfg.igUserId), ai: !!(cfg.anthropicKey || cfg.geminiKey), store: !!(cfg.sbUrl && cfg.sbKey && cfg.storeSecret), cron: !!cfg.tickKey, handles: HANDLES,
}));

/* ---------- store: Supabase document RPCs (memory fallback) ---------- */
const mem = {};
async function rpc(fn, args) {
  const r = await fetch(`${cfg.sbUrl}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: cfg.sbKey, Authorization: `Bearer ${cfg.sbKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(Object.assign({ p_secret: cfg.storeSecret }, args)),
  });
  const t = await r.text(); if (!r.ok) throw new Error(`Store error ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const useStore = () => !!(cfg.sbUrl && cfg.sbKey && cfg.storeSecret);
const store = {
  async put(coll, id, data) { if (useStore()) return rpc("growth_doc_put", { p_coll: coll, p_id: id, p_data: data }); (mem[coll] = mem[coll] || {})[id] = Object.assign({ id }, data); },
  async get(coll, id) { if (useStore()) { const r = await rpc("growth_doc_get", { p_coll: coll, p_id: id }); return r || null; } return (mem[coll] || {})[id] || null; },
  async list(coll, limit) { if (useStore()) return (await rpc("growth_docs", { p_coll: coll, p_limit: limit || 500 })) || []; return Object.values(mem[coll] || {}).slice(-(limit || 500)); },
  async del(coll, id) { if (useStore()) return rpc("growth_doc_delete", { p_coll: coll, p_id: id }); if (mem[coll]) delete mem[coll][id]; },
};
const putSnapshot = (s) => store.put("snapshots", s.username + "_" + s.date, s);
const getSnapshots = () => store.list("snapshots", 2000);
async function addIdeas(items) { for (const it of items) await store.put("ideas", "r" + it.at + "_" + crypto.randomBytes(3).toString("hex"), it); }
async function getIdeas(limit) { const l = await store.list("ideas", 2000); return l.sort((a, b) => (a.at || 0) - (b.at || 0)).slice(-limit); }

/* ---------- Instagram Graph API ---------- */
const cache = new Map();
async function cached(key, ms, fn) { const c = cache.get(key); if (c && Date.now() - c.at < ms) return c.v; const v = await fn(); cache.set(key, { at: Date.now(), v }); return v; }
async function graph(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const r = await fetch(`${cfg.graph}/${pathAndQuery}${sep}access_token=${encodeURIComponent(cfg.igToken)}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || `Instagram returned ${r.status}`); e.code = j.error && j.error.code; throw e; }
  return j;
}
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10); // IST date
async function discover(handle) {
  const f = `business_discovery.username(${handle}){username,name,followers_count,media_count,media.limit(50){caption,like_count,comments_count,media_type,media_product_type,permalink,timestamp}}`;
  const j = await graph(`${cfg.igUserId}?fields=${encodeURIComponent(f)}`);
  const b = j.business_discovery || {};
  const media = ((b.media && b.media.data) || []).map(m => ({
    caption: m.caption || "", likes: m.like_count ?? null, comments: m.comments_count ?? null,
    type: m.media_product_type === "REELS" ? "REEL" : (m.media_type || "POST"), permalink: m.permalink, timestamp: m.timestamp,
  }));
  return { username: (b.username || handle).toLowerCase(), name: b.name || "", followers: b.followers_count ?? null, posts: b.media_count ?? null, media };
}
async function refreshCompetitors(force) {
  if (force) cache.delete("comp");
  return cached("comp", 15 * 60e3, async () => {
    const results = await Promise.allSettled(HANDLES.map(discover));
    const accounts = [], errors = {};
    results.forEach((r, i) => r.status === "fulfilled" ? accounts.push(r.value) : (errors[HANDLES[i]] = r.reason.message));
    const d = today();
    for (const a of accounts) if (a.followers != null) { try { await putSnapshot({ username: a.username, date: d, followers: a.followers, posts: a.posts }); } catch (e) { console.error(e.message); } }
    return { accounts, errors, fetchedAt: new Date().toISOString() };
  });
}
app.get("/api/competitors", async (req, res) => {
  if (!cfg.igToken || !cfg.igUserId) return res.status(409).json({ error: "not_configured" });
  try { res.json(await refreshCompetitors(!!req.query.refresh)); } catch (e) { res.status(502).json({ error: e.message }); }
});
async function loadOwn(force) {
  if (force) cache.delete("own");
  return cached("own", 30 * 60e3, async () => {
    const prof = await graph(`${cfg.igUserId}?fields=username,followers_count,media_count`);
    const until = Math.floor(Date.now() / 1000), since = until - 29 * 86400;
    const series = {}; const errors = [];
    for (const metric of ["follower_count", "reach"]) {
      try {
        const j = await graph(`${cfg.igUserId}/insights?metric=${metric}&period=day&since=${since}&until=${until}`);
        ((j.data && j.data[0] && j.data[0].values) || []).forEach(v => { const d = String(v.end_time).slice(0, 10); series[d] = series[d] || { date: d }; series[d][metric === "reach" ? "reach" : "gain"] = v.value; });
      } catch (e) { errors.push(metric + ": " + e.message); }
    }
    return { username: prof.username, followers: prof.followers_count, posts: prof.media_count, series: Object.values(series).sort((a, b) => a.date < b.date ? -1 : 1), errors };
  });
}
app.get("/api/own", async (req, res) => {
  if (!cfg.igToken || !cfg.igUserId) return res.status(409).json({ error: "not_configured" });
  try { res.json(await loadOwn(!!req.query.refresh)); } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/snapshots", async (req, res) => { try { res.json(await getSnapshots()); } catch (e) { res.status(502).json({ error: e.message }); } });
app.get("/api/reel-history", async (req, res) => { try { res.json(await getIdeas(300)); } catch (e) { res.status(502).json({ error: e.message }); } });
app.post("/api/reel-history", async (req, res) => {
  const items = (Array.isArray(req.body) ? req.body : []).slice(0, 10).map(r => ({
    title: String(r.title || "").slice(0, 300), hook: String(r.hook || "").slice(0, 500), topic: String(r.topic || "").slice(0, 120),
    theme: String(r.theme || "").slice(0, 300), emotion: String(r.emotion || "").slice(0, 80), format: String(r.format || "").slice(0, 200), at: Number(r.at) || Date.now(),
  }));
  try { await addIdeas(items); res.json({ ok: true }); } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- Claude ---------- */
function parseJson(text) {
  const t = String(text || "").trim();
  try { return JSON.parse(t); } catch (e) {}
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) { try { return JSON.parse(f[1]); } catch (e) {} }
  const a = Math.min(...["[", "{"].map(c => t.indexOf(c)).filter(i => i >= 0)); const z = Math.max(t.lastIndexOf("]"), t.lastIndexOf("}"));
  if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e) {} }
  return undefined;
}
/* ---------- AI: Claude (paid) or Gemini (free), with live web search ---------- */
function aiError(msg, code) { const e = new Error(msg); e.code = code; return e; }
// messages: [{role:"user"|"assistant", content}]; opts: {json, search, maxTokens}
async function geminiCall(messages, opts) {
  const body = {
    contents: messages.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    generationConfig: { temperature: 1, maxOutputTokens: opts.maxTokens || 8000 },
  };
  if (opts.search) body.tools = [{ google_search: {} }];
  else if (opts.json) body.generationConfig.responseMimeType = "application/json";
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.geminiModel)}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": cfg.geminiKey }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "Gemini returned " + r.status;
    // Some keys/models don't allow search: retry once without it
    if (opts.search && (r.status === 400 || r.status === 403) && !/API key/i.test(msg)) return geminiCall(messages, Object.assign({}, opts, { search: false }));
    throw aiError(msg, r.status === 429 ? "rate_limited" : /API key|API_KEY/i.test(msg) ? "bad_key" : /not found|is not supported/i.test(msg) ? "bad_model" : "upstream_error");
  }
  const cand = (j.candidates || [])[0] || {};
  const text = ((cand.content || {}).parts || []).map(p => p.text || "").join("");
  const sources = (((cand.groundingMetadata || {}).groundingChunks) || []).map(c => c.web).filter(Boolean).map(w => ({ title: w.title || w.uri, url: w.uri })).slice(0, 8);
  if (!text) throw aiError("Gemini returned an empty answer" + (cand.finishReason ? " (" + cand.finishReason + ")" : ""), "empty");
  return { text, sources };
}
async function claudeCall(messages, opts) {
  const body = { model: cfg.model, max_tokens: opts.maxTokens || 8000, messages };
  if (opts.search) body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (j.error && j.error.message) || "Claude returned " + r.status;
    if (opts.search && r.status === 400 && /tool|web_search/i.test(msg)) return claudeCall(messages, Object.assign({}, opts, { search: false }));
    throw aiError(msg, r.status === 429 ? "rate_limited" : r.status === 401 ? "bad_key" : r.status === 404 ? "bad_model" : "upstream_error");
  }
  const blocks = j.content || [];
  const text = blocks.filter(b => b.type === "text").map(b => b.text).join("");
  const sources = [];
  blocks.forEach(b => (b.citations || []).forEach(c => { if (c.url && !sources.find(s => s.url === c.url)) sources.push({ title: c.title || c.url, url: c.url }); }));
  return { text, sources: sources.slice(0, 8) };
}
async function aiRaw(messages, opts) {
  opts = opts || {};
  if (cfg.anthropicKey) return claudeCall(messages, opts);
  if (cfg.geminiKey) return geminiCall(messages, opts);
  throw aiError("No AI key is set. Add GEMINI_API_KEY (free) or ANTHROPIC_API_KEY in Render.", "not_configured");
}
async function aiJson(prompt, opts) {
  const tail = "\n\nYour whole final reply must be the JSON value only, with no other text before or after it.";
  const out = await aiRaw([{ role: "user", content: prompt + tail }], Object.assign({ json: true }, opts || {}));
  const data = parseJson(out.text);
  if (data === undefined) { console.error("AI non-JSON reply:", out.text.slice(0, 300)); throw aiError("The AI's answer wasn't in the expected format. Try again.", "invalid_json"); }
  return { data, sources: out.sources };
}
// kept for the Autopilot code below
async function claude(prompt, maxTokens) { return (await aiJson(prompt, { maxTokens, search: true })).data; }

function sendAiError(res, e) {
  console.error("AI error:", e.code || "", e.message);
  res.status(e.code === "not_configured" ? 409 : 502).json({ error: e.code || "upstream_error", message: e.message });
}
app.post("/api/ai", async (req, res) => {
  const prompt = String((req.body && req.body.prompt) || "").slice(0, 60000);
  if (!prompt) return res.status(400).json({ error: "empty_prompt" });
  const search = !!(req.body && req.body.search);
  const pre = search ? "Before answering, use web search to check what is current this week (today is " + today() + ", India): trending topics, news and exam dates that matter to Indian students and parents, and trending Instagram Reel formats in Indian education. Use what you find; never invent facts.\n\n" : "";
  try { const out = await aiJson(pre + prompt, { search }); res.json({ data: out.data, sources: out.sources }); }
  catch (e) { sendAiError(res, e); }
});
app.get("/api/ai-check", async (req, res) => {
  try { const out = await aiRaw([{ role: "user", content: 'Reply with exactly: {"ok":true}' }], { json: true, maxTokens: 50 }); res.json({ ok: true, provider: cfg.anthropicKey ? "Claude" : "Gemini", sample: out.text.slice(0, 40) }); }
  catch (e) { console.error("AI check failed:", e.message); res.json({ ok: false, error: e.code || "upstream_error", message: e.message, provider: cfg.anthropicKey ? "Claude" : cfg.geminiKey ? "Gemini" : null }); }
});

/* ---------- Marketing agent chat ---------- */
const AGENT_BRIEF = "You are the in-house Instagram marketing agent for S-CUBUS Dwarka, working for the director. You think like a senior social media strategist and you do the work, not just advise.\n" +
  "How you work on every request:\n" +
  "1. Work out the real goal (followers, SATHII registrations, admissions, trust with parents) and the audience.\n" +
  "2. Look at the live data below: S-CUBUS's own numbers, the three competitors, their best recent posts and the follower history.\n" +
  "3. Use web search for anything current: this week's news and trends for Indian students and parents, upcoming exam and result dates (CBSE, JEE, NEET), festivals, and trending Reel formats. Cite what you used.\n" +
  "4. Decide, then deliver finished work: exact hooks, scripts with shots, captions, hashtags, posting times, a plan with dates. Explain the reasoning in one or two lines, tied to the data or trend.\n" +
  "Rules: write like a person, with real human emotion and specific moments; Hinglish when it fits; no emoji; no clichés like 'dream big' or 'hard work pays off'. Never invent results, ranks, fees, dates or student names: write [PLACEHOLDER]. Never repeat ideas listed under 'Already used'. Keep answers well structured with short headings and bullet points. If data is missing, say what's missing and still give your best recommendation.";
async function agentContext() {
  const parts = ["Today: " + today() + " (India)."];
  try {
    if (cfg.igToken && cfg.igUserId) {
      const comp = await refreshCompetitors(false); const snaps = await getSnapshots();
      parts.push("LIVE INSTAGRAM DATA (fetched " + comp.fetchedAt + "):\n" + summarise(comp, snaps));
      try { const own = await loadOwn(false); parts.push(`S-CUBUS insights: ${own.followers} followers; new followers last 30 days ${(own.series || []).reduce((s, r) => s + (r.gain || 0), 0)}; reach last 30 days ${(own.series || []).reduce((s, r) => s + (r.reach || 0), 0)}.`); } catch (e) {}
    } else parts.push("Live Instagram data is not connected yet. Public estimates (HypeAuditor, Aug–Oct 2026): Physics Wallah 3.9M followers, 7.48% engagement, -1.05% 30-day growth; Allen 372K, 1.77%, flat; Aakash 278K, 0.65%, flat. S-CUBUS numbers unknown.");
  } catch (e) { parts.push("Live data failed to load: " + e.message); }
  try { const reps = (await store.list("reports", 5)).sort((a, b) => a.week < b.week ? 1 : -1); if (reps[0]) parts.push("Latest weekly brief (" + reps[0].week + "): " + (reps[0].headline || "") + " — " + (reps[0].summary || "")); } catch (e) {}
  try { const ideas = await getIdeas(60); if (ideas.length) parts.push("Already used (do not repeat):\n" + ideas.map(i => "- " + i.title).join("\n")); } catch (e) {}
  return parts.join("\n\n");
}
app.post("/api/agent", async (req, res) => {
  const msgs = (Array.isArray(req.body && req.body.messages) ? req.body.messages : []).slice(-12)
    .map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 8000) })).filter(m => m.content);
  if (!msgs.length || msgs[msgs.length - 1].role !== "user") return res.status(400).json({ error: "empty_prompt" });
  try {
    const ctx = await agentContext();
    const first = { role: "user", content: CONTEXT + "\n\n" + AGENT_BRIEF + "\n\n" + ctx + "\n\n---\nDirector's request:\n" + msgs[0].content };
    const convo = [first].concat(msgs.slice(1));
    const out = await aiRaw(convo, { search: true, maxTokens: 8000 });
    res.json({ text: out.text, sources: out.sources });
  } catch (e) { sendAiError(res, e); }
});

/* ---------- Autopilot: daily data refresh + Monday brief ---------- */
const CONTEXT = "S-CUBUS (S Cubus Educational Pvt. Ltd.) is a coaching institute in Dwarka, New Delhi, Instagram @s_cubus_dwarka. Courses: Foundation (Class 7–9), Class 10 boards, JEE and NEET (Class 11). It runs the SATHII Scholarship & Aptitude Examination for classes 7th–11th (always spell it SATHII). Hindi tagline: समर्पण · सुनिश्चित · सफलता. Competitors: Physics Wallah, Allen, Aakash (Aakash has a centre in Dwarka Sector 12B). Never invent results, ranks, percentages, dates or fees: use [PLACEHOLDER] in square brackets for facts you don't have.";
const ist = () => new Date(Date.now() + 5.5 * 3600e3);
function weekKey(d) { const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return t.getUTCFullYear() + "-W" + String(Math.ceil(((t - y) / 864e5 + 1) / 7)).padStart(2, "0"); }
let running = false;
async function getState() { return (await store.get("autopilot", "state")) || { log: [] }; }
async function logRun(state, kind, ok, msg) { state.log = [{ at: new Date().toISOString(), kind, ok, msg: String(msg).slice(0, 400) }].concat(state.log || []).slice(0, 60); await store.put("autopilot", "state", state); }
function summarise(comp, snaps) {
  const lines = (comp.accounts || []).map(a => {
    const recent = (a.media || []).filter(m => Date.now() - Date.parse(m.timestamp) < 30 * 864e5);
    const n = recent.length, L = recent.reduce((s, m) => s + (m.likes || 0), 0), C = recent.reduce((s, m) => s + (m.comments || 0), 0), reels = recent.filter(m => m.type === "REEL" || m.type === "VIDEO").length;
    const hist = snaps.filter(s => s.username === a.username).sort((x, y) => x.date < y.date ? -1 : 1); const first = hist.find(s => Date.now() - Date.parse(s.date) < 31 * 864e5);
    const ch = first && a.followers ? ((a.followers - first.followers) / first.followers * 100).toFixed(2) + "% since " + first.date : "no history yet";
    return `@${a.username}: ${a.followers} followers (${ch}), ${n} posts in 30 days, avg likes ${n ? Math.round(L / n) : "?"}, avg comments ${n ? Math.round(C / n) : "?"}, engagement ${n && a.followers ? ((L + C) / n / a.followers * 100).toFixed(2) + "%" : "?"}, reels ${n ? Math.round(reels / n * 100) : "?"}%`;
  });
  const top = (comp.accounts || []).filter(a => a.username !== "s_cubus_dwarka").flatMap(a => (a.media || []).filter(m => Date.now() - Date.parse(m.timestamp) < 14 * 864e5).map(m => Object.assign({ u: a.username }, m)))
    .sort((x, y) => ((y.likes || 0) + (y.comments || 0)) - ((x.likes || 0) + (x.comments || 0))).slice(0, 8)
    .map(m => `- @${m.u} [${m.type}, ${m.likes} likes, ${m.comments} comments] ${String(m.caption).replace(/\s+/g, " ").slice(0, 200)}`);
  return "ACCOUNTS:\n" + lines.join("\n") + "\n\nTOP COMPETITOR POSTS, LAST 14 DAYS:\n" + (top.join("\n") || "(none)");
}
async function weeklyReport() {
  const comp = (cfg.igToken && cfg.igUserId) ? await refreshCompetitors(true) : { accounts: [] };
  const snaps = await getSnapshots();
  let own = null; try { if (cfg.igToken && cfg.igUserId) own = await loadOwn(true); } catch (e) {}
  const past = (await getIdeas(80)).map(i => "- " + i.title).join("\n");
  const ownLine = own ? `Own account: ${own.followers} followers; new followers last 30 days: ${(own.series || []).reduce((s, r) => s + (r.gain || 0), 0)}; reach last 30 days: ${(own.series || []).reduce((s, r) => s + (r.reach || 0), 0)}.` : "Own insights unavailable.";
  const prompt = CONTEXT + "\n\nYou are the institute's head of social media. Write this week's Instagram growth brief for the director. Be specific to the numbers, plain and direct. No emoji. If data is missing, say what is missing instead of guessing.\n\n" + ownLine + "\n\n" + summarise(comp, snaps) +
    "\n\nAlso write 4 brand-new Instagram Reel ideas built on real human moments from students' and families' lives (different topic and emotion each; filmable on a phone; no clichés like 'dream big' or 'hard work pays off'). Do NOT repeat any of these earlier ideas:\n" + (past || "(none)") +
    '\n\nReply with JSON: {"headline":"one-line verdict on the week","summary":"3-4 sentences","growth":{"followers":number|null,"new_followers_30d":number|null,"growth_rate_30d_pct":number|null},"competitors":[{"handle":"","note":"what changed and what to learn"}],"wins":["..."],"watch":["..."],"actions":["3-5 concrete actions for this week"],"reels":[{"title":"","topic":"","emotion":"","moment":"","format":"","hook":"","shots":[""],"onscreen":"","caption":"","hashtags":[""],"why":""}],"plan":[{"day":"Mon","format":"Reel|Carousel|Post|Story","topic":"","note":""}]}';
  const data = await claude(prompt, 8000);
  const wk = weekKey(ist());
  await store.put("reports", wk, Object.assign({ week: wk, createdAt: new Date().toISOString() }, data));
  if (Array.isArray(data.reels)) await addIdeas(data.reels.map((r, i) => ({ title: String(r.title || ""), hook: String(r.hook || ""), topic: String(r.topic || ""), emotion: String(r.emotion || ""), format: String(r.format || ""), theme: "weekly", at: Date.now() + i })));
  return wk;
}
async function tick(source) {
  if (running) return { skipped: "busy" };
  running = true; const out = { source, at: new Date().toISOString(), ran: [] };
  try {
    const state = await getState(); const now = ist(); const d = now.toISOString().slice(0, 10); const h = now.getUTCHours();
    if (cfg.igToken && cfg.igUserId && h >= 9 && state.lastDaily !== d) {
      try { const c = await refreshCompetitors(true); try { await loadOwn(true); } catch (e) {} state.lastDaily = d; await logRun(state, "Daily refresh", true, `Saved follower counts for ${c.accounts.length} accounts`); out.ran.push("daily"); }
      catch (e) { await logRun(state, "Daily refresh", false, e.message); }
    }
    const wk = weekKey(now);
    if ((cfg.anthropicKey || cfg.geminiKey) && now.getUTCDay() === 1 && h >= 8 && state.lastWeekly !== wk) {
      try { await weeklyReport(); state.lastWeekly = wk; await logRun(state, "Weekly brief", true, `Report, 4 reel ideas and a 7-day plan for ${wk}`); out.ran.push("weekly"); }
      catch (e) { await logRun(state, "Weekly brief", false, e.message); }
    }
  } catch (e) { out.error = e.message; console.error("tick", e); }
  finally { running = false; }
  return out;
}
setInterval(() => tick("timer").catch(() => {}), 5 * 60e3);
setTimeout(() => tick("boot").catch(() => {}), 20e3);

app.get("/api/autopilot", async (req, res) => {
  try {
    const state = await getState(); const reports = (await store.list("reports", 20)).sort((a, b) => a.week < b.week ? 1 : -1);
    res.json({ state: { lastDaily: state.lastDaily || null, lastWeekly: state.lastWeekly || null, log: state.log || [] }, report: reports[0] || null, reports: reports.map(r => r.week) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get("/api/report/:week", async (req, res) => { try { res.json(await store.get("reports", String(req.params.week))); } catch (e) { res.status(502).json({ error: e.message }); } });
app.post("/api/autopilot/run", async (req, res) => {
  const job = String((req.body && req.body.job) || "");
  try {
    const state = await getState();
    if (job === "daily") { if (!cfg.igToken || !cfg.igUserId) return res.status(409).json({ error: "not_configured" }); const c = await refreshCompetitors(true); try { await loadOwn(true); } catch (e) {} state.lastDaily = today(); await logRun(state, "Daily refresh (manual)", true, `Saved follower counts for ${c.accounts.length} accounts`); return res.json({ ok: true }); }
    if (job === "weekly") { const wk = await weeklyReport(); state.lastWeekly = wk; await logRun(state, "Weekly brief (manual)", true, "Report created for " + wk); return res.json({ ok: true, week: wk }); }
    res.status(400).json({ error: "unknown job" });
  } catch (e) { try { await logRun(await getState(), job + " (manual)", false, e.message); } catch (x) {} res.status(e.code === "not_configured" ? 409 : 502).json({ error: e.code || "failed", message: e.message }); }
});

/* ---------- static ---------- */
app.use(express.static(path.join(__dirname, "public"), { maxAge: "1h", index: "index.html" }));
app.get("/healthz", (req, res) => res.send("ok"));
app.listen(cfg.port, () => console.log(`Growth Studio on :${cfg.port} — instagram:${!!cfg.igToken} ai:${cfg.anthropicKey ? "claude" : cfg.geminiKey ? "gemini" : "off"} store:${useStore()}`));
