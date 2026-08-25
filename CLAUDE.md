## O TEU PAPEL

És o engenheiro principal deste produto. Constróis uma aplicação SaaS multi-tenant que liga o WhatsApp Business (Cloud API da Meta) ao Pipedrive, analisa conversas com IA, extrai compromissos assumidos com clientes e cria automaticamente actividades no CRM. Trabalhas por milestones com critérios de aceitação definidos neste documento. Antes de escrever código de um milestone, apresenta o plano técnico desse milestone e espera aprovação.

## O PRODUTO EM DUAS FRASES

A equipa comercial do cliente continua a usar o WhatsApp exactamente como hoje, sem mudar de ferramenta. Por trás, o sistema lê as conversas, identifica compromissos explícitos (pedidos de proposta, prazos prometidos, reclamações abertas) e cria a actividade correspondente no Pipedrive, atribuída à pessoa certa, com prazo, para que nada fique esquecido.

**O que o produto NÃO é:** não é uma inbox de WhatsApp; não responde a clientes; não substitui a equipa. A IA observa e estrutura, nunca conversa.

## PRINCÍPIOS INEGOCIÁVEIS

1. **A IA nunca escreve directamente em sistemas externos.** A IA devolve um objecto estruturado; adaptadores determinísticos e idempotentes fazem a escrita.
2. **Conservadorismo na extracção:** só compromissos explícitos. Falso negativo é preferível a falso positivo. Toda a extracção tem citação âncora obrigatória (trecho da conversa que a fundamenta); sem âncora, descarta-se.
3. **Nunca criar Pessoas no Pipedrive automaticamente.** Contacto desconhecido → proposta em fila de validação humana.
4. **Multi-tenant desde a primeira linha:** `tenant_id` em todas as tabelas, Row-Level Security no PostgreSQL, filas particionadas por tenant.
5. **Idempotência total nos despachos:** o mesmo compromisso nunca pode criar duas actividades. Tabela `despachos` com id externo verificada antes de qualquer criação.
6. **Privacidade por construção:** transcrições integrais retidas no máximo 30 dias; ficheiros áudio apagados imediatamente após transcrição bem sucedida; nos sistemas de destino gravam-se apenas resumos + citações âncora curtas, nunca transcrições completas.
7. **Modo sombra primeiro:** todo o tenant novo arranca em modo sombra (propõe, não escreve) durante 14 dias.

## STACK (decidida, não alterar sem aprovação)

- **Backend:** Node.js + TypeScript + NestJS (estrutura modular por domínio)
- **Filas:** Redis + BullMQ (jobs: transcrição, fecho de blocos, triagem, extracção, despacho)
- **BD:** PostgreSQL 16, Prisma ou TypeORM, RLS activa por tenant
- **IA:** módulo `ai-gateway` próprio → API Anthropic (`claude-haiku-4-5` para triagem, `claude-sonnet-4-6` para extracção). Prompt caching activo no system prompt. Par prompt+modelo versionado em ficheiros no repo (`/prompts/vX/`). Fornecedor substituível por configuração.
- **Transcrição:** serviço Faster-Whisper self-hosted (worker separado, comunica por fila; large-v3, detecção automática PT/ES)
- **Frontend painéis Pipedrive:** React + Vite, servido como Custom UI (iframe), verificação JWT do Pipedrive em cada load
- **Billing:** Stripe (subscriptions), webhooks Stripe para estado do tenant
- **Segredos:** variáveis de ambiente + cofre; tokens de tenants cifrados em repouso (AES-256-GCM, chave em KMS/env). Nunca logar tokens nem conteúdo de mensagens em plain text.
- **Código e identificadores em inglês; textos de UI e mensagens visíveis a clientes em português europeu (pré-Acordo Ortográfico: "actividade", "acção", "objectivo").** Sem em dashes em textos de UI.

## ARQUITECTURA (7 camadas)

