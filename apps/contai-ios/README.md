# Cont.ai by Lumarcont para iOS

App iOS para os clientes da Lumarcont digitalizarem documentos a partir do iPhone e iPad. É um invólucro nativo (SwiftUI + WKWebView) da web app `apps/contai`, com:

- ecrã inteiro, ícone e splash gerados, sessão guardada entre arranques;
- câmara e galeria através do próprio fluxo **Digitalizar** da web app (o `<input type="file">` do iOS abre a câmara ou a galeria);
- extensão de partilha **"Enviar ao Cont.ai"**: a partir de Fotografias, Ficheiros, Mail ou WhatsApp, partilhar imagens ou PDFs guarda-os no contentor da app; ao abrir o Cont.ai, entram directamente na digitalização (a web app recebe-os por `window.__contaiShared`);
- ligações externas abrem no Safari; o resto fica na app.

Toda a lógica (tratamento de imagem, PDF, envio, portal) vive na web app: uma actualização do servidor actualiza a app sem passar pela App Store. Só é preciso nova versão na loja quando mudar o invólucro (ícone, permissões, extensão).

## Duas formas de usar no iPhone

1. **Hoje, sem loja:** Safari > abrir a app > Partilhar > **Adicionar ao ecrã principal**. Fica em ecrã inteiro com a câmara a funcionar. Limitação do iOS: sem "Partilhar com Cont.ai" a partir de outras apps.
2. **App Store (esta pasta):** a mesma app com a extensão de partilha e presença na loja.

## Pré-requisitos

- Mac com Xcode 15 ou superior e [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- Conta Apple Developer Program da Lumarcont (99 USD/ano) para instalar em dispositivos e publicar.
- Domínio da web app em HTTPS (o App Transport Security do iOS bloqueia HTTP em produção; o IP de testes só serve em desenvolvimento com a excepção abaixo).

## Gerar o projecto e correr

```bash
cd apps/contai-ios
# 1. definir o endereço da web app e a equipa
sed -i '' 's|https://app.lumarcont.pt|https://<o-vosso-dominio>|' project.yml
sed -i '' 's|DEVELOPMENT_TEAM: ""|DEVELOPMENT_TEAM: "ABCDE12345"|' project.yml   # Team ID em developer.apple.com
# 2. gerar e abrir
xcodegen generate && open Contai.xcodeproj
```

No Xcode: escolher o dispositivo, Product > Run. Na primeira instalação num iPhone físico é preciso confiar no perfil de programador (Definições > Geral > VPN e gestão de dispositivos).

Para testar contra o IP sem TLS durante o desenvolvimento, acrescentar temporariamente em `project.yml` (target Contai > info > properties): `NSAppTransportSecurity: { NSAllowsArbitraryLoads: true }`. Remover antes de submeter à loja.

## Publicar na App Store

1. Product > Archive > Distribute App > App Store Connect.
2. Em App Store Connect: nome "Cont.ai by Lumarcont", categoria Negócios, capturas de ecrã de iPhone 6,7" e 6,5" (Hoje, Digitalizar, Documentos), URL de política de privacidade (site da Lumarcont), declaração de recolha de dados (documentos financeiros enviados ao gabinete; sem publicidade nem rastreio).
3. **Revisão da Apple (regra 4.2, funcionalidade mínima):** apps que são só um site podem ser recusadas. Esta app justifica-se pela câmara, pela extensão de partilha e pelo fluxo de digitalização, mas convém descrever isso nas notas para a revisão e fornecer uma conta de teste de cliente. Se a Apple insistir, a evolução é Capacitor com plugins nativos (câmara com detecção de contornos, notificações), mantendo o mesmo código web.

## Estrutura

```
project.yml                     definição do projecto (XcodeGen)
Contai/ContaiApp.swift          arranque SwiftUI, URL da web app (Info.plist > ContaiAppURL), App Group
Contai/WebView.swift            WKWebView, marcador window.__contaiNative, entrega das partilhas à página
Contai/SharedInbox.swift        leitura/limpeza dos ficheiros deixados pela extensão
Contai/Assets.xcassets          ícone 1024x1024 gerado por apps/contai/scripts/make-icons.mjs
ContaiShare/ShareViewController.swift   extensão de partilha (imagens e PDFs -> App Group)
```
