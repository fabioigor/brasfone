# Calculadoras ROI Pipedrive + Meta CAPI (INUBIA)

Aplicação de stand para o Social Media Hackathon 2026 (Forum Braga, 1 e 2 de Outubro). Duas calculadoras independentes, com uma página de entrada para escolher o perfil de quem está à frente:

- **Agências de marketing** (`/agencias/`): ROI da parceria INUBIA como parceiro gerador de leads. Fase 1 pede apenas dados da agência (clientes activos, avença média, retenção, % com Meta Ads). Fase 2 é um cliente tipo ilustrativo, pré-preenchido com benchmarks, que não entra no ROI da agência: cada cliente tem o seu CPL e as suas taxas e a agência não tem essas médias no evento. Resultados: receita adicional anual (avenças revistas nos clientes ligados + comissões), LTV e meses adicionais de retenção, valor acrescentado à carteira, retorno por hora comercial, simulador de referrals (500 € por cliente apresentado que feche projecto INUBIA acima de 5.000 €) e o funil do cliente tipo para mostrar o argumento.
- **Empresas** (`/empresas/`): ROI de ter o Pipedrive integrado com a CAPI a acompanhar leads, pipeline e conversão. Fase 1 marketing (investimento em Meta Ads, CPL), fase 2 vendas (leads sem seguimento, taxa de SQL, taxa de fecho, ticket médio, equipa comercial, margem). Resultados: ROI e payback sobre implementação e licenças, novos clientes, vendas, CAC, custo por SQL, leads recuperadas, poupança equivalente em ads.

Ambas terminam num formulário (nome, contacto, telefone, email) que cria Organização, Pessoa, Negócio e Nota no Pipedrive e envia o relatório por email: com o plano de parceiros para agências, com os próximos passos para empresas.

## Estrutura

- `public/index.html`: página de entrada.
- `public/agencias/index.html` e `public/empresas/index.html`: as duas calculadoras, independentes.
- `public/assets/roi-models.js`: os dois modelos de cálculo (partilhados com os testes).
- `public/assets/roi.js` e `roi.css`: helpers (passos, gráfico, tabela, formulário) e estilo INUBIA.
- `server/`: Express com `POST /api/roi-leads`; o relatório é enviado pela página já formatado (KPIs, tabelas, pressupostos) e o servidor só o compõe e escapa.

## Correr localmente

```bash
cd apps/roi-calculator
npm install
cp .env.example .env   # preencher token Pipedrive e SMTP
npm start              # http://localhost:3080
```

Sem credenciais (demonstração offline): `npm run dev` arranca em `DRY_RUN=1`, que regista no terminal em vez de chamar o Pipedrive e o SMTP.

Testes do relatório e do modelo: `npm test`.

## Modelos de cálculo

**Funil (comum, por mês):** leads = investimento / CPL; com seguimento = leads × (1 − % sem seguimento); SQL = com seguimento × taxa SQL; clientes = SQL × taxa de fecho; vendas = clientes × ticket; custo por SQL = investimento / SQL; CAC = investimento / clientes. Com Pipedrive + CAPI: CPL × (1 − redução), % sem seguimento × (1 − recuperação), taxa SQL × (1 + subida), taxa de fecho × (1 + subida), tectos de 95%.

**Agência:** elegíveis = clientes × % com Meta Ads; apresentados = elegíveis × % apresentados; ligados = apresentados × % que fecham projecto acima de 5.000 €. Só os ligados recebem avença × (1 + aumento) e retenção × (1 + aumento). Receita adicional anual = ligados × aumento de avença × 12 + ligados × 500 €. LTV acrescentado = (LTV novo − LTV actual) × ligados. Tempo investido = apresentados × horas × custo hora; retorno por hora = receita adicional / horas. O cliente tipo usa o funil comum sem seguimento e é apenas ilustrativo.

**Empresa:** funil comum com os dados da empresa. Investimento = implementação + (licenças × utilizadores + acompanhamento) × 12. Ganho = vendas adicionais × 12 × margem. ROI = (ganho − investimento) / investimento; payback = investimento / (ganho mensal). Poupança equivalente = investimento actual − clientes actuais × CAC novo.

## Configuração Pipedrive

Usa a API v1 com token pessoal (`PIPEDRIVE_API_TOKEN`) e o domínio da conta (`PIPEDRIVE_COMPANY_DOMAIN`). Os negócios entram no pipeline INUBIA (id 11) na etapa "Diagnóstico Estratégico" (id 74), configurável por `PIPEDRIVE_PIPELINE_ID` e `PIPEDRIVE_STAGE_ID`; `PIPEDRIVE_OWNER_ID` define o responsável. A organização é procurada pelo nome exacto e a pessoa pelo email, para não duplicar quando a mesma agência preenche duas vezes. Agências: negócio "Parceria INUBIA · nome" com valor igual à comissão de referral anual estimada. Empresas: negócio "Pipedrive + CAPI · nome" com valor igual ao investimento do primeiro ano. Ambos recebem uma nota fixada com o relatório.

## Email

SMTP via `nodemailer` (Google Workspace funciona com password de aplicação). `MAIL_CC` recebe cópia de cada envio. `PARTNER_PLAN_URL` acrescenta um botão para o plano de parceiros completo no email das agências.

## Deploy para o stand

Pronto para Vercel: `public/` é servido como estático e `api/index.js` expõe o Express como função (rewrites em `vercel.json`). Projecto `inubia-roi-capi` na equipa INUBIA, root directory `apps/roi-calculator`. Sem `PIPEDRIVE_API_TOKEN` e `SMTP_HOST` o servidor corre em modo de demonstração e a página avisa que nada foi criado. Também corre em qualquer host Node (Railway, Render, VPS) com `npm start`. A página guarda os últimos valores introduzidos no browser, o que ajuda a retomar a conversa se o ecrã for actualizado.
