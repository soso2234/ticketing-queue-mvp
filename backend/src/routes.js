import express from "express";
import crypto from "crypto";
import { redis } from "./redisClient.js"; 
import bcrypt from "bcrypt";
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
    // "10초마다 5명 입장" 가정 => 초당 5/10명 처리
    // 내 앞 사람 수 = position-1
    const BATCH_SIZE = Number(process.env.QUEUE_BATCH_SIZE || 5);
    const BATCH_INTERVAL_SEC = Number(process.env.QUEUE_BATCH_INTERVAL_SEC || 10);
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
// router.get("/queue", async (req, res) => {
//   try {
//     const result = await pool.query(
//       `SELECT id, user_id, status, created_at
//        FROM queue_entries
//        ORDER BY id DESC
//        LIMIT 50`
//     );
//     return res.json({ items: result.rows });
//   } catch (err) {
//     console.error("GET /queue failed:", err);
//     return res.status(500).json({ error: "internal_error" });
//   }
// });


/**
 * @swagger
 * /auth/kakao:
 *   get:
 *     summary: 카카오 로그인 시작 (Redirect)
 *     description: |
 *       카카오 인가 페이지로 302 Redirect 합니다.
 *       Swagger UI에서는 Try it out 대신 **브라우저에서 직접 이 URL을 열어** 테스트하세요.
 *     responses:
 *       302:
 *         description: 카카오 인가 페이지로 리다이렉트
 */
