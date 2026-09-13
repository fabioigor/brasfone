import path from "node:path";
import { openDb } from "./db.js";
import { seedDemo, bootstrapAdmin, demoModeFromEnv } from "./seed.js";
import { seedDefaultRules } from "./domain/balanceRules.js";
import { buildProvider } from "./ai/provider.js";
import { createServer } from "./server.js";
import { CentralGestClient } from "./integrations/centralgest.js";
import { startCentralGestMock } from "./integrations/centralgest-mock.js";
import { DocumentOcr } from "./ocr/engine.js";
import { buildStructuredExtractor } from "./extraction/analyse.js";
import { imapConfigFromEnv, EmailPoller } from "./channels/email.js";
import { whatsappConfigFromEnv } from "./channels/whatsapp.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join("data", "contai.db");
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join("data", "arquivo");

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  seedDefaultRules(db);
  const demo = demoModeFromEnv();
  if (demo) seedDemo(db);
  let adminLabel = "sem conta de administração definida (CONTAI_ADMIN_EMAIL / CONTAI_ADMIN_PASSWORD)";
  if (process.env.CONTAI_ADMIN_EMAIL && process.env.CONTAI_ADMIN_PASSWORD) {
    const r = bootstrapAdmin(db, process.env.CONTAI_ADMIN_EMAIL, process.env.CONTAI_ADMIN_PASSWORD);
    adminLabel = `${process.env.CONTAI_ADMIN_EMAIL} (${r === "created" ? "criada agora" : "já existia"})`;
  }

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
  const provider = buildProvider();
  const structured = buildStructuredExtractor();
  const app = createServer({ db, provider, storageRoot: STORAGE_ROOT, centralgest, ocr, structured, demo });

  const imap = imapConfigFromEnv();
  if (imap) {
    const sys = (): number => {
      const row = db.prepare("SELECT id FROM users WHERE email = 'canais@contai.local'").get() as any;
      if (row) return row.id;
      return Number(db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('canais@contai.local', 'Recepção automática', 'x', 'staff')").run().lastInsertRowid);
    };
    new EmailPoller(db, { provider, ocr, structured, storageRoot: STORAGE_ROOT, systemUserId: sys() }, imap).start();
  }

  app.listen(PORT, () => {
    console.log(`Contas: ${demo ? "dados de demonstração activos" : "sem dados de demonstração"}; administração: ${adminLabel}`);
    console.log(`Cont.ai a escutar em http://localhost:${PORT}`);
    console.log(`Fornecedor de IA: ${process.env.ANTHROPIC_API_KEY ? "Anthropic (claude-haiku-4-5)" : "heurístico local"}`);
    console.log(`CentralGest: ${centralgestLabel}`);
    console.log(`OCR: ${ocr.engines.join(" > ")}${structured ? " + extracção estruturada IA" : ""} + QR AT`);
    console.log(`Canais: email webhook ${process.env.INBOUND_EMAIL_SECRET ? "activo" : "inactivo"}, IMAP ${imap ? imap.host : "inactivo"}, WhatsApp ${whatsappConfigFromEnv() ? "activo" : "inactivo"}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
