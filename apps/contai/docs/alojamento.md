# Alojamento do Cont.ai: análise e recomendação

> **Decisão (2026-09-13):** a Lumarcont já tem servidores no **Hetzner**. O Cont.ai é alojado aí com `docker-compose.vps.yml` + Caddy. O resto deste documento mantém a análise que levou a esta decisão e o plano alternativo (Fly.io).
>
> **Servidor de produção (criado em 2026-09-13 pela API):** `contai`, id 165720077, tipo cx23 (2 vCPU, 4 GB, 40 GB; o cx33 não tinha capacidade em nenhum datacenter nesse dia, e o tipo pode ser aumentado depois sem reinstalar), Helsínquia (hel1, Finlândia, UE), IPv4 `89.167.73.120`, firewall `contai-web` (22/80/443). Provisionado com `deploy/hetzner-create.sh`; utilizador `contai` (sudo), Docker + Caddy, backups diários em `/var/backups/contai`. Domínio ainda por definir (acesso HTTP por IP); ao definir o DNS, correr `echo app.contai.pt > /etc/contai-domain && contai-update` no servidor para activar o TLS.

## O que a aplicação precisa

| Necessidade | Porquê |
|---|---|
| Processo Node **persistente** (não serverless) | Poller IMAP em segundo plano, processamento assíncrono dos webhooks do WhatsApp depois de responder 200, worker Tesseract em WASM que demora 2 a 8 s por documento |
| **Disco persistente** | SQLite (`/data/contai.db`), arquivo digital DL 28/2019 (`/data/arquivo`, tem de ser guardado 10 anos), cache de dados de língua do Tesseract |
| CPU e memória razoáveis (1 vCPU / 1 GB mínimo, 2 GB confortável) | Rasterização de PDF com canvas e OCR em WASM |
| Região **UE** | RGPD; documentos fiscais de clientes portugueses |
| HTTPS público estável | Webhooks da Meta (WhatsApp) e do fornecedor de email exigem URL pública com TLS |

## Vercel

Vercel é excelente para frontends e APIs serverless, mas o Cont.ai **não encaixa** no modelo:

- Funções serverless sem processos de longa duração: o poller IMAP e o processamento pós-200 do WhatsApp não funcionam.
- Sem sistema de ficheiros persistente: SQLite e o arquivo de documentos não podem viver ali (seria preciso migrar para Postgres gerido + object storage, e mesmo assim o OCR em WASM sofre com arranques a frio e limites de tempo por pedido).
- Limites de duração e memória por função tornam o OCR de PDFs digitalizados pouco fiável.

Conclusão: **não recomendado** para o Cont.ai na sua forma actual. Poderia servir apenas para o frontend estático, o que não traz vantagem porque o servidor Node já o serve.

## Alternativas avaliadas

| Opção | Encaixe | Custo indicativo | Notas |
|---|---|---|---|
| **Fly.io** (contentor + volume, regiões `cdg`, `fra`, `ams`, `arn`) | Muito bom | ~5 a 15 €/mês | Docker directo, volumes persistentes, regiões UE, HTTPS automático, escala para vários contentores quando migrarmos para Postgres |
| **Railway** ou **Render** (contentor + volume) | Bom | ~7 a 20 €/mês | Deploy a partir do GitHub, volume persistente, UE disponível; menos controlo de rede que o Fly |
| **Hetzner / OVH VPS** (Docker Compose) | Bom, mais operação manual | ~4 a 10 €/mês | Datacenters UE, melhor custo; exige gerir TLS (Caddy/Traefik), backups e actualizações |
| **AWS/Azure/GCP** (ECS/App Service/Cloud Run + volume/EFS) | Possível | > 30 €/mês | Sobredimensionado para um gabinete; útil só se a Lumarcont já tiver conta e equipa cloud |

## Recomendação

1. **Agora (piloto com um gabinete):** Fly.io, uma máquina `shared-cpu-2x` com 2 GB e um volume de 10 GB na região de Paris (cdg), Frankfurt (fra), Amesterdão (ams) ou Estocolmo (arn), a partir do `Dockerfile` deste repositório. Backups diários do volume (`fly volumes snapshots` são automáticos) e `JWT_SECRET`, chaves Anthropic/Meta como secrets.
2. **Quando houver vários gabinetes ou mais de ~50 k documentos:** migrar SQLite para PostgreSQL gerido (Fly Postgres, Neon ou Supabase na UE) e o arquivo para object storage S3-compatível (Tigris no Fly, Backblaze B2 UE ou Scaleway); a camada de dados está isolada em `src/db.ts` e o arquivo em `storageRoot`, por isso a migração é contida.
3. Se a Lumarcont preferir infra própria: um VPS Hetzner em Nuremberga/Helsínquia com `docker-compose.yml` + Caddy para TLS.

