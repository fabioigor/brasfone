'use strict';
/**
 * Builds the compact PDF of "Programa de Parceiros INUBIA" (versão 2026-09) with pdfkit and standard fonts,
 * so the file stays small enough to ship with the app (public/docs/programa-parceiros-inubia.pdf).
 * Run: node docs/build-programa-pdf.js [output.pdf]
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const OUT = process.argv[2] || path.join(__dirname, '..', 'public', 'docs', 'programa-parceiros-inubia.pdf');
const LOGO = path.join(__dirname, '..', 'server', 'assets', 'inubia-logo.png');
const NAVY = '#0A1628', BLUE = '#1D3DF5', MUTED = '#5a6a7e', GREEN = '#1a8a49', INK = '#0A1628', LINE = '#dce3ef', LIGHT = '#E8ECF4';

const doc = new PDFDocument({ bufferPages: true, size: 'A4', margins: { top: 56, bottom: 64, left: 56, right: 56 }, info: { Title: 'Programa de Parceiros INUBIA · versão 2026-09', Author: 'INUBIA · Grupo Brasfone' } });
doc.pipe(fs.createWriteStream(OUT));
const W = doc.page.width, H = doc.page.height, L = doc.page.margins.left, R = W - doc.page.margins.right, CW = R - L;

const ensure = (h) => { if (doc.y + h > H - doc.page.margins.bottom) doc.addPage(); };
const h1 = (t) => { ensure(80); doc.moveDown(0.4); doc.font('Helvetica-Bold').fontSize(19).fillColor(NAVY).text(t, { width: CW }); doc.moveDown(0.5); };
const h2 = (t) => { ensure(60); doc.moveDown(0.5); doc.font('Helvetica-Bold').fontSize(12.5).fillColor(BLUE).text(t, { width: CW }); doc.moveDown(0.3); };
const p = (t, o = {}) => { doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 10).fillColor(o.color || INK).text(t, { width: CW, align: 'justify', lineGap: 2 }); doc.moveDown(0.5); };
const lead = (t) => p(t, { size: 11.5, color: MUTED });
const li = (t, n) => { ensure(40); const x = L + 18; doc.font('Helvetica').fontSize(10).fillColor(INK); doc.text(n != null ? `${n}.` : '•', L + 2, doc.y, { width: 16, lineBreak: false }); doc.text(t, x, doc.y, { width: CW - 18, align: 'justify', lineGap: 2 }); doc.x = L; doc.moveDown(0.3); };
const bl = (label, t) => { ensure(40); const x = L + 18; doc.font('Helvetica').fontSize(10).fillColor(INK); doc.text('•', L + 2, doc.y, { width: 16, lineBreak: false }); const y = doc.y; doc.font('Helvetica-Bold').text(label + ' ', x, y, { width: CW - 18, continued: true }); doc.font('Helvetica').text(t, { width: CW - 18, align: 'justify', lineGap: 2 }); doc.x = L; doc.moveDown(0.3); };
const quote = (t, who) => { ensure(90); const y0 = doc.y; doc.font('Helvetica-Oblique').fontSize(10).fillColor(INK).text(`"${t}"`, L + 14, y0, { width: CW - 14, align: 'justify', lineGap: 2 }); doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(who, L + 14, doc.y + 2, { width: CW - 14 }); doc.rect(L + 2, y0, 3, doc.y - y0).fill(BLUE); doc.fillColor(INK); doc.x = L; doc.moveDown(0.8); };

// ---------- Cover band ----------
doc.rect(0, 0, W, 300).fill(NAVY);
if (fs.existsSync(LOGO)) doc.image(LOGO, L, 70, { height: 34 });
doc.font('Helvetica-Bold').fontSize(9).fillColor('#B8C4DA').text('PROGRAMA DE PARCEIROS INUBIA', L, 140, { width: CW, characterSpacing: 1.5 });
doc.font('Helvetica-Bold').fontSize(30).fillColor('#FFFFFF').text('Referenciação Pipedrive CRM', L, 158, { width: CW });
doc.font('Helvetica').fontSize(12).fillColor('#B8C4DA').text('Para agências de marketing, consultores e clientes que apresentam empresas à INUBIA. Versão 2026-09.', L, 205, { width: 380 });
doc.font('Helvetica').fontSize(8.5).fillColor('#B8C4DA').text('INUBIA · Grupo Brasfone · maior Pipedrive Platinum Partner de Portugal e Espanha · Faro, Vila do Conde, Barcelona', L, 268, { width: CW });
doc.fillColor(INK); doc.y = 330; doc.x = L;

h1('Bem-vindo ao Programa de Parceiros INUBIA');
lead('Agências de marketing, consultores e clientes Pipedrive lidam todos os dias com empresas que precisam de controlo e previsibilidade no processo comercial. Este programa recompensa quem as apresenta à INUBIA.');
p('A INUBIA faz o diagnóstico, apresenta a proposta e implementa o Pipedrive CRM, a integração com a Meta Conversions API e a automação do processo comercial. O parceiro mantém a relação com a empresa apresentada e recebe 500 € por cada referência fechada. Não há custo de adesão, não há exclusividade e não há máximo de referências.');
p('Quem já usa o Pipedrive viu de perto a mudança nos processos e os resultados que o software trouxe à sua empresa. Isso faz de si um agente da mudança, capaz de recomendar a solução a outros negócios que também podem beneficiar dela. Quem gere campanhas para clientes tem um argumento adicional: com o CRM ligado à Meta, os resultados das campanhas passam a provar-se em SQL e vendas, e não em cliques.');

h2('Como trazer uma referência');
[
  'Pense em empresas (clientes ou parceiros com quem tenha relação) que acredite que beneficiariam do Pipedrive CRM, da integração com a Meta Conversions API ou da automação do processo comercial.',
  'Veja as verticais que mais beneficiam na secção "As verticais que mais beneficiam".',
  'Recomendamos que referencie pelo menos 3 empresas; não há máximos.',
  'Contacte o gestor da empresa referenciada: explique que acredita que a solução pode ajudar o negócio, como ajudou o seu ou os dos seus clientes, e avise que a INUBIA vai entrar em contacto.',
  'Registe a referência no formulário de parceiros ou envie para parcerias@inubia.pt: nome da empresa, decisor, contacto e contexto. A INUBIA contacta a referência no máximo em 24 horas úteis.',
].forEach((t, i) => li(t, i + 1));

h2('Tabela de compensação');
{
  ensure(150);
  const cols = [CW * 0.3, CW * 0.36, CW * 0.34];
  const x = [L, L + cols[0], L + cols[0] + cols[1]];
  const headers = ['O QUE O PARCEIRO FAZ', 'O QUE A INUBIA FAZ', 'RECOMPENSA'];
  const y0 = doc.y;
  doc.rect(L, y0, CW, 22).fill(LIGHT);
  headers.forEach((h, i) => doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(h, x[i] + 8, y0 + 7, { width: cols[i] - 16, lineBreak: false }));
  const y1 = y0 + 22;
  const cell = (i, lines) => {
    let y = y1 + 10;
    lines.forEach(([t, o]) => { doc.font(o.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(o.size || 9.5).fillColor(o.color || INK).text(t, x[i] + 8, y, { width: cols[i] - 16, lineGap: 1.5 }); y = doc.y + 4; });
    return y;
  };
  const ends = [
    cell(0, [['Referenciar empresas', { bold: true }], ['Recomendamos 3 ou mais. Não há máximo.', {}]]),
    cell(1, [['Contactar no máximo em 24 horas úteis', { bold: true }], ['Diagnóstico e proposta, quando entendermos que podemos ajudar a referência.', {}]]),
    cell(2, [['500 € por cada referência fechada', { bold: true, size: 13, color: GREEN }], ['Referência fechada: projecto INUBIA (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a 5.000 €, adjudicado nos 12 meses após o registo.', {}]]),
  ];
  const y2 = Math.max(...ends) + 6;
  doc.lineWidth(0.6).strokeColor(LINE);
  doc.rect(L, y0, CW, y2 - y0).stroke();
  [x[1], x[2]].forEach((xx) => doc.moveTo(xx, y0).lineTo(xx, y2).stroke());
  doc.moveTo(L, y1).lineTo(R, y1).stroke();
  doc.x = L; doc.y = y2 + 10;
}
p('Notas: aos valores apresentados acresce o IVA à taxa legal em vigor. Nenhuma proposta será feita se entendermos que não conseguimos ajudar a referência. A comissão é devida uma única vez por referência.', { size: 8.5, color: MUTED });

h1('INUBIA: o maior Pipedrive Platinum Partner de Portugal e Espanha');
p('A INUBIA, parte do Grupo Brasfone, é especializada em consultoria tecnológica e integração de sistemas. Como Pipedrive Platinum Partner, oferece soluções personalizadas para maximizar o potencial do CRM nas empresas: implementação, integrações, automação com N8N, inteligência artificial e formação das equipas. Conte com o nosso know-how consultivo para impulsionar as vendas e optimizar os processos comerciais dos seus clientes.');
p('A sede do Grupo Brasfone é em Faro e a INUBIA tem equipas em Vila do Conde e em Barcelona, o que permite acompanhar empresas em Portugal e em Espanha com a mesma metodologia.');
{
  ensure(60); const y0 = doc.y; doc.rect(L, y0, CW, 44).fill(LIGHT);
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text('O principal desafio não é encontrar a ferramenta certa, mas sim adaptar essa ferramenta ao SEU negócio. Essa é a nossa PROMESSA na nossa proposta de valor!', L + 14, y0 + 10, { width: CW - 28 });
  doc.x = L; doc.y = y0 + 56;
}
h2('O nosso ecossistema');
p('Trabalhamos com um ecossistema digital interligado, onde todas as ferramentas comunicam entre si para proporcionar uma gestão fluida e sem falhas. No centro de tudo está o Pipedrive CRM, a peça fundamental que liga as operações das empresas: marketing, projectos, colaboração, facturação, recursos humanos e call center.');
[
  ['Pipedrive CRM', 'a peça central: leads, pipeline, actividades e previsão de vendas.'],
  ['Meta Conversions API', 'devolve à Meta os eventos do CRM (SQL, reunião, venda) para optimizar campanhas para clientes e não para formulários.'],
  ['Automação (N8N) e IA', 'seguimento automático de leads, qualificação, resumos de conversas e criação de actividades.'],
  ['CloudTalk', 'call center integrado com o CRM: chamadas, gravações e análise de conversas.'],
  ['ClickUp', 'projectos e colaboração ligados aos negócios ganhos.'],
  ['Facturação e RH', 'facturação e gestão de pessoas integradas com o processo comercial.'],
].forEach(([a, b]) => bl(a + ':', b));

h2('As verticais que mais beneficiam');
p('O Pipedrive CRM é uma ferramenta versátil que beneficia diversas verticais de negócio. As que mais beneficiam são:');
[
  ['Serviços financeiros:', 'acompanhamento detalhado de clientes, gestão de leads e automação de processos de vendas. A automação de tarefas evita que a equipa perca tempo na sua execução.'],
  ['Tecnologia e software:', 'gestão de ciclos de vendas complexos e longos, integração com outras ferramentas tecnológicas e análise do desempenho comercial.'],
  ['Imobiliário:', 'gestão de contactos, acompanhamento de leads e oportunidades, automação de follow-ups e organização de documentos.'],
  ['Serviços profissionais (advocacia, consultoria):', 'organização de clientes e processos, gestão de tarefas e prazos e personalização do atendimento.'],
  ['Educação (instituições privadas, EdTech):', 'gestão de estudantes e prospectos, automação de marketing e vendas e acompanhamento de matrículas.'],
  ['Saúde (clínicas privadas, telemedicina):', 'gestão de pacientes, automação de lembretes e consultas e personalização do atendimento.'],
].forEach(([a, b]) => bl(a, b));
p('Estas verticais beneficiam significativamente do Pipedrive CRM pela necessidade de uma gestão eficiente de leads, automação de processos, optimização de recursos e personalização do atendimento, elementos cruciais para manter a competitividade e a rentabilidade nos seus mercados.');

doc.addPage();
h1('Casos de sucesso e resultados');
p('Os projectos abaixo foram implementados pela equipa de CRM do Grupo Brasfone, que opera hoje sob a marca INUBIA. Os testemunhos são reproduzidos na íntegra.', { size: 9, color: MUTED });
const cases = [
  { who: 'Bernardo Castro, Azimute Total', challenge: 'a Azimute Total, empresa de coaching e mentorias para casais, tinha implementado o Pipedrive por conta própria e percebeu que não estava a aproveitar todas as funcionalidades e benefícios da ferramenta.', solution: 'a equipa de CRM do Grupo Brasfone foi contratada para optimizar e adaptar o Pipedrive às necessidades específicas da Azimute Total, com suporte especializado e personalização do CRM.', results: ['Utilização optimizada do CRM, com todas as funcionalidades aproveitadas.', 'Gestão comercial mais fácil, tanto na parte puramente comercial como na análise de dados e conversões.', 'O CEO passou a ter informação detalhada sobre números e conversões para decidir melhor.', 'Implementação simples, com suporte sempre disponível e especializado.'], quote: 'Desde o início da empresa, nós já tínhamos a necessidade de ter um CRM. Decidimos implementar o Pipedrive por conta própria, mas percebemos que não estávamos a usar todo o potencial da ferramenta. Recorrendo aos serviços da Brasfone, conseguimos otimizar e adaptar o Pipedrive à nossa realidade. Hoje, temos um CRM que se encaixa perfeitamente nas nossas necessidades. A gestão comercial tornou-se muito mais fácil, e agora tenho acesso a informações detalhadas sobre números e conversões. Recomendo a Brasfone a todos os empresários e empreendedores. Com um pequeno investimento, conseguimos escalar a nossa operação comercial a um nível muito mais alto.' },
  { who: 'André Feliciano, Ecoprime Soluções', challenge: 'a Ecoprime Soluções, empresa de venda de energia em Portugal, geria as operações comerciais em Excel e precisava de organizar a actividade comercial de forma mais eficiente e profissional.', solution: 'implementação do Pipedrive com uma solução completa; desde a reunião inicial ficaram claras as principais vantagens e funcionalidades do CRM para a empresa.', results: ['A equipa cresceu de dois para nove colaboradores, gerindo melhor as operações comerciais.', 'Organização de reuniões, follow-ups, propostas e comunicação entre o call center e os comerciais.', 'Produtividade significativamente melhor, sem processos arrastados e com mais controlo sobre a actividade comercial.'], quote: 'Acho que o Pipedrive nos ajuda muito aqui, principalmente na gestão da atividade comercial. Ajuda na organização das tarefas diárias, marcação de reuniões, gestão de follow-ups e propostas. Foi um investimento importante, especialmente quando a equipa começou a crescer. Estamos contentes com o Pipedrive e com o apoio da equipa da Brasfone.' },
  { who: 'Cheila Olive, Narrativa de Espaços', challenge: 'a Narrativa de Espaços geria leads e processos em Excel, com perda de tempo, dinheiro e erros. Precisava de organizar os projectos e aumentar a produtividade.', solution: 'implementação do Pipedrive com automação da gestão de leads, organização dos projectos por fases, controlo de timings e previsão de facturação.', results: ['Facturação duplicada em menos de seis meses.', 'Todos os processos organizados no Pipedrive, com visão completa dos projectos e atribuição de tarefas.', 'Produtividade da equipa triplicada, com toda a informação centralizada.'], quote: 'Existe uma empresa antes do Pipedrive e outra depois do Pipedrive. Perdíamos tempo e dinheiro com folhas de Excel. O Pipedrive nos permitiu duplicar a faturação e triplicar a produtividade dos funcionários. Acompanharam-nos em todas as etapas com um atendimento personalizado e preocupado com o nosso negócio.' },
  { who: 'Sara Abreu, Clínica Caniço', challenge: 'a Clínica Caniço precisava de um CRM eficiente para integrar funis, automatizar processos complexos e extrair relatórios de monitorização de forma fácil e rápida.', solution: 'implementação do Pipedrive com várias automações e funis personalizados para as necessidades específicas do sector dentário.', results: ['Vários funis integrados e processos complexos automatizados, com relatórios extraídos em dois cliques.', 'Soluções individualizadas para as necessidades do negócio.', 'Equipa reconhecida pela clareza e competência.'], quote: 'O serviço da Brasfone com o Pipedrive foi excelente. Desde a primeira reunião sentimos que a equipa tinha todas as competências para dar resposta aos nossos pedidos e clareza sobre o CRM. Conseguimos integrar funis e automações complexas e extrair relatórios de monitorização com apenas dois cliques. Ficamos muito satisfeitos!' },
];
cases.forEach((c) => {
  ensure(160);
  h2(c.who);
  bl('Desafio:', c.challenge);
  bl('Solução:', c.solution);
  p('Resultados:', { bold: true });
  c.results.forEach((r) => li(r));
  quote(c.quote, `— ${c.who}`);
});

doc.addPage();
h1('Termos e condições do Programa de Parceiros');
h2('Adesão');
p('A adesão faz-se no formulário de parceiros INUBIA, com os dados da empresa, do representante e o IBAN para pagamento das comissões. Ao submeter, o parceiro recebe automaticamente por email a minuta do contrato de parceria de referenciação, com todos os termos e condições, para revisão e assinatura.');
h2('Critérios de validação das referências');
[
  'A referência considera-se registada quando o parceiro a comunica à INUBIA por escrito (formulário de parceiros ou parcerias@inubia.pt), antes de qualquer contacto da INUBIA com a empresa, indicando o nome da empresa, o decisor, o contacto e o contexto.',
  'A referência é válida se, à data do registo, a empresa não estiver em negociação activa com a INUBIA ou com outra empresa do Grupo Brasfone, nem tiver sido sua cliente nos 6 meses anteriores, e se o contacto tiver consentido em ser contactado. A INUBIA confirma a validade em 5 dias úteis.',
  'A referência é fechada quando a empresa apresentada adjudica à INUBIA um projecto (implementação, integração, serviços e subscrições contratadas através da INUBIA) de valor igual ou superior a 5.000 €, acrescido de IVA, nos 12 meses após o registo.',
  'Quando a mesma empresa é registada por mais do que um parceiro, a referência é atribuída ao primeiro registo válido.',
  'A INUBIA reserva-se o direito de não apresentar proposta se julgar que não pode ajudar a referência.',
].forEach((t) => li(t));
h2('Disposições gerais');
[
  'A INUBIA não se responsabiliza por contactos que não resultem em negócios fechados.',
  'A participação no programa implica a aceitação integral dos termos e condições aqui descritos e do contrato de parceria.',
  'A INUBIA pode alterar os termos e condições do programa, comunicando-os por escrito aos parceiros com 30 dias de antecedência. As referências já registadas mantêm as condições em vigor à data do registo.',
  'O programa não implica exclusividade nem cria qualquer relação laboral, de agência ou de representação.',
].forEach((t) => li(t));
h2('Pagamento da compensação');
p('A compensação é paga no final do mês correspondente ao mês de adjudicação do projecto pela referência e contra factura do parceiro, de valor correspondente ao apurado. Os dados de pagamento (IBAN) são fornecidos na adesão. A INUBIA poderá superar os parâmetros de pagamento aqui definidos; quando isto ocorrer, não haverá nenhuma cobrança adicional. Parâmetros diferentes dos descritos poderão ser acordados conforme conveniência de ambas as partes ao longo da referenciação.');
h2('Contacto para dúvidas');
p('Para qualquer dúvida ou esclarecimento adicional sobre o Programa de Parceiros INUBIA, contacte Pedro Teixeira, responsável de parcerias, com o apoio de Diogo, Sales Manager, através de parcerias@inubia.pt ou em inubia.pt.');

// Page footers
const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i++) {
  doc.switchToPage(i);
  doc.page.margins.bottom = 0;
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`INUBIA · Grupo Brasfone · Programa de Parceiros · versão 2026-09 · ${i + 1}/${range.count}`, L, H - 40, { width: CW, align: 'right', lineBreak: false });
}
doc.end();
doc.on('end', () => console.log('written', OUT));
