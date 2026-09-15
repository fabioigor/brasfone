import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";

/**
 * Domain and TLS self-service. Staff write the domain in the UI; the app stores it in the config
 * directory shared with the host (CONTAI_CONFIG_DIR, bind-mounted from /var/lib/contai/config).
 * The host's autoupdate timer notices the change and re-runs docker compose with CONTAI_DOMAIN set,
 * so Caddy requests the certificate. Nothing here touches the host directly.
 */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normaliseDomain(raw: string): string | null {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!d) return null;
  return HOSTNAME.test(d) ? d : "invalid";
}

/** Directory exists but is not writable yet (first deploy after the mount was added). */
export function configDirPending(): boolean {
  const dir = process.env.CONTAI_CONFIG_DIR;
  if (!dir) return false;
  try { fs.accessSync(dir, fs.constants.W_OK); return false; } catch { return fs.existsSync(dir); }
}

export function configDir(): string | null {
  const dir = process.env.CONTAI_CONFIG_DIR;
  if (!dir) return null;
  // Tem de existir e ser gravavel pelo utilizador do contentor (update.sh faz o chown no host).
  try { fs.mkdirSync(dir, { recursive: true }); fs.accessSync(dir, fs.constants.W_OK); return dir; } catch { return null; }
}

export function readDomain(): string | null {
  const dir = configDir();
  if (dir) {
    try { const v = fs.readFileSync(path.join(dir, "domain"), "utf8").trim(); return v || null; } catch { /* sem ficheiro */ }
  }
  return process.env.CONTAI_DOMAIN?.trim() || null;
}

/** Writes the domain (empty string disables TLS and returns to HTTP by IP). Returns false when no config dir is mounted. */
export function writeDomain(domain: string): boolean {
  const dir = configDir();
  if (!dir) return false;
  fs.writeFileSync(path.join(dir, "domain"), domain ? domain + "\n" : "");
  return true;
}

export interface DomainStatus {
  domain: string | null;
  serverIp: string | null;
  dns: string[];
  dnsOk: boolean | null;
  applied: boolean | null;
  tls: "ok" | "erro" | "nao_verificado";
  tlsDetail: string | null;
  configurable: boolean;
}

export async function domainStatus(logDir: string | null, fetchImpl: typeof fetch = fetch): Promise<DomainStatus> {
  const domain = readDomain();
  let serverIp: string | null = null;
  let applied: boolean | null = null;
  if (logDir) {
    try { serverIp = JSON.parse(fs.readFileSync(path.join(logDir, "server.json"), "utf8")).publicIp ?? null; } catch { /* ainda sem registo */ }
    try {
      const a = fs.readFileSync(path.join(logDir, "domain.applied"), "utf8").trim();
      applied = (a || null) === (domain || null);
    } catch { applied = domain ? false : null; }
  }
  let dnsList: string[] = [];
  let dnsOk: boolean | null = null;
  if (domain) {
    // Resolver proprio com tempo limite curto: sem DNS (ex.: sandbox) a pagina nao pode ficar pendurada.
    const resolver = new dns.Resolver({ timeout: 3000, tries: 1 });
    try { dnsList = await Promise.race([resolver.resolve4(domain), new Promise<string[]>((_, rej) => setTimeout(() => rej(new Error("dns timeout")), 4000))]); } catch { dnsList = []; }
    dnsOk = serverIp ? dnsList.includes(serverIp) : (dnsList.length > 0 ? null : false);
  }
  let tls: DomainStatus["tls"] = "nao_verificado";
  let tlsDetail: string | null = null;
  if (domain && dnsList.length) {
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetchImpl(`https://${domain}/health`, { signal: ctrl.signal });
      clearTimeout(t);
      tls = r.ok ? "ok" : "erro"; tlsDetail = r.ok ? null : `HTTP ${r.status}`;
    } catch (e: any) {
      tls = "erro"; tlsDetail = String(e?.cause?.code || e?.code || e?.message || e).slice(0, 160);
    }
  }
  return { domain, serverIp, dns: dnsList, dnsOk, applied, tls, tlsDetail, configurable: !!configDir() };
}
