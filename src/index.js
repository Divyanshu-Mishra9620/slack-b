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

const CLIENT_ID = process.env.SLACK_CLIENT_ID;
const CLIENT_SECRET = process.env.SLACK_CLIENT_SECRET;
const REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const FRONTEND_URI = process.env.VITE_FRONTEND_URI;
const SCOPE = "chat:write,chat:write.public,channels:history,groups:history";

app.use(cookieParser());
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);
app.use(express.json());

app.use(
  cors({
    origin: FRONTEND_URI || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Origin"],
  })
);

app.options("*", cors());

app.use((req, res, next) => {
  console.log("Incoming cookies:", req.cookies);
  next();
});

app.get("/auth/status", async (req, res) => {
  const token = req.cookies.slack_access_token;

  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    const slack = new WebClient(token);
    const response = await slack.auth.test();

    res.json({
      authenticated: true,
      user: {
        id: response.user_id,
        name: response.user,
        team: response.team,
        image: `https://avatars.slack-edge.com/${response.user_id}`,
      },
    });
  } catch (error) {
    res.clearCookie("slack_access_token");
    res.json({ authenticated: false });
  }
});

app.get("/auth/slack", (req, res) => {
  const state = Math.random().toString(36).substring(7);
  res.cookie("slack_auth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
    domain: ".onrender.com",
    path: "/auth/slack/callback",
    maxAge: 1000 * 60 * 5,
  });

  const authUrl = `https://slack.com/oauth/v2/authorize?${querystring.stringify(
    {
      client_id: CLIENT_ID,
      scope: SCOPE,
      redirect_uri: REDIRECT_URI,
      state: state,
      user_scope: "chat:write",
    }
  )}`;

  res.redirect(authUrl);
});

app.get("/auth/slack/callback", async (req, res) => {
  console.log("Received cookies:", req.cookies); // Debug
  console.log("Query params:", req.query); // Debug
  const { code, state } = req.query;
  const storedState = req.cookies.slack_auth_state;

  if (!storedState || storedState !== state) {
    console.error("State mismatch!", {
      stored: storedState,
      received: state,
      allCookies: req.cookies,
    });
    return res.status(400).send("Invalid state parameter");
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
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const { access_token, authed_user } = response.data;
    res.cookie("slack_access_token", access_token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 30,
    });

    res.redirect(`${FRONTEND_URI}/?auth_success=1`);
  } catch (error) {
    console.error("OAuth Error:", error.response?.data || error.message);
    res.redirect(`${FRONTEND_URI}/?auth_error=1`);
  }
});

app.get("/auth/logout", (req, res) => {
  res.clearCookie("slack_access_token");
  res.redirect(`${FRONTEND_URI}/?logout_success=1`);
});

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
  console.log(
    `🔒 Slack token: ${process.env.SLACK_BOT_TOKEN ? "Exists" : "Missing!"}`
  );
});