## Arranque

```bash
cp .env.example .env   # preencher segredos
docker compose up -d --build
# ou no Fly.io
fly launch --no-deploy && fly volumes create contai_data --size 10 --region cdg && fly secrets set JWT_SECRET=... ANTHROPIC_API_KEY=...
fly deploy
```

O `Dockerfile` corre o typecheck no build, expõe `/health` como healthcheck e monta `/data` para base de dados, arquivo e cache do Tesseract.

## Lista para pôr a app no ar (o que a Lumarcont tem de fornecer)

Sem estes elementos não é possível fazer o deploy; com eles, o primeiro ambiente fica de pé em menos de uma hora.

### Obrigatório

| # | Item | Para quê | Quem trata |
|---|---|---|---|
| 1 | Conta **Fly.io** (ou Railway/Render/VPS) com cartão associado, e um utilizador com permissões de deploy | Alojar o contentor e o volume de 10 GB numa região da UE (Paris) | Lumarcont |
| 2 | **Domínio** (ex.: `app.contai.pt` ou `contai.lumarcont.pt`) e acesso ao DNS para criar um registo CNAME/A | URL pública com HTTPS para utilizadores e webhooks | Lumarcont |
| 3 | `JWT_SECRET` gerado (`openssl rand -hex 32`) | Sessões dos utilizadores | gerado no deploy |
| 3b | `CONTAI_ADMIN_EMAIL` + `CONTAI_ADMIN_PASSWORD` | Primeira conta do gabinete (em produção não há contas de demonstração); alterar a palavra-passe em "A minha conta" após o primeiro login | definido no deploy |
| 4 | Palavras-passe iniciais do gabinete e lista de empresas clientes (nome, NIF, CAE, regime de IVA) | Substituir as contas de demonstração | Lumarcont |

### Para o OCR e os agentes com IA

| # | Item | Para quê |
|---|---|---|
| 5 | **Chave da API Anthropic** (`ANTHROPIC_API_KEY`) com faturação activa | Claude visão (OCR de qualidade), extracção estruturada, memória descritiva dos relatórios, segunda opinião de IVA. Sem chave a app funciona só com Tesseract e regras |

### Para a recepção por email

| # | Item | Para quê |
|---|---|---|
| 6 | Uma caixa de correio dedicada (ex.: `docs@lumarcont.pt`) com **IMAP** activo e credenciais (ou uma app password), ou em alternativa uma conta SendGrid/Mailgun/Postmark com Inbound Parse apontado para `https://<domínio>/api/inbound/email` | Receber documentos por email; o alias `docs+<id>@` exige que o servidor de correio aceite endereços com `+` (Google Workspace e Microsoft 365 aceitam) |

### Para a recepção por WhatsApp

| # | Item | Para quê |
|---|---|---|
| 7 | Conta **Meta for Developers** com uma app do tipo Business e o produto WhatsApp adicionado; **Business verification** da Lumarcont concluída na Meta | Sem verificação o número fica limitado a contactos de teste |
| 8 | Um **número de telefone** dedicado ao WhatsApp Business (não pode estar em uso na app WhatsApp normal) | Número de recepção |
| 9 | Do painel da Meta: `WHATSAPP_ACCESS_TOKEN` (token de sistema permanente), `WHATSAPP_APP_SECRET`, `WHATSAPP_PHONE_NUMBER_ID`, e um `WHATSAPP_VERIFY_TOKEN` à escolha | Validar webhooks, descarregar media e responder |

### Para lançar no CentralGest

| # | Item | Para quê |
|---|---|---|
| 10 | **Adesão à API do CentralGest Cloud** (formulário em centralgestcloud.com) e a documentação técnica que a CentralGest enviar, mais `CENTRALGEST_BASE_URL` e `CENTRALGEST_API_KEY` | Ajustar o cliente ao contrato real e activar o lançamento directo. Até lá: CSV Primavera ou simulador |
| 11 | Código de cada empresa no CentralGest | Mapear empresa Cont.ai → empresa CentralGest |

