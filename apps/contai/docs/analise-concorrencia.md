# Análise de soluções de referência e o que o Cont.ai adopta

Analisadas em 2026-09-13: Kangaroo Files, Flowzi Operational System e BizDocs. As páginas públicas descrevem funcionalidades sem detalhe técnico; o que se segue é o que cada uma destaca e a decisão correspondente no Cont.ai.

| Capacidade destacada | Quem a destaca | Como o Cont.ai a implementa |
|---|---|---|
| Recepção multicanal (plataforma, email, WhatsApp) | Kangaroo Files, BizDocs | Portal, webhook de email (JSON ou MIME cru) + poller IMAP, webhook WhatsApp Cloud API com validação de assinatura; remetentes autorizados por empresa e alias `docs+<id>@`; remetentes desconhecidos ficam por associar, nunca criam empresas |
| Leitura do QR code da AT para lançar e cruzar facturas | BizDocs (explicitamente), CentralGest | Descodificação do QR (Despacho 412/2020-XXII) em imagens e PDFs rasterizados: NIFs, tipo, data, número, ATCUD e desagregação de IVA por taxa passam a ser dados exactos que prevalecem sobre o OCR |
| Detecção de duplicados independentemente da via de entrada | BizDocs | Hash do ficheiro + ATCUD + número/emissor, transversal a portal, email e WhatsApp e a formatos (PDF, PNG, TXT) |
| Vários documentos num só PDF (separação por QR) | BizDocs | Detecção de múltiplos QR distintos com alerta `VARIOS_DOCUMENTOS_NO_FICHEIRO`; a separação automática fica para a próxima iteração |
| OCR quando não há QR | BizDocs (add-on), Flowzi | Cascata: camada de texto do PDF → Claude visão → Tesseract com pré-processamento (escala, cinzentos, binarização Otsu) |
| Lançamentos automáticos por IA com contas e IVA | Kangaroo Files | Proposta SNC balanceada com uma linha de IVA por taxa e conta aprendida por fornecedor; sempre validada por humano |
| Classificação por tipo e fornecedor, arquivo pesquisável | Flowzi | Classificação por QR/IA/regras e arquivo por empresa/ano/mês/tipo (DL 28/2019) com texto extraído consultável |
| Integração com ERP em 1 clique (Primavera, PHC, Sage) | Flowzi, Kangaroo Files | CentralGest por API (idempotente), CSV Primavera; PHC e Sage não implementados |
| Fecho do mês antes do e-Fatura | BizDocs | Não implementado: reconciliação com o e-Fatura exige credenciais do portal da AT; previsto como fase seguinte |

## O pilar: OCR + IA para reduzir o trabalho humano

O Cont.ai combina quatro fontes por documento e regista de onde veio cada campo:

1. **QR da AT** (exacto, emitido pela máquina do fornecedor): prevalece sempre.
2. **Extracção estruturada por Claude** (JSON validado com zod, um ciclo de correcção): linhas, taxas por artigo, nomes, meio de pagamento.
3. **OCR** (camada de texto, Claude visão ou Tesseract) e **regras** determinísticas.
4. **Memória do fornecedor**: as contas usadas nas aprovações anteriores pré-preenchem a proposta seguinte.

Quando as fontes discordam, o valor mais fiável prevalece e o revisor recebe o alerta `FONTES_DIVERGENTES` com os dois valores. O objectivo é que, para facturas portuguesas com QR, o trabalho humano se reduza a confirmar uma proposta já certa.
