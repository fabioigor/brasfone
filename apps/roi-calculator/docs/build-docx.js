'use strict';
// Builds "Programa de Parceiros INUBIA" (versão 2026-09) as DOCX with docx-js.
const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, ImageRun, PageBreak, LevelFormat, Footer, PageNumber, TabStopType,
} = require('docx');

const OUT = process.argv[2] || 'Programa_Parceiros_INUBIA_2026-09.docx';
const LOGO = fs.readFileSync('/workspace/brasfone/apps/roi-calculator/server/assets/inubia-logo.png');
const NAVY = '0A1628', BLUE = '1D3DF5', MUTED = '5A6A7E', GREEN = '1A8A49', LIGHT = 'E8ECF4', LINE = 'DCE3EF';
const FONT = 'Liberation Sans';
const PAGE_W = 11906, MARGIN = 1134, CONTENT_W = PAGE_W - 2 * MARGIN; // A4, 2 cm margins

const t = (text, opts = {}) => new TextRun({ text, font: FONT, size: 22, color: NAVY, ...opts });
const p = (text, opts = {}) => new Paragraph({ spacing: { after: 140, line: 300 }, alignment: AlignmentType.JUSTIFIED, ...opts, children: Array.isArray(text) ? text : [t(text, opts.run || {})] });
const h1 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 120, after: 200 }, children: [t(text, { size: 40, bold: true, color: NAVY })] });
const h2 = (text) => new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 280, after: 120 }, children: [t(text, { size: 26, bold: true, color: BLUE })] });
const bullet = (text, ref = 'bullets') => new Paragraph({ numbering: { reference: ref, level: 0 }, spacing: { after: 90, line: 290 }, alignment: AlignmentType.JUSTIFIED, children: Array.isArray(text) ? text : [t(text)] });
const numbered = (text) => bullet(text, 'numbers');
const lead = (text) => p([t(text, { size: 24, color: MUTED })]);
const pageBreak = () => new Paragraph({ children: [new PageBreak()] });
const quote = (text, author) => new Paragraph({
  spacing: { before: 120, after: 200, line: 300 }, indent: { left: 400 },
  border: { left: { style: BorderStyle.SINGLE, size: 18, color: BLUE, space: 12 } },
  children: [t(`"${text}"`, { italics: true }), t(` ${author}`, { bold: true, size: 20, color: MUTED })],
});

function cell(children, opts = {}) {
  return new TableCell({
    width: { size: opts.width, type: WidthType.DXA },
    shading: opts.fill ? { type: ShadingType.CLEAR, fill: opts.fill, color: 'auto' } : undefined,
    margins: { top: 140, bottom: 140, left: 160, right: 160 },
    borders: opts.noBorder ? { top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' }, right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' } } : {
      top: { style: BorderStyle.SINGLE, size: 4, color: LINE }, bottom: { style: BorderStyle.SINGLE, size: 4, color: LINE },
      left: { style: BorderStyle.SINGLE, size: 4, color: LINE }, right: { style: BorderStyle.SINGLE, size: 4, color: LINE },
    },
    children,
  });
}

// ---------- Cover band ----------
const cover = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W],
  rows: [new TableRow({ children: [cell([
    new Paragraph({ spacing: { before: 400, after: 300 }, children: [new ImageRun({ type: 'png', data: LOGO, transformation: { width: 220, height: 46 } })] }),
    new Paragraph({ spacing: { after: 80 }, children: [t('PROGRAMA DE PARCEIROS INUBIA', { size: 20, color: 'B8C4DA', bold: true })] }),
    new Paragraph({ spacing: { after: 120 }, children: [t('Referenciação Pipedrive CRM', { size: 56, bold: true, color: 'FFFFFF' })] }),
    new Paragraph({ spacing: { after: 400 }, children: [t('Para agências de marketing, consultores e clientes que apresentam empresas à INUBIA. Versão 2026-09.', { size: 24, color: 'B8C4DA' })] }),
    new Paragraph({ spacing: { after: 300 }, children: [t('INUBIA · Grupo Brasfone · maior Pipedrive Platinum Partner de Portugal e Espanha', { size: 18, color: 'B8C4DA' })] }),
  ], { width: CONTENT_W, fill: NAVY, noBorder: true })] })],
});