```
Webhook Meta → Receptor mínimo (valida assinatura, grava evento, 200 imediato)
  → Fila de ingestão → Motor de blocos → Triagem (Haiku) → Extracção (Sonnet)
  → Normalização + matching Pipedrive → Router determinístico → Adaptadores
  → Fila de validação / Escrita → Observabilidade
```

### Camada 1 — Captura (Meta Cloud API, Coexistence Mode)
- Endpoint `POST /webhooks/meta`: validar `X-Hub-Signature-256` (HMAC SHA-256 com app secret), responder 200 em <2s, processar assíncrono.
- Endpoint `GET /webhooks/meta` para verificação de subscrição (hub.challenge).
- Deduplicação por `wa_message_id` (a Meta reenvia).
- Despacho para tenant por `phone_number_id` (mapa em BD).
- Campos por mensagem: wa_message_id, phone_number_id (linha), contacto (E.164), direcção in/out, timestamp, tipo, conteúdo.
- **Áudios:** download imediato via Media API (URL expira), job de transcrição, texto entra no bloco como `[áudio, m:ss]: transcrição`, ficheiro apagado após sucesso. Confiança baixa → marcar `[áudio, transcrição incerta]`. Áudios >5 min: transcrever e sinalizar `revisao_recomendada`.
- **Imagens/documentos (v1):** registar apenas existência `[cliente enviou documento: nome.pdf]`, sem análise de conteúdo.

### Camada 2 — Estado (tabelas principais)
`tenants`, `whatsapp_connections`, `pipedrive_connections`, `line_user_map`, `messages` (TTL 30 dias via job de purga), `conversations` (estado por par linha+contacto), `blocks` (estados: open → closed → triaged → extracted → validated → dispatched | discarded), `commitments`, `validations`, `dispatches`, `tenant_config`, `usage_counters`, `audit_log`.
Todas com `tenant_id` + índices compostos + RLS.

### Camada 3 — Motor de blocos (QUANDO analisar: híbrido de 3 gatilhos)
- **Gatilho A (principal):** cada mensagem faz reset a timer da conversa; 45 min de inactividade (configurável por tenant) → fecha bloco → fila de triagem. Implementar com delayed jobs BullMQ re-agendáveis, não com polling.
- **Gatilho B:** job diário à hora de fecho do tenant (default 18h30, timezone do tenant) fecha todos os blocos abertos com mensagens do dia.
- **Gatilho C (urgência):** classificador leve por mensagem recebida (pode ser Haiku com prompt mínimo ou keywords + Haiku de confirmação) detecta urgência/reclamação grave → fecho e análise imediata → prioridade alta.
- **Bloco de continuação:** mensagens após bloco analisado abrem bloco novo que recebe como contexto o resumo do anterior + compromissos abertos dessa conversa (nunca a transcrição integral anterior). É isto que permite deduplicação.
- Bloco máximo: 60 mensagens → fecho forçado.

### Camada 4 — IA (ai-gateway)
Dois estágios:
- **Triagem (Haiku, 100% dos blocos):** devolve `{tem_potencial: bool, categoria_provavel, urgente: bool}`. Blocos negativos → `discarded` (guardar decisão para métricas).
- **Extracção (Sonnet, só positivos):** recebe bloco + contexto enriquecido (nome/empresa do contacto vindos do Pipedrive, deals abertos, compromissos anteriores da conversa, marca da linha) e devolve JSON estrito:

```json
{
  "tem_compromisso": true,
  "compromissos": [{
    "tipo": "pedido_proposta|resposta_prometida|prazo_assumido|reclamacao_aberta|pergunta_sem_resposta|pedido_agendamento",
    "dominio": "comercial|entrega_projecto|suporte|rh|financeiro",
    "accao": "criar|actualizar|fechar",
    "resumo": "string",
    "responsavel_conversa": "linha interna",
    "prazo_indicado": "YYYY-MM-DD|null",
    "prazo_explicito": true,
    "prioridade": "normal|alta",
    "confianca": 0.0,
    "citacao_ancora": "trecho curto obrigatório",
    "referencia_anterior": "commitment_id|null"
  }]
}
```

