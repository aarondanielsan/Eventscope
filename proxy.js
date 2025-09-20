import express from "express";
import fetch from "node-fetch";
import cookieParser from "cookie-parser";

const PORT = 3000;
const LIGHTHOUSE_ACTIONS_URL = "https://api-cus.psav.com/lighthouse-api/production/api/flowsheets/flowsheet/GetActions";

const app = express();
app.use(cookieParser());

app.get("/lighthouse/getactions", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    res.status(400).json({ error: "Missing required date query parameter" });
    return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${requestId}] Proxying Lighthouse GetActions for ${date}`);

  try {
    const targetUrl = `${LIGHTHOUSE_ACTIONS_URL}?asOf=${encodeURIComponent(date)}`;
    const lighthouseRes = await fetch(targetUrl, {
      method: "GET",
      headers: {
        cookie: req.headers.cookie || "",
        "user-agent": req.headers["user-agent"] || "EventScope-Lighthouse-Proxy",
        accept: "application/json, text/plain, */*"
      }
    });

    const bodyText = await lighthouseRes.text();

    if (!lighthouseRes.ok) {
      console.error(
        `[${timestamp}] [${requestId}] Lighthouse responded with ${lighthouseRes.status}: ${bodyText?.slice(0, 200) || ""}`
      );
      res
        .status(lighthouseRes.status)
        .json({ error: "Lighthouse fetch failed", status: lighthouseRes.status, details: bodyText });
      return;
    }

    try {
      const json = JSON.parse(bodyText);
      res.json(json);
    } catch (parseErr) {
      console.error(`[${timestamp}] [${requestId}] Failed to parse Lighthouse response`, parseErr);
      res.status(502).json({ error: "Invalid JSON received from Lighthouse" });
    }
  } catch (err) {
    console.error(`[${timestamp}] [${requestId}] Lighthouse proxy error`, err);
    res.status(500).json({ error: "Failed to reach Lighthouse", details: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Lighthouse proxy available at http://localhost:${PORT}`);
});
