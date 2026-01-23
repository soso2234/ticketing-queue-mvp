import "dotenv/config";
import express from "express";
import cors from "cors";
import router from "./routes.js";
import crypto from "crypto";
//redis도 같이 가져오기
import { initRedis, redis } from "./redisClient.js"; 

import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger.js";
import { pool } from "./db.js";

const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 5);
const INTERVAL_MS = Number(process.env.QUEUE_BATCH_INTERVAL_MS || 3000);
const ADMISSION_TTL_SEC = Number(process.env.ADMISSION_TTL_SEC || 120);

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.use(router);

let running = false;

async function admitBatchOnce() {
  if (running) return;
  running = true;

  try {
    const eventIds = await redis.sMembers("queue:events");
    if (!eventIds.length) return;

    for (const eventId of eventIds) {
      const queueKey = `queue:${eventId}`;

      const qSize = await redis.zCard(queueKey);
      if (qSize === 0) continue;

      for (let i = 0; i < BATCH_SIZE; i++) {
        const popped = await redis.zPopMin(queueKey);

        const item =
          Array.isArray(popped)
            ? popped[0]
            : popped?.value
              ? popped
              : null;

        const queueToken = item?.value;
        if (!queueToken) break;

        const metaKey = `queue:token:${queueToken}`;
        const metaJson = await redis.get(metaKey);
        if (!metaJson) {
          await redis.del(`queue:state:${queueToken}`);
          continue;
        }

        const meta = JSON.parse(metaJson);
        const userId = meta.userId;

        const admissionToken = "a_" + crypto.randomBytes(10).toString("hex");

        await redis.set(`queue:state:${queueToken}`, "ADMITTED", { EX: ADMISSION_TTL_SEC });
        await redis.set(`queue:admission:${queueToken}`, admissionToken, { EX: ADMISSION_TTL_SEC });

        await redis.set(
          `admission:${admissionToken}`,
          JSON.stringify({ queueToken, userId, eventId, admittedAt: Date.now() }),
          { EX: ADMISSION_TTL_SEC }
        );

        console.log(`[ADMIT] event=${eventId} token=${queueToken} user=${userId} admission=${admissionToken}`);
      }
    }
  } catch (e) {
    console.error("admitBatchOnce failed:", e);
  } finally {
    running = false;
  }
}

// Redis 먼저 연결
await initRedis();

// DB 연결 테스트
try {
  const r = await pool.query("SELECT now() as now");
  console.log("[PG] connected:", r.rows[0].now);
} catch (e) {
  console.error("[PG] connection failed:", e);
  process.exit(1);
}

// 그 다음에 입장 처리기 시작
setInterval(admitBatchOnce, INTERVAL_MS);
admitBatchOnce();

// 마지막에 서버 listen
app.listen(port, () => {
  console.log(`Backend listening on ${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api-docs`);
});
