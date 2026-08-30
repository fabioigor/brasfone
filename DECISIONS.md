# Registo de decisões de produto

Decisões assumidas por omissão (conforme `CLAUDE.md`) durante o desenvolvimento, para não bloquear o trabalho em perguntas não críticas. Formato: data, decisão, contexto/alternativas consideradas, quem pode reverter.

## 2026-08-30 — ContaDesk: app para gabinete de contabilidade (novo produto no repo)

- **Decisão:** criar em `apps/contadesk/` uma aplicação para gabinetes de contabilidade inspirada no Kangaroo Files (portal do cliente, recepção e classificação de documentos, arquivo digital DL 28/2019, lançamentos propostos com validação humana, exportação Cegid Primavera), separada do produto WhatsApp→Pipedrive descrito no `CLAUDE.md`.
- **Contexto:** pedido directo do product owner. Por ser um produto distinto, não segue os milestones do `CLAUDE.md`, mas herda os princípios: a IA nunca escreve sem validação humana, idempotência total nas exportações, audit log, textos de UI em português europeu pré-Acordo.
- **Stack da v1:** Express + TypeScript + SQLite (better-sqlite3), sem serviços externos, para ter uma app executável e testável de imediato; gateway de IA com fornecedor heurístico por omissão e Anthropic opcional via `ANTHROPIC_API_KEY`. Migração para NestJS/PostgreSQL quando o produto justificar multi-gabinete.
- **Reversível por:** Fábio (product owner).

## 2026-08-25 — Criação do CLAUDE.md e arranque do projecto

- **Decisão:** adoptar o documento de especificação (PDS-INT-WA-PD-001 / ARQ-INT-WA-001 / ARQ-APP-PD-001) como `CLAUDE.md` na raiz do repositório, guiando todo o desenvolvimento subsequente por milestones.
- **Contexto:** repositório estava vazio; este é o primeiro commit.
- **Reversível por:** Fábio (product owner).
