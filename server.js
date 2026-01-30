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

const PORT = process.env.PORT ?? 3001;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn(
      "Missing GEMINI_API_KEY. Get a free key at https://aistudio.google.com/apikey and add it to .env"
    );
  }
});
