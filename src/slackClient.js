import { WebClient } from "@slack/web-api";
import dotenv from "dotenv";

const envFile =
  process.env.NODE_ENV === "production" ? ".env.production" : ".env.local";
dotenv.config({ path: envFile });

export const sendMessage = async (channel, text, postAt, token) => {
  try {
    const slack = new WebClient(token);
    const timestamp = postAt ? Number(postAt) : null;

    if (timestamp) {
      const now = Math.floor(Date.now() / 1000);

      if (timestamp <= now) {
        throw new Error("Scheduled time must be in the future");
      }
      if (timestamp > now + 120 * 24 * 60 * 60) {
        throw new Error("Cannot schedule beyond 120 days");
      }

      return await slack.chat.scheduleMessage({
        channel,
        text,
        post_at: timestamp,
      });
    }

    return await slack.chat.postMessage({ channel, text });
  } catch (error) {
    console.error("Slack API Error Details:", {
      message: error.message,
      data: error.data,
      code: error.code,
      status: error.status,
    });

    const errorMsg = error.data?.error || error.message || "Slack API error";
    throw new Error(errorMsg);
  }
};

export const getMessages = async (params, token) => {
  try {
    const slack = new WebClient(token);
    const { channel, ts, oldest, latest } = params;
    const options = {
      channel,
      inclusive: true,
      limit: 100,
    };

    if (ts) {
      options.latest = ts;
      options.oldest = ts;
    } else {
      if (oldest) options.oldest = oldest;
      if (latest) options.latest = latest;
    }

    const response = await slack.conversations.history(options);

    if (!response.messages || response.messages.length === 0) {
      throw new Error("No messages found");
    }

    return response.messages.map((msg) => ({
      ...msg,
      humanTime: new Date(parseFloat(msg.ts) * 1000).toISOString(),
    }));
  } catch (error) {
    console.error("Retrieve Error:", error.data || error.message);
    throw new Error(error.data?.error || "Failed to retrieve messages");
  }
};

export const editMessage = async (channel, ts, text, token) => {
  const slack = new WebClient(token);
  try {
    return await slack.chat.update({
      channel,
      ts,
      text,
    });
  } catch (error) {
    console.error("Edit Error:", error.data || error.message);
    throw new Error(error.data?.error || "Failed to edit message");
  }
};

export const deleteMessage = async (channel, ts, token) => {
  const slack = new WebClient(token);
  try {
    return await slack.chat.delete({
      channel,
      ts,
    });
  } catch (error) {
    console.error("Delete Error:", error.data || error.message);
    throw new Error(error.data?.error || "Failed to delete message");
  }
};
