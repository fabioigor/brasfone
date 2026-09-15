# Módulo C: relatórios financeiros para clientes, balancetes publicados e base legal

## Relatórios (dez blocos)

Gerados em Balancetes > Gerar relatório, a partir do balancete do período (e do anterior quando existe). Estrutura comum:

1. Capa com identificação, período e marca Lumarcont (fixa)
2. Semáforo de saúde em seis indicadores: evolução das vendas, margem EBITDA, resultado líquido, autonomia financeira, liquidez, prazo médio de recebimento (verde/amarelo/vermelho/cinzento; quando há referência sectorial, o veredicto face ao sector decide)
3. Memória descritiva (fixa; opcionalmente polida por IA sem alterar números)
4. Actividade: vendas, margem bruta, EBITDA e resultado
5. Estrutura de gastos
6. Tesouraria: disponibilidades, clientes, fornecedores, fundo de maneio, prazos médios de recebimento e pagamento
7. Posição face ao sector, com **desfasamento visível** (fonte, versão e data de verificação da referência sectorial) e indicadores do **modelo sectorial** (seis modelos por divisão de CAE: comércio 45-47, serviços profissionais 69-74, indústria 10-33, construção e imobiliário 41-43 e 68, restauração e hotelaria 55-56, saúde 86-87; indicadores que exigem dados fora do balancete aparecem como "n.d." com a razão)
8. Alertas fiscais abertos na conferência e obrigações do período seguinte (fixo; vem dos módulos A e B e do GestObrig)
9. Três recomendações concretas em linguagem de negócio, cada uma com a base (indicador) e **editáveis pelo contabilista** até à aprovação (fixo)
10. Anexo metodológico com fórmulas, fontes e datas de referência (fixo)

Os blocos 2, 4, 5, 6 e 7 são seleccionáveis ao gerar. **Nenhum relatório chega ao cliente sem aprovação** de um contabilista ("Aprovar para o cliente"), com registo de quem aprovou; retirar a aprovação volta a escondê-lo. Sem Power BI: gráficos SVG próprios, página interactiva e impressão em PDF pelo browser. Guardrails do texto gerado: todos os números vêm de campos calculados; sem projecções nem promessas.

## Balancetes disponibilizados ao cliente

O gabinete escolhe quando um balancete fica disponível (Balancetes > "Disponibilizar ao cliente"); o cliente vê em Análise > Balancetes só os disponibilizados, pode ver as contas, descarregar CSV e **enviar por email** (por omissão para o próprio, com o CSV em anexo e um resumo dos indicadores), útil quando está no banco. Envio pela Microsoft Graph (`Mail.Send`) a partir da caixa configurada.

## Base legal versionada

Configuração > Base legal: cada peça (Diário da República, ofício-circulado, informação vinculativa, código consolidado, doutrina interna, outro) entra com **data de publicação e data de eficácia separadas**, referência, título, resumo, endereço e o que afecta. Coordenador ou TOC registam; **só o TOC responsável valida ou rejeita**; peças validadas só o TOC altera. Cadências recomendadas: DR diária, ofícios semanal, informações vinculativas mensal, Código trimestral, doutrina manual. O ecrã mostra também a versão e a data de verificação do conhecimento carregado (taxas de IVA, benchmarks). Uma alteração legislativa nunca reclassifica o passado; a lista de artigos afectados chega com as fichas de artigo.

## API

| Método | Rota | Acesso |
|---|---|---|
| POST | `/api/reports/:companyId` `{period, sections[], polish}` | gabinete |
| PATCH | `/api/reports/:id` `{recommendations[1..3]}` (até à aprovação) | gabinete |
| POST | `/api/reports/:id/approve` `{approved}` | gabinete |
| GET | `/api/reports`, `/api/reports/:id`, `/api/reports/:id/html` (cliente: só aprovados) | autenticado |
| POST | `/api/balances/:companyId/:period/publish` `{published}` | gabinete |
| GET | `/api/balances/:companyId` (cliente: só publicados), `/api/balances/:companyId/:period/csv` | autenticado |
| POST | `/api/balances/:companyId/:period/send` `{to[], message}` | autenticado |
| GET/POST/PATCH/DELETE | `/api/legal`, `/api/legal/:id` | gabinete / coordenador / TOC |