// ---------- Compensation table ----------
const compHeader = (txt, w) => cell([new Paragraph({ children: [t(txt, { bold: true, size: 18, color: MUTED })] })], { width: w, fill: LIGHT });
const compCell = (lines, w, opts = {}) => cell(lines.map((l, i) => new Paragraph({ spacing: { after: 60 }, children: [t(l, i === 0 && opts.boldFirst ? { bold: true, size: opts.size || 22, color: opts.color || NAVY } : { size: 20 })] })), { width: w });
const colW = [Math.round(CONTENT_W * 0.3), Math.round(CONTENT_W * 0.36), CONTENT_W - Math.round(CONTENT_W * 0.3) - Math.round(CONTENT_W * 0.36)];
const compensation = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: colW,
  rows: [
    new TableRow({ tableHeader: true, children: [compHeader('O que o parceiro faz', colW[0]), compHeader('O que a INUBIA faz', colW[1]), compHeader('Recompensa', colW[2])] }),
    new TableRow({ children: [
      compCell(['Referenciar empresas', 'Recomendamos 3 ou mais. Não há máximo.'], colW[0], { boldFirst: true }),
      compCell(['Contactar no máximo em 24 horas úteis', 'Diagnóstico e proposta, quando entendermos que podemos ajudar a referência.'], colW[1], { boldFirst: true }),
      compCell(['500 € por cada referência fechada', 'Referência fechada: projecto INUBIA (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a 5.000 €, adjudicado nos 12 meses após o registo.'], colW[2], { boldFirst: true, size: 28, color: GREEN }),
    ] }),
  ],
});

// ---------- Ecosystem table ----------
const eco = [
  ['Pipedrive CRM', 'A peça central: leads, pipeline, actividades e previsão de vendas.'],
  ['Meta Conversions API', 'Devolve à Meta os eventos do CRM (SQL, reunião, venda) para optimizar campanhas para clientes e não para formulários.'],
  ['Automação (N8N) e IA', 'Seguimento automático de leads, qualificação, resumos de conversas e criação de actividades.'],
  ['CloudTalk', 'Call center integrado com o CRM: chamadas, gravações e análise de conversas.'],
  ['ClickUp', 'Projectos e colaboração ligados aos negócios ganhos.'],
  ['Facturação e RH', 'Facturação e gestão de pessoas integradas com o processo comercial.'],
];
const ecoW = [Math.round(CONTENT_W * 0.3), CONTENT_W - Math.round(CONTENT_W * 0.3)];
const ecosystem = new Table({
  width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: ecoW,
  rows: eco.map(([a, b]) => new TableRow({ children: [
    cell([new Paragraph({ children: [t(a, { bold: true, size: 21 })] })], { width: ecoW[0], fill: LIGHT }),
    cell([new Paragraph({ alignment: AlignmentType.JUSTIFIED, children: [t(b, { size: 20 })] })], { width: ecoW[1] }),
  ] })),
});

const verticals = [
  ['Serviços financeiros', 'Acompanhamento detalhado de clientes, gestão de leads e automação de processos de vendas. A automação de tarefas evita que a equipa perca tempo na sua execução.'],
  ['Tecnologia e software', 'Gestão de ciclos de vendas complexos e longos, integração com outras ferramentas tecnológicas e análise do desempenho comercial.'],
  ['Imobiliário', 'Gestão de contactos, acompanhamento de leads e oportunidades, automação de follow-ups e organização de documentos.'],
  ['Serviços profissionais (advocacia, consultoria)', 'Organização de clientes e processos, gestão de tarefas e prazos e personalização do atendimento.'],
  ['Educação (instituições privadas, EdTech)', 'Gestão de estudantes e prospectos, automação de marketing e vendas e acompanhamento de matrículas.'],
  ['Saúde (clínicas privadas, telemedicina)', 'Gestão de pacientes, automação de lembretes e consultas e personalização do atendimento.'],
];

