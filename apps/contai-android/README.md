# Cont.ai by Lumarcont para Android

App Android para os clientes da Lumarcont digitalizarem documentos a partir do telemóvel. É uma **Trusted Web Activity (TWA)**: um invólucro nativo, publicável na Play Store, que abre a web app `apps/contai` em ecrã inteiro, com ícone, splash screen, atalho "Digitalizar" e integração com o menu **Partilhar** do Android (imagens e PDFs partilhados entram directamente na digitalização). Toda a lógica (câmara, tratamento de imagem, PDF, envio) vive na web app, pelo que uma actualização do servidor actualiza a app sem passar pela loja.

## Duas formas de instalar

1. **Hoje, sem loja:** no Chrome do Android abrir a app e tocar em "Instalar no telemóvel" (ou menu > Adicionar ao ecrã principal). Fica com ícone, ecrã inteiro e partilha de ficheiros. É o que a web app já oferece.
2. **Play Store (esta pasta):** a mesma app embrulhada em TWA, para quem procura na loja ou quer distribuição gerida. Requer o domínio em HTTPS.

## Pré-requisitos para a versão Play Store

- Domínio da app com HTTPS (ex.: `app.lumarcont.pt`) a apontar para o servidor. Substituir `app.lumarcont.pt` em `twa-manifest.json` se for outro.
- Node.js 18+, JDK 17 e Android SDK (o Bubblewrap descarrega ambos na primeira execução se não existirem).
- Conta Google Play Console (taxa única de 25 USD).

## Gerar e assinar

```bash
cd apps/contai-android
npx @bubblewrap/cli@latest build        # usa twa-manifest.json; cria android.keystore na primeira vez (guardar a palavra-passe!)
# resultado: app-release-signed.apk (teste directo) e app-release-bundle.aab (Play Store)
```

Depois da primeira build, obter a impressão SHA-256 da chave:

```bash
keytool -list -v -keystore android.keystore -alias contai | grep SHA256
```

## Ligar a app ao domínio (Digital Asset Links)

Na web app, em **Configuração > Integrações > Aplicação Android**, colar o identificador (`pt.lumarcont.contai`) e a(s) impressão(ões) SHA-256. O servidor passa a responder em `https://<dominio>/.well-known/assetlinks.json`; sem isto a app abre com a barra de endereço do Chrome. Quando publicar na Play Store com assinatura pela Google, acrescentar também a impressão da chave da Google (Play Console > Integridade da app), separada por vírgula.

Validar: `npx @bubblewrap/cli validate --url https://<dominio>/` ou o [Statement List Generator](https://developers.google.com/digital-asset-links/tools/generator).

## Publicar

1. Play Console > Criar app > carregar `app-release-bundle.aab` em Teste interno.
2. Ficha da loja: nome "Cont.ai by Lumarcont", ícone `public/icon-512.png`, capturas de ecrã do telemóvel (Hoje, Digitalizar, Documentos), política de privacidade (URL no site da Lumarcont).
3. Promover a produção. Actualizações da app só são necessárias quando mudar o `twa-manifest.json` (ícone, cores, atalhos); o resto chega pelo servidor.

## Alternativa futura

Se vier a ser preciso acesso nativo que a web não dá (digitalização em lote com detecção de contornos por OpenCV, notificações push de fecho de mês), a evolução natural é Capacitor com o mesmo código web e plugins nativos, mantendo esta estrutura.
