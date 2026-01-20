import "dotenv/config";
import express from "express";
import cors from "cors";
import router from "./routes.js";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.use(router);

app.listen(port, () => {
  console.log(`Backend listening on ${port}`);
});
