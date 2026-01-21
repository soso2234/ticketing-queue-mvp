import express from "express";
import crypto from "crypto";
import { redis } from "./redisClient.js"; 
import { pool } from "./db.js";
const RESERVATION_TTL_SEC = Number(process.env.RESERVATION_TTL_SEC || 120);


const router = express.Router();

/**
 * @swagger
 * /queue/enter:
 *   post:
 *     summary: 대기열 진입
 *     description: 사용자와 공연을 기준으로 대기열에 진입하고, 대기열 토큰을 발급한다. 
 *                  WAITING  →  ADMITTED  →  EXPIRED  →  COMPLETED
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userId
 *               - eventId
 *             properties:
 *               userId:
 *                 type: string
 *                 example: "user-001"
 *               eventId:
 *                 type: string
 *                 example: "E01"
 *     responses:
 *       200:
 *         description: 대기열 등록 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queueToken:
 *                   type: string
 *                   example: "q_2f3a9c1b4e91"
 *                 status:
 *                   type: string
 *                   example: "WAITING"
 *                 position:
 *                   type: integer
 *                   example: 12
 *                 expiresInSec:
 *                   type: integer
 *                   example: 3600
 *       400:
 *         description: 필수값 누락
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "userId is required"
 *       500:
 *         description: 서버 내부 오류
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "internal_error"
 */
