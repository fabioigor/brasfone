# Integração CentralGest — contrato assumido

## Estado da documentação oficial

A CentralGest disponibiliza uma API REST no CentralGest Cloud, mas a documentação técnica **não é pública**: o acesso obtém-se através do formulário "Pedido de Adesão à API" em centralgestcloud.com (contactos: suporte@centralgest.com, +351 231 209 530).

Enquanto a adesão não estiver concluída, esta integração foi construída contra o contrato assumido abaixo, isolado em `src/integrations/centralgest.ts`. **Quando a documentação oficial for recebida, só esse ficheiro (e o mock) precisa de ser ajustado**; o resto do pipeline (validação, idempotência, MCP) não depende do formato exacto.

## Configuração

Na app: **Configuração > Integrações > CentralGest (API)** (só gabinete): URL base, chave (cifrada na base de dados), simulador local, botão **Testar ligação** (não guarda nada; regista o resultado no audit log sem a chave) e mapa dos códigos de empresa com verificação contra as empresas acessíveis. As mesmas definições podem vir do `.env`:

| Variável | Descrição |
|---|---|
| `CENTRALGEST_BASE_URL` | URL base da API (ex.: `https://api.centralgestcloud.com`) |
| `CENTRALGEST_API_KEY` | Chave/segredo atribuído na adesão à API |
| `CENTRALGEST_MOCK` | `1` arranca um CentralGest simulado local e aponta o cliente para ele (dev/demo) |

Cada empresa cliente tem um `centralgest_code` (código da empresa no CentralGest), configurável na vista Empresas.

## Contrato assumido

- `POST {base}/api/v1/auth/token` com `{ "apiKey": "..." }` → `{ "token": "...", "expiresIn": 3600 }`. Pedidos seguintes com `Authorization: Bearer <token>`; em 401 o token é renovado uma vez e o pedido repetido.
- `GET {base}/api/v1/empresas` → lista de empresas acessíveis (usado como teste de ligação).
- `POST {base}/api/v1/empresas/{codigo}/contabilidade/documentos` com:

```json
{
  "idExterno": "contai-entry-42",
  "diario": "Compras",
  "dataDocumento": "2026-07-15",
  "descricao": "Factura de compra FT A/2026-0147",
  "linhas": [
    { "conta": "62", "descricao": "FSE", "debito": 535.00, "credito": 0 },
    { "conta": "2432", "descricao": "IVA dedutivel", "debito": 123.05, "credito": 0 },
    { "conta": "221", "descricao": "Fornecedor", "debito": 0, "credito": 658.05 }
  ]
}
```

→ `201 { "id": "...", "numero": "..." }`; `409` se `idExterno` já existir (tratado como sucesso idempotente).

## Idempotência (duas camadas)

1. **Local:** a tabela `dispatches` guarda `entry_id` único por canal; um lançamento despachado nunca volta a ser enviado, e lançamentos exportados por CSV também não vão para o CentralGest (uma única via de entrega por lançamento).
2. **Remota:** o `idExterno` (`contai-entry-<id>`) permite ao CentralGest rejeitar duplicados se alguma vez houver reenvio; a resposta 409 é registada como já lançado.

## Pontos a confirmar com a documentação oficial

- Mecanismo real de autenticação (API key vs. OAuth vs. utilizador/palavra-passe).
- Caminhos e nomes de campos reais dos endpoints de lançamentos contabilísticos.
- Existência de campo de id externo/idempotência nativo.
- Estrutura de diários e planos de contas esperada (códigos numéricos vs. nomes).
- Limites de rate e formato dos erros.
