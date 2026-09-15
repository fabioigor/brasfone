# Conferência: ciclo de vida das excepções, severidades, parâmetros versionados e perfis

Implementa a especificação de desenvolvimento do Cont.ai (módulos A e B) definida com a Lumarcont na reunião de 14/09/2026.

## Excepções com estado (nunca um relatório estático)

| Estado | Significado | Quem altera | Efeito |
|---|---|---|---|
| `aberto` | Detectada, ainda não vista | Sistema | Nenhum |
| `em_analise` | Atribuída a um contabilista ("Assumir") | Utilizador | Conta para o tempo de resposta |
| `corrigido` | Erro real, lançamento corrigido | Utilizador | Confirma a regra |
| `falso_positivo` | A regra disparou sem razão; **motivo obrigatório da lista fixa** | Utilizador | Alimenta o ajuste de limiares |
| `aceite` | Desvio real mas justificado; pode criar **excepção reutilizável** | Utilizador | Alertas iguais ficam aceites automaticamente |
| `reaberto` | Voltou a ocorrer depois de corrigido | Sistema | Sobe a severidade; só o TOC responsável fecha |

Uma nova corrida da conferência substitui só os alertas abertos; os fechados ficam como histórico. A identidade de um alerta (`fingerprint`) é empresa + âmbito + regra + documento ou período. Tudo fica no `audit_log` (`finding_assign`, `finding_close`, `finding_reopen`, `exception_create`).

Motivos de falso positivo propostos (a Lumarcont corrige em Conferência > Indicadores do motor): arredondamento do software, isenção ou regime especial, espaço fiscal, sazonalidade prevista, corrigido noutro período, regra mal calibrada, dados extraídos incorrectos, outro motivo.

## Severidades

| Nível | Na app | Comportamento |
|---|---|---|
| Bloqueante | `erro` | Aprovar o lançamento exige justificação (os alertas passam a `aceite` com a nota) |
| Alerta | `aviso` | Exige decisão humana |
| Informativo | `info` | Fica registado |

Alertas gerados durante o **período de aprendizagem** de um cliente novo (6 meses por omissão, `learning_until` por empresa) ficam marcados "aprendizagem" e não bloqueiam.

## Parâmetros versionados

Nenhum valor legal ou limiar vive em código. A tabela `parameters` guarda versões com `valid_from`/`valid_to`; cada conferência regista as versões usadas (`parameters_version`). Só o TOC responsável cria versões novas (Conferência > Indicadores do motor > Parâmetros). Parâmetros iniciais: tolerâncias A1 (0,01 € por linha e por documento, com aceitação do arredondamento por linha ou por documento), balancete (0,01 €), duplicados, scores das fichas de artigo (0,90 / 0,70), período de aprendizagem (6 meses), escala dos impactos mínimos (1×), desvio da taxa efectiva (2 p.p.), divergência com a DP (50 €).

## Indicadores do motor

Precisão por regra (corrigidas / fechadas), taxa de falsos positivos, tempo médio de fecho e reaberturas, com objectivos aos 6 meses (≥ 85%, ≤ 10%, ≤ 3 dias). `GET /api/findings/metrics`.

## Perfis do gabinete

`users.profile`: `contabilista` (a sua carteira, fecha excepções), `coordenador` (padrões por cliente, motivos, contas), `toc` (tudo: parâmetros, base legal, reabertas). As contas existentes ficaram `toc`; as novas nascem `contabilista`. Carteira por contabilista em `company_assignments`.

## API

| Método | Rota | Acesso |
|---|---|---|
| GET | `/api/findings?status=aberto|em_analise|reaberto|corrigido|falso_positivo|aceite|fechado&learning=0` | autenticado |
| POST | `/api/findings/:id/transition` `{status, note, reason, assignee_id, create_exception, exception_valid_until}` | gabinete |
| POST | `/api/findings/:id/resolve` (compatibilidade: resolvido→corrigido, ignorado→falso_positivo) | gabinete |
| GET | `/api/findings/metrics?company_id&from` | gabinete |
| GET/PUT | `/api/findings/reasons` | gabinete / coordenador+ |
| GET/DELETE | `/api/exceptions`, `/api/exceptions/:id` | gabinete |
| GET/POST | `/api/parameters` | gabinete / TOC |
| POST | `/api/entries/:id/decision` com `override_reason` quando há bloqueantes | gabinete |
