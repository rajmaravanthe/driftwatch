import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApiRouter } from "./routes/api.js";
import { MockInfraProvider } from "./engine/provider.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4000);

const provider = new MockInfraProvider();
const app = express();
app.use(express.json());

app.use("/api", createApiRouter(provider));

// In production (`npm run build && npm start`) serve the built SPA too.
// Server compiles to dist/server/, so ../web = dist/web/.
const webDist = path.resolve(__dirname, "../web");
if (fs.existsSync(webDist)) {
  app.use(express.static(webDist));
  app.get(/^\/(?!api\/).*/, (_req, res) => {
    res.sendFile(path.join(webDist, "index.html"));
  });
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[driftwatch] API listening on http://localhost:${PORT}`);
  console.log(`[driftwatch] platform: ${provider.platformLabel}`);
});

export { app };