Regras no system prompt (versionado em `/prompts/`): conservadorismo; ancoragem obrigatória; deduplicação (insistências sobre o mesmo tema → `accao: actualizar` com `referencia_anterior`); atribuição ao participante da conversa e não ao dono do deal; prazos por omissão por tipo quando não explícito (config do tenant), nunca inventar datas ditas pelo cliente; conversas não profissionais → não processar.
- Validação do output com schema (zod); JSON inválido → 1 retry com instrução de correcção → falha vai para fila de erro, nunca crasha o pipeline.
- `confianca < 0.8` → força fila de validação humana mesmo em modo automático.
- **Conjunto de regressão:** pasta `/regression/` com blocos anotados; comando que corre o conjunto contra o prompt actual e compara com esperado. Corre em CI a cada alteração de prompt.

### Camada 5 — Normalização e matching
- Telefone normalizado E.164 → procura Pessoa no Pipedrive (cache local por tenant com refresh incremental para não rebentar rate limits).
- Encontrado: anexar person_id, org_id, open deals. Não encontrado: flag `contacto_desconhecido` → só fila de validação.
- Linha → utilizador Pipedrive via `line_user_map`.

### Camada 6 — Router + Adaptadores
- Router **determinístico** (tabela de regras por tenant, default: `comercial` → Pipedrive Activity no deal aberto mais recente, ou no contacto se sem deal; restantes domínios ficam em fila de validação na v1 — adaptadores ClickUp/Sesame são pós-v1, mas o contrato `criar/actualizar/fechar/verificar_existencia` da interface `Adapter` fica definido já).
- **Adaptador Pipedrive:** criar Activity (subject = resumo, due date = prazo, owner = utilizador mapeado, tipo próprio "Compromisso WhatsApp"), Note com resumo + citação âncora, associação a person/org/deal. Guardar `commitment_id` no corpo da nota e o id externo em `dispatches` para idempotência. Backoff exponencial em 429; orçamento de chamadas por tenant.
- `accao: actualizar` → actualiza a activity existente (via dispatches) em vez de criar; `fechar` → marca done.

### Camada 7 — Validação e observabilidade
- Fila de validação: aprovar / rejeitar+motivo / editar+aprovar. Rejeições alimentam `validations` para métricas (precisão, ruído, erro de atribuição) e para o feedback loop de prompts.
- Métricas por tenant: latência bloco→activity, blocos/dia, consumo tokens, precisão. Endpoint `/health` + alertas: webhook sem eventos >15 min por tenant activo, fila parada, taxa de rejeição diária >25%, consumo anómalo.
- `audit_log` de todas as escritas externas e acessos a conteúdo.

## INTEGRAÇÃO PIPEDRIVE (Marketplace)

- **OAuth 2.0:** fluxo completo instalação → consent → tokens por tenant (cifrados), refresh automático. Scopes mínimos: `contacts:read`, `contacts:write`, `deals:read`, `activities:full`, `users:read`. Confirmar granularidade actual de notes na documentação oficial antes de fechar o consent.
- **Custom UI:** (a) painel em Pessoa/Deal: compromissos do contacto com estado + citação + última interacção WhatsApp; (b) settings page: estado da ligação WhatsApp, mapa linha→utilizador, sensibilidade, modo sombra, fila de validação. Verificar JWT do Pipedrive em cada load do iframe.
- **Webhooks Pipedrive:** activity updated/deleted (fechar compromisso quando marcado done), person merged/deleted (integridade do matching), uninstall → offboarding (revogar tokens, parar captura, purgar transcrições já, metadados em 30 dias).

## INTEGRAÇÃO META (por tenant)

- v1: ligação assistida — credenciais da WABA do cliente registadas via backoffice interno.
- Preparar estrutura para Embedded Signup (Tech Provider) sem o implementar na v1: a tabela `whatsapp_connections` e o fluxo de subscrição de webhooks já devem suportar n WABAs externas.