const cases = [
  { who: 'Bernardo Castro, Azimute Total', challenge: 'A Azimute Total, empresa de coaching e mentorias para casais, tinha implementado o Pipedrive por conta própria e percebeu que não estava a aproveitar todas as funcionalidades e benefícios da ferramenta.', solution: 'A equipa de CRM do Grupo Brasfone foi contratada para optimizar e adaptar o Pipedrive às necessidades específicas da Azimute Total, com suporte especializado e personalização do CRM.', results: ['Utilização optimizada do CRM, com todas as funcionalidades aproveitadas.', 'Gestão comercial mais fácil, tanto na parte puramente comercial como na análise de dados e conversões.', 'O CEO passou a ter informação detalhada sobre números e conversões para decidir melhor.', 'Implementação simples, com suporte sempre disponível e especializado.'], quote: 'Desde o início da empresa, nós já tínhamos a necessidade de ter um CRM. Decidimos implementar o Pipedrive por conta própria, mas percebemos que não estávamos a usar todo o potencial da ferramenta. Recorrendo aos serviços da Brasfone, conseguimos otimizar e adaptar o Pipedrive à nossa realidade. Hoje, temos um CRM que se encaixa perfeitamente nas nossas necessidades. A gestão comercial tornou-se muito mais fácil, e agora tenho acesso a informações detalhadas sobre números e conversões. Recomendo a Brasfone a todos os empresários e empreendedores. Com um pequeno investimento, conseguimos escalar a nossa operação comercial a um nível muito mais alto.' },
  { who: 'André Feliciano, Ecoprime Soluções', challenge: 'A Ecoprime Soluções, empresa de venda de energia em Portugal, geria as operações comerciais em Excel e precisava de organizar a actividade comercial de forma mais eficiente e profissional.', solution: 'Implementação do Pipedrive com uma solução completa; desde a reunião inicial ficaram claras as principais vantagens e funcionalidades do CRM para a empresa.', results: ['A equipa cresceu de dois para nove colaboradores, gerindo melhor as operações comerciais.', 'Organização de reuniões, follow-ups, propostas e comunicação entre o call center e os comerciais.', 'Produtividade significativamente melhor, sem processos arrastados e com mais controlo sobre a actividade comercial.'], quote: 'Acho que o Pipedrive nos ajuda muito aqui, principalmente na gestão da atividade comercial. Ajuda na organização das tarefas diárias, marcação de reuniões, gestão de follow-ups e propostas. Foi um investimento importante, especialmente quando a equipa começou a crescer. Estamos contentes com o Pipedrive e com o apoio da equipa da Brasfone.' },
  { who: 'Cheila Olive, Narrativa de Espaços', challenge: 'A Narrativa de Espaços geria leads e processos em Excel, com perda de tempo, dinheiro e erros. Precisava de organizar os projectos e aumentar a produtividade.', solution: 'Implementação do Pipedrive com automação da gestão de leads, organização dos projectos por fases, controlo de timings e previsão de facturação.', results: ['Facturação duplicada em menos de seis meses.', 'Todos os processos organizados no Pipedrive, com visão completa dos projectos e atribuição de tarefas.', 'Produtividade da equipa triplicada, com toda a informação centralizada.'], quote: 'Existe uma empresa antes do Pipedrive e outra depois do Pipedrive. Perdíamos tempo e dinheiro com folhas de Excel. O Pipedrive nos permitiu duplicar a faturação e triplicar a produtividade dos funcionários. Acompanharam-nos em todas as etapas com um atendimento personalizado e preocupado com o nosso negócio.' },
  { who: 'Sara Abreu, Clínica Caniço', challenge: 'A Clínica Caniço precisava de um CRM eficiente para integrar funis, automatizar processos complexos e extrair relatórios de monitorização de forma fácil e rápida.', solution: 'Implementação do Pipedrive com várias automações e funis personalizados para as necessidades específicas do sector dentário.', results: ['Vários funis integrados e processos complexos automatizados, com relatórios extraídos em dois cliques.', 'Soluções individualizadas para as necessidades do negócio.', 'Equipa reconhecida pela clareza e competência.'], quote: 'O serviço da Brasfone com o Pipedrive foi excelente. Desde a primeira reunião sentimos que a equipa tinha todas as competências para dar resposta aos nossos pedidos e clareza sobre o CRM. Conseguimos integrar funis e automações complexas e extrair relatórios de monitorização com apenas dois cliques. Ficamos muito satisfeitos!' },
];

