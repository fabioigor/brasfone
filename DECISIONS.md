# Registo de decisões de produto

Decisões assumidas por omissão (conforme `CLAUDE.md`) durante o desenvolvimento, para não bloquear o trabalho em perguntas não críticas. Formato: data, decisão, contexto/alternativas consideradas, quem pode reverter.

## 2026-08-25 — Criação do CLAUDE.md e arranque do projecto

- **Decisão:** adoptar o documento de especificação (PDS-INT-WA-PD-001 / ARQ-INT-WA-001 / ARQ-APP-PD-001) como `CLAUDE.md` na raiz do repositório, guiando todo o desenvolvimento subsequente por milestones.
- **Contexto:** repositório estava vazio; este é o primeiro commit.
- **Reversível por:** Fábio (product owner).

## 2026-09-26 — Calculadora de ROI Pipedrive + Meta CAPI para o Social Media Hackathon

- **Decisão:** criar `apps/roi-calculator` (página estática + servidor Node) como ferramenta de stand da INUBIA para agências de marketing, fora do âmbito do produto WhatsApp→Pipedrive mas no mesmo monorepo.
- **Pressupostos do modelo (editáveis na página):** CPL −25%, taxa de SQL +30% relativo, retenção +50%, avença +15%, implementação 2.400 € (cerca de 32h a rates internos), manutenção 99 €/cliente/mês, comissão de referral 10% sobre o primeiro ano de serviços INUBIA do cliente apresentado, projecto médio 6.000 €, 3 clientes apresentados por ano.
- **Pipedrive:** API v1 com token pessoal; Organização procurada por nome exacto e Pessoa por email para não duplicar; Negócio com valor igual ao referral anual estimado; Nota fixada com o relatório. Pipeline/etapa/owner por variáveis de ambiente.
- **Email:** SMTP via nodemailer, relatório HTML com plano de parceiros embutido e link opcional para o plano completo.
- **Reversível por:** Fábio (product owner). Percentagem de comissão e custos a confirmar antes do evento.
