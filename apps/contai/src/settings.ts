import crypto from "node:crypto";
import { Db, audit } from "./db.js";

/**
 * Integration settings editable in the UI (staff only) and stored encrypted in the database.
 * They are applied to process.env at startup, so every component keeps reading the environment;
 * a value saved in the UI overrides the .env file. Secrets are never sent back to the browser.
 */
export interface SettingDef {
  key: string;
  label: string;
  group: "ia" | "email" | "whatsapp" | "microsoft365" | "centralgest" | "gestobrig" | "android";
  secret: boolean;
  hint?: string;
  placeholder?: string;
}

export const SETTING_DEFS: SettingDef[] = [
  { key: "ANTHROPIC_API_KEY", label: "Chave da API Anthropic", group: "ia", secret: true, hint: "Activa o OCR por visão, a extracção estruturada e os agentes. Sem chave, a app usa o Tesseract local e o QR da AT." },
  { key: "CONTAI_OCR_MODEL", label: "Modelo de visão (OCR)", group: "ia", secret: false, placeholder: "claude-opus-5" },
  { key: "CONTAI_AGENT_MODEL", label: "Modelo dos agentes", group: "ia", secret: false, placeholder: "claude-opus-5" },
  { key: "MS365_MAIL_USER", label: "Caixa de correio Microsoft 365 (recomendado)", group: "email", secret: false, placeholder: "documentos@lumarcont.pt", hint: "Lida pela Graph API com a autenticação da aplicação Microsoft 365 configurada abaixo (permissão Mail.ReadWrite). Sem palavra-passe da caixa; as mensagens ficam marcadas como lidas e com a categoria Cont.ai." },
  { key: "MS365_MAIL_FOLDER", label: "Pasta a vigiar", group: "email", secret: false, placeholder: "inbox" },
  { key: "MS365_MAIL_POLL_SECONDS", label: "Intervalo de leitura Microsoft 365 (segundos)", group: "email", secret: false, placeholder: "120" },
  { key: "INBOUND_EMAIL_SECRET", label: "Segredo do webhook de email", group: "email", secret: true, hint: "Cabeçalho x-contai-secret enviado pelo serviço de email (Postmark, Mailgun, n8n...)." },
  { key: "IMAP_HOST", label: "Servidor IMAP (alternativa a Microsoft 365)", group: "email", secret: false, placeholder: "imap.exemplo.pt", hint: "Só para caixas fora do Microsoft 365. Ignorado quando a caixa Microsoft 365 acima está definida." },
  { key: "IMAP_PORT", label: "Porta IMAP", group: "email", secret: false, placeholder: "993" },
  { key: "IMAP_USER", label: "Utilizador IMAP", group: "email", secret: false, placeholder: "documentos@gabinete.pt" },
  { key: "IMAP_PASSWORD", label: "Palavra-passe IMAP", group: "email", secret: true },
  { key: "IMAP_MAILBOX", label: "Pasta IMAP", group: "email", secret: false, placeholder: "INBOX" },
  { key: "IMAP_POLL_SECONDS", label: "Intervalo de leitura (segundos)", group: "email", secret: false, placeholder: "120" },
  { key: "WHATSAPP_VERIFY_TOKEN", label: "Token de verificação", group: "whatsapp", secret: true, hint: "Valor que se indica na Meta ao registar o webhook." },
  { key: "WHATSAPP_APP_SECRET", label: "App secret (Meta)", group: "whatsapp", secret: true, hint: "Valida a assinatura X-Hub-Signature-256 de cada evento." },
  { key: "WHATSAPP_ACCESS_TOKEN", label: "Access token (Cloud API)", group: "whatsapp", secret: true },
  { key: "WHATSAPP_PHONE_NUMBER_ID", label: "Phone number ID", group: "whatsapp", secret: false },
  { key: "WHATSAPP_REPLY", label: "Confirmar recepção ao remetente (1/0)", group: "whatsapp", secret: false, placeholder: "1" },
  { key: "CENTRALGEST_BASE_URL", label: "URL base da API CentralGest", group: "centralgest", secret: false, placeholder: "https://api.centralgestcloud.com", hint: "Fornecido pela CentralGest após o Pedido de Adesão à API. Sem barra final." },
  { key: "CENTRALGEST_API_KEY", label: "Chave da API CentralGest", group: "centralgest", secret: true, hint: "Chave atribuída na adesão. Usada para obter o token Bearer (POST /api/v1/auth/token)." },
  { key: "MS365_TENANT_ID", label: "Tenant ID (Entra ID)", group: "microsoft365", secret: false, placeholder: "00000000-0000-0000-0000-000000000000", hint: "Portal Azure > Microsoft Entra ID > Visão geral > ID do inquilino." },
  { key: "MS365_CLIENT_ID", label: "Application (client) ID", group: "microsoft365", secret: false, hint: "Registo de aplicação criado para o Cont.ai (Entra ID > Registos de aplicações)." },
  { key: "MS365_CLIENT_SECRET", label: "Client secret", group: "microsoft365", secret: true, hint: "Certificados e segredos > Novo segredo do cliente. Anote a data de expiração." },
  { key: "MS365_DRIVE_USER", label: "OneDrive do utilizador (email)", group: "microsoft365", secret: false, placeholder: "documentos@lumarcont.pt", hint: "Conta do Microsoft 365 cujo OneDrive recebe os documentos. Em alternativa indique um site SharePoint abaixo." },
  { key: "MS365_SITE_ID", label: "Site SharePoint (ID) em alternativa", group: "microsoft365", secret: false, hint: "Deixe vazio para usar o OneDrive do utilizador." },
  { key: "MS365_ROOT_FOLDER", label: "Pasta raiz", group: "microsoft365", secret: false, placeholder: "Cont.ai", hint: "Dentro dela: Empresa (NIF) / Ano / Mês / Tipo de documento." },
  { key: "ANDROID_PACKAGE", label: "Identificador da app Android", group: "android", secret: false, placeholder: "pt.lumarcont.contai", hint: "Package name da Trusted Web Activity publicada na Play Store." },
  { key: "ANDROID_SHA256_FINGERPRINTS", label: "Impressões SHA-256 da chave de assinatura", group: "android", secret: false, hint: "Uma ou várias, separadas por vírgula (Play Console > Integridade da app > Assinatura). Publicadas em /.well-known/assetlinks.json para a app abrir sem barra de endereço." },
  { key: "GESTOBRIG_URL", label: "Endereço do GestObrig do gabinete", group: "gestobrig", secret: false, placeholder: "https://www.gestobrig.com", hint: "Ligação aberta pelos botões \"Abrir GestObrig\" (site do gabinete ou instância própria)." },
  { key: "GESTOBRIG_SOON_DAYS", label: "Dias para considerar um prazo \"a vencer\"", group: "gestobrig", secret: false, placeholder: "7", hint: "Obrigações por cumprir com prazo dentro deste número de dias aparecem destacadas ao cliente e ao gabinete." },
  { key: "CENTRALGEST_MOCK", label: "Simulador local (1/0)", group: "centralgest", secret: false, placeholder: "0", hint: "1 arranca um CentralGest simulado dentro da app para testar o fluxo de lançamento sem credenciais. Ignorado quando URL e chave estão preenchidos." },
];

