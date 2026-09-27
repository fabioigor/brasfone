# Calculadora ROI Pipedrive + Meta CAPI (INUBIA)

Aplicação de stand para o Social Media Hackathon 2026 (Forum Braga, 1 e 2 de Outubro). Mostra a agências de marketing o retorno de integrar o Pipedrive com a Meta Conversions API (CAPI): CPL mais baixo, mais SQL ao mesmo investimento, clientes retidos mais tempo, avença justificada e comissão de referral pela parceria INUBIA.

## Fluxo

1. **Enquadramento**: o que é a integração e porque interessa à agência, ao cliente e à parceria.
2. **A vossa agência**: avença mensal, clientes activos, retenção em meses, investimento em ads, CPL, taxa de SQL, taxa de fecho, ticket médio do cliente final e percentagem de clientes activos que apresentariam à INUBIA. Pressupostos editáveis (redução de CPL 25%, subida de SQL 30%, subida de fecho 10%, retenção +50%, avença +15%, custos da integração, taxa de fecho dos referrals e comissão).
3. **Resultados**: ROI ao primeiro ano, payback, custo por SQL, LTV, vendas geradas ao cliente, CAC, comissões de referral com simulador da carteira (slider), gráfico do funil e tabela de cálculo.
4. **Receber relatório**: nome da agência, contacto, telefone e email. O servidor cria Organização, Pessoa, Negócio e Nota no Pipedrive e envia o relatório por email com o plano de parceiros.

## Correr localmente

```bash
cd apps/roi-calculator
npm install
cp .env.example .env   # preencher token Pipedrive e SMTP
npm start              # http://localhost:3080
```

Sem credenciais (demonstração offline): `npm run dev` arranca em `DRY_RUN=1`, que regista no terminal em vez de chamar o Pipedrive e o SMTP.

Testes do relatório e do modelo: `npm test`.

## Modelo de cálculo

Por cliente e por mês: leads = investimento / CPL; SQL = leads × taxa SQL; custo por SQL = investimento / SQL. Com CAPI: CPL × (1 − redução), taxa SQL × (1 + subida), tecto de 95%.

Relação com o cliente: LTV = avença × retenção; com CAPI: avença × (1 + aumento) × retenção × (1 + aumento de retenção).

Cliente final: novos clientes = SQL × taxa de fecho (com CAPI, taxa × (1 + subida)); CAC = investimento / novos clientes; vendas = novos clientes × ticket médio.

Referral: clientes apresentados = clientes activos × %; fechos = apresentados × taxa de fecho dos referrals; comissão = fechos × 500 € (por projecto INUBIA acima de 5.000 €).

Agência (primeiro ano): ganho = (avenças revistas − avenças actuais) × 12 × clientes + comissões de referral. Investimento = implementação + manutenção × 12 × clientes. ROI = (ganho − investimento) / investimento. Payback = investimento / (ganho / 12).

## Configuração Pipedrive

Usa a API v1 com token pessoal (`PIPEDRIVE_API_TOKEN`) e o domínio da conta (`PIPEDRIVE_COMPANY_DOMAIN`). Os negócios entram no pipeline INUBIA (id 11) na etapa "Diagnóstico Estratégico" (id 74), configurável por `PIPEDRIVE_PIPELINE_ID` e `PIPEDRIVE_STAGE_ID`; `PIPEDRIVE_OWNER_ID` define o responsável. A organização é procurada pelo nome exacto e a pessoa pelo email, para não duplicar quando a mesma agência preenche duas vezes. O negócio tem como valor a comissão de referral anual estimada e recebe uma nota fixada com o relatório.

## Email

SMTP via `nodemailer` (Google Workspace funciona com password de aplicação). `MAIL_CC` recebe cópia de cada envio. `PARTNER_PLAN_URL` acrescenta um botão para o plano de parceiros completo.

## Deploy para o stand

Pronto para Vercel: `public/` é servido como estático e `api/index.js` expõe o Express como função (rewrites em `vercel.json`). Projecto `inubia-roi-capi` na equipa INUBIA, root directory `apps/roi-calculator`. Sem `PIPEDRIVE_API_TOKEN` e `SMTP_HOST` o servidor corre em modo de demonstração e a página avisa que nada foi criado. Também corre em qualquer host Node (Railway, Render, VPS) com `npm start`. A página guarda os últimos valores introduzidos no browser, o que ajuda a retomar a conversa se o ecrã for actualizado.
