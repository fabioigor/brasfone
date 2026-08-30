import path from "node:path";
import { openDb } from "./db.js";
import { seedDemo } from "./seed.js";
import { buildProvider } from "./ai/provider.js";
import { createServer } from "./server.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join("data", "contadesk.db");
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join("data", "arquivo");

const db = openDb(DB_PATH);
seedDemo(db);

const app = createServer({ db, provider: buildProvider(), storageRoot: STORAGE_ROOT });

app.listen(PORT, () => {
  console.log(`ContaDesk a escutar em http://localhost:${PORT}`);
  console.log(`Fornecedor de IA: ${process.env.ANTHROPIC_API_KEY ? "Anthropic (claude-haiku-4-5)" : "heuristico local"}`);
});