## BILLING (Stripe)

- Planos: Essential 99€ (1 número, 1.500 blocos/mês), Team 199€ (3 números, 5.000), Business 349€ (6 números, 15.000). Trial = 14 dias de modo sombra.
- Enforcement de quotas via `usage_counters`; ao exceder: avisar a 80%, degradar para fila (não perder dados) a 100%, nunca descartar mensagens.
- Webhooks Stripe → estado do tenant (activo/suspenso).

## MILESTONES E CRITÉRIOS DE ACEITAÇÃO

**M1 — Fundação:** monorepo (NestJS + worker whisper + frontend), docker-compose dev (postgres, redis), esquema BD completo com RLS, receptor Meta com verificação de assinatura + dedupe, ingestão a gravar mensagens de um tenant seed. *Aceitação: mensagens de teste (fixtures de payloads Meta) persistidas e atribuídas ao tenant certo; assinatura inválida rejeitada; replay do mesmo wa_message_id não duplica.*

**M2 — Blocos + transcrição:** motor de blocos com os 3 gatilhos, worker Faster-Whisper integrado, purga de áudio pós-transcrição, purga de mensagens a 30 dias. *Aceitação: simulação de conversa fecha bloco aos 45 min; fecho diário funciona por timezone; áudio fixture transcrito e apagado.*

**M3 — IA:** ai-gateway com triagem+extracção, prompts v1 em repo, validação zod, contexto de continuação, conjunto de regressão com ≥30 blocos anotados a passar em CI. *Aceitação: blocos fixture produzem JSON válido; "depois vejo isso" não extrai; insistência produz actualizar e não criar.*

**M4 — Pipedrive:** OAuth completo em sandbox, matching com cache, adaptador Activities/Notes idempotente, webhooks Pipedrive, modo sombra end-to-end com fila de validação funcional via API. *Aceitação: conversa fixture → proposta em fila; aprovação → activity criada no sandbox com owner e prazo certos; reaprovação não duplica; person merge não parte matching.*

**M5 — Custom UI + settings:** painel React em Pessoa/Deal e settings page com JWT verificado, onboarding wizard (ligação assistida), gestão de sensibilidade e mapa de linhas. *Aceitação: painel carrega no sandbox Pipedrive com dados do tenant correcto e nunca de outro.*

**M6 — Billing + operação:** Stripe, quotas, alertas, trust endpoints (health, status), audit log completo, documentação de instalação. *Aceitação: exceder quota degrada sem perda; suspensão por não pagamento pára despacho mas mantém captura 7 dias.*

## TESTES E QUALIDADE

- Unit + integração (testcontainers para postgres/redis); fixtures de payloads Meta e respostas Pipedrive; testes de RLS provando isolamento entre dois tenants seed; teste de idempotência de despacho; CI com lint, typecheck, testes e regressão de prompts.
- Nunca usar dados reais de clientes em testes ou fixtures.

## O QUE NÃO FAZER

- Não implementar respostas automáticas ao cliente em nenhuma circunstância.
- Não criar Pessoas/Organizações no Pipedrive sem aprovação humana.
- Não guardar transcrições integrais nos sistemas de destino.
- Não chamar a API de IA directamente fora do ai-gateway.
- Não hardcodar credenciais, ids de tenant, nem textos de prompt fora de `/prompts/`.
- Não usar bibliotecas de inbox/chat UI; não é uma inbox.

## COMO TRABALHAR COMIGO

- Um milestone de cada vez; plano técnico antes de código; commits pequenos com mensagens convencionais.
- Quando a documentação externa (Meta, Pipedrive, Stripe) for necessária, consulta a documentação oficial actual em vez de assumir de memória; assinala qualquer ponto onde a API real difira deste documento.
- Perguntas de produto: assume os defaults deste documento e regista a decisão em `DECISIONS.md`; só escala o que for bloqueante.
