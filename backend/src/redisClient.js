import { createClient } from "redis";

const REDIS_ENABLED = process.env.REDIS_ENABLED === "true";

export const redis = REDIS_ENABLED
  ? createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    })
  : null;

export async function initRedis() {
  if (!REDIS_ENABLED) {
    console.warn("Redis disabled (REDIS_ENABLED=false)");
    return;
  }

  //수정
  try {
    await redis.connect();
    console.log("Redis connected");
  } catch (err) {
    console.warn("Redis connection failed, continuing without Redis");
  }
}
