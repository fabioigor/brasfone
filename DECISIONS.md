# Registo de decisões de produto

Decisões assumidas por omissão (conforme `CLAUDE.md`) durante o desenvolvimento, para não bloquear o trabalho em perguntas não críticas. Formato: data, decisão, contexto/alternativas consideradas, quem pode reverter.

## 2026-09-14 — Microsoft 365: OneDrive como repositório dos documentos e email com autenticação da aplicação

- **Decisão:** integrar o Microsoft 365 pela Graph API com autenticação de aplicação (client credentials) e uma só aplicação registada no Entra ID: (1) arquivo de todos os documentos recebidos no OneDrive (ou SharePoint) da Lumarcont em pastas Empresa (NIF)/Ano/Mês/Tipo, sincronização idempotente em segundo plano com registo de erros e repetição; (2) leitura da caixa de recepção (ex.: documentos@lumarcont.pt) pela Graph, sem palavra-passe da caixa, substituindo o IMAP quando configurada (IMAP mantém-se para caixas fora do 365). Pedido do product owner: o OneDrive é o repositório oficial dos digitalizados e o email tem de usar a autenticação do Microsoft 365.
- **Princípios mantidos:** a app é a fonte e o OneDrive o arquivo (sem leitura inversa nem apagamentos); segredos cifrados; audit log por upload; recomendação de Application Access Policy para limitar a permissão de correio a uma caixa. Envio de email pela app (`Mail.Send`) fica para depois.
- **Reversível por:** Fábio (product owner).

## 2026-09-14 — Domínio, TLS e testes de credenciais em auto-serviço; fase de testes com o cliente

- **Decisão:** o domínio define-se na própria app (Integrações > Domínio e TLS) e é aplicado pelo servidor sem SSH, através de uma pasta de configuração partilhada entre o contentor e o host lida pelo temporizador de actualização. Cada grupo de credenciais tem um teste que não guarda nada (Anthropic, IMAP, WhatsApp, CentralGest). Objectivo: o product owner completa a configuração sozinho e sem passar segredos pela conversa com o assistente.
- **Fase de testes:** o produto entra agora em utilização de teste pela Lumarcont, com feedback para ajustes e novas funcionalidades; o token da API do Hetzner mantém-se activo durante esta fase, usado apenas para operações de infra-estrutura (recriar ou redimensionar o servidor), nunca guardado em ficheiros.
- **Reversível por:** Fábio (product owner).

## 2026-09-14 — App iOS: invólucro nativo com extensão de partilha

- **Decisão:** a app iOS (`apps/contai-ios/`) é um invólucro SwiftUI + WKWebView da web app, gerado com XcodeGen, com extensão de partilha "Enviar ao Cont.ai" (imagens e PDFs guardados no App Group e injectados na vista Digitalizar via `window.__contaiShared`). Mesma lógica que a versão Android: todo o produto vive na web app e actualiza-se pelo servidor; a loja só recebe nova versão quando o invólucro muda.
- **Contexto:** o iOS não suporta Trusted Web Activity nem `share_target` para web apps, por isso a integração com o menu Partilhar exige código nativo. A alternativa Capacitor fica documentada para o caso de a revisão da Apple (regra 4.2) exigir mais funcionalidade nativa. Não é possível compilar nem assinar iOS a partir deste ambiente; o projecto está completo mas a primeira compilação tem de ser feita num Mac com Xcode e conta Apple Developer.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Identidade visual Lumarcont, digitalização pelo telemóvel e app Android