const DEFS_BY_KEY = new Map(SETTING_DEFS.map((d) => [d.key, d]));

function keyMaterial(): Buffer {
  const secret = process.env.CONTAI_SECRET_KEY || process.env.JWT_SECRET;
  if (!secret) throw new Error("CONTAI_SECRET_KEY ou JWT_SECRET em falta: não é possível cifrar definições.");
  return crypto.scryptSync(secret, "contai-settings-v1", 32);
}

export function encryptValue(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

export function decryptValue(stored: string): string {
  const [v, iv, tag, data] = stored.split(":");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Formato de definição cifrada inválido.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyMaterial(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

function readAll(db: Db): Map<string, string> {
  const rows = db.prepare("SELECT key, value_enc FROM settings").all() as { key: string; value_enc: string }[];
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!DEFS_BY_KEY.has(r.key)) continue;
    try { out.set(r.key, decryptValue(r.value_enc)); } catch { /* chave alterada: ignora o valor, fica o ambiente */ }
  }
  return out;
}

/** Loads stored settings into process.env (stored values win over the .env file). Returns the keys applied. */
export function applyStoredSettings(db: Db): string[] {
  const applied: string[] = [];
  for (const [k, v] of readAll(db)) {
    process.env[k] = v;
    applied.push(k);
  }
  return applied;
}

export interface SettingView extends SettingDef {
  /** "definicoes" = saved in the UI, "ambiente" = from .env only, "nenhum" = empty */
  source: "definicoes" | "ambiente" | "nenhum";
  /** Non-secret values are returned in full; secrets only as a masked tail. */
  value: string | null;
  masked: string | null;
}

export function listSettings(db: Db): SettingView[] {
  const stored = readAll(db);
  return SETTING_DEFS.map((d) => {
    const fromStore = stored.get(d.key);
    const current = fromStore ?? process.env[d.key] ?? "";
    const source: SettingView["source"] = fromStore !== undefined ? "definicoes" : current ? "ambiente" : "nenhum";
    const masked = current ? (current.length > 6 ? "••••" + current.slice(-4) : "••••") : null;
    return { ...d, source, value: d.secret ? null : current || null, masked: current ? masked : null };
  });
}

/**
 * Saves the given values (empty string or null removes the stored value, falling back to .env).
 * Unknown keys are rejected. Values are never written to the audit log.
 */
export function saveSettings(db: Db, userId: number, values: Record<string, string | null>): { saved: string[]; cleared: string[] } {
  const saved: string[] = [];
  const cleared: string[] = [];
  const upsert = db.prepare("INSERT INTO settings (key, value_enc, updated_by, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_by = excluded.updated_by, updated_at = excluded.updated_at");
  const del = db.prepare("DELETE FROM settings WHERE key = ?");
  const tx = db.transaction(() => {
    for (const [k, raw] of Object.entries(values)) {
      if (!DEFS_BY_KEY.has(k)) throw new Error(`Definição desconhecida: ${k}`);
      const v = (raw ?? "").trim();
      if (!v) { del.run(k); delete process.env[k]; cleared.push(k); continue; }
      upsert.run(k, encryptValue(v), userId);
      process.env[k] = v;
      saved.push(k);
    }
  });
  tx();
  audit(db, userId, "settings_update", "settings", null, JSON.stringify({ saved, cleared }));
  return { saved, cleared };
}
