# Fornecedores, centros de custo e perguntas de recepção

## Centros de custo

- Cada empresa cliente tem os seus centros de custo (código + nome), geridos pelo gabinete em **Empresas > Centros de custo**. Um centro em uso nunca é apagado: fica inactivo.
- Entram **desde a digitalização**: no ecrã Digitalizar e no formulário de Documentos há um selector de tipo de documento e de centro de custo (o cliente vê os da sua empresa). O tipo indicado pelo cliente prevalece sobre a classificação automática (`classification_source = cliente`); o centro fica no documento e é aplicado às linhas de gasto/rendimento (classes 3, 6 e 7) do lançamento proposto.
- No **WhatsApp**, depois de receber um documento, a app pergunta o tipo e, se a empresa tiver centros de custo, a qual pertence (ver abaixo).
- Na **Validação**, cada linha do lançamento tem a coluna "C. custo"; o cartão "Fornecedor / terceiro" permite corrigir tipo e centro do documento e re-propor (`POST /api/documents/:id/intake`).
- A exportação Primavera ganhou a coluna `CentroCusto`; no CentralGest o campo será mapeado quando o conector real v5.1 for ligado.

## Fornecedores e descoberta por NIF

Um terceiro é "conhecido" quando foi registado pelo gabinete ou quando já tem uma conta SNC aprendida de uma aprovação. Quando um documento chega de um NIF desconhecido, a Validação mostra "fornecedor novo" e o botão **Pesquisar marcas por NIF**:

1. **Dígito de controlo** do NIF (local).
2. **VIES** (Comissão Europeia, API REST pública): denominação social e morada para NIFs portugueses; probabilidade 0,95.
3. **Pesquisa web por IA** (ferramenta `web_search` da Anthropic, dentro do ai-gateway): marcas e nomes comerciais associados ao NIF, cada um com probabilidade e páginas de evidência. Só corre quando há chave da API Anthropic; a IA devolve candidatos, nunca cria nada.
4. **Nome impresso no documento** (probabilidade 0,6).

Os candidatos são fundidos (mesmo nome sem sufixo legal = mesmo candidato, com as outras grafias em `aliases`), ordenados por probabilidade e apresentados com barras; o resultado fica em cache 30 dias por NIF (`supplier_discoveries`) e a pesquisa fica no `audit_log`. Escolhida a marca, abre o formulário **Criar fornecedor**: denominação, marca, site, actividade, conta de gasto, outras marcas, e os **centros de custo a associar** com um "habitual" (aplicado por omissão aos documentos seguintes). Pode criar-se um centro de custo novo no próprio formulário. Por omissão, o centro habitual e a conta são aplicados aos lançamentos pendentes desse fornecedor.

A vista **Configuração > Fornecedores** lista os terceiros por empresa com estado (registado, conta aprendida, fornecedor novo), documentos, lançamentos por validar e centros de custo, com os mesmos botões Pesquisar/Registar/Editar.

## Perguntas no WhatsApp

Com `WHATSAPP_REPLY=1` e `WHATSAPP_ASK=1` (por omissão), depois de um documento ser recebido e classificado:

```
Recebemos o seu documento. Que tipo de documento é?
1. Factura de compra (de um fornecedor) (detectado)
2. Despesa ou talão (sem factura completa)
3. Factura de venda (emitida pela sua empresa)
4. Nota de crédito
5. Recibo
6. Extracto bancário
7. Outro documento
Responda com o número, ou "ok" para manter o detectado.
```

Depois da resposta (número, "ok" ou palavra-chave), se a empresa tiver centros de custo:

```
Registado como Despesa. A que centro de custo pertence?
1. Administracao
2. Fabrico
3. Loja (habitual deste fornecedor)
0. Sem centro de custo
Responda com o número, ou "ok" para o habitual.
```

Termina com "Obrigado. Registado como Despesa, centro de custo Loja. O gabinete valida o lançamento e avisa se faltar algo." Respostas não percebidas repetem a pergunta (até 2 vezes); depois mantém-se a classificação automática. As respostas aplicam-se aos documentos daquela mensagem (`channel_dialogs`), sem novo OCR: a extracção guardada é reutilizada e a proposta pendente é substituída (`applyIntakeAnswers`). Um lançamento já decidido nunca é alterado. Respostas interactivas (listas/botões da Meta) são lidas como texto. O diálogo expira em 24 horas e é substituído por um documento novo do mesmo remetente.

## API

| Método | Rota | Acesso | Função |
|---|---|---|---|
| GET | `/api/companies/:id/cost-centers?all=1` | autenticado (a sua empresa) | centros activos (gabinete: `all=1` inclui inactivos) + tipos de documento |
| POST | `/api/companies/:id/cost-centers` `{code, name}` | gabinete | criar |
| PATCH | `/api/cost-centers/:id` `{name, active}` | gabinete | renomear / (des)activar |
| DELETE | `/api/cost-centers/:id` | gabinete | apagar (ou desactivar se em uso) |
| POST | `/api/documents` (+ `doc_type`, `cost_center_id`) | autenticado | carregar com tipo e centro |
| POST | `/api/documents/:id/intake` `{doc_type, cost_center_id}` | gabinete | corrigir e re-propor |
| GET | `/api/suppliers?company_id&status=todos|desconhecidos|registados` | gabinete | terceiros com estado e pendentes |
| POST | `/api/suppliers/discover` `{nif, company_id, document_id, refresh}` | gabinete | descoberta por NIF |
| POST | `/api/companies/:id/suppliers` | gabinete | criar/actualizar fornecedor com centros de custo |
| PATCH | `/api/suppliers/:id` | gabinete | editar |

`GET /api/entries` devolve por lançamento `supplier` (nif, known, registered, name, brand, cost_centers, default_cost_center_id), `cost_centers` da empresa, `document_cost_center_id` e `client_doc_type`; as linhas aceitam `cost_center` na decisão.

## Limites

- A pesquisa web depende da qualidade das páginas públicas; a probabilidade é uma estimativa da IA e do cruzamento de fontes, não uma certeza. A escolha é sempre humana.
- O VIES nem sempre divulga o nome (a AT pode ocultá-lo); nesse caso a nota explica-o.
- A criação do fornecedor no CentralGest (`POST /fornecedores`) fica para o conector v5.1; hoje o registo é interno ao Cont.ai.
