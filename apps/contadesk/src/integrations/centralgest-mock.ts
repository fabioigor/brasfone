/**
 * Local CentralGest Cloud simulator implementing the assumed contract in
 * docs/centralgest-api.md. Used by the test suite and by dev/demo mode
 * (CENTRALGEST_MOCK=1) while API adhesion with CentralGest is pending.
 */
import express from "express";
import http from "node:http";
import { AddressInfo } from "node:net";

export interface MockState {
  apiKey: string;
  companies: { codigo: string; nome: string }[];
  documents: Map<string, { id: string; numero: string; payload: any }>;
  failNext: boolean;
}

export function createCentralGestMock(apiKey = "chave-demo"): { app: express.Express; state: MockState } {
  const state: MockState = {
    apiKey,
    companies: [
      { codigo: "PADARIA", nome: "Padaria Central Lda" },
      { codigo: "TECNO", nome: "TecnoNorte Unipessoal Lda" },
    ],
    documents: new Map(),
    failNext: false,
  };

  const app = express();
  app.use(express.json());

  const TOKEN = "mock-token-" + Math.random().toString(36).slice(2);

  app.post("/api/v1/auth/token", (req, res) => {
    if (req.body?.apiKey !== state.apiKey) {
      return res.status(401).json({ erro: "apiKey invalida" });
    }
    return res.json({ token: TOKEN, expiresIn: 3600 });
  });

  app.use("/api/v1", (req, res, next) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ erro: "token invalido" });
    }
    next();
  });

  app.get("/api/v1/empresas", (_req, res) => {
    res.json({ empresas: state.companies });
  });

  app.post("/api/v1/empresas/:codigo/contabilidade/documentos", (req, res) => {
    if (state.failNext) {
      state.failNext = false;
      return res.status(500).json({ erro: "falha simulada" });
    }
    const codigo = req.params.codigo;
    if (!state.companies.some((c) => c.codigo === codigo)) {
      return res.status(404).json({ erro: `empresa ${codigo} desconhecida` });
    }
    const { idExterno, diario, dataDocumento, linhas } = req.body || {};
    if (!idExterno || !diario || !dataDocumento || !Array.isArray(linhas) || linhas.length === 0) {
      return res.status(400).json({ erro: "payload incompleto" });
    }
    const debito = linhas.reduce((s: number, l: any) => s + (l.debito || 0), 0);
    const credito = linhas.reduce((s: number, l: any) => s + (l.credito || 0), 0);
    if (Math.round(debito * 100) !== Math.round(credito * 100)) {
      return res.status(422).json({ erro: "documento desbalanceado" });
    }
    const existing = state.documents.get(idExterno);
    if (existing) {
      return res.status(409).json({ id: existing.id, numero: existing.numero, erro: "idExterno duplicado" });
    }
    const id = "CG-" + (state.documents.size + 1);
    const numero = `${diario.slice(0, 3).toUpperCase()}/${state.documents.size + 1}`;
    state.documents.set(idExterno, { id, numero, payload: req.body });
    return res.status(201).json({ id, numero });
  });

  return { app, state };
}

/** Starts the mock on an ephemeral (or given) port; returns its base URL. */
export function startCentralGestMock(
  apiKey = "chave-demo",
  port = 0
): Promise<{ baseUrl: string; server: http.Server; state: MockState }> {
  const { app, state } = createCentralGestMock(apiKey);
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      const address = server.address() as AddressInfo;
      resolve({ baseUrl: `http://localhost:${address.port}`, server, state });
    });
  });
}
