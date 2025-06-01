import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import querystring from "querystring";
import axios from "axios";

import {
  sendMessage,
  getMessages,
  editMessage,
  deleteMessage,
} from "./slackClient.js";
import { WebClient } from "@slack/web-api";

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

const app = express();
const PORT = process.env.PORT || 5000;

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const FRONTEND_URI = process.env.VITE_FRONTEND_URI;

const SCOPE =
  "chat:write,chat:write.public,channels:history,groups:history,users:read";

app.use(cookieParser());

app.use(
  cors({
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://localhost:5173",
        "https://slack-f.vercel.app",
        "https://slack-b.onrender.com",
        "https://e69d-2406-b400-66-539-64b5-a596-8711-9b26.ngrok-free.app/auth/slack/callback",
        /\.ngrok-free\.app$/,
      ];

      if (
        !origin ||
        allowedOrigins.some((allowed) =>
          typeof allowed === "string"
            ? origin === allowed
            : allowed.test(origin)
        )
      ) {
        callback(null, origin); // Return the specific origin instead of true
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Origin",
      "Cache-Control",
      "Accept",
      "X-Requested-With",
    ],
    exposedHeaders: ["set-cookie"],
  })
);
app.options("*", cors());

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    cookies: req.cookies,
    env: {
      NODE_ENV: NODE_ENV,
      CLIENT_ID: !!CLIENT_ID,
      REDIRECT_URI: REDIRECT_URI,
    },
  });
});

const cookieDomain =
  process.env.NODE_ENV === "production" ? ".onrender.com" : undefined;

app.get("/debug/cookies", (req, res) => {
  res.json({
    cookies: req.cookies,
    headers: req.headers,
    env: process.env.NODE_ENV,
    domain: cookieDomain,
    secure: req.secure,
  });
});

app.get("/debug/auth-state", (req, res) => {
  res.json({
    authStateCookie: req.cookies.slack_auth_state,
    accessTokenCookie: req.cookies.slack_access_token,
    cookieHeaders: req.headers.cookie,
  });
});

app.get("/auth/status", async (req, res) => {
  const token = req.cookies.slack_access_token;

  if (!token) {
    console.log("No token found");

    return res.json({ authenticated: false });
  }

  try {
    const slack = new WebClient(token);
    const authTest = await slack.auth.test();
    console.log("Auth test success:", authTest);
    if (!authTest.ok) {
      throw new Error("Slack API returned invalid auth");
    }
    const userInfo = await slack.users.info({
      user: authTest.user_id,
    });
    console.log("User info:", userInfo.user);

    res.json({
      authenticated: true,
      user: {
        id: authTest.user_id,
        name: userInfo.user.real_name || userInfo.user.name,
        team: authTest.team,
        image:
          userInfo.user.profile?.image_512 ||
          userInfo.user.profile?.image_192 ||
          "",
      },
    });
  } catch (error) {
    console.error("Token validation failed:", {
      error: error.message,
      data: error.data,
      stack: error.stack,
    });

    res.clearCookie("slack_access_token", {
      domain: cookieDomain,
      path: "/",
    });

    res.json({ authenticated: false });
  }
});

app.get("/auth/slack", (req, res) => {
  const state = Math.random().toString(36).substring(7);
  res.cookie("slack_auth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    domain: cookieDomain,
    maxAge: 60000,
    path: "/",
  });

  const authUrl = `https://slack.com/oauth/v2/authorize?${querystring.stringify(
    {
      client_id: CLIENT_ID,
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      state: state,
      user_scope: "",
    }
  )}`;
  res.redirect(authUrl);
});

app.get("/auth/refresh", async (req, res) => {
  const token = req.cookies.slack_access_token;
  console.log(token);

  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const slack = new WebClient(token);
    const authTest = await slack.auth.test();

    res.json({
      token,
      user: {
        id: authTest.user_id,
        team: authTest.team,
      },
    });
  } catch (error) {
    res.status(401).json({ error: "Token refresh failed" });
  }
});
const getCookieOptions = (req) => ({
  httpOnly: true,
  secure: req.secure || req.headers["x-forwarded-proto"] === "https",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  domain: process.env.NODE_ENV === "production" ? ".onrender.com" : undefined,
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
});