- **Design:** o sistema visual passa a herdar a identidade de lumarcont.pt (logótipo dourado em serifa, neutros quentes, verde profundo, tipografia leve): dourado `#8f6d47` como única cor de acção (com contraste suficiente sobre branco), fundos quentes, marca "Cont.ai" em serifa com "BY LUMARCONT" espaçado, tagline do site no login ("Bem-vindo à nova era da contabilidade digital"). Sem carregar fontes externas (pilha de sistema com fallback serifado), para a web app funcionar offline e rápida em telemóvel. Tema escuro mantido.
- **Digitalização móvel:** vista "Digitalizar" (clientes e gabinete) com câmara, galeria/PDF, rotação, reordenação, tratamento de imagem (cinzentos com contraste por omissão, cor, preto e branco por Otsu) e geração de PDF A4 no browser com um escritor mínimo próprio (`public/scan.js`, sem bibliotecas). Envio pelo mesmo `POST /api/documents`, logo com QR da AT, OCR e proposta de lançamento. Partilha do Android ("Partilhar com Cont.ai") via `share_target` tratada pelo service worker. Detecção de contornos e correcção de perspectiva ficam para uma iteração seguinte.
- **App Android:** web app instalável (PWA com ícones PNG, atalho "Digitalizar", botão "Instalar no telemóvel") desde já, e projecto Trusted Web Activity em `apps/contai-android/` (Bubblewrap) para a Play Store, com `/.well-known/assetlinks.json` gerado a partir das definições (identificador e impressões SHA-256). Motivo: toda a lógica vive na web app, uma actualização do servidor actualiza todos os telemóveis, e a versão de loja só depende do domínio HTTPS e de uma chave de assinatura. Capacitor fica como evolução se for preciso código nativo.
- **Servidor:** mudado para Falkenstein (fsn1, o datacenter Hetzner mais próximo de Portugal, com Nuremberga) e para cpx32 (4 vCPU AMD, 8 GB), a pedido do product owner ("mais próximo de Portugal e optimizado"): OCR local e builds Docker beneficiam de mais núcleos; o tipo pode subir sem reinstalar, mas não descer (disco de 160 GB).
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Segredos das integrações na UI (cifrados) e servidor que segue o ramo

- **Decisão:** as credenciais das integrações (Anthropic, email webhook/IMAP, WhatsApp, CentralGest) deixam de exigir edição do `.env` no servidor: configuram-se em Configuração > Integrações (só gabinete), ficam cifradas na base de dados (AES-256-GCM, chave derivada de `CONTAI_SECRET_KEY`/`JWT_SECRET`), sobrepõem-se ao ambiente e nunca voltam ao browser em claro. Guardar reinicia a app em produção para recarregar os componentes. O servidor de produção corre `contai-autoupdate` de 5 em 5 minutos e aplica automaticamente os commits novos do ramo.
- **Contexto:** o token da API do Hetzner foi revogado após o provisionamento (boa prática) e não há acesso SSH a partir do ambiente de desenvolvimento. Sem estes dois mecanismos, cada alteração de código ou de segredo exigiria intervenção manual na consola do Hetzner. Os segredos passam a ser introduzidos pelo product owner directamente na app, sem transitar pela conversa com o assistente.
- **Reversível por:** Fábio (product owner).

## 2026-09-13 — Sem contas de demonstração em produção; administração por variáveis de ambiente

- **Decisão:** com `NODE_ENV=production` a app não semeia as contas de demonstração (`gabinete@demo.pt`, etc., com palavras-passe públicas no README); a primeira conta do gabinete é criada uma só vez a partir de `CONTAI_ADMIN_EMAIL` + `CONTAI_ADMIN_PASSWORD`, e cada utilizador pode alterar a sua palavra-passe em "A minha conta" (`POST /api/auth/password`, registado no audit log). `CONTAI_SEED_DEMO=1` força a demonstração (formação, ambientes de teste). A página de login só mostra as credenciais de demonstração quando o servidor as tem (`GET /api/public-config`).
- **Contexto:** o primeiro arranque em produção no Hetzner ficou acessível na Internet com as contas de demonstração; o servidor foi recriado de raiz com esta alteração. Regras de conferência de balancetes continuam a ser semeadas em qualquer ambiente.
- **Reversível por:** Fábio (product owner).

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
