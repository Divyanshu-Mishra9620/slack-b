import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import querystring from "querystring";
import axios from "axios";
import Token from "./models/Token.js";
import crypto from "crypto";

import {
  sendMessage,
  getMessages,
  editMessage,
  deleteMessage,
} from "./slackClient.js";
import { WebClient } from "@slack/web-api";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";

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
const NODE_ENV = process.env.NODE_ENV;
const MONGO_URI = process.env.MONGO_DB_URI;

mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
mongoose.connection.on("connected", () => console.log("MongoDB connected ✅"));
mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error:", err);
});

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
        "https://e0b4-2406-b400-66-2df1-8cb0-c840-8d6d-40e4.ngrok-free.app",
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
        callback(null, origin);
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
app.use(express.json());
app.options("*", cors());
app.use(
  morgan(":method :url :status :res[content-length] - :response-time ms")
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(
  "/favicon.ico",
  express.static(path.join(__dirname, "public/favicon.ico"))
);

app.get("/auth/status", async (req, res) => {
  const userId = req.query.userId;

  if (!userId) {
    console.log("No userId provided");
    return res.status(400).json({
      authenticated: false,
      error: "Missing userId",
      details: "No userId parameter provided in request",
    });
  }

  try {
    console.log(`Checking auth status for user: ${userId}`);
    const tokenEntry = await Token.findOne({ userId });

    if (!tokenEntry) {
      console.log(`No token entry found for user: ${userId}`);
      return res.json({
        authenticated: false,
        error: "No token found",
        details: "No token record exists for this user",
      });
    }

    if (!tokenEntry.accessToken) {
      console.log(`Empty access token for user: ${userId}`);
      return res.json({
        authenticated: false,
        error: "Invalid token",
        details: "Token record exists but accessToken is empty",
      });
    }

    console.log(`Found token for user: ${userId}, verifying with Slack...`);
    const slack = new WebClient(tokenEntry.accessToken);
    const authTest = await slack.auth.test();

    console.log("Slack auth test response:", authTest);

    if (!authTest.ok) {
      console.error("Slack auth test failed:", authTest.error);
      return res.json({
        authenticated: false,
        error: "Slack API authentication failed",
        details: authTest.error,
      });
    }

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
          "",
      },
    });
  } catch (error) {
    console.error("Token validation failed:", {
      error: error.message,
      stack: error.stack,
      response: error.response?.data,
    });

    res.status(500).json({
      authenticated: false,
      error: "Token validation failed",
      details: error.message,
    });
  }
});

app.get("/auth/slack", (req, res) => {
  try {
    const state = crypto.randomBytes(16).toString("hex");

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
  } catch (error) {
    console.error("Slack OAuth redirect error:", error);
    res.status(500).send("OAuth redirect error");
  }
});

app.get("/auth/slack/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) {
    return res.redirect(`${FRONTEND_URI}/?auth_error=missing_code`);
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
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    const { access_token, authed_user, team } = response.data;

    if (!response.data.ok || !access_token || !authed_user || !team) {
      return res.redirect(`${FRONTEND_URI}/?auth_error=invalid_response`);
    }

    await Token.findOneAndUpdate(
      { userId: authed_user.id, teamId: team.id },
      { accessToken: access_token },
      { upsert: true, new: true }
    );

    res.redirect(`${FRONTEND_URI}/?auth_success=1&user_id=${authed_user.id}`);
  } catch (error) {
    console.error(
      "Slack Auth Callback Error:",
      error.response?.data || error.message
    );
    res.redirect(`${FRONTEND_URI}/?auth_error=server_error`);
  }
});

app.get("/slack/token/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const tokenEntry = await Token.findOne({ userId });
    if (!tokenEntry) return res.status(404).json({ error: "Token not found" });

    res.json({ accessToken: tokenEntry.accessToken });
  } catch (error) {
    console.error("Token Fetch Error:", error);
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/logout/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await Token.findOneAndDelete({ userId });
    if (!result)
      return res.status(404).json({ message: "No session found for user" });

    res.json({ message: "User logged out successfully" });
  } catch (error) {
    console.error("Logout Error:", error);
    res.status(500).json({ error: "Logout failed" });
  }
});

app.post("/api/messages", async (req, res) => {
  try {
    const token = req.cookies.slack_access_token || SLACK_BOT_TOKEN;
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
    const token = req.cookies.slack_access_token || SLACK_BOT_TOKEN;
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
    const token = req.cookies.slack_access_token || SLACK_BOT_TOKEN;
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
    const token = req.cookies.slack_access_token || SLACK_BOT_TOKEN;
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