### Passos do deploy (feitos por mim assim que tiver os acessos)

```bash
cd apps/contai
fly auth login
fly launch --copy-config --no-deploy          # usa o fly.toml deste repositorio
fly volumes create contai_data --region cdg --size 10
fly secrets set JWT_SECRET=... ANTHROPIC_API_KEY=... INBOUND_EMAIL_SECRET=... \
  IMAP_HOST=... IMAP_USER=... IMAP_PASSWORD=... \
  WHATSAPP_VERIFY_TOKEN=... WHATSAPP_APP_SECRET=... WHATSAPP_ACCESS_TOKEN=... WHATSAPP_PHONE_NUMBER_ID=... WHATSAPP_REPLY=1
fly deploy
fly certs add app.contai.pt                   # depois de criar o CNAME no DNS
```

Depois do deploy: configurar o webhook do WhatsApp no painel da Meta (`https://app.contai.pt/webhooks/whatsapp`, campo `messages`), apontar o Inbound Parse do email (se usado) para `/api/inbound/email` com o segredo, criar as empresas e os remetentes autorizados, e substituir as contas de demonstração.

### Operação

- Backups: snapshots diários automáticos do volume no Fly (5 dias de retenção por omissão); recomenda-se um `fly volumes snapshots create` semanal guardado fora, ou a migração para Postgres gerido com backups PITR quando o volume de documentos crescer.
- Monitorização: `/health` já é usado pelo healthcheck; alertas de disco cheio no volume (arquivo cresce ~0,5 MB por documento digitalizado).
- RGPD: dados na UE (Paris); a chave Anthropic envia imagens de documentos para a API da Anthropic (retenção de 30 dias); se o gabinete exigir, desligar com `CONTAI_DISABLE_AI_EXTRACTION=1` e usar só OCR local.

## Fly.io e a UE: o que fica onde (verificado em 2026-09-13)

- **Regiões europeias do Fly.io:** Paris (`cdg`), Frankfurt (`fra`), Amesterdão (`ams`) e Estocolmo (`arn`); Londres (`lhr`) é Reino Unido, fora da UE. Madrid não existe como região. A máquina e o volume ficam na região escolhida, por isso **os dados em repouso (base de dados, arquivo de documentos) ficam fisicamente na UE**.
- **A empresa é norte-americana** (Fly.io, Inc.). Consequências: os metadados da conta, faturação e registos da plataforma são processados nos EUA; a empresa está certificada no **EU-US Data Privacy Framework** e disponibiliza um **DPA com Cláusulas Contratuais-Tipo** (pedido em fly.io/documents). Mesmo assim, como entidade americana, pode ser obrigada pelo **CLOUD Act** a entregar dados que controla, mesmo que estejam num servidor na UE. É o problema conhecido como Schrems II: para a maioria das PME é um risco aceite e documentado; para um gabinete de contabilidade que guarda documentos fiscais de dezenas de empresas, é uma decisão a tomar conscientemente.
- **Nota sobre a IA:** o mesmo raciocínio aplica-se à API da Anthropic (empresa americana, com DPA). As imagens dos documentos são enviadas para OCR e extracção quando `ANTHROPIC_API_KEY` está definida; pode desligar-se com `CONTAI_DISABLE_AI_EXTRACTION=1` e ficar só com OCR local.

### Alternativa 100% europeia (empresa e servidores na UE)

| Fornecedor | Sede | Datacenters UE | Custo indicativo | Como |
|---|---|---|---|---|
| **Hetzner Cloud** | Alemanha | Nuremberga, Falkenstein, Helsínquia | CX22 (2 vCPU, 4 GB) ~4 €/mês + volume | `docker-compose.vps.yml` + Caddy (TLS automático) |
| **Scaleway** | França | Paris, Amesterdão | ~7 €/mês | idem |
| **OVHcloud** | França | Gravelines, Estrasburgo | ~6 €/mês | idem |

Com um destes, não há transferência internacional de dados a justificar (fora a Anthropic, se activada). O custo é a operação: actualizações do sistema, backups (snapshot do volume + `sqlite3 .backup` diário para um bucket S3 europeu, por exemplo Scaleway ou Hetzner Object Storage) e monitorização, que eu configuro no arranque.

