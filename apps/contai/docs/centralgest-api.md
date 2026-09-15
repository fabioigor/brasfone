# Integração CentralGest: contrato real (REST API v5.1) e plano de adaptação

## Estado (2026-09-14)

A Lumarcont recebeu da CentralGest a documentação **CentralGest REST API v5.1 (19-01-2022)**, o **Anexo Recaptcha v1.0** e o **Questionário de levantamento API**, que a CentralGest exige antes de conceder acesso ("apenas disponibilizamos o acesso, não efectuamos a integração"). O questionário foi preenchido pelo Grupo Brasfone com os requisitos do Cont.ai (ficheiro `Questionario_levantamento_API_CentralGest_ContAi_Lumarcont.docx`, enviado ao Diogo Martins). Os PDFs da CentralGest não são versionados neste repositório por serem documentação proprietária; este ficheiro resume o que interessa à integração.

Até à recepção deste contrato, o cliente `src/integrations/centralgest.ts` foi construído contra um **contrato assumido** (`/api/v1/auth/token`, `/api/v1/empresas`, `/api/v1/empresas/{codigo}/contabilidade/documentos`) com simulador local (`CENTRALGEST_MOCK=1`). **Esse contrato não corresponde à API real** e vai ser substituído conforme o plano abaixo; o resto do pipeline (validação, tabela `dispatches`, MCP, UI) não muda.

## O que a API real oferece (v5.1)

**Autenticação**
- Token por serviço, configurado no CentralGest ERP, persistente e rotável (podem existir vários, com validades diferentes). É a opção adequada a integrações servidor a servidor e a que pedimos.
- Alternativa: `POST /auth/login` com `{ "username", "password" }` e, quando o Recaptcha está activo (por defeito em portais e na Cloud Privada), parâmetros `recaptchaType` (v2/v3) e `recaptchaToken`; chaves públicas em `GET /api/v1/configs/recaptcha`. Só serve para portais com utilizador humano.

**Entidades**
- `GET /clientes`, `GET /fornecedores`: pesquisa (`pesquisa`, `campospesq`, ex. `nconta='22111001'` ou por `nContribuint`), paginação (`pagina`, `porpagina`), ordenação. Devolve `list`, `total`, `searchFields`. Campos principais: `nConta`, `nome`, `nContribuint`, `email`, `codPagamento`, `idExterno` (String[30]), `iban`, `codMoeda`.
- `POST /clientes`, `POST /fornecedores` (obrigatórios `nome`, `nContribuint`), `PUT` para actualizar (quase todos os campos obrigatórios no PUT).
- `GET /artigos`, `POST /artigos`: artigos com `codIvaVenda`/`taxaIvaVenda`, `codIvaCompra`/`taxaIvaCompra`, família, unidade.

**Documentos comerciais** (`POST /docscomerciais?terminadoc=true&memoria=false`)
- Corpo `{ cab, clifo, linhas }`. Obrigatórios: `cab.nDocFa` (tipo de documento), `cab.nNumer` (série), `cab.dataDoc`, `linhas[].nArtigo`, `linhas[].qtd1`, `linhas[].prVenda1`.
- Cabeçalho relevante para compras: `nFactFornec` (n.º do documento do fornecedor, String[60]), `dataDocExterno`, `dataVenc`, totais (`totalDocumento`, `totalLiquido`, `totalIliquido`, `totalIva`) forçados com `docActions: [{ action: 1, activo: true }]` ("Envia totais"), `observacoes` (String[100]), `codRet`/`taxaRet` para retenções.
- `clifo.action` decide o tratamento do cliente/fornecedor pelo NIF: 0 valida pelo NIF, 5 cria novo, 1/3 actualiza, 9 tem de existir (não cria nem actualiza).
- Resposta: `{ status, message, data: { cab: { faccbId, nDoc, nDocumento, nDocumentoDraft, ... }, clifo, linhas } }`. O `faccbId` é o identificador único para operações posteriores; `GET /docscomerciais/{id}/pdf` devolve o PDF; `GET /docscomerciais` pesquisa (ex. `pesquisa=nDocFa=1&nConta=211110001`, codificado em URL) e devolve estado (`estado`, `porPagar`, `anulado`, `atEstado`, `hashEstado`, `transformado`).

**Gestão de documentos (contabilidade digital)**
- Quando um documento comercial de tipo classificado como **compras efectivas** ou **vendas efectivas** é encerrado e integrado na contabilidade, os PDFs da pasta do documento passam para a contabilidade (pasta pai `GestCom`, sub-pasta pelo n.º do documento draft).
- Fluxo: `POST /gdoc` (garantir a pasta `GestCom`), `GET /gdoc/folderidanexos?parentfolderid=...&foldername=1.1.3` (obter a pasta do documento), `POST /gdoc/{folderid}/uploadfile` com `filename`, `params=NdocFaDraft=..&NNumerDraft=..&NDocumentoDraft=..`, `tipodocentity=14` e o ficheiro em multipart.

