# Cont.ai by Lumarcont

Portal digital para gabinetes de contabilidade, inspirado no Kangaroo Files: recepção de documentos dos clientes, classificação automática, arquivo digital organizado (Decreto-Lei 28/2019), geração de lançamentos contabilísticos com validação humana obrigatória, lançamento directo no CentralGest por API (com servidor MCP para agentes de IA) e exportação para Cegid Primavera.

## Dossier de transferência

`docs/handover.md` resume produto, pedidos, arquitectura, infra-estrutura, estado e pendentes para quem continuar ou refazer o projecto; `docs/api.md` lista as 68 rotas e as 25 ferramentas MCP.

## Microsoft 365

OneDrive (ou SharePoint) como arquivo de todos os documentos recebidos, em pastas por empresa, ano, mês e tipo, e caixa de email lida pela Graph API com a autenticação da aplicação Microsoft 365 (sem IMAP nem palavra-passe da caixa). Configuração em Integrações; guia do registo no Entra ID em `docs/microsoft365.md`.

## Fornecedores por NIF, centros de custo e perguntas no WhatsApp

Centros de custo por empresa escolhidos desde a digitalização (ecrã Digitalizar, formulário de Documentos, perguntas no WhatsApp) e aplicados às linhas do lançamento e à exportação; fornecedor desconhecido → pesquisa por NIF (VIES + pesquisa web por IA + nome no documento) com marcas e probabilidades, escolha humana, criação do fornecedor com centros de custo e aplicação aos lançamentos pendentes. Ver `docs/fornecedores.md`.

## Pastas OneDrive por centro de custo

Criar um centro de custo cria a pasta correspondente no OneDrive (com subpasta "A receber"); documentos com centro de custo arquivam-se dentro dela e ficheiros deixados em "A receber" entram na app já com esse centro. Ver `docs/microsoft365.md`.

## GestObrig: prazos declarativos e acessos às entidades

Importação da listagem de obrigações do GestObrig (CSV/Excel, sem API pública) para a vista Indicadores e prazos do gabinete e de cada cliente, com prazos em atraso e a vencer também na página Hoje; cofre cifrado de acessos aos portais oficiais (AT, Segurança Social Directa, IAPMEI, fundos de compensação...) por empresa, com revelação auditada e botão para abrir o portal. Ver `docs/gestobrig.md`.

## Digitalizar pelo telemóvel, app Android e app iOS

Os clientes fotografam facturas e recibos em **Digitalizar** (câmara ou galeria, várias páginas, tratamento de imagem e PDF gerado no browser) e enviam ao gabinete; no Android e no iOS também por **Partilhar com Cont.ai**. A web app instala-se pelo Chrome ou Safari ("Adicionar ao ecrã principal"); para as lojas existem o projecto Trusted Web Activity em `apps/contai-android/` (Play Store) e o projecto SwiftUI + WKWebView com extensão de partilha em `apps/contai-ios/` (App Store). Detalhes em `docs/android.md` e `docs/ios.md`.

## Funcionalidades

