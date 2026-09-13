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
