import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import morgan from "morgan";

import {
  sendMessage,
  getMessages,
  editMessage,
  deleteMessage,
} from "./slackClient.js";

const app = express();
const PORT = process.env.PORT || 5000;

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

app.use(
  cors({
    origin: process.env.VITE_API_URL || "*",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Origin"],
  })
);

app.options("*", cors());

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
    const { channel, text, postAt } = req.body;

    if (!channel) throw new Error("Missing channel ID");
    if (!text || text.trim() === "")
      throw new Error("Message text cannot be empty");

    const timestamp = postAt ? Number(postAt) : null;

    const result = await sendMessage(channel, text, timestamp);
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

    const result = await getMessages(params);
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
    const { channel, ts, text } = req.body;

    if (!channel || !ts || !text) {
      throw new Error("All fields are required");
    }

    const result = await editMessage(channel, ts, text);
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
    const { channel, ts } = req.body;

    if (!channel || !ts) {
      throw new Error("Channel and timestamp are required");
    }

    const result = await deleteMessage(channel, ts);
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