- **Portal do cliente:** cada empresa cliente tem acesso próprio para carregar documentos, ver o estado do processamento e responder a pedidos do gabinete.
- **Recepção por email e WhatsApp:** webhook de email (JSON ou MIME cru) e poller IMAP; webhook WhatsApp Cloud API com validação de assinatura e download de media; remetentes autorizados por empresa e alias `docs+<id>@`; remetentes desconhecidos ficam por associar (nunca criam empresas); confirmação opcional ao remetente. Ver `docs/canais.md`.
- **QR code da AT:** descodificação do QR (Despacho 412/2020-XXII) em imagens e PDFs: NIFs, tipo, data, número, ATCUD e desagregação de IVA por taxa passam a ser dados exactos que prevalecem sobre o OCR. Duplicados detectados também por ATCUD; documentos anulados e ficheiros com vários QR são sinalizados.
- **Extracção estruturada por IA e fusão de fontes:** com `ANTHROPIC_API_KEY`, o Claude devolve JSON validado (emitente, adquirente, linhas com taxa, IVA por taxa, totais); QR > IA > regras, com proveniência por campo e alerta `FONTES_DIVERGENTES` quando discordam. Pré-processamento de imagem (escala, cinzentos, Otsu) antes do Tesseract.
- **Memória de fornecedores:** as contas SNC usadas nas aprovações humanas são aprendidas por NIF e pré-preenchem as propostas seguintes; lançamentos com uma linha de IVA por taxa.
- **OCR de PDFs e imagens:** PDFs com camada de texto são lidos directamente (pdfjs, layout preservado); digitalizações e fotografias (PNG, JPG, WebP, TIFF, PDF sem texto) passam por OCR: Claude visão (SDK oficial, modelo `claude-opus-5` por omissão, configurável com `CONTAI_OCR_MODEL`) quando há `ANTHROPIC_API_KEY`, senão Tesseract local em WASM (português + inglês, dados de língua em cache em `data/tesseract`). PDFs digitalizados são rasterizados com `@napi-rs/canvas`. Confiança baixa gera o alerta `OCR_CONFIANCA_BAIXA`; ficheiros sem texto extraível geram `TEXTO_NAO_EXTRAIDO`. O texto e o método ficam guardados e visíveis (botão "Texto"), e qualquer documento pode ser reprocessado com os motores actuais.
- **Classificação automática:** cada documento é classificado (factura de compra/venda, recibo, nota de crédito, extracto bancário, despesa) com extracção de NIF, data, número de documento, base tributável, IVA e total. A direcção compra/venda decide-se comparando o NIF emissor com o NIF da empresa.
- **Arquivo digital:** os ficheiros são arquivados por empresa/ano/mês/tipo, com deduplicação por hash SHA-256 (o mesmo ficheiro nunca entra duas vezes).
- **Lançamentos propostos:** o motor gera lançamentos SNC balanceados (clientes 211, fornecedores 221, IVA dedutível 2432, IVA liquidado 2433, FSE 62, prestações de serviços 721) com grau de confiança. Nada é exportado sem aprovação humana.
- **Fila de validação com pré-visualização:** o gabinete vê o documento original (PDF, imagem ou texto) lado a lado com os dados extraídos (com proveniência: QR, IA, regras), os alertas e as linhas do lançamento; aprova, edita ou rejeita com motivo; atalhos de teclado (A, R, J, K). Linhas desbalanceadas são recusadas.
- **Lançamento no CentralGest (API):** os lançamentos aprovados são enviados directamente para o CentralGest Cloud via API, com idempotência em duas camadas (tabela `dispatches` local + `idExterno` no destino). Cada empresa tem um código CentralGest configurável na vista Empresas. Ver `docs/centralgest-api.md`.
- **Exportação Primavera:** CSV de movimentos idempotente; um lançamento exportado nunca volta a sair (tabela `export_batch_entries` com `entry_id` único). Cada lançamento segue por uma única via de entrega: API CentralGest ou CSV.
- **Pedidos de documentos:** o gabinete pede documentos com prazo; o cliente responde com upload dirigido ao pedido.
- **Calendário fiscal:** próximas obrigações (IVA mensal/trimestral, DMR, SAF-T, Modelo 22, IES, pagamentos por conta) conforme o regime de IVA de cada empresa.
- **Audit log:** todas as escritas e acessos a documentos ficam registados.

## Agentes de análise (conferência, balancetes, relatórios)

