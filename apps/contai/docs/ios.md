# iPhone e iPad

## Hoje, sem loja

Safari > abrir a app > Partilhar > **Adicionar ao ecrã principal**. Fica em ecrã inteiro (`apple-mobile-web-app-capable`), com ícone e o fluxo Digitalizar a funcionar: o botão Fotografar abre a câmara do iOS, a galeria abre Fotografias e Ficheiros. Limitações do iOS para web apps: não há "Partilhar com Cont.ai" a partir de outras apps e a sessão pode expirar mais depressa.

## App Store

Projecto em `apps/contai-ios/` (SwiftUI + WKWebView, gerado com XcodeGen) com extensão de partilha "Enviar ao Cont.ai". Os ficheiros partilhados são guardados no App Group e, ao abrir a app, injectados na página como `window.__contaiShared` (nome, tipo, base64); a vista Digitalizar recebe-os como se tivessem sido escolhidos da galeria. A página detecta a app nativa por `window.__contaiNative` e esconde o botão "Instalar no telemóvel".

Requisitos: Mac com Xcode, conta Apple Developer (99 USD/ano) e o domínio em HTTPS (o iOS bloqueia HTTP em produção). Instruções completas em `apps/contai-ios/README.md`, incluindo a nota sobre a regra 4.2 da revisão da Apple.

## Android

Ver `docs/android.md` (web app instalável e Trusted Web Activity para a Play Store).
