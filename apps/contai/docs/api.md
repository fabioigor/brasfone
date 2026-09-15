# API HTTP do Cont.ai (gerado a partir de src/server.ts)

Autenticação: `Authorization: Bearer <JWT>` obtido em `POST /api/auth/login`. Acesso **gabinete** = utilizadores `staff`; **autenticado** = staff ou cliente (clientes vêem só a sua empresa); **público** = sem token (webhooks validam segredo/assinatura; a pré-visualização usa um token curto no URL).

| Método | Rota | Acesso |
|---|---|---|
| GET | `/` | público |
| GET | `/.well-known/assetlinks.json` | público |
| POST | `/api/audit/companies/:companyId` | gabinete |
| POST | `/api/audit/documents/:id` | gabinete |
| POST | `/api/auth/login` | público |
| POST | `/api/auth/password` | autenticado |
| GET | `/api/balances/:companyId` | autenticado |
| GET | `/api/balances/:companyId/:period` | autenticado |
| POST | `/api/balances/:companyId/:period/check` | gabinete |
| POST | `/api/balances/:companyId/derive` | gabinete |
| POST | `/api/balances/:companyId/import` | gabinete |
| POST | `/api/centralgest/dispatch/:companyId` | gabinete |
| GET | `/api/centralgest/dispatches` | gabinete |
| GET | `/api/centralgest/status` | gabinete |
| POST | `/api/centralgest/test` | gabinete |
| GET | `/api/channels/status` | gabinete |
| GET | `/api/companies` | autenticado |
| POST | `/api/companies` | gabinete |
| PATCH | `/api/companies/:id` | gabinete |
| GET | `/api/companies/:id/contacts` | gabinete |
| POST | `/api/companies/:id/contacts` | gabinete |
| POST | `/api/companies/:id/users` | gabinete |
| GET | `/api/companies/:id/cost-centers` | autenticado |
| POST | `/api/companies/:id/cost-centers` | gabinete |
| PATCH | `/api/cost-centers/:id` | gabinete |
| DELETE | `/api/cost-centers/:id` | gabinete |
| POST | `/api/documents/:id/intake` | gabinete |
| GET | `/api/suppliers` | gabinete |
| POST | `/api/suppliers/discover` | gabinete |
| POST | `/api/companies/:id/suppliers` | gabinete |
| PATCH | `/api/suppliers/:id` | gabinete |
| GET | `/api/companies/:id/efatura` | autenticado |
| POST | `/api/companies/:id/efatura/import` | gabinete |
| POST | `/api/companies/:id/efatura/reconcile` | gabinete |
| GET | `/api/companies/:id/efatura/notify` | gabinete |
| POST | `/api/companies/:id/efatura/notify` | gabinete |
| PATCH | `/api/efatura/:id` | gabinete |
| GET | `/api/companies/:id/credentials` | autenticado |
| POST | `/api/findings/:id/transition` | gabinete |
| GET | `/api/findings/metrics` | gabinete |
| GET | `/api/findings/reasons` | gabinete |
| PUT | `/api/findings/reasons` | gabinete |
| GET | `/api/exceptions` | gabinete |
| DELETE | `/api/exceptions/:id` | gabinete |
| GET | `/api/parameters` | gabinete |
| POST | `/api/parameters` | gabinete |
| GET | `/api/users` | gabinete |
| POST | `/api/users` | gabinete |
| DELETE | `/api/users/:id` | gabinete |
| POST | `/api/companies/:id/credentials` | autenticado |
| POST | `/api/companies/:id/credentials/:credId/reveal` | autenticado |
| DELETE | `/api/companies/:id/credentials/:credId` | gabinete |
| GET | `/api/credentials/entities` | autenticado |
| POST | `/api/credentials/import` | gabinete |
| GET | `/api/obligations` | autenticado |
| POST | `/api/obligations/import` | gabinete |
| PATCH | `/api/obligations/:id` | gabinete |
| DELETE | `/api/obligations/:id` | gabinete |
| DELETE | `/api/contacts/:id` | gabinete |
| GET | `/api/dashboard` | autenticado |
| GET | `/api/documents` | autenticado |
| POST | `/api/documents` | autenticado |
| GET | `/api/documents/:id/file` | autenticado |
| GET | `/api/documents/:id/preview` | público |
| GET | `/api/documents/:id/preview-url` | autenticado |
| POST | `/api/documents/:id/reprocess` | gabinete |
| GET | `/api/documents/:id/text` | autenticado |
| GET | `/api/domain` | gabinete |
| PUT | `/api/domain` | gabinete |
| GET | `/api/entries` | gabinete |
| POST | `/api/entries/:id/decision` | gabinete |
| POST | `/api/export/:companyId` | gabinete |
| GET | `/api/export/batches` | gabinete |
| GET | `/api/export/batches/:id/download` | gabinete |
| GET | `/api/findings` | autenticado |
| POST | `/api/findings/:id/resolve` | gabinete |
| POST | `/api/findings/:id/second-opinion` | gabinete |
| GET | `/api/inbound` | gabinete |
| POST | `/api/inbound/:id/assign` | gabinete |
| POST | `/api/inbound/email` | público |
| GET | `/api/knowledge` | gabinete |
| GET | `/api/me` | autenticado |
| GET | `/api/onedrive/status` | gabinete |
| POST | `/api/onedrive/sync` | gabinete |
| GET | `/api/public-config` | público |
| GET | `/api/reports` | autenticado |
| POST | `/api/reports/:companyId` | gabinete |
| GET | `/api/reports/:id` | autenticado |
| GET | `/api/reports/:id/html` | autenticado |
| GET | `/api/requests` | autenticado |
| POST | `/api/requests` | gabinete |
| POST | `/api/requests/:id/cancel` | gabinete |
| GET | `/api/rules` | gabinete |
| POST | `/api/rules` | gabinete |
| DELETE | `/api/rules/:id` | gabinete |
| PATCH | `/api/rules/:id` | gabinete |
| GET | `/api/settings` | gabinete |
| PUT | `/api/settings` | gabinete |
| POST | `/api/settings/test/:group` | gabinete |
| GET | `/api/system` | gabinete |
| GET | `/health` | público |
| ALL | `/share-target` | público |
| GET | `/webhooks/whatsapp` | público |
| POST | `/webhooks/whatsapp` | público |

## Servidor MCP `contai` (25 ferramentas, stdio, `npm run mcp`)

- `centralgest_lancar`
- `centralgest_listar_despachos`
- `contai_associar_contacto`
- `contai_conferir_balancete`
- `contai_conferir_documentos`
- `contai_conhecimento_fiscal`
- `contai_decidir_lancamento`
- `contai_definir_codigo_centralgest`
- `contai_definir_padrao`
- `contai_estado`
- `contai_gerar_relatorio`
- `contai_importar_balancete`
- `contai_listar_alertas`
- `contai_listar_contactos`
- `contai_listar_documentos`
- `contai_listar_empresas`
- `contai_listar_lancamentos`
- `contai_listar_padroes`
- `contai_listar_recepcoes`
- `contai_memoria_fornecedores`
- `contai_processar_documento`
- `contai_reprocessar_documento`
- `contai_resolver_alerta`
- `contai_segunda_opiniao_iva`
- `contai_texto_documento`
