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
import { ingestDocument } from "./pipeline.js";
import { applyStoredSettings } from "./settings.js";
import { microsoft365ConfigFromEnv, Microsoft365Client, OneDriveSync, Microsoft365Files } from "./integrations/microsoft365.js";
import { graphMailConfigFromEnv, GraphMailPoller } from "./channels/graphMail.js";

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.DB_PATH || path.join("data", "contai.db");
const STORAGE_ROOT = process.env.STORAGE_ROOT || path.join("data", "arquivo");

async function main(): Promise<void> {
  const db = openDb(DB_PATH);
  seedDefaultRules(db);
  // Definicoes guardadas na UI (cifradas) sobrepoem-se ao .env.
  const applied = applyStoredSettings(db);
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
  const ms365 = microsoft365ConfigFromEnv();
  const ms365Client = ms365 ? new Microsoft365Client(ms365) : null;
  const onedrive = ms365 && ms365Client ? new OneDriveSync(db, STORAGE_ROOT, ms365Client, ms365.rootFolder) : null;

  const app = createServer({
    db, provider, storageRoot: STORAGE_ROOT, centralgest, ocr, structured, demo, onedrive,
    mailer: ms365Client ? new Microsoft365Files(ms365Client) : null,
    // Em producao o contentor reinicia (restart: unless-stopped) e recarrega tudo com as novas definicoes.
    onSettingsSaved: process.env.NODE_ENV === "production" ? () => { console.log("Definições alteradas: a reiniciar."); process.exit(0); } : null,
  });

  const sys = (): number => {
    const row = db.prepare("SELECT id FROM users WHERE email = 'canais@contai.local'").get() as any;
    if (row) return row.id;
    return Number(db.prepare("INSERT INTO users (email, name, password_hash, role) VALUES ('canais@contai.local', 'Recepção automática', 'x', 'staff')").run().lastInsertRowid);
  };
  if (onedrive) {
    // Files dropped in a cost centre's "A receber" folder are ingested with that cost centre.
    onedrive.setIntake({ systemUserId: sys(), ingest: (i) => ingestDocument(db, provider, STORAGE_ROOT, { ...i, channel: "portal" }, ocr, structured) });
    onedrive.start(60_000);
  }
  const graphMail = ms365Client ? graphMailConfigFromEnv() : null;
  const imap = graphMail ? null : imapConfigFromEnv();
  let mailLabel = "inactivo";
  if (graphMail && ms365Client) {
    new GraphMailPoller(db, { provider, ocr, structured, storageRoot: STORAGE_ROOT, systemUserId: sys() }, ms365Client, graphMail).start();
    mailLabel = `Microsoft 365 (${graphMail.mailbox}, pasta ${graphMail.folder})`;
  } else if (imap) {
    new EmailPoller(db, { provider, ocr, structured, storageRoot: STORAGE_ROOT, systemUserId: sys() }, imap).start();
    mailLabel = `IMAP ${imap.host}`;
  }

  app.listen(PORT, () => {
    console.log(`Contas: ${demo ? "dados de demonstração activos" : "sem dados de demonstração"}; administração: ${adminLabel}`);
    console.log(`Cont.ai a escutar em http://localhost:${PORT}`);
    if (applied.length) console.log(`Definições da UI aplicadas: ${applied.join(", ")}`);
    console.log(`Fornecedor de IA: ${process.env.ANTHROPIC_API_KEY ? "Anthropic (claude-haiku-4-5)" : "heurístico local"}`);
    console.log(`CentralGest: ${centralgestLabel}`);
    console.log(`OCR: ${ocr.engines.join(" > ")}${structured ? " + extracção estruturada IA" : ""} + QR AT`);
    console.log(`Arquivo OneDrive: ${ms365 ? (ms365.siteId ? "SharePoint " + ms365.siteId : "OneDrive de " + ms365.driveUser) + " / " + ms365.rootFolder : "não configurado"}`);
    console.log(`Canais: email webhook ${process.env.INBOUND_EMAIL_SECRET ? "activo" : "inactivo"}, caixa de email ${mailLabel}, WhatsApp ${whatsappConfigFromEnv() ? "activo" : "inactivo"}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