- **Conferência de lançamentos:** cada documento é conferido automaticamente na entrada e a pedido. Alertas: `IVA_CALCULO` (valor do IVA não bate com a taxa), `TAXA_INEXISTENTE` (taxa não existe no território/data), `TAXA_DESADEQUADA` / `TAXAS_MISTAS_POSSIVEIS` (taxa aplicada não corresponde ao produto/serviço segundo as Listas I e II do CIVA), `TOTAL_INCOERENTE`, `DUPLICADO` (mesmo número do mesmo emissor), `DATA_FUTURA`, `AUMENTO_IMPOSTO_ANOMALO` (taxa efectiva sobe face ao histórico do terceiro) e `NIF_TERCEIRO_EM_FALTA`. Os alertas são conservadores: assinalam, nunca corrigem.
- **Conhecimento fiscal versionado:** taxas por território (Continente, Açores, Madeira), histórico de taxas e categorias de produtos/serviços com base legal vivem em `src/knowledge/vat-rules.json` com `version` e `last_verified`. Quando a data ultrapassa o prazo de revisão, o painel e o MCP sinalizam conhecimento desactualizado; a actualização da lei é uma alteração de dados revista em git, não de código.
- **Conferência de balancetes:** importação de CSV (`conta;descricao;debito;credito[;saldo]`) ou derivação dos lançamentos aprovados; avaliação contra **padrões configuráveis** (sinal dos saldos, variação % ou € face ao período anterior, saldo máximo/mínimo, rácios) na área "Balancetes"; 10 padrões por omissão, mais padrões por empresa.
- **Relatórios financeiros para clientes:** KPIs, rácios comparados com o sector de actividade (CAE → 6 modelos sectoriais em `src/knowledge/sector-benchmarks.json`), estrutura de gastos, gráficos SVG (paleta validada, legíveis em modo claro/escuro) e memória descritiva determinística; com `ANTHROPIC_API_KEY` o agente reescreve a memória (modelo `claude-opus-5`) sem alterar números. Os relatórios ficam na área reservada do cliente.
- **Fontes externas:** o Banco de Portugal (BPstat) tem API REST pública, verificada neste ambiente; o INE tem API JSON. Não é preciso scraping. Ver `docs/fontes-externas.md`.
- **Área reservada (web app):** o portal do cliente é instalável (manifest + service worker) e mostra documentos, alertas que lhe dizem respeito, pedidos e relatórios.

## Gateway de IA

Toda a inteligência passa pelo módulo `src/ai/provider.ts`. Por omissão usa o motor heurístico determinístico (funciona offline). Com `ANTHROPIC_API_KEY` definida, as classificações de confiança baixa são refinadas com `claude-haiku-4-5`; uma falha da IA nunca pára o pipeline (o resultado heurístico prevalece). Nenhum outro módulo chama APIs de IA directamente.

## Servidor MCP (lançar documentação no CentralGest via agentes de IA)

O Cont.ai inclui um servidor MCP (Model Context Protocol) em `src/mcp/server.ts` que expõe o pipeline completo a agentes como o Claude:

| Ferramenta | Função |
|---|---|
| `contai_estado` | Contagens por estado + teste de ligação ao CentralGest |
| `contai_listar_empresas` | Empresas clientes com NIF e código CentralGest |
| `contai_definir_codigo_centralgest` | Mapear empresa → código CentralGest |
| `contai_listar_documentos` | Documentos com tipo, estado e dados extraídos |
| `contai_processar_documento` | Ler (OCR se necessário), classificar e conferir um ficheiro PDF/imagem/texto e propor o lançamento SNC |
| `contai_texto_documento` / `contai_reprocessar_documento` | Ver o texto extraído e reprocessar com os motores actuais |
| `contai_listar_recepcoes` / `contai_associar_contacto` / `contai_listar_contactos` | Recepção por email/WhatsApp e remetentes autorizados |
| `contai_memoria_fornecedores` | Contas aprendidas por terceiro |
| `contai_listar_lancamentos` | Lançamentos com linhas, por estado |
| `contai_decidir_lancamento` | Aprovar (com edição de linhas) ou rejeitar com motivo |
| `centralgest_lancar` | Enviar os aprovados para o CentralGest (idempotente) |
| `centralgest_listar_despachos` | Historial de despachos com números remotos e erros |
| `contai_conferir_documentos` | Reexecutar a conferência de IVA/coerência/duplicados |
| `contai_listar_alertas` / `contai_resolver_alerta` | Gerir alertas de documentos e balancetes |
| `contai_segunda_opiniao_iva` | Segunda opinião do agente fiscal sobre um alerta |
| `contai_importar_balancete` / `contai_conferir_balancete` | Balancetes e padrões |
| `contai_listar_padroes` / `contai_definir_padrao` | Configurar padrões de conferência |
| `contai_gerar_relatorio` | Relatório financeiro com comparação sectorial |
| `contai_conhecimento_fiscal` | Versão e estado das regras de IVA e benchmarks |

Toda a escrita no CentralGest passa pelo despachante determinístico e idempotente; o mesmo lançamento nunca é enviado duas vezes, mesmo que o agente repita a ferramenta.

