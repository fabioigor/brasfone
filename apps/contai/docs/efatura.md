# e-Fatura: documentos comunicados, conciliação automática e email ao cliente

## O que faz

1. **Importação** da exportação do e-Fatura (Portal das Finanças > e-Fatura > Adquirente > Consultar faturas > período > Exportar, CSV ou Excel) por empresa, em Análise > e-Fatura. Reconhece as colunas por palavras-chave (emitente com "NIF - Nome", tipo, número / ATCUD, data, total, IVA, base, situação, sector); reimportar actualiza sem duplicar (chave: empresa + NIF do emitente + número normalizado). Quando o emitente é a própria empresa, o documento é de venda.
2. **Conciliação automática** com os documentos recebidos no Cont.ai (portal, telemóvel, email, WhatsApp, OneDrive): por ATCUD, por NIF + número normalizado (maiúsculas, sem espaços, sem zeros à esquerda), ou por NIF + data + total (±0,05 €, marcado "aprox."). Cada comunicado fica **validado** (ligado ao documento) ou **em falta**. Os documentos de compra recebidos que não constam do e-Fatura nos meses importados aparecem como **recebidos não comunicados**.
3. **Pedidos automáticos:** cada documento de compra em falta cria um pedido ao cliente (Pedidos, com a etiqueta "e-Fatura", prazo 7 dias). Quando o documento chega por qualquer canal, a conciliação corre de novo (hook no pipeline) e o pedido fica cumprido sozinho. O gabinete pode marcar um comunicado como "ignorado" (cancela o pedido) e voltar a pedir.
4. **Email ao cliente:** botão "Enviar email ao cliente" prepara um email em HTML e texto com a lista dos validados e dos em falta (data, emitente, documento, total, soma em falta), destinatários por omissão = utilizadores cliente da empresa + remetentes de email registados, editáveis, com nota adicional. Envio pela Microsoft Graph (`POST /users/{caixa}/sendMail`, permissão de aplicação **Mail.Send**) a partir da caixa `MS365_MAIL_USER` (ou `MS365_DRIVE_USER`). Sem Microsoft 365 configurado, a app devolve o texto para copiar. Cada envio fica em `efatura_notifications` e no `audit_log`.
5. **Área do cliente:** a vista e-Fatura mostra os comunicados da sua empresa com o estado; nos em falta há um botão para enviar o ficheiro directamente (cumpre o pedido). A página Hoje destaca "N documentos em falta".

## Porquê por ficheiro

A AT não disponibiliza API pública para terceiros consultarem os documentos comunicados por fornecedores (o webservice do e-Fatura serve para os emitentes comunicarem facturas, não para listar compras). A interface `EFaturaSource` (`src/integrations/efatura.ts`) é o contrato para um conector futuro; `FileEFaturaSource` é a implementação actual. Não fazemos scraping do portal com as credenciais do cliente.

## API

| Método | Rota | Acesso | Função |
|---|---|---|---|
| GET | `/api/companies/:id/efatura?status=todos|em_falta|validado|ignorado&period=AAAA-MM` | autenticado (a sua empresa) | comunicados + resumo + não comunicados + estado do email |
| POST | `/api/companies/:id/efatura/import` (multipart `file`, `?dry_run=1`) | gabinete | importar e conciliar |
| POST | `/api/companies/:id/efatura/reconcile` | gabinete | conciliar de novo |
| PATCH | `/api/efatura/:id` `{status: em_falta|ignorado}` | gabinete | ignorar / voltar a pedir |
| GET | `/api/companies/:id/efatura/notify?period=` | gabinete | pré-visualizar o email (destinatários, assunto, HTML, histórico) |
| POST | `/api/companies/:id/efatura/notify` `{to[], cc[], period, message}` | gabinete | enviar (ou devolver o texto se não houver Microsoft 365) |

`GET /api/dashboard` inclui `efatura` (resumo da empresa) e `GET /api/requests` marca `from_efatura`.

## Configuração

- Microsoft 365: acrescentar a permissão de aplicação `Mail.Send` ao registo da aplicação (ver `docs/microsoft365.md`) e conceder consentimento; recomenda-se a política de acesso à caixa (`New-ApplicationAccessPolicy`) para limitar o envio à caixa `documentos@lumarcont.pt`.
- `CONTAI_PUBLIC_URL` (opcional): endereço da app incluído no email.

Exemplo fictício: `fixtures/efatura-compras.csv`.