app.get("/auth/slack/callback", async (req, res) => {
  const { code, state, error } = req.query;
  console.log(code, state);

  if (error) {
    console.error("Slack OAuth error:", error);
    return res.redirect(`${FRONTEND_URI}/?auth_error=1&slack_error=${error}`);
  }

  if (
    !state ||
    !req.cookies.slack_auth_state ||
    state !== req.cookies.slack_auth_state
  ) {
    console.error("State mismatch", {
      received: state,
      expected: req.cookies.slack_auth_state,
      cookies: req.cookies,
    });
    return res.redirect(`${FRONTEND_URI}/?auth_error=1&reason=state_mismatch`);
  }

  try {
    const response = await axios.post(
      "https://slack.com/api/oauth.v2.access",
      querystring.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    if (!response.data.ok) {
      console.error("Slack API Error:", response.data.error);
      return res.redirect(
        `${FRONTEND_URI}/?auth_error=1&reason=${encodeURIComponent(
          response.data.error || "slack_api_error"
        )}`
      );
    }

    console.log(
      "Slack OAuth response:",
      JSON.stringify(response.data, null, 2)
    );

    const cookieOptions = getCookieOptions(req);

    console.log(cookieOptions);

    res.cookie("slack_access_token", response.data.access_token, cookieOptions);

    res.clearCookie("slack_auth_state", {
      httpOnly: true,
      secure: cookieOptions.secure,
      sameSite: cookieOptions.sameSite,
      domain: cookieOptions.domain,
      path: "/",
    });

    res.redirect(`${FRONTEND_URI}/?auth_success=1`);
  } catch (error) {
    console.error("Full OAuth Error:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack,
    });
    res.redirect(
      `${FRONTEND_URI}/?auth_error=1&reason=${encodeURIComponent(
        error.response?.data?.error || "unknown"
      )}`
    );
  }
});

app.get("/cookie-test", (req, res) => {
  res.json({
    cookiesReceived: req.cookies,
    headers: req.headers["cookie"],
    env: process.env.NODE_ENV,
  });
});

app.get("/env-check", (req, res) => {
  res.json({
    env: process.env.NODE_ENV,
    cookieDomain:
      process.env.NODE_ENV === "production"
        ? "slack-b.onrender.com"
        : "localhost",
    frontendUrl: process.env.VITE_FRONTEND_URI,
    usingHttps: req.secure,
  });
});

app.get("/auth/logout", (req, res) => {
  res.clearCookie("slack_access_token", {
    domain:
      process.env.NODE_ENV === "production"
        ? "slack-b.onrender.com"
        : undefined,
    path: "/",
  });
  res.clearCookie("slack_auth_visible", {
    domain:
      process.env.NODE_ENV === "production" ? "slack-f.vercel.app" : undefined,
    path: "/",
  });
  res.json({ success: true });
});

app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

app.use(express.json());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  next();
});

app.post("/api/messages", async (req, res) => {
  try {
    const token = req.cookies.slack_access_token || process.env.SLACK_BOT_TOKEN;
    const { channel, text, postAt } = req.body;

    if (!channel) throw new Error("Missing channel ID");
    if (!text || text.trim() === "")
      throw new Error("Message text cannot be empty");

    const timestamp = postAt ? Number(postAt) : null;

    const result = await sendMessage(channel, text, timestamp, token);
    res.json(result);
  } catch (error) {
    console.error("API Error:", {
      message: error.message,
      stack: error.stack,
      details: error.response?.data,
    });
    res.status(400).json({
      error: error.message,
      details: error.response?.data?.error || "No additional details",
    });
  }
});

app.get("/api/messages", async (req, res) => {
  try {
    const token = req.cookies.slack_access_token || process.env.SLACK_BOT_TOKEN;
    const { channel, ts, oldest, latest } = req.query;

    if (!channel) throw new Error("Channel is required");
    if (!ts && !oldest && !latest) {
      throw new Error("At least one timestamp or time range is required");
    }

    const params = {
      channel,
      ts: ts ? parseFloat(ts) : undefined,
      oldest: oldest ? parseFloat(oldest) : undefined,
      latest: latest ? parseFloat(latest) : undefined,
    };

    const result = await getMessages(params, token);
    res.json(result);
  } catch (error) {
    console.error("Retrieve Error:", error);
    res.status(400).json({
      error: error.message,
      details: error.response?.data?.error,
    });
  }
});

app.put("/api/messages", async (req, res) => {
  try {
    const token = req.cookies.slack_access_token || process.env.SLACK_BOT_TOKEN;
    const { channel, ts, text } = req.body;

    if (!channel || !ts || !text) {
      throw new Error("All fields are required");
    }

    const result = await editMessage(channel, ts, text, token);
    res.json(result);
  } catch (error) {
    console.error("Edit Error:", error);
    res.status(400).json({
      error: error.message,
      details: error.response?.data?.error,
    });
  }
});

app.delete("/api/messages", async (req, res) => {
  try {
    const token = req.cookies.slack_access_token || process.env.SLACK_BOT_TOKEN;
    const { channel, ts } = req.body;

    if (!channel || !ts) {
      throw new Error("Channel and timestamp are required");
    }

    const result = await deleteMessage(channel, ts, token);
    res.json(result);
  } catch (error) {
    console.error("Delete Error:", error);
    res.status(400).json({
      error: error.message,
      details: error.response?.data?.error,
    });
  }
});

app.use((err, req, res, next) => {
  console.error("Unhandled Error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`⏰ Current server time: ${new Date().toISOString()}`);
  console.log(`🔒 Slack token: ${SLACK_BOT_TOKEN ? "Exists" : "Missing!"}`);
});
