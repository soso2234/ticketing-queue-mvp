import express from "express";
import { pool } from "./db.js";

const router = express.Router();

// POST /queue/enter  { "userId": "user-001" }
router.post("/queue/enter", async (req, res) => {
  try {
    const { userId } = req.body || {};
    if (!userId) return res.status(400).json({ error: "userId is required" });

    const result = await pool.query(
      `INSERT INTO queue_entries (user_id, status)
       VALUES ($1, 'WAITING')
       RETURNING id, user_id, status, created_at`,
      [userId]
    );

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("POST /queue/enter failed:", err);
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
