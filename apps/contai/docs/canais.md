# Recepção por email e WhatsApp

## Encaminhamento

Um documento recebido por um canal é atribuído a uma empresa por, nesta ordem:

1. **Remetente autorizado**: endereço de email ou número WhatsApp (formato internacional sem `+`, ex.: `351912345678`) registado em Empresas → Remetentes (`company_contacts`).
2. **Alias no destinatário** (só email): `docs+<id>@...` ou `empresa-<id>@...` encaminha para a empresa `<id>`.
3. Caso contrário a mensagem fica em **Recepção → Por associar**. O gabinete associa o remetente a uma empresa (o contacto fica registado para as mensagens seguintes) e pede o reenvio. Nunca se criam empresas automaticamente.

Cada anexo suportado (PDF, PNG, JPG, WebP, TIFF, TXT, CSV, XML) segue o mesmo pipeline do portal (OCR, QR, IA, classificação, conferência, proposta) com `channel` = `email` ou `whatsapp`. A deduplicação usa o Message-ID / id da mensagem WhatsApp e, para os documentos, hash + ATCUD + número/emissor.

## Email

- **Webhook** `POST /api/inbound/email` com cabeçalho `x-contai-secret: <INBOUND_EMAIL_SECRET>`. Aceita JSON `{message_id, from, to, subject, text, attachments:[{filename, content_type, content_base64}]}` (formato de SendGrid Inbound Parse, Mailgun, Postmark ou um relay próprio) ou o email MIME cru com `Content-Type: message/rfc822`.
- **IMAP**: definir `IMAP_HOST`, `IMAP_USER`, `IMAP_PASSWORD` (opcionais `IMAP_PORT`=993, `IMAP_SECURE`=1, `IMAP_MAILBOX`=INBOX, `IMAP_POLL_SECONDS`=120). O poller lê mensagens não lidas, processa-as e marca-as como lidas.

## WhatsApp (Meta Cloud API)

- Variáveis: `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` (para responder), `WHATSAPP_REPLY=1` para confirmar ao remetente ("Documento recebido e classificado: factura compra").
- Configurar no painel da Meta o webhook `https://<host>/webhooks/whatsapp` com o verify token; o `GET` responde ao `hub.challenge` e o `POST` valida `X-Hub-Signature-256` (HMAC SHA-256 do corpo com o app secret), responde 200 de imediato e processa em segundo plano.
- Imagens e documentos são descarregados pela Graph API (`/{media-id}` → URL → bytes) e passam pelo OCR. Mensagens só de texto ficam registadas como "sem anexos".

Depois de receber um documento, com `WHATSAPP_ASK=1` (por omissão), a app pergunta ao cliente o tipo de documento e o centro de custo (ver `docs/fornecedores.md`).

## Segurança

- O webhook de email exige segredo partilhado; o de WhatsApp exige assinatura válida.
- Conteúdo dos emails (corpo) só é guardado como excerto de 300 caracteres; anexos vão para o arquivo da empresa.
- Todas as recepções ficam em `inbound_messages` e no audit log.


## Caixa de email Microsoft 365 (Graph)

Quando `MS365_MAIL_USER` está definido (Integrações > Recepção por email), a caixa é lida pela Graph API com a autenticação da aplicação Microsoft 365 em vez de IMAP: mensagens por ler com anexos, anexos inline ignorados, mensagem marcada como lida com a categoria "Cont.ai". Ver `docs/microsoft365.md`.
