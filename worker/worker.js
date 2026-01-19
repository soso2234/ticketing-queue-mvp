import dotenv from "dotenv";
import { createClient } from "redis";
import pg from "pg";

dotenv.config();
const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

const redis = createClient({
  url: `redis://${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`,
});

async function main() {
  await redis.connect();
  console.log("Worker connected to Redis");

  // 데모: 3초마다 WAITING 중 가장 오래된 1명 -> ALLOWED로 변경
  setInterval(async () => {
    try {
      const r = await pool.query(
        "SELECT id FROM queue_entries WHERE status='WAITING' ORDER BY id ASC LIMIT 1"
      );
      if (r.rows.length === 0) return;

      const id = r.rows[0].id;
      await pool.query("UPDATE queue_entries SET status='ALLOWED' WHERE id=$1", [id]);
      await redis.publish("queue_events", JSON.stringify({ type: "ALLOWED", id }));
      console.log("Promoted queue entry:", id);
    } catch (e) {
      console.error("Worker error:", e.message);
    }
  }, 3000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
