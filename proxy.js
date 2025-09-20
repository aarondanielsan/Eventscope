import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import tough from "tough-cookie";
import fetchOrig from "node-fetch";
import fetchCookie from "fetch-cookie";

const PORT = Number(process.env.PORT) || 3000;
const LIGHTHOUSE_ACTIONS_URL = "https://api-cus.psav.com/lighthouse-api/production/api/flowsheets/flowsheet/GetActions";

const allowedOriginPatterns = [
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  /^https?:\/\/0\.0\.0\.0(?::\d+)?$/i
];

const app = express();
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));

const corsOptions = {
  origin(origin, callback) {
    if (!origin || origin === "null") {
      return callback(null, true);
    }
    if (allowedOriginPatterns.some(pattern => pattern.test(origin))) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization", "X-LH-Auth"],
  exposedHeaders: ["Location"]
};

app.use(cors(corsOptions));
app.use((req, res, next) => {
  res.header("Vary", "Origin");
  const origin = req.headers.origin;
  if (!origin || origin === "null") {
    res.header("Access-Control-Allow-Origin", "null");
  }
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-LH-Auth");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  return next();
});

app.use((err, req, res, next) => {
  if (err && err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next(err);
});

const jar = new tough.CookieJar(undefined, { looseMode: true });
const fetch = fetchCookie(fetchOrig, jar);

function maskValue(value = "") {
  if (!value) return "none";
  if (value.length <= 8) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function filteredCookieHeader(req) {
  const inbound = req.get("x-lh-cookie") || req.headers.cookie || "";
  if (!inbound) return "";
  return inbound
    .split(";")
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^lh_auth=/i.test(part))
    .join("; ");
}

async function readBodyAsText(res) {
  try {
    return await res.text();
  } catch (err) {
    return "";
  }
}

app.post("/lighthouse/set-auth", async (req, res) => {
  const raw = (req.body?.token || "").trim();
  if (!raw) {
    return res.status(400).json({ error: "Missing token" });
  }
  if (!/^bearer\s+/i.test(raw)) {
    return res.status(400).json({ error: "Token must start with 'Bearer '" });
  }
  const normalized = `Bearer ${raw.replace(/^bearer\s+/i, "").trim()}`;
  const cookieOptions = {
    httpOnly: true,
    sameSite: "Lax",
    secure: !!req.secure,
    maxAge: 8 * 60 * 60 * 1000
  };
  res.cookie("lh_auth", normalized, cookieOptions);
  console.log(`[LH] stored proxy auth cookie (${maskValue(normalized)})`);
  return res.json({ ok: true });
});

app.post("/lighthouse/clear-auth", (req, res) => {
  res.clearCookie("lh_auth", { httpOnly: true, sameSite: "Lax", secure: !!req.secure });
  console.log("[LH] cleared proxy auth cookie");
  return res.json({ ok: true });
});

app.get("/lighthouse/getactions", async (req, res) => {
  const { date } = req.query;
  if (!date) {
    return res.status(400).json({ error: "Missing ?date=ISO string" });
  }

  const isoDate = String(date);
  const targetUrl = `${LIGHTHOUSE_ACTIONS_URL}?asOf=${encodeURIComponent(isoDate)}`;
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const forwardedAuth = (req.get("x-lh-auth") || req.get("authorization") || req.cookies?.lh_auth || "").trim();
  const forwardedCookies = filteredCookieHeader(req);

  console.log(`[LH ${requestId}] -> GET ${targetUrl}`);
  console.log(`[LH ${requestId}] auth header: ${forwardedAuth ? maskValue(forwardedAuth) : "none"}`);
  if (forwardedCookies) {
    console.log(`[LH ${requestId}] forwarding ${forwardedCookies.split(";").length} cookie(s)`);
  }

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        "User-Agent": req.headers["user-agent"] || "EventScope-Proxy/1.0",
        Accept: "application/json, text/plain, */*",
        ...(forwardedAuth ? { Authorization: forwardedAuth } : {}),
        ...(forwardedCookies ? { Cookie: forwardedCookies } : {})
      },
      redirect: "manual"
    });

    const { status } = response;
    const location = response.headers.get("location");
    const contentType = response.headers.get("content-type") || "";
    const setCookie = response.headers.raw()?.["set-cookie"] || [];

    console.log(`[LH ${requestId}] <- ${status}${location ? ` (location: ${location})` : ""}`);
    if (setCookie.length) {
      console.log(`[LH ${requestId}] lighthouse set-cookie: ${setCookie.map(cookie => cookie.split(";")[0]).join(", ")}`);
    }

    if (status === 301 || status === 302) {
      return res.status(401).json({ error: "Redirect to login", location });
    }

    if (status === 401 || status === 403) {
      const snippet = (await readBodyAsText(response)).slice(0, 500);
      console.warn(`[LH ${requestId}] unauthorized (${status}) ${snippet}`);
      return res.status(status).json({ error: "Unauthorized to Lighthouse", details: snippet });
    }

    if (!response.ok) {
      const snippet = (await readBodyAsText(response)).slice(0, 500);
      console.warn(`[LH ${requestId}] error ${status} ${snippet}`);
      return res.status(status).json({ error: `Lighthouse responded with ${status}`, details: snippet });
    }

    if (!contentType.toLowerCase().includes("application/json")) {
      const snippet = (await readBodyAsText(response)).slice(0, 500);
      console.warn(`[LH ${requestId}] unexpected content-type ${contentType}`);
      return res.status(502).json({ error: "Unexpected non-JSON response", snippet });
    }

    const json = await response.json();
    console.log(`[LH ${requestId}] success (${Array.isArray(json) ? json.length : Object.keys(json || {}).length} items)`);
    return res.json(json);
  } catch (err) {
    console.error(`[LH ${requestId}] proxy error`, err);
    return res.status(502).json({ error: "Proxy fetch failed", message: err?.message || String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`EventScope proxy listening on http://localhost:${PORT}`);
});
