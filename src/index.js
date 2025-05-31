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
const SLACK_REDIRECT_URI = process.env.SLACK_REDIRECT_URI;
const FRONTEND_URI = process.env.VITE_FRONTEND_URI;

const SCOPE =
  "chat:write,chat:write.public,channels:history,groups:history,users:read";

app.use(cookieParser());

const allowedOrigins = ["http://localhost:5173", "https://slack-f.vercel.app"];

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
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

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    cookies: req.cookies,
    env: {
      NODE_ENV: NODE_ENV,
      CLIENT_ID: !!CLIENT_ID,
      REDIRECT_URI: SLACK_REDIRECT_URI,
    },
  });
});

app.options("*", cors());

app.get("/auth/status", async (req, res) => {
  const token = req.cookies.slack_access_token;

  if (!token) {
    return res.json({ authenticated: false });
  }

  try {
    const slack = new WebClient(token);
    const authTest = await slack.auth.test();
    const userInfo = await slack.users.info({
      user: authTest.user_id,
    });
    res.json({
      authenticated: true,
      user: {
        id: authTest.user_id,
        name: userInfo.user.real_name || userInfo.user.name,
        team: authTest.team,
        image:
          userInfo.user.profile?.image_512 ||
          userInfo.user.profile?.image_192 ||
          `https://avatars.slack-edge.com/${authTest.user_id}`,
      },
    });

    // const response = await slack.auth.test();
    // console.log("Auth status check:", {
    //   cookies: req.cookies,
    //   tokenPresent: !!token,
    //   authTestResponse: response,
    // });

    // res.json({
    //   authenticated: true,
    //   user: {
    //     id: response.user_id,
    //     name: response.user,
    //     team: response.team,
    //     image: `https://avatars.slack-edge.com/${response.user_id}`,
    //   },
    // });
  } catch (error) {
    res.clearCookie("slack_access_token");
    res.json({ authenticated: false });
  }
});

app.get("/auth/slack", (req, res) => {
  const state = Math.random().toString(36).substring(7);
  res.cookie("slack_auth_state", state, {
    httpOnly: true,
    secure: true,
    sameSite: "none",
    domain:
      process.env.NODE_ENV === "production"
        ? "slack-b.onrender.com"
        : undefined,
    maxAge: 60000,
    path: "/",
  });

  const authUrl = `https://slack.com/oauth/v2/authorize?${querystring.stringify(
    {
      client_id: CLIENT_ID,
      scope: SCOPE,
      redirect_uri: SLACK_REDIRECT_URI,
      state: state,
      user_scope: "",
    }
  )}`;
  res.redirect(authUrl);
});

app.get("/auth/slack/callback", async (req, res) => {
  const { code, state } = req.query;
  const storedState = req.cookies.slack_auth_state;

  if (!storedState || storedState !== state) {
    console.error("State mismatch", {
      storedState,
      state,
      cookies: req.cookies,
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
        redirect_uri: SLACK_REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    if (!response.data.ok) {
      console.error("Slack API Error:", response.data.error);
      return res.redirect(`${FRONTEND_URI}/?auth_error=1`);
    }

    console.log("OAuth exchange response:", {
      status: response.status,
      data: response.data,
    });

    res.cookie("slack_access_token", response.data.access_token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      domain:
        process.env.NODE_ENV === "production"
          ? "slack-b.onrender.com"
          : undefined,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });

    res.cookie("slack_auth_visible", "true", {
      secure: true,
      sameSite: "none",
      domain:
        process.env.NODE_ENV === "production"
          ? "slack-f.vercel.app"
          : undefined,
      maxAge: 30 * 24 * 60 * 60 * 1000,
      path: "/",
    });
    res.clearCookie("slack_auth_state", {
      domain:
        process.env.NODE_ENV === "production"
          ? "slack-b.onrender.com"
          : undefined,
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

app.get("/auth/logout", (req, res) => {
  res.clearCookie("slack_access_token", {
    domain: "slack-b.onrender.com",
    path: "/",
  });
  res.clearCookie("slack_auth_visible", {
    domain: "slack-f.vercel.app",
    path: "/",
  });
  res.redirect(`${FRONTEND_URI}/?logout_success=1`);
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
  console.log(
    `🔒 Slack token: ${process.env.SLACK_BOT_TOKEN ? "Exists" : "Missing!"}`
  );
});
