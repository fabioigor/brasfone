# Digitalização pelo telemóvel e app Android

## O que o cliente faz

1. Abre o Cont.ai no telemóvel (instalado pelo Chrome ou pela Play Store) e toca em **Digitalizar**.
2. **Fotografar** abre a câmara (várias fotografias seguidas) ou **Escolher da galeria ou PDF**.
3. Cada página pode ser rodada, reordenada ou removida. Tratamento à escolha: cinzentos com contraste (por omissão, o melhor para OCR), cor, preto e branco ou original.
4. **Enviar**: as fotografias são redimensionadas (lado maior 2200 px), tratadas e juntas num PDF A4 (ou um PDF por página, para vários recibos de uma vez); PDFs escolhidos da galeria seguem tal como estão. Tudo no browser, sem bibliotecas externas (`public/scan.js`).
5. O servidor recebe pelo mesmo `POST /api/documents` do portal: QR da AT, OCR, classificação e proposta de lançamento como para qualquer outro canal. O cliente vê de imediato o tipo de documento reconhecido.
6. No Android, **Partilhar** uma fotografia ou PDF com o Cont.ai (a partir da galeria, do WhatsApp ou do email) abre a digitalização já com os ficheiros (`share_target` no manifest, tratado pelo service worker).

## Porquê web app instalável primeiro

A câmara, o tratamento de imagem e a geração de PDF funcionam no Chrome do Android sem código nativo, e uma actualização do servidor chega a todos os telemóveis sem loja. A versão Play Store (`apps/contai-android`, Trusted Web Activity) embrulha exactamente a mesma app e só depende do domínio em HTTPS e de uma chave de assinatura. Detecção automática de contornos e correcção de perspectiva ficam para uma iteração seguinte (OpenCV em WASM ou Capacitor com plugin nativo); hoje a app conta com o enquadramento do utilizador e com a robustez do OCR e do QR da AT.

## Instalação hoje (sem loja)

Chrome no Android: botão **Instalar no telemóvel** no login ou em Hoje, ou menu > Adicionar ao ecrã principal. iPhone: Partilhar > Adicionar ao ecrã principal (sem partilha de ficheiros para a app, limitação do iOS).
