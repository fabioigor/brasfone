# Registo de decisões de produto

Decisões assumidas por omissão (conforme `CLAUDE.md`) durante o desenvolvimento, para não bloquear o trabalho em perguntas não críticas. Formato: data, decisão, contexto/alternativas consideradas, quem pode reverter.

## 2026-08-25 — Criação do CLAUDE.md e arranque do projecto

- **Decisão:** adoptar o documento de especificação (PDS-INT-WA-PD-001 / ARQ-INT-WA-001 / ARQ-APP-PD-001) como `CLAUDE.md` na raiz do repositório, guiando todo o desenvolvimento subsequente por milestones.
- **Contexto:** repositório estava vazio; este é o primeiro commit.
- **Reversível por:** Fábio (product owner).

## 2026-09-26 — Calculadora de ROI Pipedrive + Meta CAPI para o Social Media Hackathon

- **Decisão:** criar `apps/roi-calculator` (página estática + servidor Node) como ferramenta de stand da INUBIA para agências de marketing, fora do âmbito do produto WhatsApp→Pipedrive mas no mesmo monorepo.
- **Pressupostos do modelo (editáveis na página):** CPL −25%, taxa de SQL +30% relativo, retenção +50%, avença +15%, implementação 2.400 € (cerca de 32h a rates internos), manutenção 99 €/cliente/mês, taxa de fecho SQL→cliente +10% relativo; comissão de referral de 500 € por cliente apresentado que feche projecto INUBIA acima de 5.000 € (regra definida pelo Fábio), com 50% da carteira apresentada e 60% de fecho por defeito.
- **Pipedrive:** API v1 com token pessoal; Organização procurada por nome exacto e Pessoa por email para não duplicar; Negócio com valor igual ao referral anual estimado; Nota fixada com o relatório. Pipeline/etapa/owner por variáveis de ambiente.
- **Email:** SMTP via nodemailer, relatório HTML com plano de parceiros embutido e link opcional para o plano completo.
- **Reversível por:** Fábio (product owner). Custos de implementação e manutenção a confirmar antes do evento.

## 2026-09-27 — Duas calculadoras independentes (agências e empresas)

- **Decisão:** separar a calculadora em duas: `/agencias/` (parceria, parceiro gerador de leads) e `/empresas/` (Pipedrive + CAPI no funil da própria empresa), com página de entrada para escolher o perfil.
- **Contexto:** a versão única misturava dados da agência com dados dos clientes da agência; uma agência com dezenas de clientes não tem CPL nem taxas médias no evento. Na calculadora de agências, o ROI usa só dados da agência (fase 1) e o cliente tipo (fase 2) é ilustrativo, pré-preenchido com benchmarks, sem entrar no ROI.
- **Pressupostos agências:** 80% dos clientes com Meta Ads, 50% dos elegíveis apresentados, 60% fecham projecto acima de 5.000 €, 500 € por referral, retenção +50% e avença +15% só nos clientes ligados, 3 h comerciais por cliente apresentado a 45 €/h.
- **Pressupostos empresas:** CPL −25%, 20% de leads sem seguimento com 50% recuperadas pelo Pipedrive, taxa de SQL +30% e fecho +10% (relativos), margem 40%. Investimento definido pelo Fábio: licenciamento Pipedrive 708 €/utilizador/ano mais implementação média 5.000 €, relacionado com o custo da equipa comercial (por omissão 3 comerciais a 2.000 €/mês). ROI e payback calculados sobre a margem adicional; mostra-se também o peso do Pipedrive no custo da equipa, o custo total por cliente (ads + equipa) e os clientes adicionais necessários para pagar o investimento.
- **Servidor:** o relatório passa a ser enviado pela página já formatado (KPIs, tabelas, pressupostos); o servidor compõe o email e a nota, escapa tudo e limita tamanhos. Negócio "Parceria INUBIA · nome" (valor = referral anual) ou "Pipedrive + CAPI · nome" (valor = investimento do 1.º ano).
- **Reversível por:** Fábio (product owner). Custos de implementação e licenças a confirmar antes do evento.

## 2026-09-27 — Programa de Parceiros INUBIA versão 2026-09, adesão e minuta automática

- **Decisão:** nova versão do programa de referenciação (documento DOCX/PDF em `apps/roi-calculator/docs/`), formulário de adesão `/parceiros/` e minuta de contrato gerada automaticamente em PDF e enviada por email na adesão. Apresentação do plano de parceiros publicada como deck.
- **O que mudou face ao documento anterior:** destinatários alargados a agências de marketing e consultores (parceiros geradores de leads), emissor passa a INUBIA (Grupo Brasfone) com a posição de maior Pipedrive Platinum Partner de Portugal e Espanha, referência fechada passa a projecto adjudicado de valor igual ou superior a 5.000 € + IVA (o documento anterior tinha 4.000 € numa página e 3.450 € noutra, com mínimo de 3 licenças anuais), janela de 12 meses após o registo, validação em 5 dias úteis, quarentena de 6 meses para empresas já em negociação ou clientes do grupo, alterações comunicadas com 30 dias (antes: sem aviso prévio), contacto passa a parcerias@inubia.pt, com Pedro Teixeira como responsável de parcerias e o apoio do Diogo enquanto Sales Manager (antes: Miguel Gonçalves). Mantidos: 500 € por referência, contacto em 24 horas úteis, pagamento no final do mês da adjudicação contra factura, direito de não apresentar proposta, verticais e casos de sucesso com testemunhos na íntegra.
- **Minuta de contrato:** 12 cláusulas (objecto, registo e validação, obrigações da INUBIA, comissão, facturação, obrigações do parceiro, independência e não exclusividade, confidencialidade 2 anos, RGPD, vigência 12 meses com denúncia a 30 dias e comissões devidas 6 meses após a cessação, alterações, lei portuguesa e foro de Faro). Identificação legal da INUBIA por variáveis de ambiente; sem elas ficam marcadores visíveis. Documento para revisão jurídica antes do evento.
- **Reversível por:** Fábio (product owner).