**O que a documentação não descreve** (perguntas colocadas no questionário)
1. Acesso multi-empresa: como se endereça cada empresa cliente do gabinete (URL/base de dados por empresa, token por empresa ou parâmetro). É essencial para um gabinete com dezenas de empresas.
2. Lançamentos contabilísticos directos: não existe endpoint de contabilidade; a entrada na contabilidade faz-se via documentos comerciais integrados. Confirmar a parametrização da integração automática por tipo de documento.
3. Consulta de balancetes, saldos e extractos (para conferência e relatórios): não consta da v5.1.
4. Formato das respostas de erro (`status` diferente de 0, `message`), códigos e limites de pedidos (rate limits), tamanho máximo de ficheiro.
5. Ambiente de testes com dados fictícios e lista de `nDocFa`/`nNumer` da instalação da Lumarcont (tipo "Factura de fornecedor", "Nota de crédito de fornecedor", série por empresa).
6. Exposição da API do CentralGest Cloud da Lumarcont: pública com token ou restrita por IP/VPN.

## Mapeamento Cont.ai → CentralGest

| Cont.ai | CentralGest v5.1 |
|---|---|
| Lançamento aprovado de factura de compra | `POST /docscomerciais` com `nDocFa` do tipo "factura de fornecedor" da empresa, `nNumer` da série, `dataDoc` = data do documento, `nFactFornec` = n.º da factura, `dataDocExterno`, totais enviados (`docActions` 1), `clifo` com `nContribuint` do emitente e `action` 0 (validar) ou 5 (criar, só após aprovação humana) |
| Linhas do lançamento (conta SNC 62x/31x/…) | `linhas[]` com `nArtigo` de um **artigo genérico por conta de gasto** parametrizado no ERP (ex. `G62` FSE, `G31` mercadorias), `qtd1` = 1, `prVenda1` = base, `taxaIva`/`valorIva` por taxa; uma linha por taxa de IVA |
| Nota de crédito de fornecedor | mesmo fluxo com o `nDocFa` de nota de crédito |
| Factura de venda (quando o cliente factura fora do CentralGest) | `POST /docscomerciais` de tipo venda efectiva com `clifo` = cliente |
| PDF original | `/gdoc` upload para a pasta do documento (contabilidade digital) |
| Idempotência (`dispatches.external_id = contai-doc-<id>`) | antes de criar: `GET /docscomerciais?pesquisa=nFactFornec=...&nConta=...`; após criar: guardar `faccbId`, `nDoc`, `nDocumentoDraft`; texto `contai-doc-<id>` em `observacoes` |
| Código da empresa (`companies.centralgest_code`) | identificação da empresa/base no CentralGest conforme resposta à pergunta 1 (URL ou token por empresa) |
| Matching de fornecedor por NIF | `GET /fornecedores?pesquisa=nContribuint='NIF'` (cache diária) |

## Plano de adaptação do conector

1. `src/integrations/centralgest.ts`: novo cliente com `ClientConfig { baseUrl, token }` por empresa (ou global, conforme resposta), métodos `findSupplierByNif`, `createSupplier`, `findDocument(nFactFornec, nConta)`, `createPurchaseDocument(entry)`, `attachPdf(faccbId, nDocumentoDraft, pdf)`, `getDocumentPdf(faccbId)`. Autenticação por token de serviço (cabeçalho a confirmar com a CentralGest; a documentação não indica o nome do cabeçalho).
2. Parametrização por empresa em Empresas: `nDocFa`/`nNumer` de compras e de notas de crédito, artigos genéricos por conta SNC, `action` por defeito (0) e política de criação de fornecedores.
3. `dispatchApprovedEntries`: manter a tabela `dispatches`; substituir a chamada ao contrato assumido pela sequência pesquisa → criação → upload do PDF, com tratamento de `status != 0` como erro repetível ou definitivo conforme `message`.
4. Simulador `centralgest-mock.ts` reescrito para o contrato v5.1 (mesmos endpoints e respostas), para manter os testes e a demonstração sem credenciais.
5. Integrações > CentralGest: campos para URL base e token por serviço (já existem), mais os parâmetros por empresa; "Testar ligação" passa a chamar `GET /fornecedores?porpagina=1`.

Enquanto o acesso não chega, a entrega por CSV Primavera e o simulador continuam disponíveis.
