import "dotenv/config";
import express from "express";
import cors from "cors";
import router from "./routes.js";
import { initRedis } from "./redisClient.js";

import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

/**
 * @swagger
 * /health:
 *   get:
 *     summary: 헬스체크
 *     responses:
 *       200:
 *         description: 정상
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:
 *                   type: string
 *                   example: ok
 */
app.get("/health", (req, res) => res.json({ status: "ok" }));


app.use(router);

// Redis init
await initRedis();

app.listen(port, () => {
  console.log(`Backend listening on ${port}`);
  console.log(`Swagger docs: http://localhost:${port}/api-docs`);
});
