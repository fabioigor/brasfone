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

## Módulo B: padrões de balancete com dupla condição

- Tipo `variacao` com **método de referência**: mês anterior, mediana móvel de 12 meses (exige ≥ 3 meses de histórico), homóloga (mesmo mês do ano anterior), % das vendas, % dos gastos com pessoal, valor fixo esperado, dias de recebimento, dias de pagamento.
- **Dupla condição obrigatória:** o alerta só dispara quando o desvio relativo (%, p.p. ou dias) **e** o impacto absoluto em euros ultrapassam ambos o limiar. A API recusa regras de variação sem impacto mínimo. Os impactos mínimos são multiplicados pelo parâmetro `escala_impactos_minimos` (recalcular a partir da facturação mediana da carteira).
- **Hierarquia em quatro níveis**, resolvida do mais específico para o mais genérico: conta do cliente > cliente > sector (prefixo de CAE) > global. Para a mesma família (tipo + contas) só a regra mais específica corre. Globais e sectoriais são do TOC responsável; por cliente e por conta, do coordenador.
- **Padrões por defeito** da especificação: 61 % das vendas 5 p.p./1 000 €; 62 mediana 30%/500 €; 63 mediana 10%/1 000 €; 64 mediana 2%/250 €; 68 mediana 40%/500 € (informativo); 71 e 72 homóloga 25%/2 500 €; 21 dias de recebimento 15 dias/5 000 €; 22 dias de pagamento 15 dias/5 000 €. As regras antigas só por percentagem foram removidas.
- **Estruturais:** B1.01 débitos = créditos (tolerância `tolerancia_balancete_eur`), B1.03 soma das subcontas = saldo da agregadora quando o balancete traz ambas (`SUBCONTAS_INCOERENTES`, bloqueante), sinal dos saldos (B1.04/B1.08 via padrões).
- **Aprendizagem:** 6 meses por cliente novo (`periodo_aprendizagem_meses` ou `learning_until` da empresa): as variações são geradas mas marcadas "aprendizagem".

## Carteira do contabilista

Um contabilista com empresas atribuídas (Empresas > Equipa do gabinete > Carteira) só vê e valida essas empresas: listas de empresas, documentos, lançamentos e alertas filtradas no servidor; aprovar fora da carteira devolve 403. Sem atribuições, vê todas. Coordenador e TOC vêem tudo.

| Método | Rota | Acesso |
|---|---|---|
| GET | `/api/users` (com `company_ids`), `/api/users/:id/assignments` | gabinete |
| POST | `/api/users` `{name, email, password, profile, company_ids}` | coordenador+ |
| PATCH | `/api/users/:id` `{profile, company_ids, name}` (perfil TOC só pelo TOC) | coordenador+ |
| POST/PATCH/DELETE | `/api/rules` (com `method`, `min_impact`, `cae_prefix`, `account`) | coordenador+; globais/sectoriais só TOC |
| PATCH | `/api/companies/:id` `{learning_until}` | gabinete |
