import "dotenv/config";
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
    const url = `${base}/rest/api/2/search?jql=${encodeURIComponent(jql)}&fields=summary,status,key,project,assignee&maxResults=50`;
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

app.post("/api/chat", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error:
          "Missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey and add it to .env",
      });
    }
    const { message } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'message'" });
    }

    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: message,
    });

    const reply = response.text ?? "No response.";
    res.json({ reply });
  } catch (err) {
    console.error(err);
    const status = err?.status ?? 500;
    const msg = err?.message ?? "Gemini request failed.";
    res.status(status).json({ error: msg });
  }
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
