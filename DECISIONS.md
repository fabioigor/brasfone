# Registo de decisões de produto

Decisões assumidas por omissão (conforme `CLAUDE.md`) durante o desenvolvimento, para não bloquear o trabalho em perguntas não críticas. Formato: data, decisão, contexto/alternativas consideradas, quem pode reverter.

## 2026-09-13 — Alojamento: Hetzner (infra-estrutura existente da Lumarcont)

- **Facto a reter:** a Lumarcont **já tem servidores no Hetzner**. Qualquer recomendação futura de alojamento, backups, base de dados ou object storage deve partir desta infra-estrutura (Hetzner Cloud/Dedicated, Hetzner Object Storage, snapshots Hetzner) antes de considerar outros fornecedores.
- **Decisão:** o Cont.ai é alojado nos servidores Hetzner da Lumarcont com `docker-compose.vps.yml` + Caddy (TLS automático). Empresa e servidores na UE, sem transferência internacional de dados a justificar (excepto a API da Anthropic, opcional). O Fly.io fica apenas como plano alternativo documentado.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Marca, alojamento e UX

- **Marca:** o nome final é **Cont.ai by Lumarcont**; a menção "by Lumarcont" aparece no login, na barra lateral, no manifest da web app e no rodapé dos relatórios.
- **Alojamento:** Vercel foi avaliado e **rejeitado** para esta aplicação (serverless sem processos persistentes nem disco: incompatível com o poller IMAP, o processamento pós-webhook, o OCR em WASM e o arquivo DL 28/2019). Recomendação: contentor com volume persistente na UE, **Fly.io** para o piloto (Dockerfile e docker-compose no repositório), com migração para PostgreSQL gerido + object storage S3 quando houver vários gabinetes. Análise em `apps/contai/docs/alojamento.md`.
- **UX/UI:** nova estrutura com barra lateral agrupada (Trabalho, Análise, Configuração), página inicial **"Hoje"** como fila de trabalho (lançamentos por aprovar com aprovação inline, alertas por gravidade, remetentes por associar), sistema visual com uma só cor de acção, tema claro/escuro e layout responsivo. Princípio: o contabilista abre a app e vê só o que precisa da sua decisão.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Recepção multicanal e OCR de nova geração (QR da AT, IA estruturada, fusão de fontes, memória)

- **Decisão:** após análise de Kangaroo Files, Flowzi e BizDocs (`apps/contai/docs/analise-concorrencia.md`), adoptar: (1) QR code da AT como fonte autoritativa (NIFs, ATCUD, IVA por taxa), (2) extracção estruturada por Claude validada com zod, (3) fusão QR > IA > regras com proveniência por campo e alerta quando discordam, (4) memória de fornecedores aprendida das aprovações humanas, (5) recepção por email (webhook + IMAP) e WhatsApp (Cloud API) com remetentes autorizados por empresa.
- **Princípios mantidos:** remetentes desconhecidos nunca criam empresas (ficam por associar); a IA propõe e o humano aprova; a memória só aprende de aprovações humanas; webhooks validam segredo/assinatura e respondem 200 de imediato.
- **Fora desta iteração:** separação automática de PDFs com várias facturas (só alerta), reconciliação com e-Fatura (requer credenciais AT), integrações PHC/Sage.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Nome do produto: Cont.ai

- **Decisão:** a aplicação passa a chamar-se **Cont.ai** (antes "ContaDesk", nome provisório). Renomeação consistente: directório `apps/contai/`, pacote `contai`, marca na UI e no manifest da web app, servidor MCP `contai` com ferramentas `contai_*`, variáveis de ambiente `CONTAI_*`, base de dados `data/contai.db`, `idExterno` no CentralGest `contai-entry-<id>`.
- **Contexto:** pedido directo do product owner. Como ainda não há instalações em produção, a renomeação de identificadores externos (ferramentas MCP, variáveis, idExterno) não tem custo de migração; as referências históricas neste registo foram actualizadas para o nome final.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — OCR de PDFs e imagens

- **Decisão:** extracção de texto em cascata: camada de texto do PDF (pdfjs) → Claude visão (SDK oficial, `claude-opus-5` por omissão) quando há chave → Tesseract local em WASM (por+eng) como fallback offline; PDFs digitalizados rasterizados com `@napi-rs/canvas` (binários pré-compilados, sem dependências de sistema). O resultado é texto linha a linha, para que a extracção, classificação e conferência existentes funcionem sem alterações.
- **Contexto:** o ambiente de execução não tem poppler nem tesseract instalados; a solução tem de ser toda em Node para ser portátil. O parser de linhas de artigos passou a tolerar colunas separadas por um só espaço (saída típica do OCR).
- **Princípios mantidos:** o OCR nunca decide; confiança abaixo de 85% gera alerta para o revisor, e o texto extraído fica guardado e consultável para verificação contra o original. Modelo de visão configurável (`CONTAI_OCR_MODEL`) para quem preferir um modelo mais barato em volume.
- **Reversível por:** Fábio (product owner).

