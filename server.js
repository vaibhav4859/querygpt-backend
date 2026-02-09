import "dotenv/config";
import crypto from "crypto";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
const allowedOrigin = process.env.ALLOWED_ORIGIN;
app.use(
  cors(
    allowedOrigin
      ? { origin: allowedOrigin }
      : {} // no option = allow all origins
  )
);
app.use(express.json());

const JIRA_DOMAIN = process.env.JIRA_DOMAIN || "";
const JIRA_EMAIL = process.env.JIRA_EMAIL || "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN || "";

const jiraAuthHeader =
  JIRA_EMAIL && JIRA_API_TOKEN
    ? "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64")
    : null;

/** GET /api/jira/issues — list issues assigned to user (X-User-Email header) */
app.get("/api/jira/issues", async (req, res) => {
  const email = req.get("X-User-Email");
  if (!email?.trim()) {
    return res.status(400).json({ error: "X-User-Email header required" });
  }
  if (!JIRA_DOMAIN || !jiraAuthHeader) {
    return res.status(503).json({ error: "Jira not configured" });
  }
  try {
    const base = JIRA_DOMAIN.replace(/\/$/, "");
    const jql = `assignee = "${email.trim()}" ORDER BY created DESC`;
    const url = `${base}/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}&fields=summary,status,key,project,assignee&maxResults=50`;
    const r = await fetch(url, {
      headers: { Accept: "application/json", Authorization: jiraAuthHeader },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const issues = (data.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields?.summary ?? "",
      status: i.fields?.status?.name ?? "",
      project: i.fields?.project?.key ?? "",
    }));
    res.json({ issues });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch Jira issues" });
  }
});

/** GET /api/jira/issue?key=CAV-1868 — single issue (by key/URL; no assignee check, can be any issue) */
app.get("/api/jira/issue", async (req, res) => {
  const key = (req.query.key || "").toString().trim().toUpperCase();
  if (!key) return res.status(400).json({ error: "query param key required" });
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return res.status(400).json({ error: "Invalid Jira key" });
  if (!JIRA_DOMAIN || !jiraAuthHeader) {
    return res.status(503).json({ error: "Jira not configured" });
  }
  try {
    const base = JIRA_DOMAIN.replace(/\/$/, "");
    const r = await fetch(`${base}/rest/api/2/issue/${key}`, {
      headers: { Accept: "application/json", Authorization: jiraAuthHeader },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({
      key: data.key,
      summary: data.fields?.summary ?? "",
      description: typeof data.fields?.description === "string" ? data.fields.description.trim() : "",
      status: data.fields?.status?.name ?? "",
      project: data.fields?.project?.key ?? "",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to fetch Jira issue" });
  }
});

const GEMINI_MODEL = "gemini-2.5-pro";
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Chat sessions: sessionId -> { chat, lastUsed } */
const chatSessions = new Map();

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [id, data] of chatSessions.entries()) {
    if (now - data.lastUsed > SESSION_TTL_MS) chatSessions.delete(id);
  }
}

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error:
          "Missing GEMINI_API_KEY",
      });
    }
    const { message, sessionId, systemInstruction } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'message'" });
    }

    pruneExpiredSessions();

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    let reply;
    let outSessionId = sessionId;

    const existing = sessionId && chatSessions.get(sessionId);
    if (existing) {
      const { chat } = existing;
      existing.lastUsed = Date.now();
      const response = await chat.sendMessage({ message });
      reply = response?.text ?? "No response.";
    } else {
      const config = systemInstruction && typeof systemInstruction === "string"
        ? { systemInstruction }
        : {};
      const chat = ai.chats.create({
        model: GEMINI_MODEL,
        config,
      });
      const response = await chat.sendMessage({ message });
      reply = response?.text ?? "No response.";
      outSessionId = crypto.randomUUID();
      chatSessions.set(outSessionId, { chat, lastUsed: Date.now() });
    }

    res.json({ reply, sessionId: outSessionId });
  } catch (err) {
    console.error(err);
    const status = err?.status ?? 500;
    const msg = err?.message ?? "Gemini request failed.";
    res.status(status).json({ error: msg });
  }
});

/** POST /api/chat/end — end a chat session (e.g. when user navigates away) */
app.post("/api/chat/end", (req, res) => {
  const { sessionId } = req.body ?? {};
  if (sessionId && typeof sessionId === "string") {
    chatSessions.delete(sessionId);
  }
  res.json({ ok: true });
});

export default app;

const PORT = process.env.PORT ?? 3001;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    if (!process.env.GEMINI_API_KEY) {
      console.warn(
        "Missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey and add it to .env"
      );
    }
  });
}
