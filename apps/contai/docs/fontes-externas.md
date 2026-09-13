# Fontes externas para benchmarking sectorial

## Conclusão da análise

Não é necessário scraping: tanto o Banco de Portugal como o INE expõem APIs públicas em JSON.

| Fonte | Mecanismo | Verificação neste ambiente | Cliente |
|---|---|---|---|
| Banco de Portugal - BPstat (Quadros do Setor / Central de Balanços) | API REST pública `https://bpstat.bportugal.pt/data/v1/` (documentação em `/data/docs`) | **Verificado**: `GET /domains/?lang=PT` devolve JSON com os domínios estatísticos | `src/integrations/bpstat.ts` |
| INE - indicadores | API JSON `https://www.ine.pt/ine/json_indicador/pindica.jsp?op=2&varcd=<código>&lang=PT` | Não verificado: o host não respondeu a partir da sandbox (timeout); a API é pública e documentada pelo INE | `src/integrations/ine.ts` |

## Como se usa

- Os benchmarks sectoriais vivem em `src/knowledge/sector-benchmarks.json` (versão + data de verificação). Os valores actuais são **indicativos** e devem ser substituídos pelos valores oficiais dos Quadros do Setor via BPstat antes de os relatórios serem entregues a clientes.
- Fluxo de actualização recomendado: `BpstatClient.searchSeries("Quadros do Setor rendibilidade CAE 10")` → escolher as séries por CAE → `seriesObservations` → actualizar os rácios do sector no JSON → alterar `last_verified`. O alerta de conhecimento desactualizado dispara automaticamente quando a data ultrapassa o prazo de revisão.
- Os indicadores do INE (volume de negócios por CAE, índices de preços, emprego) são complementares para a memória descritiva do contexto macro.

## Termos de uso

Ambas as fontes são dados abertos com atribuição obrigatória ("Fonte: Banco de Portugal - BPstat" / "Fonte: INE"). A atribuição é impressa no rodapé de cada relatório.