## 2026-09-12 — Agentes de análise: conferência de IVA, balancetes, relatórios sectoriais, web app do cliente

- **Decisão:** implementar as quatro dores prioritárias como motores determinísticos com conhecimento versionado em JSON (taxas/listas do CIVA, benchmarks sectoriais) e agentes de IA apenas para explicar e dar segunda opinião, nunca para decidir. Os alertas de taxa de IVA vs produto são sempre "aviso" (a lei tem excepções que o texto do documento não revela); erros aritméticos e taxas inexistentes são "erro".
- **Actualização da lei:** o conhecimento tem `version` + `last_verified` + prazo de revisão; ultrapassado o prazo, o sistema avisa. A actualização é uma alteração de dados revista em git, não código.
- **Fontes externas:** BPstat (Banco de Portugal) tem API REST pública, verificada; INE tem API JSON (não verificada a partir da sandbox). Sem scraping. Benchmarks actuais marcados como indicativos até serem carregados do BPstat.
- **Modelo de IA:** `claude-opus-5` para os agentes (memória descritiva, segunda opinião), `claude-haiku-4-5` como trabalhador barato na classificação; tudo via SDK oficial `@anthropic-ai/sdk`, com fallbacks server-side activados.
- **Reversível por:** Fábio (product owner).

## 2026-08-30 — Integração CentralGest por API + servidor MCP

- **Decisão:** integrar o Cont.ai com o CentralGest Cloud por API (lançamento directo dos lançamentos aprovados) e expor o pipeline via servidor MCP (`apps/contai/src/mcp/server.ts`) para que agentes de IA lancem a documentação de forma automática.
- **Contexto:** a API do CentralGest existe mas não tem documentação pública (acesso via "Pedido de Adesão à API"). O cliente foi construído contra um contrato assumido, documentado em `apps/contai/docs/centralgest-api.md`, isolado em `src/integrations/centralgest.ts`, e acompanhado de um simulador local (`CENTRALGEST_MOCK=1`) usado em dev e testes. Quando a documentação oficial chegar, só o cliente e o mock precisam de ajuste.
- **Princípios mantidos:** toda a escrita no CentralGest passa por um despachante determinístico e idempotente (tabela `dispatches` com `entry_id` único + `idExterno` no destino); só lançamentos aprovados por humano (ou pela ferramenta de decisão MCP, invocada explicitamente) são despachados; cada lançamento segue por uma única via de entrega (API CentralGest ou CSV Primavera).
- **Reversível por:** Fábio (product owner).

## 2026-08-30 — Cont.ai: app para gabinete de contabilidade (novo produto no repo)

- **Decisão:** criar em `apps/contai/` uma aplicação para gabinetes de contabilidade inspirada no Kangaroo Files (portal do cliente, recepção e classificação de documentos, arquivo digital DL 28/2019, lançamentos propostos com validação humana, exportação Cegid Primavera), separada do produto WhatsApp→Pipedrive descrito no `CLAUDE.md`.
- **Contexto:** pedido directo do product owner. Por ser um produto distinto, não segue os milestones do `CLAUDE.md`, mas herda os princípios: a IA nunca escreve sem validação humana, idempotência total nas exportações, audit log, textos de UI em português europeu pré-Acordo.
- **Stack da v1:** Express + TypeScript + SQLite (better-sqlite3), sem serviços externos, para ter uma app executável e testável de imediato; gateway de IA com fornecedor heurístico por omissão e Anthropic opcional via `ANTHROPIC_API_KEY`. Migração para NestJS/PostgreSQL quando o produto justificar multi-gabinete.
- **Reversível por:** Fábio (product owner).

## 2026-08-25 — Criação do CLAUDE.md e arranque do projecto

- **Decisão:** adoptar o documento de especificação (PDS-INT-WA-PD-001 / ARQ-INT-WA-001 / ARQ-APP-PD-001) como `CLAUDE.md` na raiz do repositório, guiando todo o desenvolvimento subsequente por milestones.
- **Contexto:** repositório estava vazio; este é o primeiro commit.
- **Reversível por:** Fábio (product owner).
