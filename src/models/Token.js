import mongoose from "mongoose";

const tokenSchema = new mongoose.Schema({
  userId: { type: String, required: true, index: true },
  teamId: { type: String, required: true },
  accessToken: { type: String, required: true },
  createdAt: { type: Date, default: Date.now, expires: 2592000 },
});

export default mongoose.model("Token", tokenSchema);