router.post("/queue/enter", async (req, res) => {
  try {
    const { userId, eventId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });
    if (!eventId) return res.status(400).json({ error: "eventId is required" });

    // queueToken 발급
    const queueToken = "q_" + crypto.randomBytes(12).toString("hex");
    const now = Date.now();

    // Redis Key 설계
    const queueKey = `queue:${eventId}`;          // 공연별 대기열
    const metaKey = `queue:token:${queueToken}`;  // 토큰 메타
    const stateKey = `queue:state:${queueToken}`; // 상태

    // 시연용으로 1시간
    const TTL_SEC = 60 * 60;

    // 토큰 메타 저장 (유저/공연/진입시각)
    await redis.set(
      metaKey,
      JSON.stringify({ queueToken, userId, eventId, joinedAt: now }),
      { EX: TTL_SEC }
    );

    // 상태 저장
    await redis.set(stateKey, "WAITING", { EX: TTL_SEC });

    // 대기열에 등록
    await redis.zAdd(queueKey, [{ score: now, value: queueToken }]);

    // 이벤트 발행용 세트에 eventId 추가
    await redis.sAdd("queue:events", eventId);

    // 내 순번 계산
    const rank = await redis.zRank(queueKey, queueToken);
    const position = rank === null ? null : rank + 1;

    return res.json({
      queueToken,
      status: "WAITING",
      position,
      expiresInSec: TTL_SEC,
    });
  } catch (err) {
    console.error("POST /queue/enter failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/**
 * @swagger
 * /queue/status:
 *   get:
 *     summary: 대기열 상태 조회
 *     description: queueToken으로 현재 상태(WAITING/ADMITTED 등), 순번, 예상 대기시간을 조회한다.
 *     parameters:
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *         example: "q_f59389c651690733dfe705fa"
 *     responses:
 *       200:
 *         description: 조회 성공
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 queueToken:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: "WAITING"
 *                 position:
 *                   type: integer
 *                   example: 42
 *                 estimatedWaitSec:
 *                   type: integer
 *                   example: 24
 *                 expiresInSec:
 *                   type: integer
 *                   example: 3500
 *                 admissionToken:
 *                   type: string
 *                   nullable: true
 *                 admissionUrl:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: token 누락
 *       404:
 *         description: token not found
 */
router.get("/queue/status", async (req, res) => {
  try {
    const token = req.query.token;
    if (!token) return res.status(400).json({ error: "token is required" });

    const metaKey = `queue:token:${token}`;
    const stateKey = `queue:state:${token}`;

    const metaJson = await redis.get(metaKey);
    if (!metaJson) return res.status(404).json({ error: "token_not_found" });

    const meta = JSON.parse(metaJson);
    const { eventId } = meta;

    const status = (await redis.get(stateKey)) || "WAITING";

    // 남은 유효시간(초) - metaKey TTL 기준
    const ttlSec = await redis.ttl(metaKey); // -1, -2 일 수 있음
    const expiresInSec = ttlSec > 0 ? ttlSec : 0;

    // 현재 순번 계산
    const queueKey = `queue:${eventId}`;
    const rank = await redis.zRank(queueKey, token);
    const position = rank === null ? null : rank + 1;

    // 예상 대기시간 계산:
    // "3초마다 5명 입장" 가정 => 초당 5/3명 처리
    // 내 앞 사람 수 = position-1
    const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 5);
    const BATCH_INTERVAL_SEC = Number(process.env.QUEUE_BATCH_INTERVAL_SEC || 3);
    const perSec = BATCH_SIZE / BATCH_INTERVAL_SEC;

    let estimatedWaitSec = null;
    if (position !== null && status === "WAITING") {
      const ahead = Math.max(position - 1, 0);
      estimatedWaitSec = Math.ceil(ahead / perSec);
    }

    // ADMITTED 상태면 admissionToken/admissionUrl도 내려주기
    // worker가 아래 키를 만들어주면 됨:
    // queue:admission:{queueToken} = admissionToken (TTL 120 등)
    let admissionToken = null;
    let admissionUrl = null;

    if (status === "ADMITTED") {
      admissionToken = await redis.get(`queue:admission:${token}`);
      if (admissionToken) {
        admissionUrl = `/reserve?admissionToken=${encodeURIComponent(admissionToken)}`;
      }
    }

    return res.json({
      queueToken: token,
      status,
      position,
      estimatedWaitSec,
      expiresInSec,
      admissionToken,
      admissionUrl,
    });
  } catch (err) {
    console.error("GET /queue/status failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

 /**
  * @swagger
  * /reservation/start:
  *   post:
  *     summary: 입장 토큰 검증 및 예매(예약) 세션 시작
  *     description: admissionToken을 검증하고, 유효하면 reservationId를 발급한다.
  *     requestBody:
  *       required: true
  *       content:
  *         application/json:
  *           schema:
  *             type: object
  *             required:
  *               - admissionToken
  *             properties:
  *               admissionToken:
  *                 type: string
  *                 example: "a_123abc"
  *     responses:
  *       200:
  *         description: 예약 세션 생성 성공
  *         content:
  *           application/json:
  *             schema:
  *               type: object
  *               properties:
  *                 reservationId:
  *                   type: string
  *                   example: "r_9f8e7d6c"
  *                 expiresInSec:
  *                   type: integer
  *                   example: 120
  *                 userId:
  *                   type: string
  *                   example: "user-001"
  *                 eventId:
  *                   type: string
  *                   example: "E01"
  *       401:
  *         description: admissionToken이 유효하지 않음(만료/존재하지 않음)
  *       400:
  *         description: admissionToken 누락
  */
router.post("/reservation/start", async (req, res) => {
  try {
    const { admissionToken } = req.body || {};
    if (!admissionToken)
      return res.status(400).json({ error: "admissionToken is required" });

    // admissionToken 검증 (없으면 만료/위조/미발급)
    const admissionKey = `admission:${admissionToken}`;
    const payloadJson = await redis.get(admissionKey);
    if (!payloadJson) {
      return res.status(401).json({ error: "invalid_or_expired_admissionToken" });
    }

    const payload = JSON.parse(payloadJson);
    const { queueToken, userId, eventId } = payload;

    // reservationId 발급 + 예약 세션 저장 (TTL 120초)
    const reservationId = "r_" + crypto.randomBytes(10).toString("hex");
    const reservationKey = `reservation:${reservationId}`;

    await redis.set(
      reservationKey,
      JSON.stringify({
        reservationId,
        admissionToken,
        queueToken,
        userId,
        eventId,
        startedAt: Date.now(),
      }),
      { EX: RESERVATION_TTL_SEC }
    );

    await redis.del(admissionKey);

    return res.json({
      reservationId,
      expiresInSec: RESERVATION_TTL_SEC,
      userId,
      eventId,
    });
  } catch (err) {
    console.error("POST /reservation/start failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// GET /queue
router.get("/queue", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, user_id, status, created_at
       FROM queue_entries
       ORDER BY id DESC
       LIMIT 50`
    );
    return res.json({ items: result.rows });
  } catch (err) {
    console.error("GET /queue failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
