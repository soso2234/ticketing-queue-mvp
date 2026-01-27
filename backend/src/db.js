import pg from "pg";
const { Pool } = pg;

export const pool = new Pool({
	host: process.env.DB_HOST,
	port: Number(process.env.DB_PORT || 5432),
	user: process.env.DB_USER,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_NAME,
	
	// RDS는 기본적으로 SSL을 권장/요구하는 경우가 많음
	ssl: { rejectUnauthorized: false },
});

pool.on("connect", () => {
  console.log("PostgreSQL connected");
});

pool.on("error", (err) => {
  console.error("PostgreSQL pool error", err);
});