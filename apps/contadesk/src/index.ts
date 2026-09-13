import path from "node:path";
import { openDb } from "./db.js";
import { seedDemo } from "./seed.js";
import { buildProvider } from "./ai/provider.js";
import { createServer } from "./server.js";
import { CentralGestClient } from "./integrations/centralgest.js";
import { startCentralGestMock } from "./integrations/centralgest-mock.js";
import { DocumentOcr } from "./ocr/engine.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join("data", "contadesk.db");
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join("data", "arquivo");

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  seedDemo(db);

  let centralgest = CentralGestClient.fromEnv();
  let centralgestLabel = "não configurado";
  if (centralgest) {
    centralgestLabel = process.env.CENTRALGEST_BASE_URL!;
  } else if (process.env.CENTRALGEST_MOCK === "1") {
    const mock = await startCentralGestMock("chave-demo");
    centralgest = new CentralGestClient({ baseUrl: mock.baseUrl, apiKey: "chave-demo" });
    centralgestLabel = `simulador local em ${mock.baseUrl}`;
  }

  const ocr = DocumentOcr.fromEnv();
  const app = createServer({ db, provider: buildProvider(), storageRoot: STORAGE_ROOT, centralgest, ocr });

  app.listen(PORT, () => {
    console.log(`ContaDesk a escutar em http://localhost:${PORT}`);
    console.log(`Fornecedor de IA: ${process.env.ANTHROPIC_API_KEY ? "Anthropic (claude-haiku-4-5)" : "heurístico local"}`);
    console.log(`CentralGest: ${centralgestLabel}`);
    console.log(`OCR: ${ocr.engines.join(" > ")}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
