# Cont.ai by Lumarcont: dossier de transferência

Documento único para quem for continuar, reconstruir ou fazer outra versão do produto (pessoa ou assistente de IA). Descreve o que existe, porquê, como corre e o que falta. O código completo está no repositório `fabioigor/brasfone`, ramo `claude/accounting-app-kangaroo-ymg5d7` (PR #1), pastas `apps/contai` (web app e servidor), `apps/contai-android` (Play Store) e `apps/contai-ios` (App Store). Nenhum segredo está neste documento nem no repositório.

## 1. O produto em três frases

Cont.ai by Lumarcont é uma plataforma para gabinetes de contabilidade em Portugal, inspirada no Kangaroo Files e na análise de Flowzi e BizDocs. Os clientes do gabinete enviam documentos (fotografia no telemóvel, portal, email, WhatsApp); a app lê-os (QR da AT, OCR, IA), propõe lançamentos contabilísticos em SNC, confere IVA e balancetes, arquiva no OneDrive e entrega no CentralGest ou por CSV Primavera. O humano aprova sempre; a IA nunca escreve directamente nos sistemas de destino.

Cliente: Lumarcont, gabinete de contabilidade em Faro (lumarcont.pt), fundado em 1996. Product owner: Fábio (Grupo Brasfone).

## 2. Princípios não negociáveis (herdados do CLAUDE.md do repositório)

1. A IA propõe; a decisão é humana. Lançamentos ficam "pendentes" até aprovação; o despacho para o CentralGest só acontece depois.
2. Idempotência total nas escritas externas (tabela `dispatches`, `idExterno contai-entry-<id>`, nomes de ficheiro no OneDrive com o id do documento).
3. Conservadorismo nos alertas: taxa de IVA vs produto é sempre "aviso" (a lei tem excepções); erros aritméticos e taxas inexistentes são "erro".
4. Remetentes desconhecidos nunca criam empresas; ficam "por associar".
5. Audit log de todas as escritas externas, decisões, alterações de definições e acessos a conteúdo.
6. Código e identificadores em inglês; UI em português europeu pré-Acordo Ortográfico ("actividade", "acção", "factura"); sem travessões (em dashes) na UI.
7. Conhecimento fiscal (taxas de IVA, listas do CIVA, benchmarks) em JSON versionado com `last_verified` e alerta de desactualização; nunca no código.

## 3. Pedidos do product owner (por ordem, com a decisão tomada)

1. App para gabinete de contabilidade a replicar o Kangaroo Files: portal do cliente, recepção multicanal, arquivo digital (DL 28/2019), classificação por IA, validação humana, exportação Cegid Primavera.
2. Integração com CentralGest por API e servidor MCP para lançar documentação automaticamente. Decisão: cliente contra um contrato assumido (a API da CentralGest exige "Pedido de Adesão"), simulador local, 25 ferramentas MCP.
3. Quatro "dores" prioritárias: conferência de lançamentos (IVA vs taxa, vs produto, lei em vigor, aumentos anómalos), conferência de balancetes com padrões configuráveis, relatórios financeiros com benchmarks sectoriais (INE, Banco de Portugal), área reservada do cliente como web app.
4. OCR de PDFs e imagens, "o máximo evoluído": cascata pdfjs → Claude visão → Tesseract WASM, QR da AT como fonte autoritativa, extracção estruturada validada com zod, fusão QR > IA > regras com proveniência por campo, memória de fornecedores aprendida das aprovações.
5. Recepção por email e WhatsApp.
6. Nome final "Cont.ai by Lumarcont"; UX/UI "inovador e simples"; alojamento a decidir (Vercel rejeitado por ser serverless; decisão Hetzner porque a Lumarcont já tem servidores lá).
7. Pré-visualização do documento ao lado da informação na aprovação.
8. Servidor no Hetzner criado pela API, sem browser; depois mudado para Falkenstein (mais perto de Portugal) e cpx32 (4 vCPU AMD, 8 GB).
9. Sem contas de demonstração em produção; conta de administração por variáveis de ambiente; alteração de palavra-passe na app.
10. Segredos das integrações introduzidos na própria app (cifrados), nunca pela conversa; actualização automática do servidor a partir do ramo (sem SSH nem token).
11. Área CentralGest com teste de ligação e mapa de códigos de empresa.
12. Design inspirado no site lumarcont.pt (dourado do logótipo, neutros quentes, verde profundo, serifa).
13. App Android para os clientes digitalizarem pelo telemóvel; depois app iOS semelhante.
14. Domínio e TLS definidos na app; testes de credenciais por grupo antes de guardar.
15. Botão de pré-visualização em todo o lado, porque o humano tem de confirmar os dados quando a qualidade do OCR + IA foi baixa.
16. Integração Microsoft 365: OneDrive como repositório dos documentos digitalizados; email com autenticação do Microsoft 365 (Graph API, sem IMAP).
17. Fase de testes com o cliente em curso; feedback para ajustes e novas funcionalidades.

## 4. Arquitectura

- **Stack:** Node 22 + TypeScript + Express; SQLite (better-sqlite3) com migrações aditivas; frontend em JavaScript puro (PWA: manifest, service worker, instalável, share target); JWT com papéis `staff` e `client`; zod; vitest + supertest; Playwright para verificações visuais. Sem bundler. Um só processo; workers por `setInterval` (IMAP/Graph mail, OneDrive).
- **Camadas:** recepção (portal, `POST /api/documents`, email webhook/IMAP/Graph, WhatsApp webhook, digitalização no telemóvel) → `ingestDocument` (pipeline: guardar ficheiro em `data/arquivo`, sha256 para duplicados, QR da AT, OCR em cascata, extracção estruturada, fusão de fontes, classificação, proposta de lançamento, conferência de IVA, findings) → validação humana (`entries` pendentes) → entrega (CentralGest API idempotente ou CSV Primavera) e arquivo (OneDrive).
- **IA:** `src/ai/provider.ts` (fornecedor heurístico local por omissão; Anthropic via SDK oficial quando há `ANTHROPIC_API_KEY`), `src/ai/agents.ts` (memória descritiva de relatórios, segunda opinião de IVA), `src/extraction/structured.ts` (extracção estruturada por Claude, JSON validado com zod), `src/ocr/engine.ts` (Claude visão, Tesseract, pdfjs, rasterização com @napi-rs/canvas). Modelos configuráveis (`CONTAI_OCR_MODEL`, `CONTAI_AGENT_MODEL`, por omissão `claude-opus-5`; `claude-haiku-4-5` como trabalhador barato na classificação).
- **Conhecimento:** `src/knowledge/vat-rules.json` (taxas por território: Continente 23/13/6, Açores 16/9/4, Madeira 22/12/4; Listas I e II do CIVA), `sector-benchmarks.json` (indicativos, por CAE), `index.ts` com verificação de `last_verified`.
- **Base de dados (18 tabelas):** users, companies, documents (com colunas OCR e OneDrive), entries, doc_requests, export_batches, export_batch_entries, dispatches, findings, trial_balances, trial_balance_lines, balance_rules, reports, supplier_profiles, company_contacts, inbound_messages, audit_log, settings (valores cifrados AES-256-GCM). Esquema completo em `src/db.ts`.
- **API HTTP:** 87 rotas (lista gerada em `docs/api.md`). **MCP:** 25 ferramentas `contai_*` e `centralgest_*` (`src/mcp/server.ts`, stdio).
- **Frontend:** `public/index.html`, `public/app.js` (uma função `viewX(main)` por página; router por hash; `el()` para DOM), `public/scan.js` (tratamento de imagem e escritor de PDF sem dependências), `public/styles.css` (tokens de design), `public/sw.js`. Páginas: Hoje (fila de trabalho), Digitalizar, Documentos, Validação (mestre/detalhe com pré-visualização), Conferência, Recepção, Pedidos, Balancetes, Relatórios, Indicadores e prazos, Empresas, Entrega, Integrações, A minha conta.

## 5. Funcionalidades entregues (estado: em produção, versão 0.5.0)

- Portal do gabinete e área reservada do cliente (cada cliente vê só a sua empresa).
- Digitalização no telemóvel: câmara/galeria, várias páginas, rotação, tratamento (cinzentos com contraste, cor, preto e branco por Otsu), PDF A4 gerado no browser, envio; partilha do Android e do iOS para a app.
- Leitura: QR da AT (Despacho 412/2020-XXII, campos A..S, ATCUD, IVA por taxa), OCR em cascata, extracção estruturada por IA, fusão com proveniência por campo, alerta quando as fontes divergem, memória de fornecedores por NIF.
- Lançamentos propostos em SNC com uma linha de IVA por taxa; validação com pré-visualização lado a lado, edição de linhas, atalhos de teclado; badge de qualidade de leitura e aviso abaixo de 85% de confiança.
- Conferência de documentos: IVA_CALCULO, TAXA_INEXISTENTE, TAXA_DESADEQUADA, TAXAS_MISTAS_POSSIVEIS, TOTAL_INCOERENTE, DUPLICADO (ATCUD/número), DATA_FUTURA, AUMENTO_IMPOSTO_ANOMALO, NIF_TERCEIRO_EM_FALTA, DOCUMENTO_ANULADO, QR_INCOERENTE, VARIOS_DOCUMENTOS_NO_FICHEIRO, FONTES_DIVERGENTES.
- Balancetes: importação CSV, regras configuráveis (variações anómalas, saldos com sinal errado, etc.), conferência entre períodos.
- Relatórios financeiros por cliente: KPIs, rácios vs benchmarks sectoriais, gráficos SVG, memória descritiva por IA, HTML.
- Canais: email (Microsoft 365 via Graph, webhook JSON/MIME, IMAP), WhatsApp Cloud API (assinatura validada, download de media, confirmação opcional), remetentes autorizados por empresa, alias `docs+<id>@`.
- Arquivo OneDrive/SharePoint por Empresa (NIF)/Ano/Mês/Tipo, idempotente, com repetição e estado.
- CentralGest: cliente contra contrato assumido, agora com o contrato real v5.1 analisado e plano de adaptação (`docs/centralgest-api.md`), simulador, teste de ligação, mapa de códigos, despacho idempotente; CSV Primavera como alternativa.
- Fornecedores e centros de custo: centros por empresa desde a digitalização (web, telemóvel, WhatsApp com perguntas de tipo e centro), descoberta de fornecedor por NIF (VIES + pesquisa web por IA com probabilidades), registo com centros de custo e aplicação aos pendentes (`docs/fornecedores.md`).
- GestObrig (sem API pública): importação de obrigações por ficheiro para Indicadores e prazos (gabinete e cliente), marcação manual, resumo na página Hoje; cofre de acessos às entidades por empresa com revelação auditada (`docs/gestobrig.md`).
- Integrações em auto-serviço: definições cifradas, teste por grupo (Anthropic, email 365/IMAP, WhatsApp, Microsoft 365, CentralGest), domínio e TLS, estado do sistema (versão, commit, registo da actualização automática).
- Apps nativas: Android (Trusted Web Activity, Bubblewrap) e iOS (SwiftUI + WKWebView com extensão de partilha, XcodeGen); ambas invólucros da web app.
- Design com a identidade da Lumarcont; tema claro/escuro; responsivo.
- 142 testes automáticos (vitest), incluindo OCR real sobre fixtures, Graph API simulada, CentralGest simulado, RLS de papéis, idempotência.

## 6. Infra-estrutura e operação

- **Servidor:** Hetzner Cloud, projecto da Lumarcont, servidor `contai` (cpx32, Falkenstein), Ubuntu 24.04, Docker + Caddy (TLS automático quando houver domínio), firewall 22/80/443, ufw, fail2ban, backups diários em `/var/backups/contai`. Criado por `deploy/hetzner-create.sh` com `deploy/hetzner-cloud-init.yaml` (API do Hetzner, sem browser nem SSH).
- **Actualização automática:** temporizador systemd de 5 em 5 minutos corre `deploy/autoupdate.sh` (fetch do ramo; se mudou, `deploy/update.sh`: pull, rebuild, `docker compose up -d`). Um push ao ramo chega a produção em 2 a 7 minutos. Também reaplica quando o domínio muda (ficheiro em `/var/lib/contai/config/domain`, escrito pela app).
- **Configuração:** `.env` no servidor só com `JWT_SECRET`, `CONTAI_ADMIN_EMAIL`, `CONTAI_ADMIN_PASSWORD` (e opcionalmente `CONTAI_SECRET_KEY`); tudo o resto em Integrações. Lições aprendidas: o cron da imagem cloud arranca com PATH mínimo (sem `/usr/sbin`), por isso a actualização passou a systemd; `sudo -u` falha no primeiro arranque do cloud-init (palavra-passe expirada), por isso o clone é feito como root e entregue ao utilizador; um `CONTAI_DOMAIN` vazio faz o Caddy tratar o bloco como opções globais, por isso o compose usa `${CONTAI_DOMAIN:-:80}`.
- **Dados de demonstração em produção:** empresa fictícia "Padaria Central Lda (demo)" (NIF 506284417, inventado), conta de cliente de demonstração, 6 documentos das fixtures, 2 balancetes. Podem ser apagados no fim da fase de testes.
- **Fixtures:** todas fictícias (NIFs e nomes inventados). Nunca usar dados reais de clientes em testes.

## 7. Estado actual e pendentes

Pendente do lado da Lumarcont: registo A do domínio no Wix (DNS de lumarcont.pt está em ns6/ns7.wixdns.net) e gravação do domínio em Integrações; chaves Anthropic, WhatsApp, Microsoft 365 (registo no Entra ID conforme `docs/microsoft365.md`); adesão à API do CentralGest; contas Google Play e Apple Developer; compilação da app iOS num Mac.

Fora desta iteração (documentado como futuro): separação automática de PDFs com várias facturas (hoje só alerta), reconciliação com e-Fatura, integrações PHC/Sage, detecção de contornos e correcção de perspectiva na digitalização, envio de email pela app (`Mail.Send`), leitura inversa do OneDrive, migração para PostgreSQL + object storage quando houver vários gabinetes, benchmarks carregados automaticamente do BPstat (API pública verificada; INE não verificado).

## 8. Como correr localmente

```bash
cd apps/contai
npm install
cp .env.example .env            # JWT_SECRET; sem NODE_ENV=production fica com dados de demonstração
npm run dev                     # http://localhost:3000 (gabinete@demo.pt / gabinete123; padaria@demo.pt / cliente123)
npm test                        # 142 testes
npm run mcp                     # servidor MCP por stdio
CENTRALGEST_MOCK=1 npm run dev  # com o CentralGest simulado
```

## 9. Onde está cada coisa

| Tema | Ficheiros |
|---|---|
| Decisões de produto, com datas e razões | `DECISIONS.md` (raiz do repositório) |
| Alojamento, provisionamento, actualização automática, go-live | `apps/contai/docs/alojamento.md`, `deploy/*` |
| Canais (email, WhatsApp) | `docs/canais.md`, `src/channels/*` |
| Microsoft 365 (OneDrive, caixa de email, Entra ID) | `docs/microsoft365.md`, `src/integrations/microsoft365.ts`, `src/channels/graphMail.ts` |
| CentralGest (contrato assumido, simulador) | `docs/centralgest-api.md`, `src/integrations/centralgest*.ts` |
| Fornecedores, centros de custo, diálogo WhatsApp | `docs/fornecedores.md`, `src/integrations/supplierDiscovery.ts`, `src/channels/dialog.ts`, `src/ai/agents.ts` |
| GestObrig, obrigações e cofre de acessos | `docs/gestobrig.md`, `src/integrations/gestobrig.ts`, `src/domain/credentials.ts` |
| Análise de concorrência (Kangaroo Files, Flowzi, BizDocs) | `docs/analise-concorrencia.md` |
| Fontes externas (BPstat, INE) | `docs/fontes-externas.md` |
| Apps de telemóvel | `docs/android.md`, `docs/ios.md`, `apps/contai-android/`, `apps/contai-ios/` |
| API e MCP | `docs/api.md`, `src/server.ts`, `src/mcp/server.ts` |
| Regras de negócio | `src/domain/*` (extraction, classification, entries, vatAudit, trialBalance, balanceRules, financialReport, reportHtml, supplierMemory, exportPrimavera, obligations) |
| Leitura de documentos | `src/extraction/*` (QR da AT, estruturada, fusão, pré-processamento), `src/ocr/engine.ts`, `src/pipeline.ts` |
| Frontend | `public/*` |
| Testes e fixtures | `test/*`, `fixtures/*` |

## 10. Sugestões para uma nova versão

Se a próxima versão for construída de raiz, vale manter: o fluxo "QR da AT primeiro, IA depois, regras a fechar", a fusão com proveniência por campo (o contabilista tem de saber de onde veio cada número), a pré-visualização ao lado dos dados em todos os ecrãs, o conhecimento fiscal em dados versionados, a idempotência nas entregas e o auto-serviço de configuração (segredos, domínio, testes de ligação). Melhorias óbvias: PostgreSQL desde o início se for multi-gabinete, filas (BullMQ) para OCR e sincronizações, detecção de contornos na digitalização (OpenCV em WASM), e-Fatura, e um contrato CentralGest real assim que a documentação chegar.
