# Calculadoras ROI Pipedrive + Meta CAPI (INUBIA)

Aplicação de stand para o Social Media Hackathon 2026 (Forum Braga, 1 e 2 de Outubro). Duas calculadoras independentes, com uma página de entrada para escolher o perfil de quem está à frente:

- **Agências de marketing** (`/agencias/`): ROI da parceria INUBIA como parceiro gerador de leads. Fase 1 pede apenas dados da agência (clientes activos, avença média, retenção, % com Meta Ads). Fase 2 é um cliente tipo ilustrativo, pré-preenchido com benchmarks, que não entra no ROI da agência: cada cliente tem o seu CPL e as suas taxas e a agência não tem essas médias no evento. Resultados: receita adicional anual (avenças revistas nos clientes ligados + comissões), LTV e meses adicionais de retenção, valor acrescentado à carteira, retorno por hora comercial, simulador de referrals (500 € por cliente apresentado que feche projecto INUBIA acima de 5.000 €) e o funil do cliente tipo para mostrar o argumento.
- **Empresas** (`/empresas/`): ROI de ter o Pipedrive integrado com a CAPI a acompanhar leads, pipeline e conversão. Fase 1 marketing (investimento em Meta Ads, CPL), fase 2 vendas (leads sem seguimento, taxa de SQL, taxa de fecho, ticket médio, número de comerciais e custo mensal por comercial, margem). O investimento é o licenciamento Pipedrive (708 € por utilizador e ano) mais a implementação INUBIA média (5.000 €), posto ao lado do custo da equipa comercial. Resultados: ROI e payback sobre a margem adicional, custo total por cliente (ads + equipa), peso do Pipedrive no custo da equipa, clientes adicionais necessários para pagar o investimento, novos clientes, vendas e poupança equivalente em ads.

Ambas terminam num formulário (nome, contacto, telefone, email) que cria Organização, Pessoa, Negócio e Nota no Pipedrive e envia o relatório por email: com o plano de parceiros para agências, com os próximos passos para empresas.

- **Adesão de parceiros** (`/parceiros/`): formulário com os dados da empresa, do representante e o IBAN. Ao submeter, o servidor regista a organização, a pessoa, uma nota e uma tarefa de validação no Pipedrive e envia por email a minuta do contrato de parceria em PDF, gerada com os dados da adesão (`server/contract.js`, pdfkit). O botão "Pré-visualizar a minuta" devolve o mesmo PDF sem registar nada.
- **Documentos** (`docs/`): programa de parceiros versão 2026-09 em DOCX (editável) e PDF; o PDF é servido em `/docs/programa-parceiros-inubia.pdf` e ligado nos emails.

## Estrutura

- `public/index.html`: página de entrada.
- `public/agencias/index.html` e `public/empresas/index.html`: as duas calculadoras, independentes.
- `public/assets/roi-models.js`: os dois modelos de cálculo (partilhados com os testes).
- `public/assets/roi.js` e `roi.css`: helpers (passos, gráfico, tabela, formulário) e estilo INUBIA.
- `public/parceiros/index.html`: formulário de adesão ao programa de parceiros.
- `server/`: Express com `POST /api/roi-leads` (relatórios de ROI), `POST /api/partners` (adesão + minuta por email), `POST /api/partners/preview` (minuta em PDF sem efeitos) e `GET /api/partners/program` (condições). O relatório de ROI é enviado pela página já formatado e o servidor só o compõe e escapa.
- `server/partner-program.js`: condições canónicas do programa (500 € por referência fechada, projecto mínimo de 5.000 €, 24 horas úteis, vigência, etc.) e identificação legal da INUBIA a partir do ambiente (`PARTNER_COMPANY_LEGAL`, `PARTNER_COMPANY_NIF`, `PARTNER_COMPANY_ADDRESS`).
- `server/contract.js`: cláusulas da minuta e geração do PDF; `server/partner-email.js`: email de boas-vindas e nota do CRM.

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

**Empresa:** funil comum com os dados da empresa. Custo da equipa = comerciais × custo mensal × 12. Investimento (1.º ano) = implementação média + comerciais × licença anual; anos seguintes = licenças. Peso = investimento / custo anual da equipa. Custo total por cliente = (ads + equipa mensal) / clientes, antes e depois. Ganho = vendas adicionais × 12 × margem. ROI = (ganho − investimento) / investimento; payback = investimento / ganho mensal. Clientes adicionais para pagar = investimento / (ticket × margem). Poupança equivalente = investimento actual − clientes actuais × CAC novo.

## Configuração Pipedrive

Usa a API v1 com token pessoal (`PIPEDRIVE_API_TOKEN`) e o domínio da conta (`PIPEDRIVE_COMPANY_DOMAIN`). Os negócios entram no pipeline INUBIA (id 11) na etapa "Diagnóstico Estratégico" (id 74), configurável por `PIPEDRIVE_PIPELINE_ID` e `PIPEDRIVE_STAGE_ID`; `PIPEDRIVE_OWNER_ID` define o responsável. A organização é procurada pelo nome exacto e a pessoa pelo email, para não duplicar quando a mesma agência preenche duas vezes. Agências: negócio "Parceria INUBIA · nome" com valor igual à comissão de referral anual estimada. Empresas: negócio "Pipedrive + CAPI · nome" com valor igual ao investimento do primeiro ano. Ambos recebem uma nota fixada com o relatório.

## Email

SMTP via `nodemailer` (Google Workspace funciona com password de aplicação). `MAIL_CC` recebe cópia de cada envio. `PARTNER_PLAN_URL` acrescenta um botão para o plano de parceiros completo no email das agências.

## Deploy para o stand

Pronto para Vercel: `public/` é servido como estático e `api/index.js` expõe o Express como função (rewrites em `vercel.json`). Projecto `inubia-roi-capi` na equipa INUBIA, root directory `apps/roi-calculator`. Sem `PIPEDRIVE_API_TOKEN` e `SMTP_HOST` o servidor corre em modo de demonstração e a página avisa que nada foi criado. Também corre em qualquer host Node (Railway, Render, VPS) com `npm start`. A página guarda os últimos valores introduzidos no browser, o que ajuda a retomar a conversa se o ecrã for actualizado.

## Página para QR code no evento e autocolantes

`public/qr/index.html` é a landing page para quem chega pelo QR do stand: mini-calculadora com três valores (perfil empresa ou agência, `?perfil=empresa|agencia`), argumento CAPI condensado da LP inubia.pt/capi-social, formulário que cria o contacto no Pipedrive com origem "QR stand" e envia o relatório, e FAQ curta. Os autocolantes 60 x 60 mm (PDF com marcas de corte, versões escura e clara, folhas A4 de 12) e o QR em PNG/SVG estão em `docs/autocolantes/`, gerados por `node docs/build-stickers.js [url]` (por omissão aponta para https://inubia-roi-capi.vercel.app/qr/).