const children = [
  cover,
  new Paragraph({ spacing: { before: 300 } }),
  h1('Bem-vindo ao Programa de Parceiros INUBIA'),
  lead('Agências de marketing, consultores e clientes Pipedrive lidam todos os dias com empresas que precisam de controlo e previsibilidade no processo comercial. Este programa recompensa quem as apresenta à INUBIA.'),
  p('A INUBIA faz o diagnóstico, apresenta a proposta e implementa o Pipedrive CRM, a integração com a Meta Conversions API e a automação do processo comercial. O parceiro mantém a relação com a empresa apresentada e recebe 500 € por cada referência fechada. Não há custo de adesão, não há exclusividade e não há máximo de referências.'),
  p('Quem já usa o Pipedrive viu de perto a mudança nos processos e os resultados que o software trouxe à sua empresa. Isso faz de si um agente da mudança, capaz de recomendar a solução a outros negócios que também podem beneficiar dela. Quem gere campanhas para clientes tem um argumento adicional: com o CRM ligado à Meta, os resultados das campanhas passam a provar-se em SQL e vendas, e não em cliques.'),

  h2('Como trazer uma referência'),
  numbered('Pense em empresas (clientes ou parceiros com quem tenha relação) que acredite que beneficiariam do Pipedrive CRM, da integração com a Meta Conversions API ou da automação do processo comercial.'),
  numbered('Veja as verticais que mais beneficiam na secção "As verticais que mais beneficiam".'),
  numbered('Recomendamos que referencie pelo menos 3 empresas; não há máximos.'),
  numbered('Contacte o gestor da empresa referenciada: explique que acredita que a solução pode ajudar o negócio, como ajudou o seu ou os dos seus clientes, e avise que a INUBIA vai entrar em contacto.'),
  numbered('Registe a referência no formulário de parceiros ou envie para parcerias@inubia.pt: nome da empresa, decisor, contacto e contexto. A INUBIA contacta a referência no máximo em 24 horas úteis.'),

  h2('Tabela de compensação'),
  compensation,
  p([t('Notas: aos valores apresentados acresce o IVA à taxa legal em vigor. Nenhuma proposta será feita se entendermos que não conseguimos ajudar a referência. A comissão é devida uma única vez por referência.', { size: 19, color: MUTED })], { spacing: { before: 120, after: 140 } }),

  pageBreak(),
  h1('INUBIA: o maior Pipedrive Platinum Partner de Portugal e Espanha'),
  p('A INUBIA, parte do Grupo Brasfone, é especializada em consultoria tecnológica e integração de sistemas. Como Pipedrive Platinum Partner, oferece soluções personalizadas para maximizar o potencial do CRM nas empresas: implementação, integrações, automação com N8N, inteligência artificial e formação das equipas. Conte com o nosso know-how consultivo para impulsionar as vendas e optimizar os processos comerciais dos seus clientes.'),
  p('A sede do Grupo Brasfone é em Faro e a INUBIA tem equipas em Vila do Conde e em Barcelona, o que permite acompanhar empresas em Portugal e em Espanha com a mesma metodologia.'),
  quote('O principal desafio não é encontrar a ferramenta certa, mas sim adaptar essa ferramenta ao SEU negócio. Essa é a nossa PROMESSA na nossa proposta de valor!', ''),

  h2('O nosso ecossistema'),
  p('Trabalhamos com um ecossistema digital interligado, onde todas as ferramentas comunicam entre si para proporcionar uma gestão fluida e sem falhas. No centro de tudo está o Pipedrive CRM, a peça fundamental que liga as operações das empresas: marketing, projectos, colaboração, facturação, recursos humanos e call center.'),
  ecosystem,
  new Paragraph({ spacing: { after: 200 } }),

  h2('As verticais que mais beneficiam'),
  p('O Pipedrive CRM é uma ferramenta versátil que beneficia diversas verticais de negócio. As que mais beneficiam são:'),
  ...verticals.map(([name, benefit]) => bullet([t(name + ': ', { bold: true }), t(benefit)])),
  p('Estas verticais beneficiam significativamente do Pipedrive CRM pela necessidade de uma gestão eficiente de leads, automação de processos, optimização de recursos e personalização do atendimento, elementos cruciais para manter a competitividade e a rentabilidade nos seus mercados.'),

  pageBreak(),
  h1('Casos de sucesso e resultados'),
  p([t('Os projectos abaixo foram implementados pela equipa de CRM do Grupo Brasfone, que opera hoje sob a marca INUBIA. Os testemunhos são reproduzidos na íntegra.', { size: 20, color: MUTED })]),
  ...cases.flatMap((c) => [
    h2(c.who),
    p([t('Desafio: ', { bold: true }), t(c.challenge)]),
    p([t('Solução: ', { bold: true }), t(c.solution)]),
    p([t('Resultados:', { bold: true })], { spacing: { after: 60 } }),
    ...c.results.map((r) => bullet(r)),
    quote(c.quote, `— ${c.who}`),
  ]),

  pageBreak(),
  h1('Termos e condições do Programa de Parceiros'),
  h2('Adesão'),
  p('A adesão faz-se no formulário de parceiros INUBIA, com os dados da empresa, do representante e o IBAN para pagamento das comissões. Ao submeter, o parceiro recebe automaticamente por email a minuta do contrato de parceria de referenciação, com todos os termos e condições, para revisão e assinatura.'),
  h2('Critérios de validação das referências'),
  bullet('A referência considera-se registada quando o parceiro a comunica à INUBIA por escrito (formulário de parceiros ou parcerias@inubia.pt), antes de qualquer contacto da INUBIA com a empresa, indicando o nome da empresa, o decisor, o contacto e o contexto.'),
  bullet('A referência é válida se, à data do registo, a empresa não estiver em negociação activa com a INUBIA ou com outra empresa do Grupo Brasfone, nem tiver sido sua cliente nos 6 meses anteriores, e se o contacto tiver consentido em ser contactado. A INUBIA confirma a validade em 5 dias úteis.'),
  bullet('A referência é fechada quando a empresa apresentada adjudica à INUBIA um projecto (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a 5.000 €, acrescido de IVA, nos 12 meses após o registo.'),
  bullet('Quando a mesma empresa é registada por mais do que um parceiro, a referência é atribuída ao primeiro registo válido.'),
  bullet('A INUBIA reserva-se o direito de não apresentar proposta se julgar que não pode ajudar a referência.'),
  h2('Disposições gerais'),
  bullet('A INUBIA não se responsabiliza por contactos que não resultem em negócios fechados.'),
  bullet('A participação no programa implica a aceitação integral dos termos e condições aqui descritos e do contrato de parceria.'),
  bullet('A INUBIA pode alterar os termos e condições do programa, comunicando-os por escrito aos parceiros com 30 dias de antecedência. As referências já registadas mantêm as condições em vigor à data do registo.'),
  bullet('O programa não implica exclusividade nem cria qualquer relação laboral, de agência ou de representação.'),
  h2('Pagamento da compensação'),
  p('A compensação é paga no final do mês correspondente ao mês de adjudicação do projecto pela referência e contra factura do parceiro, de valor correspondente ao apurado. Os dados de pagamento (IBAN) são fornecidos na adesão. A INUBIA poderá superar os parâmetros de pagamento aqui definidos; quando isto ocorrer, não haverá nenhuma cobrança adicional. Parâmetros diferentes dos descritos poderão ser acordados conforme conveniência de ambas as partes ao longo da referenciação.'),
  h2('Contacto para dúvidas'),
  p('Para qualquer dúvida ou esclarecimento adicional sobre o Programa de Parceiros INUBIA, contacte a equipa de parcerias através de parcerias@inubia.pt ou em inubia.pt.'),
];

const doc = new Document({
  creator: 'INUBIA · Grupo Brasfone', title: 'Programa de Parceiros INUBIA · versão 2026-09',
  styles: { default: { document: { run: { font: FONT, size: 22, color: NAVY } } } },
  numbering: { config: [
    { reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '•', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 300 } } } }] },
    { reference: 'numbers', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 340 } } } }] },
  ] },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_W }], children: [t('INUBIA · Grupo Brasfone · Programa de Parceiros · versão 2026-09', { size: 16, color: MUTED }), new TextRun({ text: '\t', font: FONT, size: 16 }), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: 16, color: MUTED })] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((buf) => { fs.writeFileSync(OUT, buf); console.log('written', OUT, buf.length, 'bytes'); });
