import swaggerJSDoc from "swagger-jsdoc";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Ticketing Queue API",
      version: "1.0.0",
    },
    servers: [{ 
      url: process.env.API_BASE_URL || "http://localhost:3000" 
    }],
  },
  apis: [
    path.join(__dirname, "server.js"),
    path.join(__dirname, "routes.js"),
  ],
});
