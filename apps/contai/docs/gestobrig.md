# GestObrig: obrigações declarativas, prazos e acessos às entidades

## O que faz

- **Indicadores e prazos com dados reais:** a vista Análise > Indicadores e prazos (gabinete e cliente) mostra o estado das obrigações controladas no GestObrig: em atraso, a vencer nos próximos dias (7 por omissão, configurável), por cumprir, cumpridas este mês; tabela com obrigação, período, prazo, estado, data de entrega e responsável. A página Hoje destaca os prazos em atraso e a vencer. O cliente vê só a sua empresa; o gabinete filtra por empresa e pode marcar entregas como cumpridas, justificadas ou reabrir.
- **Cofre de acessos às entidades:** utilizador e palavra-passe de cada empresa nos portais oficiais (Portal das Finanças, e-Fatura, Segurança Social Directa, IAPMEI/certificação PME, Fundos de Compensação, ACT, Banco de Portugal, GestObrig, outra). O cliente vê e copia os acessos da sua empresa para entrar nos portais e aceitar termos da Segurança Social, renovar o certificado PME ou tratar de outras comunicações; pode também actualizar a palavra-passe quando a muda no portal. Cada consulta ("Mostrar") fica no registo de auditoria com o utilizador que a fez.

## Porquê por ficheiro

O GestObrig (gestobrig.com) não tem API pública (verificado em 2026-09-14: site, preços e suporte; contacto técnico gestobrigweb@gmail.com). A integração faz-se em camadas:

1. **Ficheiro (disponível):** exportar do GestObrig a listagem de obrigações e carregar em Configuração > Integrações > GestObrig. As empresas são reconhecidas pelo NIF (ou pelo nome exacto). Reimportar actualiza estados sem duplicar (chave: empresa, código da obrigação, período, referência).
2. **Ligações (disponível):** o botão "Abrir GestObrig" usa o endereço configurado em `GESTOBRIG_URL`.
3. **API ou conector (futuro):** a interface `ObligationsSource` em `src/integrations/gestobrig.ts` é o contrato; `FileObligationsSource` é a única implementação. Quando a GestObrig disponibilizar API ou exportação automática, acrescenta-se um conector sem tocar na UI.

## Formato dos ficheiros

Aceita CSV (separador `;` ou `,`) e Excel (primeira folha). A primeira linha com pelo menos três células é o cabeçalho; as colunas são reconhecidas por palavras-chave:

| Campo | Cabeçalhos reconhecidos |
|---|---|
| NIF | nif, contribuinte, nipc |
| Empresa | entidade, empresa, cliente, nome |
| Obrigação | obrigação, declaração, tipo, descrição |
| Período | período, ano, mês, trimestre, exercício (aceita `2026-07`, `2º Trimestre 2026`, `Julho 2026`, `2025`) |
| Prazo | prazo, limite, vencimento, data fim (aceita `2026-08-20`, `20/08/2026`, datas Excel) |
| Estado | estado, situação, status (entregue/cumprida, pendente, fora de prazo, justificada) |
| Entrega | entrega, submissão, envio |
| Responsável | responsável, utilizador, técnico |
| Notas | observações, notas, justificação |

Uma entrega com data posterior ao prazo fica "fora de prazo" automaticamente. Códigos atribuídos por palavras-chave: IVA-DP, IVA-REC, DMR, DMR-SS, SAFT, DRI, MOD22, IES, MOD10, MOD30, MOD3, PEC, IUC, IMI, RCBE, INV, OUTRA.

O ficheiro de acessos usa colunas empresa/NIF, entidade, utilizador, palavra-passe, URL e notas; a entidade é classificada por palavras-chave (Finanças, Segurança Social, IAPMEI, fundos, ACT, Banco de Portugal, GestObrig).

Exemplos fictícios em `fixtures/gestobrig-obrigacoes.csv` e `fixtures/gestobrig-acessos.csv`.

## API

| Método | Rota | Acesso | Função |
|---|---|---|---|
| GET | `/api/obligations?status=abertas|todas|cumprida|fora_prazo|justificada&company_id&from&to` | autenticado | lista + resumo (`overdue`, `dueSoon`, `open`, `doneThisMonth`, `lateThisYear`) |
| POST | `/api/obligations/import` (multipart `file`, opcional `company_id`, `?dry_run=1`) | gabinete | pré-visualização ou importação |
| PATCH | `/api/obligations/:id` `{status, submitted_at, notes}` | gabinete | marcar cumprida/justificada/reabrir |
| DELETE | `/api/obligations/:id` | gabinete | apagar |
| GET | `/api/credentials/entities` | autenticado | entidades conhecidas |
| GET | `/api/companies/:id/credentials` | autenticado (a sua empresa) | lista sem palavras-passe |
| POST | `/api/companies/:id/credentials` | autenticado (a sua empresa) | criar/actualizar (id opcional) |
| POST | `/api/companies/:id/credentials/:credId/reveal` | autenticado (a sua empresa) | devolve utilizador e palavra-passe; auditado |
| DELETE | `/api/companies/:id/credentials/:credId` | gabinete | apagar |
| POST | `/api/credentials/import` (multipart `file`) | gabinete | importar lista de acessos |

`GET /api/dashboard` passou a incluir `gestobrig` (`summary`, `open` até 60 dias, `total`, `soonDays`, `url`).

## Segurança e limites

- Palavras-passe cifradas com AES-256-GCM (mesma chave das definições de integração); nunca são listadas, só reveladas uma a uma, e cada revelação fica em `audit_log` (`credential_reveal`).
- Não há autologin nos portais: usam CAPTCHA, autenticação de dois factores e Chave Móvel Digital, e automatizá-los violaria os respectivos termos. A app abre o portal e o cliente cola os dados.
- Os acessos são por empresa; um cliente nunca vê os de outra empresa (verificado por testes).
- Os dados de obrigações vêm do último ficheiro importado; não há sincronização automática enquanto não houver API.
