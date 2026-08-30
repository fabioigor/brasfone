# ContaDesk

Portal digital para gabinetes de contabilidade, inspirado no Kangaroo Files: recepção de documentos dos clientes, classificação automática, arquivo digital organizado (Decreto-Lei 28/2019), geração de lançamentos contabilísticos com validação humana obrigatória e exportação para Cegid Primavera.

## Funcionalidades

- **Portal do cliente:** cada empresa cliente tem acesso próprio para carregar documentos, ver o estado do processamento e responder a pedidos do gabinete.
- **Classificação automática:** cada documento é classificado (factura de compra/venda, recibo, nota de crédito, extracto bancário, despesa) com extracção de NIF, data, número de documento, base tributável, IVA e total. A direcção compra/venda decide-se comparando o NIF emissor com o NIF da empresa.
- **Arquivo digital:** os ficheiros são arquivados por empresa/ano/mês/tipo, com deduplicação por hash SHA-256 (o mesmo ficheiro nunca entra duas vezes).
- **Lançamentos propostos:** o motor gera lançamentos SNC balanceados (clientes 211, fornecedores 221, IVA dedutível 2432, IVA liquidado 2433, FSE 62, prestações de serviços 721) com grau de confiança. Nada é exportado sem aprovação humana.
- **Fila de validação:** o gabinete aprova, edita as linhas ou rejeita com motivo. Linhas desbalanceadas são recusadas.
- **Exportação Primavera:** CSV de movimentos idempotente; um lançamento exportado nunca volta a sair (tabela `export_batch_entries` com `entry_id` único).
- **Pedidos de documentos:** o gabinete pede documentos com prazo; o cliente responde com upload dirigido ao pedido.
- **Calendário fiscal:** próximas obrigações (IVA mensal/trimestral, DMR, SAF-T, Modelo 22, IES, pagamentos por conta) conforme o regime de IVA de cada empresa.
- **Audit log:** todas as escritas e acessos a documentos ficam registados.

## Gateway de IA

Toda a inteligência passa pelo módulo `src/ai/provider.ts`. Por omissão usa o motor heurístico determinístico (funciona offline). Com `ANTHROPIC_API_KEY` definida, as classificações de confiança baixa são refinadas com `claude-haiku-4-5`; uma falha da IA nunca pára o pipeline (o resultado heurístico prevalece). Nenhum outro módulo chama APIs de IA directamente.

## Como correr

```bash
cd apps/contadesk
npm install
npm start          # http://localhost:3000
```

Contas de demonstração (criadas no primeiro arranque):

| Utilizador | Email | Palavra-passe | Papel |
|---|---|---|---|
| Maria Contabilista | gabinete@demo.pt | gabinete123 | Gabinete (staff) |
| João Padeiro | padaria@demo.pt | cliente123 | Cliente (Padaria Central Lda) |
| Ana Silva | tecnonorte@demo.pt | cliente123 | Cliente (TecnoNorte Unipessoal Lda) |

Variáveis de ambiente: `PORT` (3000), `DB_PATH` (`data/contadesk.db`), `STORAGE_ROOT` (`data/arquivo`), `JWT_SECRET` (obrigatória em produção), `ANTHROPIC_API_KEY` (opcional).

## Testes

```bash
npm run typecheck
npm test   # 34 testes: dominio (extraccao, classificacao, lancamentos, calendario) + API end-to-end
```

Os testes cobrem o fluxo completo (upload → proposta → validação → exportação), a idempotência da exportação, a deduplicação por hash e o isolamento entre empresas (um cliente nunca vê nem carrega documentos de outra).

## Limitações da v1 (assumidas)

- Só extrai texto de ficheiros de texto (TXT/CSV/XML/JSON); PDFs e imagens são arquivados e classificados pelo nome do ficheiro, ficando os detalhes para o revisor (OCR fica para a v2).
- Recepção por email/WhatsApp: o esquema já tem o campo `channel`, mas só o canal portal está implementado.
- Exportação Primavera em CSV genérico de movimentos; o mapeamento exacto para o importador do Cegid Primavera deve ser confirmado com a documentação oficial.
- Base de dados SQLite num único ficheiro, adequada a um gabinete; migração para PostgreSQL quando for multi-gabinete.
