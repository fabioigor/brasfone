# ContaDesk

Portal digital para gabinetes de contabilidade, inspirado no Kangaroo Files: recepção de documentos dos clientes, classificação automática, arquivo digital organizado (Decreto-Lei 28/2019), geração de lançamentos contabilísticos com validação humana obrigatória, lançamento directo no CentralGest por API (com servidor MCP para agentes de IA) e exportação para Cegid Primavera.

## Funcionalidades

- **Portal do cliente:** cada empresa cliente tem acesso próprio para carregar documentos, ver o estado do processamento e responder a pedidos do gabinete.
- **Classificação automática:** cada documento é classificado (factura de compra/venda, recibo, nota de crédito, extracto bancário, despesa) com extracção de NIF, data, número de documento, base tributável, IVA e total. A direcção compra/venda decide-se comparando o NIF emissor com o NIF da empresa.
- **Arquivo digital:** os ficheiros são arquivados por empresa/ano/mês/tipo, com deduplicação por hash SHA-256 (o mesmo ficheiro nunca entra duas vezes).
- **Lançamentos propostos:** o motor gera lançamentos SNC balanceados (clientes 211, fornecedores 221, IVA dedutível 2432, IVA liquidado 2433, FSE 62, prestações de serviços 721) com grau de confiança. Nada é exportado sem aprovação humana.
- **Fila de validação:** o gabinete aprova, edita as linhas ou rejeita com motivo. Linhas desbalanceadas são recusadas.
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

O ContaDesk inclui um servidor MCP (Model Context Protocol) em `src/mcp/server.ts` que expõe o pipeline completo a agentes como o Claude:

| Ferramenta | Função |
|---|---|
| `contadesk_estado` | Contagens por estado + teste de ligação ao CentralGest |
| `contadesk_listar_empresas` | Empresas clientes com NIF e código CentralGest |
| `contadesk_definir_codigo_centralgest` | Mapear empresa → código CentralGest |
| `contadesk_listar_documentos` | Documentos com tipo, estado e dados extraídos |
| `contadesk_processar_documento` | Classificar um ficheiro/texto e propor o lançamento SNC |
| `contadesk_listar_lancamentos` | Lançamentos com linhas, por estado |
| `contadesk_decidir_lancamento` | Aprovar (com edição de linhas) ou rejeitar com motivo |
| `centralgest_lancar` | Enviar os aprovados para o CentralGest (idempotente) |
| `centralgest_listar_despachos` | Historial de despachos com números remotos e erros |
| `contadesk_conferir_documentos` | Reexecutar a conferência de IVA/coerência/duplicados |
| `contadesk_listar_alertas` / `contadesk_resolver_alerta` | Gerir alertas de documentos e balancetes |
| `contadesk_segunda_opiniao_iva` | Segunda opinião do agente fiscal sobre um alerta |
| `contadesk_importar_balancete` / `contadesk_conferir_balancete` | Balancetes e padrões |
| `contadesk_listar_padroes` / `contadesk_definir_padrao` | Configurar padrões de conferência |
| `contadesk_gerar_relatorio` | Relatório financeiro com comparação sectorial |
| `contadesk_conhecimento_fiscal` | Versão e estado das regras de IVA e benchmarks |

Toda a escrita no CentralGest passa pelo despachante determinístico e idempotente; o mesmo lançamento nunca é enviado duas vezes, mesmo que o agente repita a ferramenta.

Configuração no Claude Code / Claude Desktop:

```json
{
  "mcpServers": {
    "contadesk": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "<repo>/apps/contadesk",
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
cd apps/contadesk
npm install
npm start          # http://localhost:3000
```

Contas de demonstração (criadas no primeiro arranque):

| Utilizador | Email | Palavra-passe | Papel |
|---|---|---|---|
| Maria Contabilista | gabinete@demo.pt | gabinete123 | Gabinete (staff) |
| João Padeiro | padaria@demo.pt | cliente123 | Cliente (Padaria Central Lda) |
| Ana Silva | tecnonorte@demo.pt | cliente123 | Cliente (TecnoNorte Unipessoal Lda) |

Variáveis de ambiente: `PORT` (3000), `DB_PATH` (`data/contadesk.db`), `STORAGE_ROOT` (`data/arquivo`), `JWT_SECRET` (obrigatória em produção), `ANTHROPIC_API_KEY` (opcional), `CENTRALGEST_BASE_URL` + `CENTRALGEST_API_KEY` (API CentralGest) ou `CENTRALGEST_MOCK=1` (simulador local).

## Testes

```bash
npm run typecheck
npm test   # 82 testes: dominio, conferencia IVA, balancetes, relatorios, API end-to-end, CentralGest e MCP
```

Os testes cobrem o fluxo completo (upload → proposta → validação → exportação), a idempotência da exportação, a deduplicação por hash e o isolamento entre empresas (um cliente nunca vê nem carrega documentos de outra).

## Limitações da v1 (assumidas)

- Os benchmarks sectoriais são valores indicativos; devem ser actualizados com os Quadros do Setor via BPstat antes de entregar relatórios a clientes (fluxo em `docs/fontes-externas.md`).
- A categorização produto → taxa de IVA é por palavras-chave e emite avisos (nunca erros): a decisão final sobre a taxa legal é do contabilista.

- Só extrai texto de ficheiros de texto (TXT/CSV/XML/JSON); PDFs e imagens são arquivados e classificados pelo nome do ficheiro, ficando os detalhes para o revisor (OCR fica para a v2).
- Recepção por email/WhatsApp: o esquema já tem o campo `channel`, mas só o canal portal está implementado.
- Exportação Primavera em CSV genérico de movimentos; o mapeamento exacto para o importador do Cegid Primavera deve ser confirmado com a documentação oficial.
- A API do CentralGest não tem documentação pública (o acesso obtém-se via "Pedido de Adesão à API" junto da CentralGest); o cliente implementa o contrato assumido em `docs/centralgest-api.md` e está isolado em `src/integrations/centralgest.ts` para ser ajustado quando a documentação oficial chegar.
- Base de dados SQLite num único ficheiro, adequada a um gabinete; migração para PostgreSQL quando for multi-gabinete.