### Recomendação actualizada

- **Se o gabinete aceitar um fornecedor americano com DPA e dados em repouso na UE:** Fly.io em Paris (`cdg`), menos operação, deploy em minutos.
- **Se quiser eliminar a exposição ao CLOUD Act (e a Lumarcont quiser dizer aos clientes "tudo em servidores europeus de empresas europeias"):** Hetzner Cloud com `docker-compose.vps.yml`. É a opção que eu escolheria para um gabinete de contabilidade.

```bash
# VPS Hetzner (Ubuntu 24.04) com Docker instalado
git clone <repo> && cd apps/contai
cp .env.example .env && nano .env            # segredos
export CONTAI_DOMAIN=app.contai.pt           # DNS A -> IP do VPS
docker compose -f docker-compose.vps.yml up -d --build
```

## Provisionamento automático no Hetzner (pela API, sem browser)

### Actualizações sem SSH nem token: o servidor segue o ramo

O servidor corre `contai-autoupdate` de 5 em 5 minutos (cron): faz `git fetch` e, se o ramo remoto tiver commits novos, corre `contai-update` (pull + rebuild da imagem + reinício sem perder o volume `/data`). Assim, **um push para o ramo chega a produção em menos de 10 minutos**, sem chave SSH e sem token da API do Hetzner. Registo em `/var/log/contai-autoupdate.log`. Os scripts `contai-update` e `contai-autoupdate` do servidor são wrappers finos: a lógica está em `apps/contai/deploy/update.sh` e `deploy/autoupdate.sh`, no repositório, e actualiza-se também por git. `GET /health` devolve a versão do `package.json` para confirmar que build está a correr. Servidores criados antes desta versão activam-no uma vez, como root (consola web do Hetzner): `contai-update && bash /home/contai/brasfone/apps/contai/deploy/enable-autoupdate.sh`. Quando a PR for integrada em `main`, mudar o ramo seguido com `cd /home/contai/brasfone && runuser -u contai -- git checkout main`.

### Segredos das integrações: página "Integrações" na app

As chaves da Anthropic, do email (webhook e IMAP), do WhatsApp e do CentralGest configuram-se em **Configuração > Integrações** (só gabinete). Ficam cifradas na base de dados (AES-256-GCM, chave derivada de `CONTAI_SECRET_KEY` ou, na sua ausência, de `JWT_SECRET`), sobrepõem-se ao `.env` e nunca voltam ao browser em claro (só os últimos 4 caracteres). Guardar reinicia a app em produção (poucos segundos) para todos os componentes recarregarem. O `.env` do servidor só precisa, por isso, de `JWT_SECRET`, `CONTAI_ADMIN_*` e, opcionalmente, `CONTAI_SECRET_KEY`.

`deploy/hetzner-create.sh` cria o servidor completo a partir desta máquina: firewall (22/80/443), chave SSH opcional, servidor Ubuntu 24.04 com cloud-init que instala Docker, endurece o acesso (ufw, fail2ban, actualizações automáticas), clona o repositório, escreve o `.env` e arranca a app com Caddy. Inclui `contai-update` (actualizar para a última versão) e `contai-backup` (cópia diária consistente da base de dados e do arquivo para `/var/backups/contai`, 7 dias).

```bash
# 1. Token: Hetzner Console -> projecto -> Security -> API tokens -> Generate (Read & Write)
export HCLOUD_TOKEN=...
# 2. Segredos da app
cp .env.example /tmp/contai.env && nano /tmp/contai.env     # pelo menos JWT_SECRET, CONTAI_ADMIN_EMAIL e CONTAI_ADMIN_PASSWORD
# 3. Criar (por omissao: cx33 em Nuremberga; se nao houver capacidade, SERVER_TYPE=cx23 LOCATION=hel1; DOMAIN vazio = HTTP por IP para testar)
ENV_FILE=/tmp/contai.env DOMAIN=app.contai.pt ADMIN_PUBKEY_FILE=~/.ssh/id_ed25519.pub ./deploy/hetzner-create.sh
```

Quando o DNS do domínio apontar para o IP, o Caddy obtém o certificado automaticamente. Para pré-visualizar o cloud-init sem criar nada: `DRY_RUN=1`.