Configuração no Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "contai": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "<repo>/apps/contai",
      "env": {
        "CENTRALGEST_BASE_URL": "https://<url-da-api>",
        "CENTRALGEST_API_KEY": "<chave>"
      }
    }
  }
}
```

Para experimentar sem credenciais reais: `CENTRALGEST_MOCK=1` arranca um CentralGest simulado local (também usado nos testes).

## Como correr

```bash
cd apps/contai
npm install
npm start          # http://localhost:3000
```

Contas de demonstração (criadas no primeiro arranque **fora de produção**; em produção, `NODE_ENV=production`, não são criadas e a primeira conta do gabinete vem de `CONTAI_ADMIN_EMAIL` + `CONTAI_ADMIN_PASSWORD`; `CONTAI_SEED_DEMO=1` força a demonstração):

| Utilizador | Email | Palavra-passe | Papel |
|---|---|---|---|
| Maria Contabilista | gabinete@demo.pt | gabinete123 | Gabinete (staff) |
| João Padeiro | padaria@demo.pt | cliente123 | Cliente (Padaria Central Lda) |
| Ana Silva | tecnonorte@demo.pt | cliente123 | Cliente (TecnoNorte Unipessoal Lda) |

Variáveis de ambiente: `PORT` (3000), `DB_PATH` (`data/contai.db`), `STORAGE_ROOT` (`data/arquivo`), `JWT_SECRET` (obrigatória em produção), `CONTAI_ADMIN_EMAIL` + `CONTAI_ADMIN_PASSWORD` (conta de administração criada uma só vez no arranque; a palavra-passe muda-se depois em "A minha conta"), `CONTAI_SEED_DEMO` (dados de demonstração: por omissão só fora de produção), `CONTAI_SECRET_KEY` (cifra as definições guardadas em Configuração > Integrações; por omissão deriva de `JWT_SECRET`), `ANTHROPIC_API_KEY` (opcional), `CENTRALGEST_BASE_URL` + `CENTRALGEST_API_KEY` (API CentralGest) ou `CENTRALGEST_MOCK=1` (simulador local), `CONTAI_OCR_MODEL` (modelo de visão), `TESSERACT_CACHE_PATH` / `TESSERACT_LANG_PATH` (dados de língua; por omissão descarregados uma vez para `data/tesseract`), `CONTAI_DISABLE_TESSERACT=1` (desligar OCR local), `CONTAI_DISABLE_AI_EXTRACTION=1` (desligar extracção estruturada), `INBOUND_EMAIL_SECRET`, `IMAP_*`, `WHATSAPP_*` (canais; ver `docs/canais.md`).

## Testes

```bash
npm run typecheck
npm test   # 120+ testes: dominio, OCR, QR da AT, fusao de fontes, canais email/WhatsApp, conferencia IVA, balancetes, relatorios, API, CentralGest e MCP
```

Os testes cobrem o fluxo completo (upload → proposta → validação → exportação), a idempotência da exportação, a deduplicação por hash e o isolamento entre empresas (um cliente nunca vê nem carrega documentos de outra).

## Limitações da v1 (assumidas)

- Os benchmarks sectoriais são valores indicativos; devem ser actualizados com os Quadros do Setor via BPstat antes de entregar relatórios a clientes (fluxo em `docs/fontes-externas.md`).
- A categorização produto → taxa de IVA é por palavras-chave e emite avisos (nunca erros): a decisão final sobre a taxa legal é do contabilista.

- O OCR local (Tesseract) precisa de descarregar os dados de língua na primeira utilização (ou de os ter em `TESSERACT_LANG_PATH`); em servidores sem rede, use Claude visão ou pré-carregue a cache.
- Recepção por email/WhatsApp: o esquema já tem o campo `channel`, mas só o canal portal está implementado.
- Exportação Primavera em CSV genérico de movimentos; o mapeamento exacto para o importador do Cegid Primavera deve ser confirmado com a documentação oficial.
- A API do CentralGest não tem documentação pública (o acesso obtém-se via "Pedido de Adesão à API" junto da CentralGest); o cliente implementa o contrato assumido em `docs/centralgest-api.md` e está isolado em `src/integrations/centralgest.ts` para ser ajustado quando a documentação oficial chegar.
- Base de dados SQLite num único ficheiro, adequada a um gabinete; migração para PostgreSQL quando for multi-gabinete.
