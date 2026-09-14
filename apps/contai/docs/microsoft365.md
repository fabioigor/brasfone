# Microsoft 365: OneDrive como arquivo e caixa de email com autenticação da aplicação

## O que faz

- **Arquivo no OneDrive/SharePoint:** cada documento recebido (portal, telemóvel, email, WhatsApp) é copiado, em segundo plano e de forma idempotente, para o OneDrive da Lumarcont em `Cont.ai / Empresa (NIF) / Ano / Mês / Tipo de documento / <id>-<nome original>`. O documento mostra a ligação "OneDrive" em Documentos; erros ficam registados e repetem-se até 5 vezes (botão "Repetir os com erro" em Integrações).
- **Email com autenticação Microsoft 365:** a caixa de recepção (ex.: `documentos@lumarcont.pt`) é lida pela Graph API com a identidade da aplicação, sem guardar a palavra-passe da caixa e sem IMAP. Mensagens por ler com anexos entram no mesmo fluxo dos outros canais (remetentes autorizados por empresa); depois ficam marcadas como lidas com a categoria "Cont.ai". Anexos inline (assinaturas, logótipos) são ignorados.

## Registo da aplicação no Entra ID (uma vez, 10 minutos, com conta de administrador do 365)

1. https://entra.microsoft.com > Identidade > Aplicações > **Registos de aplicações** > Novo registo. Nome "Cont.ai by Lumarcont", tipos de conta "apenas este directório". Sem URI de redireccionamento.
2. Na página da aplicação, copiar **ID da aplicação (cliente)** e **ID do directório (inquilino)**.
3. **Certificados e segredos** > Novo segredo do cliente (validade 24 meses). Copiar o **valor** já (só aparece uma vez) e anotar a data de expiração.
4. **Permissões de API** > Adicionar > Microsoft Graph > **Permissões de aplicação**: `Files.ReadWrite.All` (OneDrive) e `Mail.ReadWrite` (caixa de email). Depois **Conceder consentimento de administrador**.
5. Recomendado, para limitar o acesso do email a uma só caixa: no Exchange Online PowerShell,
   `New-ApplicationAccessPolicy -AppId <client id> -PolicyScopeGroupId documentos@lumarcont.pt -AccessRight RestrictAccess -Description "Cont.ai"`.
   Sem esta política a permissão `Mail.ReadWrite` abrange todas as caixas do inquilino.
6. Criar (se não existir) a caixa `documentos@lumarcont.pt` (caixa partilhada serve e não gasta licença) e garantir que a conta dona do OneDrive tem licença com OneDrive.

## Configurar no Cont.ai

Configuração > Integrações:

- **Microsoft 365 (OneDrive como arquivo):** Tenant ID, Client ID, Client secret, OneDrive do utilizador (email da conta cuja drive recebe os ficheiros) ou, em alternativa, ID de um site SharePoint; pasta raiz (por omissão `Cont.ai`). **Testar com os valores acima** confirma o acesso à drive e mostra a quota.
- **Recepção por email:** Caixa de correio Microsoft 365 (o email da caixa), pasta (`inbox`) e intervalo. O teste mostra o número de mensagens e de não lidas. Quando a caixa 365 está definida, o IMAP é ignorado.
- Guardar reinicia a app; o arquivo começa a sincronizar os documentos já existentes (20 por minuto) e a caixa passa a ser lida no intervalo definido.

## Segurança

- Segredos cifrados na base de dados (AES-256-GCM); nunca voltam ao browser em claro.
- A aplicação só escreve na pasta raiz configurada; não apaga nada no OneDrive. Os nomes de ficheiro incluem o id do documento, por isso reenviar nunca duplica (substitui).
- Cada upload fica no audit log (`onedrive_upload`) com o caminho; os testes de credenciais ficam no audit log sem valores.
- Renovar o client secret antes de expirar: basta colar o novo em Integrações.

## Limitações desta iteração

- Não há leitura inversa (alterações feitas directamente no OneDrive não voltam à app); o OneDrive é arquivo, a app é a fonte.
- Ficheiros acima de 4 MB seguem por sessão de upload em blocos de 5 MiB; acima de 250 GB não é suportado pela Graph.
- Enviar email a partir da app (confirmações ao remetente) fica para uma iteração seguinte (`Mail.Send`).
