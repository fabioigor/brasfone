# Alojamento do Cont.ai: análise e recomendação

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
| **Fly.io** (contentor + volume, região `mad`/`cdg`) | Muito bom | ~5 a 15 €/mês | Docker directo, volumes persistentes, regiões UE, HTTPS automático, escala para vários contentores quando migrarmos para Postgres |
| **Railway** ou **Render** (contentor + volume) | Bom | ~7 a 20 €/mês | Deploy a partir do GitHub, volume persistente, UE disponível; menos controlo de rede que o Fly |
| **Hetzner / OVH VPS** (Docker Compose) | Bom, mais operação manual | ~4 a 10 €/mês | Datacenters UE, melhor custo; exige gerir TLS (Caddy/Traefik), backups e actualizações |
| **AWS/Azure/GCP** (ECS/App Service/Cloud Run + volume/EFS) | Possível | > 30 €/mês | Sobredimensionado para um gabinete; útil só se a Lumarcont já tiver conta e equipa cloud |

## Recomendação

1. **Agora (piloto com um gabinete):** Fly.io, uma máquina `shared-cpu-2x` com 2 GB e um volume de 10 GB na região de Madrid ou Paris, a partir do `Dockerfile` deste repositório. Backups diários do volume (`fly volumes snapshots` são automáticos) e `JWT_SECRET`, chaves Anthropic/Meta como secrets.
2. **Quando houver vários gabinetes ou mais de ~50 k documentos:** migrar SQLite para PostgreSQL gerido (Fly Postgres, Neon ou Supabase na UE) e o arquivo para object storage S3-compatível (Tigris no Fly, Backblaze B2 UE ou Scaleway); a camada de dados está isolada em `src/db.ts` e o arquivo em `storageRoot`, por isso a migração é contida.
3. Se a Lumarcont preferir infra própria: um VPS Hetzner em Nuremberga/Helsínquia com `docker-compose.yml` + Caddy para TLS.

## Arranque

```bash
cp .env.example .env   # preencher segredos
docker compose up -d --build
# ou no Fly.io
fly launch --no-deploy && fly volumes create contai_data --size 10 --region mad && fly secrets set JWT_SECRET=... ANTHROPIC_API_KEY=...
fly deploy
```

O `Dockerfile` corre o typecheck no build, expõe `/health` como healthcheck e monta `/data` para base de dados, arquivo e cache do Tesseract.

## Lista para pôr a app no ar (o que a Lumarcont tem de fornecer)

Sem estes elementos não é possível fazer o deploy; com eles, o primeiro ambiente fica de pé em menos de uma hora.

### Obrigatório

| # | Item | Para quê | Quem trata |
|---|---|---|---|
| 1 | Conta **Fly.io** (ou Railway/Render/VPS) com cartão associado, e um utilizador com permissões de deploy | Alojar o contentor e o volume de 10 GB na região de Madrid | Lumarcont |
| 2 | **Domínio** (ex.: `app.contai.pt` ou `contai.lumarcont.pt`) e acesso ao DNS para criar um registo CNAME/A | URL pública com HTTPS para utilizadores e webhooks | Lumarcont |
| 3 | `JWT_SECRET` gerado (`openssl rand -hex 32`) | Sessões dos utilizadores | gerado no deploy |
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
fly volumes create contai_data --region mad --size 10
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
- RGPD: dados na UE (Madrid); a chave Anthropic envia imagens de documentos para a API da Anthropic (retenção de 30 dias); se o gabinete exigir, desligar com `CONTAI_DISABLE_AI_EXTRACTION=1` e usar só OCR local.