// 1) 카카오 로그인 시작: 카카오 인가 페이지로 리다이렉트
router.get("/auth/kakao", async (req, res) => {
  const clientId = process.env.KAKAO_REST_API_KEY;
  const redirectUri = process.env.KAKAO_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).json({ error: "missing_kakao_env" });
  }

  // CSRF 방지용 state (소규모라도 추천)
  const state = crypto.randomBytes(16).toString("hex");
  await redis.set(`oauth:kakao:state:${state}`, "1", { EX: 300 }); // 5분

  const authorizeUrl =
    `https://kauth.kakao.com/oauth/authorize` +
    `?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.redirect(authorizeUrl);

});


/**
 * @swagger
 * /auth/kakao/callback:
 *   get:
 *     summary: 카카오 로그인 콜백
 *     description: |
 *       카카오가 redirect_uri로 인가 코드를 전달하면, 서버가 토큰 교환 후 사용자 정보를 조회하고 DB에 저장합니다.
 *       일반적으로 사용자가 직접 호출하지 않고, 카카오 로그인 흐름에서 자동으로 호출됩니다.
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: state
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 로그인 성공(시연용 JSON)
 *       400:
 *         description: 잘못된 요청(code/state 누락 등)
 */
// 2) 콜백: code -> token -> userinfo -> DB upsert(SELECT/INSERT)
router.get("/auth/kakao/callback", async (req, res) => {
  try {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).json({ error, error_description });
    }
    if (!code) return res.status(400).json({ error: "missing_code" });
    if (!state) return res.status(400).json({ error: "missing_state" });

    // state 검증
    const stateKey = `oauth:kakao:state:${state}`;
    const okState = await redis.get(stateKey);
    if (!okState) return res.status(400).json({ error: "invalid_state" });
    await redis.del(stateKey);

    const clientId = process.env.KAKAO_REST_API_KEY;
    const redirectUri = process.env.KAKAO_REDIRECT_URI;
    const clientSecret = process.env.KAKAO_CLIENT_SECRET;

    // 1) access token 요청
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: String(code),
    });
    if (clientSecret) body.set("client_secret", clientSecret);

    const tokenResp = await fetch("https://kauth.kakao.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body,
    });

    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok) {
      return res.status(400).json({ error: "token_request_failed", details: tokenJson });
    }

    const accessToken = tokenJson.access_token;

    // 2) 사용자 정보 조회
    const meResp = await fetch("https://kapi.kakao.com/v2/user/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meJson = await meResp.json();
    if (!meResp.ok) {
      return res.status(400).json({ error: "me_request_failed", details: meJson });
    }

    const kakaoId = String(meJson.id);
    const nickname =
      meJson?.kakao_account?.profile?.nickname ??
      meJson?.properties?.nickname ??
      null;
    const email = meJson?.kakao_account?.email ?? null;
    const gender = meJson?.kakao_account?.gender ?? null;

    // 3) DB upsert
    const existing = await pool.query(
      `SELECT id FROM users WHERE kakao_id = $1 LIMIT 1`,
      [kakaoId]
    );

    let userRow;
    if (existing.rowCount === 0) {
      const ins = await pool.query(
        `INSERT INTO users (auth_provider, kakao_id, email, nickname, gender)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, auth_provider, kakao_id, email, nickname, gender, created_at`,
        ["KAKAO", kakaoId, email, nickname, gender]
      );
      userRow = ins.rows[0];
    } else {
      const upd = await pool.query(
        `UPDATE users
         SET email = COALESCE($2, email),
             nickname = COALESCE($3, nickname),
             gender = COALESCE($4, gender),
             updated_at = now()
         WHERE kakao_id = $1
         RETURNING id, auth_provider, kakao_id, email, nickname, gender, created_at`,
        [kakaoId, email, nickname, gender]
      );
      userRow = upd.rows[0];
    }

    // ===============================
    // ✅ 여기부터 "팝업 종료 + 부모창 알림"
    // ===============================
    const frontendOrigin = process.env.FRONTEND_ORIGIN || "http://localhost:4000";

    const payload = {
      ok: true,
      user: {
        id: userRow.id,
        auth_provider: userRow.auth_provider,
        kakao_id: userRow.kakao_id,
        email: userRow.email,
        nickname: userRow.nickname,
        gender: userRow.gender,
      },
    };

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Login Success</title>
        </head>
        <body>
          <script>
            (function () {
              try {
                var data = ${JSON.stringify(payload)};
                var targetOrigin = ${JSON.stringify(frontendOrigin)};
                if (window.opener && !window.opener.closed) {
                  window.opener.postMessage(data, targetOrigin);
                }
              } catch (e) {}
              window.close();
            })();
          </script>
          <noscript>로그인이 완료되었습니다. 이 창을 닫아주세요.</noscript>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("GET /auth/kakao/callback failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});


/* 
  ************************
  ************************
  자체 회원가입 
  ************************
  ************************
*/

// 회원가입 api
router.post("/auth/signup", async (req, res) => {
  try {
    const { email, password, nickname, gender } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });
    if (!password) return res.status(400).json({ error: "password is required" });

    // 정책: 자체가입은 LOCAL
    // (카카오 가입자와의 교차 중복 정책은 백엔드에서 추후 반영 가능)

    // 비밀번호 해시
    const passwordHash = await bcrypt.hash(password, 10);

    // 삽입 (중복은 UNIQUE 인덱스가 막아줌)
    const r = await pool.query(
      `INSERT INTO users (auth_provider, email, password, nickname, gender)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, auth_provider, email, nickname, gender, created_at`,
      ["LOCAL", email, passwordHash, nickname ?? null, gender ?? null]
    );

    return res.status(201).json({ ok: true, user: r.rows[0] });
  } catch (err) {
    // email UNIQUE 충돌 처리
    if (err?.code === "23505") {
      return res.status(409).json({ error: "email_already_exists" });
    }
    console.error("POST /auth/signup failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

// 로그인 api
router.post("/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required" });
    if (!password) return res.status(400).json({ error: "password is required" });

    const r = await pool.query(
      `SELECT id, auth_provider, email, password, nickname, gender
       FROM users
       WHERE email = $1
       LIMIT 1`,
      [email]
    );

    if (r.rowCount === 0) {
      return res.status(401).json({ error: "invalid_credentials" });
    }

    const user = r.rows[0];

    // 카카오 가입자는 자체 로그인 불가(정책을 여기서 강제)
    if (user.auth_provider !== "LOCAL") {
      return res.status(403).json({ error: "not_local_account" });
    }

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: "invalid_credentials" });

    // 다음 단계에서 JWT 발급할 예정. 지금은 성공 응답만.
    return res.json({
      ok: true,
      user: {
        id: user.id,
        auth_provider: user.auth_provider,
        email: user.email,
        nickname: user.nickname,
        gender: user.gender,
      },
    });
  } catch (err) {
    console.error("POST /auth/login failed:", err);
    return res.status(500).json({ error: "internal_error" });
  }
});

/*
  ************************
  ************************
  카카오 로그아웃
  ************************
  ************************
*/

// 카카오 로그아웃 시작: 카카오 로그아웃 페이지로 리다이렉트
router.get("/auth/kakao/logout", (req, res) => {
  const clientId = process.env.KAKAO_REST_API_KEY;
  const logoutRedirectUri = process.env.KAKAO_LOGOUT_REDIRECT_URI;

  if (!clientId) return res.status(500).send("missing KAKAO_REST_API_KEY");
  if (!logoutRedirectUri) return res.status(500).send("missing KAKAO_LOGOUT_REDIRECT_URI");

  const url =
    "https://kauth.kakao.com/oauth/logout" +
    `?client_id=${encodeURIComponent(clientId)}` +
    `&logout_redirect_uri=${encodeURIComponent(logoutRedirectUri)}`;

  return res.redirect(url);
});

// 카카오 로그아웃 완료 후 돌아오는 콜백: 프론트 홈으로 보내기
router.get("/auth/kakao/logout/callback", (req, res) => {
  const frontendBase = process.env.FRONTEND_ORIGIN || "http://localhost:4000";
  return res.redirect(`${frontendBase}/`);
});


export default router;
