/* Cont.ai - portal do gabinete de contabilidade (frontend) */
"use strict";

let token = localStorage.getItem("cd_token") || null;
let user = JSON.parse(localStorage.getItem("cd_user") || "null");
let companies = [];

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, children = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    n.append(c.nodeType ? c : document.createTextNode(c));
  }
  return n;
};

function toast(msg, isError) {
  const t = el("div", { class: "toast" + (isError ? " err" : "") }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  if (token) headers.Authorization = "Bearer " + token;
  if (opts.json) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.json);
  }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && path !== "/api/auth/login") {
    logout();
    throw new Error("Sessão expirada.");
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || "Erro no pedido.");
  return body;
}

function logout() {
  token = null;
  user = null;
  localStorage.removeItem("cd_token");
  localStorage.removeItem("cd_user");
  render();
}

/* ---------- helpers de apresentacao ---------- */

const STATUS_BADGE = {
  recebido: "info",
  classificado: "info",
  proposto: "warn",
  pendente: "warn",
  validado: "ok",
  aprovado: "ok",
  exportado: "ok",
  cumprido: "ok",
  rejeitado: "bad",
  cancelado: "bad",
  lancado: "ok",
  ja_existia: "info",
  erro: "bad",
  aviso: "warn",
  info: "info",
  aberto: "warn",
  resolvido: "ok",
  ignorado: "",
  activo: "ok",
  inactivo: "",
};

const DOC_TYPE_LABEL = {
  factura_compra: "Factura de compra",
  factura_venda: "Factura de venda",
  nota_credito: "Nota de crédito",
  recibo: "Recibo",
  extracto_bancario: "Extracto bancário",
  despesa: "Despesa",
  guia_transporte: "Guia de transporte",
  outro: "Outro",
  por_classificar: "Por classificar",
};

const badge = (s) => el("span", { class: "badge " + (STATUS_BADGE[s] || "") }, s);

const OCR_LABEL = { texto: "texto", pdf_texto: "PDF com texto", tesseract: "OCR local", claude_visao: "OCR Claude", indisponivel: "sem texto" };
const SOURCE_LABEL = { qr: "QR AT", ia: "IA", heuristica: "regras" };
const FINDING_LABEL = {
  IVA_CALCULO: "IVA mal calculado", TAXA_INEXISTENTE: "Taxa de IVA inexistente", TAXA_DESADEQUADA: "Taxa desadequada ao produto",
  TAXAS_MISTAS_POSSIVEIS: "Artigos com taxas diferentes", TAXA_NAO_IDENTIFICADA: "Taxa de IVA não identificada", TOTAL_INCOERENTE: "Total incoerente",
  DUPLICADO: "Documento duplicado", DATA_FUTURA: "Data futura", DATA_EM_FALTA: "Data em falta", AUMENTO_IMPOSTO_ANOMALO: "Aumento anómalo de imposto",
  NIF_TERCEIRO_EM_FALTA: "NIF do terceiro em falta", OCR_CONFIANCA_BAIXA: "OCR com confiança baixa", TEXTO_NAO_EXTRAIDO: "Texto não extraído",
  FONTES_DIVERGENTES: "Fontes de extracção divergentes", QR_INCOERENTE: "QR code incoerente", DOCUMENTO_ANULADO: "Documento anulado",
  VARIOS_DOCUMENTOS_NO_FICHEIRO: "Vários documentos no ficheiro", SALDO_INVERTIDO: "Saldo com sinal invertido", VARIACAO_ANOMALA: "Variação anómala",
  SALDO_FORA_DO_PADRAO: "Saldo fora do padrão", RACIO_FORA_DO_PADRAO: "Rácio fora do padrão", BALANCETE_DESEQUILIBRADO: "Balancete desequilibrado", EBITDA_NEGATIVO: "EBITDA negativo",
};
const findingLabel = (code) => FINDING_LABEL[code] || code.replace(/_/g, " ").toLowerCase().replace(/^./, (c) => c.toUpperCase());
const sourcesBadges = (d) => {
  let sources = [];
  try { sources = (JSON.parse(d.extracted_json || "{}").sources) || []; } catch (e) { /* ignore */ }
  const wrap = el("span", {});
  for (const src of sources) {
    if (src === "heuristica" && sources.length > 1) continue;
    wrap.append(el("span", { class: "badge " + (src === "qr" ? "ok" : src === "ia" ? "info" : ""), style: "margin-right:4px", title: src === "qr" ? "Dados lidos do QR code da AT (exactos)" : src === "ia" ? "Extracção estruturada por IA" : "Extracção por regras" }, SOURCE_LABEL[src] || src));
  }
  return wrap;
};
const ocrBadge = (d) => {
  if (!d.ocr_method || d.ocr_method === "texto") return el("span", { class: "muted small" }, "texto");
  const cls = d.ocr_method === "indisponivel" ? "bad" : d.ocr_confidence !== null && d.ocr_confidence < 0.85 ? "warn" : "info";
  const conf = d.ocr_confidence !== null && d.ocr_confidence < 1 ? " " + Math.round(d.ocr_confidence * 100) + "%" : "";
  return el("span", { class: "badge " + cls, title: "Método de extracção de texto" }, (OCR_LABEL[d.ocr_method] || d.ocr_method) + conf);
};

/** Painel modal (funciona em telemovel, sem janelas novas). Fecha com Esc, com o botao ou tocando fora. */
function openModal(title, content, opts = {}) {
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (ev) => { if (ev.key === "Escape") close(); };
  const card = el("div", { class: "modal-card" + (opts.wide ? " wide" : "") }, [
    el("div", { class: "modal-head" }, [el("strong", {}, title), el("span", { class: "spacer" }), el("button", { class: "btn small", type: "button", onclick: close }, "Fechar")]),
    el("div", { class: "modal-body" }, content),
  ]);
  const overlay = el("div", { class: "modal", onclick: (ev) => { if (ev.target === overlay) close(); } }, card);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  return close;
}

/** Abre o documento original (imagem, PDF ou texto) num painel, para confirmar os dados lidos. */
async function openDocModal(docId, name) {
  const holder = el("div", { class: "muted small" }, "A carregar o documento...");
  openModal(name || "Documento", holder, { wide: true });
  const pane = await previewPane(docId);
  holder.replaceWith(pane);
}

/** Inline document preview (PDF via visualizador do browser, imagem, ou texto). */
async function previewPane(docId) {
  const pane = el("div", { class: "preview" });
  try {
    const info = await api("/api/documents/" + docId + "/preview-url");
    if (info.kind === "image") {
      pane.append(el("img", { src: info.url, alt: info.name, class: "preview-img" }));
    } else {
      // Parametros do visualizador de PDF do browser: sem barra nem painel lateral, ajustado a largura.
      pane.append(el("iframe", { src: info.kind === "pdf" ? info.url + "#toolbar=0&navpanes=0&view=FitH" : info.url, title: info.name, class: "preview-frame" }));
    }
    pane.append(el("div", { class: "preview-bar" }, [
      el("span", { class: "muted small" }, info.name),
      el("span", { class: "spacer" }),
      el("a", { class: "btn small", href: info.url, target: "_blank", rel: "noopener" }, "Abrir"),
      el("button", { class: "btn small", onclick: () => showDocumentText(docId, info.name) }, "Texto extraído"),
    ]));
  } catch (e) {
    pane.append(el("div", { class: "empty" }, "Sem pré-visualização: " + e.message));
  }
  return pane;
}

async function showDocumentText(docId, name) {
  try {
    const out = await api("/api/documents/" + docId + "/text");
    const meta = "Método: " + (OCR_LABEL[out.method] || out.method || "n/d") + (out.confidence != null ? " · confiança " + Math.round(out.confidence * 100) + "%" : "");
    openModal("Texto extraído · " + (name || ""), el("div", { class: "stack" }, [
      el("p", { class: "small muted" }, meta),
      el("h3", {}, "Dados extraídos"), el("pre", { class: "small pre" }, JSON.stringify(out.extracted, null, 2)),
      el("h3", {}, "Texto lido"), el("pre", { class: "small pre" }, out.text || "(documento de texto: ver ficheiro original)"),
    ]), { wide: true });
  } catch (e) { toast(e.message, true); }
}

/** Badge de qualidade da leitura para um lancamento/documento; avisa quando o humano deve confirmar com o original. */
function readingQuality(ocrMethod, ocrConfidence) {
  if (!ocrMethod || ["texto", "pdf_texto", "duplicado"].includes(ocrMethod)) return null;
  const pct = ocrConfidence != null ? Math.round(ocrConfidence * 100) : null;
  const low = pct != null && pct < 85;
  return el("span", { class: "badge " + (low ? "warn" : "info"), title: "Qualidade da leitura (OCR/IA)" }, (OCR_LABEL[ocrMethod] || ocrMethod) + (pct != null ? " " + pct + "%" : "") + (low ? " · confirme com o documento" : ""));
}
const money = (n) => Number(n).toFixed(2).replace(".", ",") + " €";
const fmtConf = (c) => (c == null ? "" : Math.round(c * 100) + "%");

function companyOptions(select, includeAll) {
  select.innerHTML = "";
  if (includeAll) select.append(el("option", { value: "" }, "Todas as empresas"));
  for (const c of companies) select.append(el("option", { value: c.id }, c.name));
}

/* ---------- vistas ---------- */

async function viewDashboard(main) {
  const isStaff = user.role === "staff";
  const params = isStaff ? "" : "";
  const data = await api("/api/dashboard" + params);
  const count = (arr, s) => (arr.find((x) => x.status === s) || {}).n || 0;

  main.append(el("h2", {}, isStaff ? "Painel do gabinete" : "A minha empresa"));
  main.append(
    el("div", { class: "grid cols-4" }, [
      el("div", { class: "card stat" }, [
        el("div", { class: "n" }, String(count(data.entries, "pendente"))),
        el("div", { class: "l" }, "Lançamentos por validar"),
      ]),
      el("div", { class: "card stat" }, [
        el("div", { class: "n" }, String(count(data.documents, "validado") + count(data.documents, "exportado"))),
        el("div", { class: "l" }, "Documentos validados"),
      ]),
      el("div", { class: "card stat" }, [
        el("div", { class: "n" }, String(count(data.documents, "classificado") + count(data.documents, "proposto"))),
        el("div", { class: "l" }, "Documentos em processamento"),
      ]),
      el("div", { class: "card stat" }, [
        el("div", { class: "n" }, String(data.pendingRequests)),
        el("div", { class: "l" }, "Pedidos pendentes"),
      ]),
      el("div", { class: "card stat" }, [
        el("div", { class: "n" }, String((data.openFindings || []).reduce((s, x) => s + x.n, 0))),
        el("div", { class: "l" }, "Alertas de conferência abertos"),
      ]),
    ])
  );

  if (isStaff && data.knowledge && data.knowledge.length) {
    const stale = data.knowledge.filter((k) => k.stale);
    main.append(
      el("div", { class: "card" }, [
        el("h2", {}, "Conhecimento fiscal do agente"),
        el("div", { class: "muted small" }, data.knowledge.map((k) => k.name.replace("_", " ") + " v" + k.version + " (verificado em " + k.lastVerified + ", há " + k.ageDays + " dias)").join(" · ")),
        stale.length ? el("p", { class: "error" }, "Atenção: " + stale.map((k) => k.name).join(", ") + " ultrapassou o prazo de revisão. Confirme a lei em vigor antes de confiar nos alertas de IVA.") : el("p", { class: "muted small" }, "Regras dentro do prazo de revisão."),
      ])
    );
  }

  await obligationsSection(main, isStaff, data.gestobrig);
  await credentialsSection(main, isStaff);

  const obl = el("tbody");
  for (const o of data.obligations) {
    obl.append(el("tr", {}, [el("td", {}, o.dueDate), el("td", {}, o.label), el("td", {}, el("span", { class: "badge info" }, o.code))]));
  }
  main.append(
    el("div", { class: "card" }, [
      el("h2", {}, "Calendário fiscal (próximos 60 dias)"),
      el("p", { class: "muted small" }, "Prazos gerais; prorrogações extraordinárias da AT não estão reflectidas."),
      el("div", { class: "table-wrap" }, el("table", {}, [el("thead", {}, el("tr", {}, [el("th", {}, "Data limite"), el("th", {}, "Obrigação"), el("th", {}, "Código")])), obl])),
    ])
  );
}

/* ---------- obrigacoes declarativas (GestObrig) ---------- */

const OBLIGATION_STATUS = { por_cumprir: ["Por cumprir", "warn"], cumprida: ["Cumprida", "ok"], fora_prazo: ["Fora de prazo", "bad"], justificada: ["Justificada", "info"] };
function obligationBadge(o, today) {
  const [label, cls] = OBLIGATION_STATUS[o.status] || [o.status, ""];
  if (o.status === "por_cumprir" && o.due_date && o.due_date < today) return el("span", { class: "badge bad" }, "Em atraso");
  return el("span", { class: "badge " + cls }, label);
}
const fmtDate = (d) => (d ? d.split("-").reverse().join("/") : "");

async function obligationsSection(main, isStaff, initial) {
  const card = el("div", { class: "card" });
  const head = el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, [el("h2", { style: "margin:0;flex:1" }, "Obrigações declarativas e prazos")]);
  card.append(head);
  card.append(el("p", { class: "muted small" }, isStaff
    ? "Estado das obrigações controladas no GestObrig (importadas em Integrações > GestObrig). Marque aqui as entregas feitas fora do GestObrig; o cliente vê o mesmo estado na sua área."
    : "Estado das obrigações fiscais e declarativas da sua empresa, controladas pelo gabinete. Verde é entregue; a vermelho estão as que passaram do prazo."));

  const companySel = isStaff ? el("select") : null;
  if (companySel) companyOptions(companySel, true);
  const statusSel = el("select", {}, [
    el("option", { value: "abertas" }, "Por cumprir"), el("option", { value: "todas" }, "Todas"),
    el("option", { value: "cumprida" }, "Cumpridas"), el("option", { value: "fora_prazo" }, "Fora de prazo"), el("option", { value: "justificada" }, "Justificadas"),
  ]);
  const stats = el("div", { class: "grid cols-4" });
  const tbody = el("tbody");
  const empty = el("div", { class: "empty", hidden: "" });
  const table = el("div", { class: "table-wrap" }, el("table", { class: "docs" }, [
    el("thead", {}, el("tr", {}, [isStaff ? el("th", {}, "Empresa") : null, el("th", {}, "Obrigação"), el("th", {}, "Período"), el("th", {}, "Prazo"), el("th", {}, "Estado"), el("th", {}, "Entregue"), el("th", {}, isStaff ? "Responsável" : ""), isStaff ? el("th", {}, "") : null])),
    tbody,
  ]));

  let gestUrl = (initial && initial.url) || "https://www.gestobrig.com";
  const openLink = el("a", { class: "btn small", href: gestUrl, target: "_blank", rel: "noopener" }, "Abrir GestObrig");
  head.append(companySel, statusSel, isStaff ? openLink : null);

  const load = async () => {
    const q = new URLSearchParams({ status: statusSel.value });
    if (companySel && companySel.value) q.set("company_id", companySel.value);
    const data = await api("/api/obligations?" + q.toString());
    gestUrl = data.gestobrigUrl || gestUrl; openLink.href = gestUrl;
    const s = data.summary;
    stats.innerHTML = "";
    stats.append(
      el("div", { class: "card stat flat " + (s.overdue ? "warn" : "") }, [el("div", { class: "n", style: s.overdue ? "color:var(--danger)" : "" }, String(s.overdue)), el("div", { class: "l" }, "Em atraso")]),
      el("div", { class: "card stat flat " + (s.dueSoon ? "warn" : "") }, [el("div", { class: "n" }, String(s.dueSoon)), el("div", { class: "l" }, "A vencer em " + data.soonDays + " dias")]),
      el("div", { class: "card stat flat" }, [el("div", { class: "n" }, String(s.open)), el("div", { class: "l" }, "Por cumprir")]),
      el("div", { class: "card stat flat" }, [el("div", { class: "n" }, String(s.doneThisMonth)), el("div", { class: "l" }, "Cumpridas este mês")]),
    );
    tbody.innerHTML = "";
    const rows = data.obligations || [];
    empty.hidden = rows.length > 0; table.hidden = rows.length === 0;
    empty.textContent = statusSel.value === "abertas" && (s.open === 0)
      ? (isStaff ? "Sem obrigações por cumprir registadas. Importe a exportação do GestObrig em Integrações > GestObrig para ver aqui o controlo de prazos." : "Sem obrigações por cumprir. Quando o gabinete carregar o controlo de prazos, aparece aqui.")
      : "Nada a mostrar com este filtro.";
    for (const o of rows) {
      const actions = [];
      if (isStaff) {
        const setStatus = async (status) => { try { await api("/api/obligations/" + o.id, { method: "PATCH", json: { status } }); toast("Obrigação actualizada."); await load(); } catch (e) { toast(e.message, true); } };
        if (o.status === "por_cumprir") actions.push(el("button", { class: "btn small primary", onclick: () => setStatus("cumprida") }, "Cumprida"), el("button", { class: "btn small", onclick: () => setStatus("justificada"), title: "Não aplicável ou justificada junto da entidade" }, "Justificar"));
        else actions.push(el("button", { class: "btn small", onclick: () => setStatus("por_cumprir") }, "Reabrir"));
      }
      tbody.append(el("tr", { class: o.status === "por_cumprir" && o.due_date && o.due_date < data.today ? "overdue" : "" }, [
        isStaff ? el("td", { "data-l": "Empresa" }, o.company_name) : null,
        el("td", { "data-l": "Obrigação" }, [el("strong", {}, o.label), o.notes ? el("div", { class: "muted small" }, o.notes) : null]),
        el("td", { "data-l": "Período" }, o.period || ""),
        el("td", { "data-l": "Prazo" }, fmtDate(o.due_date)),
        el("td", { "data-l": "Estado" }, obligationBadge(o, data.today)),
        el("td", { "data-l": "Entregue" }, fmtDate(o.submitted_at)),
        el("td", { "data-l": isStaff ? "Responsável" : "" }, isStaff ? (o.responsible || "") : ""),
        isStaff ? el("td", {}, el("div", { class: "actions" }, actions)) : null,
      ]));
    }
  };
  statusSel.addEventListener("change", () => load().catch((e) => toast(e.message, true)));
  if (companySel) companySel.addEventListener("change", () => load().catch((e) => toast(e.message, true)));
  card.append(stats, empty, table);
  main.append(card);
  try { await load(); } catch (e) { card.append(el("p", { class: "error small" }, e.message)); }
}

/* ---------- cofre de acessos as entidades ---------- */

async function credentialsSection(main, isStaff) {
  const card = el("div", { class: "card" });
  const head = el("div", { style: "display:flex;gap:10px;align-items:center;flex-wrap:wrap" }, [el("h2", { style: "margin:0;flex:1" }, "Acessos às entidades")]);
  card.append(head);
  card.append(el("p", { class: "muted small" }, isStaff
    ? "Utilizador e palavra-passe de cada empresa nos portais oficiais (Portal das Finanças, Segurança Social Directa, IAPMEI, fundos de compensação...). Guardados cifrados; cada consulta fica no registo de auditoria. O cliente vê os acessos da sua empresa e pode copiá-los para entrar nos portais e aceitar termos, certificados e comunicações."
    : "Os acessos da sua empresa aos portais oficiais, guardados pelo gabinete. Use \"Mostrar\" para ver a palavra-passe e \"Abrir portal\" para entrar e aceitar termos da Segurança Social, renovar o certificado PME ou tratar de outras comunicações. Cada consulta fica registada."));

  const companySel = isStaff ? el("select") : null;
  if (companySel) companyOptions(companySel, false);
  const companyId = () => (companySel ? Number(companySel.value) : (companies[0] || {}).id);
  const list = el("div", { class: "stack" });
  const addBtn = el("button", { class: "btn small" }, "Adicionar acesso");
  head.append(companySel, addBtn);
  let entities = [];

  const revealRow = async (c, holder) => {
    try {
      const r = await api("/api/companies/" + companyId() + "/credentials/" + c.id + "/reveal", { method: "POST" });
      holder.innerHTML = "";
      const copyBtn = (label, value) => el("button", { class: "btn small", type: "button", onclick: async () => { try { await navigator.clipboard.writeText(value); toast(label + " copiado."); } catch (e) { toast("Copie manualmente: o browser não permitiu o acesso à área de transferência.", true); } } }, "Copiar " + label.toLowerCase());
      holder.append(el("div", { class: "cred-reveal" }, [
        el("div", {}, [el("span", { class: "muted small" }, "Utilizador "), el("code", {}, r.username || "(sem utilizador)"), " ", r.username ? copyBtn("Utilizador", r.username) : null]),
        el("div", {}, [el("span", { class: "muted small" }, "Palavra-passe "), el("code", {}, r.password || "(sem palavra-passe)"), " ", r.password ? copyBtn("Palavra-passe", r.password) : null]),
        el("div", { class: "muted small" }, "Esconde-se automaticamente em 60 segundos."),
      ]));
      setTimeout(() => { holder.innerHTML = ""; }, 60000);
    } catch (e) { toast(e.message, true); }
  };

  const editForm = (c) => {
    const entSel = el("select", {}, entities.map((e) => el("option", { value: e.code }, e.label)));
    if (c) entSel.value = c.entity;
    const label = el("input", { placeholder: "Designação (opcional)", value: c ? c.label : "" });
    const url = el("input", { placeholder: "https://...", value: c ? (c.url || "") : "" });
    const usernameIn = el("input", { placeholder: "Utilizador / NIF / NISS", autocomplete: "off", value: c ? (c.username || "") : "" });
    const password = el("input", { type: "password", placeholder: c && c.has_password ? "(mantida; escreva para substituir)" : "Palavra-passe", autocomplete: "new-password" });
    const notes = el("textarea", { rows: "2", placeholder: "Notas (ex.: 2FA no telemóvel do gerente)" }); notes.value = c ? (c.notes || "") : "";
    const hint = el("div", { class: "muted small" });
    const applyEntity = () => { const e = entities.find((x) => x.code === entSel.value); hint.textContent = (e && e.hint) || ""; if (!c && e && e.url && !url.value) url.value = e.url; if (!c && e && !label.value) label.placeholder = e.label; };
    entSel.addEventListener("change", applyEntity); applyEntity();
    const save = el("button", { class: "btn primary", type: "submit" }, c ? "Guardar" : "Adicionar");
    const form = el("form", { class: "form-col wide" }, [
      el("label", {}, ["Entidade", entSel, hint]), el("label", {}, ["Designação", label]), el("label", {}, ["Endereço do portal", url]),
      el("label", {}, ["Utilizador", usernameIn]), el("label", {}, ["Palavra-passe", password]), el("label", {}, ["Notas", notes]),
      el("div", { class: "form-row" }, [save]),
    ]);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault(); save.disabled = true;
      try {
        await api("/api/companies/" + companyId() + "/credentials", { method: "POST", json: { id: c ? c.id : undefined, entity: entSel.value, label: label.value || null, url: url.value || null, username: usernameIn.value || null, password: password.value || null, notes: notes.value || null } });
        toast(c ? "Acesso actualizado." : "Acesso guardado."); close(); await load();
      } catch (e) { toast(e.message, true); } finally { save.disabled = false; }
    });
    const close = openModal(c ? "Editar acesso" : "Novo acesso", form);
  };
  addBtn.addEventListener("click", () => editForm(null));

  const load = async () => {
    const data = await api("/api/companies/" + companyId() + "/credentials");
    entities = data.entities || [];
    list.innerHTML = "";
    if (!data.credentials.length) {
      list.append(el("div", { class: "empty" }, isStaff ? "Sem acessos registados para esta empresa. Adicione manualmente ou importe a lista de acessos do GestObrig em Integrações > GestObrig." : "O gabinete ainda não registou acessos para a sua empresa."));
      return;
    }
    for (const c of data.credentials) {
      const holder = el("div", { style: "grid-column:1 / -1" });
      const actions = [
        c.url ? el("a", { class: "btn small", href: c.url, target: "_blank", rel: "noopener" }, "Abrir portal") : null,
        c.has_password || c.username ? el("button", { class: "btn small primary", onclick: () => revealRow(c, holder) }, "Mostrar") : null,
        el("button", { class: "btn small", onclick: () => editForm(c) }, "Editar"),
        isStaff ? el("button", { class: "btn small danger", onclick: async () => { if (!confirm("Apagar o acesso \"" + c.label + "\"?")) return; try { await api("/api/companies/" + companyId() + "/credentials/" + c.id, { method: "DELETE" }); toast("Acesso apagado."); await load(); } catch (e) { toast(e.message, true); } } }, "Apagar") : null,
      ];
      list.append(el("div", { class: "item" }, [
        el("div", {}, [
          el("div", { class: "title" }, c.label),
          el("div", { class: "meta" }, [el("span", { class: "badge info" }, c.entity), c.username ? "utilizador " + c.username : "sem utilizador", c.has_password ? "· palavra-passe guardada" : "· sem palavra-passe", c.updated_at ? "· actualizado " + new Date(c.updated_at.replace(" ", "T") + "Z").toLocaleDateString("pt-PT") : ""]),
          c.notes ? el("div", { class: "small", style: "margin-top:4px" }, c.notes) : null,
        ]),
        el("div", { class: "actions" }, actions),
        holder,
      ]));
    }
  };
  if (companySel) companySel.addEventListener("change", () => load().catch((e) => toast(e.message, true)));
  card.append(list);
  main.append(card);
  if (!companyId()) { list.append(el("div", { class: "empty" }, "Sem empresas.")); return; }
  try { await load(); } catch (e) { list.append(el("p", { class: "error small" }, e.message)); }
}

async function viewDocuments(main) {
  const isStaff = user.role === "staff";
  main.append(el("h2", {}, "Documentos"));

  // Formulario de upload
  const fileInput = el("input", { type: "file", required: "true", accept: ".pdf,.png,.jpg,.jpeg,.webp,.tif,.tiff,.txt,.csv,.xml,application/pdf,image/*,text/*" });
  const companySelect = el("select");
  const uploadBtn = el("button", { class: "btn primary", type: "submit" }, "Carregar documento");
  const form = el("form", { class: "form-row" }, [
    el("label", {}, ["Ficheiro", fileInput]),
    isStaff ? el("label", {}, ["Empresa", companySelect]) : null,
    uploadBtn,
  ]);
  if (isStaff) companyOptions(companySelect, false);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!fileInput.files[0]) return;
    uploadBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append("file", fileInput.files[0]);
      if (isStaff) fd.append("company_id", companySelect.value);
      const out = await api("/api/documents", { method: "POST", body: fd });
      const ocrNote = out.ocr && out.ocr.method && !["texto", "duplicado"].includes(out.ocr.method) ? " · " + OCR_LABEL[out.ocr.method] + (out.ocr.confidence < 1 ? " (" + Math.round(out.ocr.confidence * 100) + "%)" : "") : "";
      toast(out.duplicate ? "Documento já existia (não duplicado)." : "Documento carregado e classificado: " + (DOC_TYPE_LABEL[out.docType] || out.docType) + ocrNote);
      render();
    } catch (e) {
      toast(e.message, true);
    } finally {
      uploadBtn.disabled = false;
    }
  });
  main.append(el("div", { class: "card" }, [el("h2", {}, "Novo documento"), form]));

  const docs = (await api("/api/documents")).documents;
  const tbody = el("tbody");
  for (const d of docs) {
    tbody.append(
      el("tr", {}, [
        el("td", {}, [
          el("a", { href: "/api/documents/" + d.id + "/file", onclick: (ev) => downloadDoc(ev, d.id, d.original_name) }, d.original_name),
          el("div", { class: "muted small" }, d.company_name),
        ]),
        el("td", { "data-l": "Tipo" }, DOC_TYPE_LABEL[d.doc_type] || d.doc_type),
        el("td", { "data-l": "Data" }, d.doc_date || ""),
        el("td", { "data-l": "Confiança" }, fmtConf(d.classification_confidence)),
        el("td", { "data-l": "Extracção" }, [ocrBadge(d), " ", sourcesBadges(d)]),
        el("td", { "data-l": "Estado" }, [badge(d.status), d.onedrive_url ? el("a", { class: "badge info", href: d.onedrive_url, target: "_blank", rel: "noopener", style: "margin-left:4px;text-decoration:none", title: d.onedrive_path || "" }, "OneDrive") : d.onedrive_error ? el("span", { class: "badge warn", title: d.onedrive_error, style: "margin-left:4px" }, "OneDrive: erro") : null]),
        el("td", { class: "acts" }, [
          el("button", { class: "btn small primary", onclick: () => openDocModal(d.id, d.original_name) }, "Ver"),
          el("button", { class: "btn small", onclick: () => showDocumentText(d.id, d.original_name) }, "Texto"),
          isStaff ? " " : null,
          isStaff ? el("button", { class: "btn small", onclick: async () => { try { const o = await api("/api/documents/" + d.id + "/reprocess", { method: "POST" }); toast("Reprocessado: " + (OCR_LABEL[o.ocr.method] || o.ocr.method) + ", " + o.findings.length + " alerta(s)."); render(); } catch (e) { toast(e.message, true); } } }, "Reprocessar") : null,
        ]),
      ])
    );
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", { class: "docs" }, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Documento"), el("th", {}, "Tipo"), el("th", {}, "Data"), el("th", {}, "Confiança"), el("th", {}, "Extracção"), el("th", {}, "Estado"), el("th", {}, "")])),
        docs.length ? tbody : el("tbody", {}, el("tr", {}, el("td", { colspan: "7", class: "muted" }, "Sem documentos."))),
      ])
    )
  );
}

async function downloadDoc(ev, id, name) {
  ev.preventDefault();
  try {
    const res = await fetch("/api/documents/" + id + "/file", { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) throw new Error("Sem acesso ao ficheiro.");
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast(e.message, true);
  }
}

async function viewValidation(main) {
  const entries = (await api("/api/entries?status=pendente")).entries;
  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const wantedId = Number(params.get("id"));
  const selected = entries.find((e) => e.id === wantedId) || entries[0] || null;

  main.append(el("div", { class: "hero" }, [
    el("div", {}, [
      el("h2", {}, "Validação de lançamentos"),
      el("div", { class: "sub" }, entries.length ? entries.length + " por decidir. Teclas: A aprovar · R rejeitar · J/K seguinte/anterior." : "Nenhum lançamento por decidir."),
    ]),
  ]));
  if (!entries.length) { main.append(el("div", { class: "empty" }, [el("div", { class: "big" }, "✓"), "Fila vazia. Nada é exportado sem aprovação humana."])); return; }

  // Lista (mestre)
  const list = el("div", { class: "vlist" });
  for (const e of entries) {
    list.append(el("a", { href: "#validacao?id=" + e.id, class: "vitem" + (selected && e.id === selected.id ? " active" : "") }, [
      el("div", { class: "title" }, e.description.replace(/ - NIF \d{9}$/, "")),
      el("div", { class: "meta" }, [e.company_name, " · ", e.entry_date, " · ", fmtEur(e.lines.reduce((a, l) => a + l.debit, 0))]),
      el("div", { class: "meta" }, [el("span", { class: "badge " + (e.confidence < 0.8 ? "warn" : "ok") }, fmtConf(e.confidence)), (e.sources || []).includes("qr") ? el("span", { class: "badge ok" }, "QR AT") : null, (e.sources || []).includes("ia") ? el("span", { class: "badge info" }, "IA") : null]),
    ]));
  }

  // Detalhe: pré-visualização + informação lado a lado
  const detail = el("div", { class: "vdetail" });
  if (selected) {
    const [pane, findingsRes] = await Promise.all([previewPane(selected.document_id), api("/api/findings?status=aberto&company_id=" + selected.company_id)]);
    const docFindings = (findingsRes.findings || []).filter((f) => f.document_id === selected.document_id);
    const x = selected.extracted || {};
    const src = (k) => (x.fieldSources && x.fieldSources[k]) ? el("span", { class: "badge " + (x.fieldSources[k] === "qr" ? "ok" : "info"), style: "margin-left:6px" }, SOURCE_LABEL[x.fieldSources[k]] || x.fieldSources[k]) : null;
    const fact = (label, value, key) => el("div", { class: "fact" }, [el("div", { class: "eyebrow" }, label), el("div", { class: "fact-v" }, [value == null || value === "" ? "—" : String(value), key ? src(key) : null])]);
    const facts = el("div", { class: "facts" }, [
      fact("Emitente", (x.issuerName ? x.issuerName + " · " : "") + (x.issuerNif || ""), "issuerNif"),
      fact("Documento", x.docNumber, "docNumber"),
      fact("Data", x.docDate, "docDate"),
      fact("Base", x.netAmount != null ? fmtEur(x.netAmount) : null, "netAmount"),
      fact("IVA", x.vatAmount != null ? fmtEur(x.vatAmount) + ((x.vatBreakdown || []).length > 1 ? " (" + x.vatBreakdown.map((b) => b.rate + "%").join(" + ") + ")" : x.vatRate != null ? " (" + x.vatRate + "%)" : "") : null, "vatAmount"),
      fact("Total", x.totalAmount != null ? fmtEur(x.totalAmount) : null, "totalAmount"),
      x.atcud ? fact("ATCUD", x.atcud, "atcud") : null,
    ]);
    const alerts = el("div", { class: "stack" });
    for (const f of docFindings) alerts.append(el("div", { class: "item alert " + f.severity, style: "padding:10px 12px" }, [el("div", {}, [el("div", { class: "title small" }, findingLabel(f.code)), el("div", { class: "small muted" }, f.message)])]));
    const weak = selected.ocr_method && !["texto", "pdf_texto", "duplicado"].includes(selected.ocr_method) && selected.ocr_confidence != null && selected.ocr_confidence < 0.85;
    const info = el("div", { class: "vinfo stack" }, [
      weak ? el("div", { class: "card flat", style: "border-left:4px solid var(--warn)" }, [el("strong", {}, "Leitura com confiança de " + Math.round(selected.ocr_confidence * 100) + "% (" + (OCR_LABEL[selected.ocr_method] || selected.ocr_method) + ")"), el("div", { class: "small muted" }, "Confirme os valores com o documento ao lado antes de aprovar. Pode corrigir as linhas do lançamento aqui.")]) : null,
      el("div", { class: "card flat" }, [el("h2", {}, "Dados extraídos"), readingQuality(selected.ocr_method, selected.ocr_confidence), facts]),
      docFindings.length ? el("div", {}, [el("div", { class: "eyebrow", style: "margin-bottom:6px" }, "Alertas deste documento"), alerts]) : null,
      entryCard(selected),
    ]);
    detail.append(el("div", { class: "vsplit" }, [pane, info]));
  }
  main.append(el("div", { class: "vlayout" }, [list, detail]));

  // Atalhos de teclado
  const idx = entries.findIndex((e) => selected && e.id === selected.id);
  const go = (i) => { const t = entries[i]; if (t) location.hash = "#validacao?id=" + t.id; };
  window.onkeydown = (ev) => {
    if (currentRoute() !== "validacao" || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (ev.key === "j" || ev.key === "J") go(idx + 1);
    else if (ev.key === "k" || ev.key === "K") go(idx - 1);
    else if ((ev.key === "a" || ev.key === "A") && selected) document.querySelector(".vinfo .approve-btn")?.click();
    else if ((ev.key === "r" || ev.key === "R") && selected) document.querySelector(".vinfo .reject-btn")?.click();
  };
}

function entryCard(e) {
  const linesBody = el("tbody");
  const lineInputs = [];
  for (const l of e.lines) {
    const acc = el("input", { value: l.account });
    const desc = el("input", { value: l.description });
    const deb = el("input", { class: "num", value: l.debit.toFixed(2) });
    const cred = el("input", { class: "num", value: l.credit.toFixed(2) });
    lineInputs.push({ acc, desc, deb, cred });
    linesBody.append(el("tr", {}, [el("td", {}, acc), el("td", {}, desc), el("td", {}, deb), el("td", {}, cred)]));
  }

  const reason = el("input", { placeholder: "Motivo da rejeição" });
  const lowConf = e.confidence < 0.8;

  const decide = async (action) => {
    try {
      const payload = { action };
      if (action === "rejeitar") payload.reason = reason.value;
      if (action === "aprovar") {
        payload.lines = lineInputs.map((li) => ({
          account: li.acc.value.trim(),
          description: li.desc.value.trim(),
          debit: Number(li.deb.value.replace(",", ".")) || 0,
          credit: Number(li.cred.value.replace(",", ".")) || 0,
        }));
      }
      await api("/api/entries/" + e.id + "/decision", { method: "POST", json: payload });
      toast(action === "aprovar" ? "Lançamento aprovado." : "Lançamento rejeitado.");
      render();
    } catch (err) {
      toast(err.message, true);
    }
  };

  return el("div", { class: "card" }, [
    el("div", { class: "form-row" }, [
      el("div", {}, [
        el("strong", {}, e.description),
        el("div", { class: "muted small" }, e.company_name + " · " + e.original_name + " · " + e.entry_date + " · Diário: " + e.journal),
      ]),
      el("span", { class: "spacer" }),
      el("span", { class: "badge " + (lowConf ? "warn" : "ok") }, "Confiança " + fmtConf(e.confidence)),
    ]),
    el("div", { class: "table-wrap" },
      el("table", { class: "entry-lines" }, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Conta SNC"), el("th", {}, "Descrição"), el("th", {}, "Débito"), el("th", {}, "Crédito")])),
        linesBody,
      ])
    ),
    el("div", { class: "form-row", style: "margin-top:10px" }, [
      el("button", { class: "btn primary approve-btn", onclick: () => decide("aprovar") }, "Aprovar"),
      el("label", { style: "flex:2" }, ["", reason]),
      el("button", { class: "btn danger reject-btn", onclick: () => decide("rejeitar") }, "Rejeitar"),
    ]),
  ]);
}

async function viewRequests(main) {
  const isStaff = user.role === "staff";
  main.append(el("h2", {}, "Pedidos de documentos"));

  if (isStaff) {
    const companySelect = el("select");
    companyOptions(companySelect, false);
    const title = el("input", { placeholder: "Ex.: Extracto bancário de Julho", required: "true" });
    const due = el("input", { type: "date", required: "true" });
    const form = el("form", { class: "form-row" }, [
      el("label", {}, ["Empresa", companySelect]),
      el("label", { style: "flex:2" }, ["Pedido", title]),
      el("label", {}, ["Prazo", due]),
      el("button", { class: "btn primary", type: "submit" }, "Criar pedido"),
    ]);
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      try {
        await api("/api/requests", { method: "POST", json: { company_id: Number(companySelect.value), title: title.value, due_date: due.value } });
        toast("Pedido criado.");
        render();
      } catch (e) {
        toast(e.message, true);
      }
    });
    main.append(el("div", { class: "card" }, [el("h2", {}, "Novo pedido"), form]));
  }

  const reqs = (await api("/api/requests")).requests;
  const tbody = el("tbody");
  for (const r of reqs) {
    const actions = el("td");
    if (isStaff && r.status === "pendente") {
      actions.append(el("button", { class: "btn small danger", onclick: async () => { await api("/api/requests/" + r.id + "/cancel", { method: "POST" }); render(); } }, "Cancelar"));
    }
    if (!isStaff && r.status === "pendente") {
      const fi = el("input", { type: "file", style: "font-size:12px" });
      fi.addEventListener("change", async () => {
        if (!fi.files[0]) return;
        try {
          const fd = new FormData();
          fd.append("file", fi.files[0]);
          fd.append("request_id", String(r.id));
          await api("/api/documents", { method: "POST", body: fd });
          toast("Documento enviado. Pedido cumprido.");
          render();
        } catch (e) {
          toast(e.message, true);
        }
      });
      actions.append(fi);
    }
    tbody.append(
      el("tr", {}, [
        el("td", {}, [r.title, el("div", { class: "muted small" }, r.company_name)]),
        el("td", {}, r.due_date),
        el("td", {}, badge(r.status)),
        actions,
      ])
    );
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Pedido"), el("th", {}, "Prazo"), el("th", {}, "Estado"), el("th", {}, "")])),
        reqs.length ? tbody : el("tbody", {}, el("tr", {}, el("td", { colspan: "4", class: "muted" }, "Sem pedidos."))),
      ])
    )
  );
}

async function viewCompanies(main) {
  main.append(el("h2", {}, "Empresas clientes"));

  const name = el("input", { placeholder: "Nome da empresa", required: "true" });
  const nif = el("input", { placeholder: "NIF (9 dígitos)", required: "true", pattern: "\\d{9}" });
  const regime = el("select", {}, [el("option", { value: "trimestral" }, "IVA trimestral"), el("option", { value: "mensal" }, "IVA mensal")]);
  const form = el("form", { class: "form-row" }, [
    el("label", { style: "flex:2" }, ["Nome", name]),
    el("label", {}, ["NIF", nif]),
    el("label", {}, ["Regime", regime]),
    el("button", { class: "btn primary", type: "submit" }, "Adicionar"),
  ]);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/companies", { method: "POST", json: { name: name.value, nif: nif.value, vat_regime: regime.value } });
      toast("Empresa criada.");
      await loadCompanies();
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
  main.append(el("div", { class: "card" }, [el("h2", {}, "Nova empresa"), form]));

  const tbody = el("tbody");
  for (const c of companies) {
    const userBtn = el("button", { class: "btn small" }, "Criar acesso de cliente");
    userBtn.addEventListener("click", async () => {
      const email = prompt("Email do utilizador cliente:");
      if (!email) return;
      const password = prompt("Palavra-passe inicial (mín. 8 caracteres):");
      if (!password) return;
      try {
        await api("/api/companies/" + c.id + "/users", { method: "POST", json: { name: c.name, email, password } });
        toast("Acesso criado para " + email);
      } catch (e) {
        toast(e.message, true);
      }
    });
    const cgInput = el("input", { value: c.centralgest_code || "", placeholder: "ex.: PADARIA", style: "width:100px" });
    const caeInput = el("input", { value: c.cae || "", placeholder: "CAE", style: "width:70px" });
    const terrSel = el("select", {}, ["continente", "acores", "madeira"].map((t) => el("option", { value: t }, t)));
    terrSel.value = c.territory || "continente";
    const cgBtn = el("button", { class: "btn small" }, "Guardar");
    cgBtn.addEventListener("click", async () => {
      try {
        await api("/api/companies/" + c.id, { method: "PATCH", json: { centralgest_code: cgInput.value.trim() || null, cae: caeInput.value.trim() || null, territory: terrSel.value } });
        toast("Empresa actualizada.");
        await loadCompanies();
      } catch (e) {
        toast(e.message, true);
      }
    });
    tbody.append(el("tr", {}, [
      el("td", {}, c.name),
      el("td", {}, c.nif),
      el("td", {}, c.vat_regime),
      el("td", {}, [caeInput, " ", terrSel]),
      el("td", {}, [cgInput, " ", cgBtn]),
      el("td", {}, [userBtn, " ", el("button", { class: "btn small", onclick: () => manageContacts(c) }, "Remetentes")]),
    ]));
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Nome"), el("th", {}, "NIF"), el("th", {}, "Regime IVA"), el("th", {}, "CAE / território"), el("th", {}, "Código CentralGest"), el("th", {}, "")])),
        tbody,
      ])
    )
  );
}

async function viewExport(main) {
  main.append(el("h2", {}, "Entrega da contabilidade"));
  main.append(el("p", { class: "muted" }, "Cada lançamento aprovado segue por uma única via: API CentralGest ou CSV Primavera. Ambas são idempotentes: o mesmo lançamento nunca sai duas vezes."));

  // --- CentralGest (API) ---
  const cgStatus = await api("/api/centralgest/status");
  const cgCard = el("div", { class: "card" });
  cgCard.append(el("h2", {}, "CentralGest (API)"));
  if (!cgStatus.configured) {
    cgCard.append(el("p", { class: "muted" }, "Não configurado. Defina CENTRALGEST_BASE_URL e CENTRALGEST_API_KEY (ou CENTRALGEST_MOCK=1 para o simulador local) e reinicie o servidor."));
  } else if (cgStatus.connection !== "ok") {
    cgCard.append(el("p", { class: "error" }, "Ligação com erro: " + cgStatus.detail));
  } else {
    cgCard.append(el("p", { class: "muted small" }, "Ligação OK. Empresas remotas: " + cgStatus.remoteCompanies.map((c) => c.codigo).join(", ")));
    const cgCompany = el("select");
    companyOptions(cgCompany, false);
    const cgBtn = el("button", { class: "btn primary" }, "Lançar aprovados no CentralGest");
    cgBtn.addEventListener("click", async () => {
      cgBtn.disabled = true;
      try {
        const out = await api("/api/centralgest/dispatch/" + cgCompany.value, { method: "POST", json: {} });
        if (!out.outcomes.length) toast("Nada por lançar para esta empresa.");
        else {
          const done = out.outcomes.filter((o) => o.status === "lancado" || o.status === "ja_existia").length;
          const errs = out.outcomes.filter((o) => o.status === "erro");
          toast(done + " lançamento(s) no CentralGest" + (errs.length ? "; " + errs.length + " com erro" : "") + ".", errs.length > 0);
        }
        render();
      } catch (e) {
        toast(e.message, true);
      } finally {
        cgBtn.disabled = false;
      }
    });
    cgCard.append(el("div", { class: "form-row" }, [el("label", {}, ["Empresa", cgCompany]), cgBtn]));
  }
  main.append(cgCard);

  if (cgStatus.configured) {
    const dispatches = (await api("/api/centralgest/dispatches")).dispatches;
    const dtbody = el("tbody");
    for (const d of dispatches) {
      dtbody.append(el("tr", {}, [
        el("td", {}, "#" + d.entry_id),
        el("td", {}, [d.entry_description, el("div", { class: "muted small" }, d.company_name)]),
        el("td", {}, d.remote_number || ""),
        el("td", {}, [badge(d.status), d.error_detail ? el("div", { class: "error small" }, d.error_detail) : null]),
        el("td", {}, d.created_at),
      ]));
    }
    main.append(
      el("div", { class: "card table-wrap" }, [
        el("h2", {}, "Despachos CentralGest"),
        el("table", {}, [
          el("thead", {}, el("tr", {}, [el("th", {}, "Lançamento"), el("th", {}, "Descrição"), el("th", {}, "N.º remoto"), el("th", {}, "Estado"), el("th", {}, "Data")])),
          dispatches.length ? dtbody : el("tbody", {}, el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Sem despachos."))),
        ]),
      ])
    );
  }

  // --- Primavera (CSV) ---
  main.append(el("h2", {}, "Cegid Primavera (CSV)"));

  const companySelect = el("select");
  companyOptions(companySelect, false);
  const btn = el("button", { class: "btn primary" }, "Exportar lançamentos aprovados");
  btn.addEventListener("click", async () => {
    try {
      const out = await api("/api/export/" + companySelect.value, { method: "POST" });
      if (out.entryCount === 0) toast("Nada por exportar para esta empresa.");
      else toast("Lote " + out.batchId + " criado com " + out.entryCount + " lançamento(s).");
      render();
    } catch (e) {
      toast(e.message, true);
    }
  });
  main.append(el("div", { class: "card form-row" }, [el("label", {}, ["Empresa", companySelect]), btn]));

  const batches = (await api("/api/export/batches")).batches;
  const tbody = el("tbody");
  for (const b of batches) {
    const dl = el("button", { class: "btn small" }, "Descarregar CSV");
    dl.addEventListener("click", async () => {
      const res = await fetch("/api/export/batches/" + b.id + "/download", { headers: { Authorization: "Bearer " + token } });
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "primavera-lote-" + b.id + ".csv";
      a.click();
      URL.revokeObjectURL(a.href);
    });
    tbody.append(el("tr", {}, [el("td", {}, "#" + b.id), el("td", {}, b.company_name), el("td", {}, String(b.entry_count)), el("td", {}, b.created_at), el("td", {}, dl)]));
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Lote"), el("th", {}, "Empresa"), el("th", {}, "Lançamentos"), el("th", {}, "Data"), el("th", {}, "")])),
        batches.length ? tbody : el("tbody", {}, el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Sem lotes exportados."))),
      ])
    )
  );
}

/* ---------- Conferência (alertas) ---------- */

async function viewAudit(main) {
  const isStaff = user.role === "staff";
  main.append(el("h2", {}, isStaff ? "Conferência de lançamentos e balancetes" : "Alertas sobre os meus documentos"));

  if (isStaff) {
    const companySelect = el("select");
    companyOptions(companySelect, false);
    const runBtn = el("button", { class: "btn primary" }, "Reconferir documentos da empresa");
    runBtn.addEventListener("click", async () => {
      runBtn.disabled = true;
      try {
        const out = await api("/api/audit/companies/" + companySelect.value, { method: "POST" });
        toast(out.documents + " documento(s) conferido(s), " + out.findings + " alerta(s).");
        render();
      } catch (e) { toast(e.message, true); } finally { runBtn.disabled = false; }
    });
    main.append(el("div", { class: "card form-row" }, [el("label", {}, ["Empresa", companySelect]), runBtn]));
  }

  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const status = params.get("estado") || "aberto";
  main.append(el("div", { class: "form-row" }, ["aberto", "resolvido", "ignorado"].map((s) =>
    el("a", { href: "#conferencia?estado=" + s, class: "btn small" + (s === status ? " primary" : "") }, s.charAt(0).toUpperCase() + s.slice(1) + "s")
  )));

  const findings = (await api("/api/findings?status=" + status)).findings;
  if (!findings.length) { main.append(el("div", { class: "card muted" }, "Sem alertas " + status + "s.")); return; }

  const tbody = el("tbody");
  for (const f of findings) {
    const actions = el("td");
    if (isStaff && f.status === "aberto") {
      const note = el("input", { placeholder: "Nota (opcional)", style: "width:150px;font-size:12px" });
      const resolve = async (st) => {
        try { await api("/api/findings/" + f.id + "/resolve", { method: "POST", json: { status: st, note: note.value || undefined } }); toast("Alerta " + st + "."); render(); }
        catch (e) { toast(e.message, true); }
      };
      actions.append(note, " ", el("button", { class: "btn small primary", onclick: () => resolve("resolvido") }, "Resolvido"), " ", el("button", { class: "btn small", onclick: () => resolve("ignorado") }, "Ignorar"));
    }
    tbody.append(el("tr", {}, [
      el("td", {}, badge(f.severity)),
      el("td", {}, [el("strong", {}, findingLabel(f.code)), el("div", { class: "muted small" }, f.code), el("div", { class: "small" }, f.message)]),
      el("td", {}, [f.scope === "documento" ? (f.original_name || "documento #" + f.document_id) : "Balancete " + (f.period || ""), el("div", { class: "muted small" }, f.company_name)]),
      actions,
    ]));
  }
  main.append(el("div", { class: "card table-wrap" }, el("table", {}, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Gravidade"), el("th", {}, "Alerta"), el("th", {}, "Origem"), el("th", {}, "")])),
    tbody,
  ])));
}

/* ---------- Balancetes e padrões ---------- */

const RULE_TYPE_LABEL = {
  saldo_sinal: "Sinal do saldo", variacao_percentual: "Variação %", variacao_absoluta: "Variação €",
  saldo_maximo: "Saldo máximo", saldo_minimo: "Saldo mínimo", racio: "Rácio",
};

async function viewBalances(main) {
  main.append(el("h2", {}, "Balancetes"));

  const companySelect = el("select");
  companyOptions(companySelect, false);
  const period = el("input", { type: "month", required: "true" });
  const file = el("input", { type: "file", accept: ".csv,text/csv" });
  const importBtn = el("button", { class: "btn primary", type: "submit" }, "Importar CSV");
  const deriveBtn = el("button", { class: "btn", type: "button" }, "Derivar dos lançamentos");
  const form = el("form", { class: "form-row" }, [
    el("label", {}, ["Empresa", companySelect]), el("label", {}, ["Período", period]), el("label", { style: "flex:2" }, ["CSV (conta;descricao;debito;credito)", file]), importBtn, deriveBtn,
  ]);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!file.files[0] || !period.value) return;
    try {
      const fd = new FormData(); fd.append("file", file.files[0]); fd.append("period", period.value);
      const out = await api("/api/balances/" + companySelect.value + "/import", { method: "POST", body: fd });
      toast("Balancete importado (" + out.lines + " contas)."); render();
    } catch (e) { toast(e.message, true); }
  });
  deriveBtn.addEventListener("click", async () => {
    if (!period.value) return toast("Indique o período.", true);
    try {
      const out = await api("/api/balances/" + companySelect.value + "/derive", { method: "POST", json: { period: period.value } });
      toast("Balancete derivado (" + out.lines + " contas)."); render();
    } catch (e) { toast(e.message, true); }
  });
  main.append(el("div", { class: "card" }, [el("h2", {}, "Novo balancete"), form]));

  for (const c of companies) {
    const list = (await api("/api/balances/" + c.id)).balances;
    if (!list.length) continue;
    const tbody = el("tbody");
    for (const b of list) {
      const checkBtn = el("button", { class: "btn small primary" }, "Conferir");
      checkBtn.addEventListener("click", async () => {
        try {
          const out = await api("/api/balances/" + c.id + "/" + b.period + "/check", { method: "POST" });
          toast(out.findings.length + " alerta(s) para " + b.period + (out.previousPeriod ? " (vs " + out.previousPeriod + ")" : " (sem período anterior)"));
          location.hash = "#conferencia";
        } catch (e) { toast(e.message, true); }
      });
      const reportBtn = el("button", { class: "btn small" }, "Gerar relatório");
      reportBtn.addEventListener("click", async () => {
        try {
          const out = await api("/api/reports/" + c.id, { method: "POST", json: { period: b.period } });
          toast("Relatório gerado: " + out.summary.slice(0, 80));
          location.hash = "#relatorios";
        } catch (e) { toast(e.message, true); }
      });
      tbody.append(el("tr", {}, [el("td", {}, b.period), el("td", {}, b.source), el("td", {}, b.created_at), el("td", {}, [checkBtn, " ", reportBtn])]));
    }
    main.append(el("div", { class: "card table-wrap" }, [el("h2", {}, c.name), el("table", {}, [
      el("thead", {}, el("tr", {}, [el("th", {}, "Período"), el("th", {}, "Origem"), el("th", {}, "Importado em"), el("th", {}, "")])), tbody,
    ])]));
  }

  const rules = (await api("/api/rules")).rules;
  const rname = el("input", { placeholder: "Nome do padrão", required: "true" });
  const rtype = el("select", {}, Object.entries(RULE_TYPE_LABEL).map(([k, v]) => el("option", { value: k }, v)));
  const rprefix = el("input", { placeholder: "Contas (ex.: 62 ou 71,72)", required: "true" });
  const rparam = el("input", { placeholder: "devedor/credor ou contas do denominador" });
  const rthr = el("input", { type: "number", step: "0.01", placeholder: "Limiar" });
  const rsev = el("select", {}, [el("option", { value: "aviso" }, "Aviso"), el("option", { value: "erro" }, "Erro"), el("option", { value: "info" }, "Info")]);
  const rcompany = el("select");
  rcompany.append(el("option", { value: "" }, "Global (todas)"));
  for (const c of companies) rcompany.append(el("option", { value: c.id }, c.name));
  const rform = el("form", { class: "form-row" }, [
    el("label", { style: "flex:2" }, ["Nome", rname]), el("label", {}, ["Tipo", rtype]), el("label", {}, ["Contas", rprefix]),
    el("label", {}, ["Parâmetro", rparam]), el("label", {}, ["Limiar", rthr]), el("label", {}, ["Gravidade", rsev]), el("label", {}, ["Âmbito", rcompany]),
    el("button", { class: "btn primary", type: "submit" }, "Criar padrão"),
  ]);
  rform.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/rules", { method: "POST", json: {
        company_id: rcompany.value ? Number(rcompany.value) : null, name: rname.value, type: rtype.value,
        account_prefixes: rprefix.value.split(",").map((x) => x.trim()).filter(Boolean),
        param: rparam.value || null, threshold: rthr.value === "" ? null : Number(rthr.value), severity: rsev.value,
      } });
      toast("Padrão criado."); render();
    } catch (e) { toast(e.message, true); }
  });
  const rbody = el("tbody");
  for (const r of rules) {
    const toggle = el("button", { class: "btn small" }, r.enabled ? "Desactivar" : "Activar");
    toggle.addEventListener("click", async () => { await api("/api/rules/" + r.id, { method: "PATCH", json: { enabled: !r.enabled } }); render(); });
    const del = el("button", { class: "btn small danger" }, "Apagar");
    del.addEventListener("click", async () => { if (confirm("Apagar o padrão \"" + r.name + "\"?")) { await api("/api/rules/" + r.id, { method: "DELETE" }); render(); } });
    rbody.append(el("tr", {}, [
      el("td", {}, [r.name, el("div", { class: "muted small" }, r.companyId ? (companies.find((c) => c.id === r.companyId) || {}).name || "" : "Global")]),
      el("td", {}, RULE_TYPE_LABEL[r.type] || r.type), el("td", {}, r.accountPrefixes.join(", ")),
      el("td", {}, [r.param || "", r.threshold !== null ? " " + r.threshold : ""]), el("td", {}, badge(r.severity)),
      el("td", {}, r.enabled ? badge("activo") : badge("inactivo")), el("td", {}, [toggle, " ", del]),
    ]));
  }
  main.append(el("div", { class: "card" }, [el("h2", {}, "Padrões de conferência"), el("p", { class: "muted small" }, "Regras que disparam alertas ao conferir um balancete: sinal dos saldos, variações anormais face ao período anterior, saldos limite e rácios."), rform]));
  main.append(el("div", { class: "card table-wrap" }, el("table", {}, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Padrão"), el("th", {}, "Tipo"), el("th", {}, "Contas"), el("th", {}, "Parâmetro / limiar"), el("th", {}, "Gravidade"), el("th", {}, "Estado"), el("th", {}, "")])), rbody,
  ])));
}

/* ---------- Relatórios financeiros ---------- */

async function viewReports(main) {
  const isStaff = user.role === "staff";
  main.append(el("h2", {}, isStaff ? "Relatórios financeiros para clientes" : "Os meus relatórios financeiros"));
  if (isStaff) main.append(el("p", { class: "muted" }, "Os relatórios são gerados a partir do balancete do período (vista Balancetes), com comparação ao sector de actividade da empresa (CAE) e memória descritiva."));

  const reports = (await api("/api/reports")).reports;
  if (!reports.length) { main.append(el("div", { class: "card muted" }, "Ainda não há relatórios.")); return; }
  for (const r of reports) {
    const openBtn = el("button", { class: "btn small primary" }, "Abrir relatório");
    openBtn.addEventListener("click", async () => {
      const res = await fetch("/api/reports/" + r.id + "/html", { headers: { Authorization: "Bearer " + token } });
      const html = await res.text();
      const w = window.open("", "_blank");
      if (w) { w.document.open(); w.document.write(html); w.document.close(); }
    });
    main.append(el("div", { class: "card" }, [
      el("div", { class: "form-row" }, [
        el("div", { style: "flex:1" }, [el("strong", {}, r.title), el("div", { class: "muted small" }, r.company_name + " · modelo: " + r.template + " · " + r.created_at)]),
        openBtn,
      ]),
      el("p", {}, r.summary),
    ]));
  }
}


/* ---------- Recepção multi-canal ---------- */

const INBOUND_STATUS_LABEL = { processado: "Processado", sem_empresa: "Remetente por associar", sem_anexos: "Sem anexos", erro: "Erro" };

async function viewInbox(main) {
  main.append(el("h2", {}, "Recepção por email e WhatsApp"));
  const st = await api("/api/channels/status");
  main.append(el("div", { class: "card" }, [
    el("h2", {}, "Canais"),
    el("div", { class: "form-row" }, [
      el("span", { class: "badge " + (st.email_webhook ? "ok" : "") }, "Email (webhook) " + (st.email_webhook ? "activo" : "inactivo")),
      el("span", { class: "badge " + (st.imap ? "ok" : "") }, "Email (IMAP) " + (st.imap ? "activo" : "inactivo")),
      el("span", { class: "badge " + (st.whatsapp ? "ok" : "") }, "WhatsApp " + (st.whatsapp ? "activo" : "inactivo") + (st.whatsapp_reply ? " · confirma ao remetente" : "")),
      el("span", { class: "badge " + (st.ai_extraction ? "ok" : "") }, "Extracção IA " + (st.ai_extraction ? "activa" : "inactiva")),
      el("span", { class: "badge info" }, "OCR: " + st.ocr.join(" › ") + " · QR AT"),
    ]),
    el("p", { class: "muted small" }, "Cada empresa tem remetentes autorizados (emails e números WhatsApp) na vista Empresas. Emails para docs+<id>@... entram directamente na empresa <id>. Remetentes desconhecidos ficam aqui à espera de associação; nunca criam empresas."),
  ]));

  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const status = params.get("estado") || "";
  main.append(el("div", { class: "form-row" }, [["", "Todas"], ["sem_empresa", "Por associar"], ["processado", "Processadas"], ["sem_anexos", "Sem anexos"], ["erro", "Erros"]].map(([k, v]) =>
    el("a", { href: "#recepcao" + (k ? "?estado=" + k : ""), class: "btn small" + (k === status ? " primary" : "") }, v)
  )));

  const msgs = (await api("/api/inbound" + (status ? "?status=" + status : ""))).messages;
  if (!msgs.length) { main.append(el("div", { class: "card muted" }, "Sem mensagens recebidas.")); return; }
  const tbody = el("tbody");
  for (const m of msgs) {
    const actions = el("td");
    if (m.status === "sem_empresa") {
      const sel = el("select"); companyOptions(sel, false);
      const btn = el("button", { class: "btn small primary" }, "Associar");
      btn.addEventListener("click", async () => {
        try { const out = await api("/api/inbound/" + m.id + "/assign", { method: "POST", json: { company_id: Number(sel.value) } }); toast(out.note); render(); }
        catch (e) { toast(e.message, true); }
      });
      actions.append(sel, " ", btn);
    }
    const docs = m.document_ids ? JSON.parse(m.document_ids) : [];
    tbody.append(el("tr", {}, [
      el("td", {}, [el("span", { class: "badge info" }, m.channel), el("div", { class: "muted small" }, m.received_at)]),
      el("td", {}, [m.sender, el("div", { class: "muted small" }, (m.subject || m.body_excerpt || ""))]),
      el("td", {}, m.company_name || el("span", { class: "muted" }, "desconhecida")),
      el("td", {}, [badge(m.status === "processado" ? "ok" : m.status === "sem_empresa" ? "aviso" : m.status === "erro" ? "erro" : "info"), " ", INBOUND_STATUS_LABEL[m.status] || m.status, m.error_detail ? el("div", { class: "error small" }, m.error_detail) : null]),
      el("td", {}, docs.length ? docs.length + " doc." : String(m.attachments) + " anexo(s)"),
      actions,
    ]));
  }
  main.append(el("div", { class: "card table-wrap" }, el("table", {}, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Canal"), el("th", {}, "Remetente"), el("th", {}, "Empresa"), el("th", {}, "Estado"), el("th", {}, "Documentos"), el("th", {}, "")])), tbody,
  ])));
}

async function manageContacts(company) {
  const contacts = (await api("/api/companies/" + company.id + "/contacts")).contacts;
  const list = contacts.map((c) => c.channel + ": " + c.address + (c.label ? " (" + c.label + ")" : "")).join("\n") || "(nenhum)";
  const input = prompt("Remetentes autorizados de " + company.name + ":\n" + list + "\n\nAdicionar novo contacto (email ou número internacional, ex.: 351912345678). Deixe vazio para não adicionar:");
  if (!input) return;
  const channel = input.includes("@") ? "email" : "whatsapp";
  try { await api("/api/companies/" + company.id + "/contacts", { method: "POST", json: { channel, address: input.trim() } }); toast("Contacto " + channel + " associado."); }
  catch (e) { toast(e.message, true); }
}


/* ---------- Hoje (fila de trabalho) ---------- */

const fmtEur = (n) => Number(n).toLocaleString("pt-PT", { style: "currency", currency: "EUR" });

async function viewToday(main) {
  const isStaff = user.role === "staff";
  const [dash, entriesRes, findingsRes, inboundRes] = await Promise.all([
    api("/api/dashboard"),
    isStaff ? api("/api/entries?status=pendente") : Promise.resolve({ entries: [] }),
    api("/api/findings?status=aberto"),
    isStaff ? api("/api/inbound?status=sem_empresa") : Promise.resolve({ messages: [] }),
  ]);
  const entries = entriesRes.entries || [];
  const findings = (findingsRes.findings || []).filter((f) => f.severity !== "info");
  const inbound = inboundRes.messages || [];
  const count = (arr, st) => (arr.find((x) => x.status === st) || {}).n || 0;
  const today = new Date().toLocaleDateString("pt-PT", { weekday: "long", day: "numeric", month: "long" });

  main.append(el("div", { class: "hero" }, [
    el("div", {}, [
      el("div", { class: "eyebrow" }, today),
      el("h1", {}, isStaff ? (entries.length + findings.length + inbound.length === 0 ? "Tudo em dia." : "O que precisa de si hoje") : "A minha empresa"),
      el("div", { class: "sub" }, isStaff
        ? entries.length + " lançamento(s) por aprovar · " + findings.length + " alerta(s) · " + inbound.length + " remetente(s) por associar"
        : "Documentos, alertas e relatórios da " + ((companies[0] || {}).name || "sua empresa")),
    ]),
    el("div", { class: "grid cols-4", style: "min-width:min(560px,100%)" }, [
      el("div", { class: "card stat accent" }, [el("div", { class: "n" }, String(count(dash.documents, "validado") + count(dash.documents, "exportado"))), el("div", { class: "l" }, "Documentos validados")]),
      el("div", { class: "card stat" }, [el("div", { class: "n" }, String(count(dash.documents, "classificado") + count(dash.documents, "proposto"))), el("div", { class: "l" }, "Em processamento")]),
      el("div", { class: "card stat warn" }, [el("div", { class: "n" }, String(findings.length)), el("div", { class: "l" }, "Alertas abertos")]),
      el("div", { class: "card stat" }, [el("div", { class: "n" }, String(dash.pendingRequests)), el("div", { class: "l" }, "Pedidos pendentes")]),
    ]),
  ]));
  if (!isStaff) {
    main.append(el("div", { class: "card", style: "display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap" }, [
      el("div", {}, [el("strong", {}, "Tem documentos para enviar?"), el("div", { class: "muted small" }, "Fotografe com o telemóvel; a app trata da imagem, junta as páginas e entrega ao gabinete.")]),
      el("a", { class: "btn gold", href: "#digitalizar" }, "Digitalizar agora"),
    ]));
    const inst = installCard(); if (inst) main.append(inst);
  }

  const left = el("div", { class: "stack" });
  const right = el("div", { class: "stack" });

  if (isStaff) {
    left.append(el("div", { class: "eyebrow" }, "Lançamentos por aprovar"));
    if (!entries.length) left.append(el("div", { class: "empty" }, [el("div", { class: "big" }, "✓"), "Nenhum lançamento à espera. Os documentos novos aparecem aqui já lidos e conferidos."]));
    for (const e of entries.slice(0, 12)) left.append(triageEntry(e));
    if (entries.length > 12) left.append(el("a", { href: "#validacao", class: "btn" }, "Ver todos os " + entries.length + " lançamentos"));
  }

  right.append(el("div", { class: "eyebrow" }, isStaff ? "Alertas de conferência" : "Alertas sobre os seus documentos"));
  if (!findings.length) right.append(el("div", { class: "empty" }, "Sem alertas abertos."));
  for (const f of findings.slice(0, 8)) {
    right.append(el("div", { class: "item alert " + f.severity }, [
      el("div", {}, [
        el("div", { class: "title" }, findingLabel(f.code)),
        el("div", { class: "meta" }, [badge(f.severity), f.original_name || ("Balancete " + (f.period || "")), "· " + f.company_name]),
        el("div", { class: "small", style: "margin-top:6px" }, f.message),
      ]),
      isStaff ? el("div", { class: "actions" }, [
        el("button", { class: "btn small", onclick: async () => { await api("/api/findings/" + f.id + "/resolve", { method: "POST", json: { status: "resolvido" } }); render(); } }, "Resolvido"),
      ]) : null,
    ]));
  }
  if (findings.length > 8) right.append(el("a", { href: "#conferencia", class: "btn" }, "Ver todos os alertas"));

  const gb = dash.gestobrig;
  if (gb && (gb.summary.overdue + gb.summary.dueSoon > 0)) {
    const todayIso = new Date().toISOString().slice(0, 10);
    right.append(el("div", { class: "eyebrow", style: "margin-top:8px" }, "Prazos declarativos"));
    right.append(el("div", { class: "small muted" }, gb.summary.overdue + " em atraso · " + gb.summary.dueSoon + " a vencer em " + gb.soonDays + " dias"));
    for (const o of gb.open.filter((x) => x.due_date).slice(0, 5)) {
      right.append(el("div", { class: "item alert " + (o.due_date < todayIso ? "erro" : "") }, [
        el("div", {}, [el("div", { class: "title" }, o.label), el("div", { class: "meta" }, [obligationBadge(o, todayIso), "prazo " + fmtDate(o.due_date), isStaff ? "· " + o.company_name : (o.period ? "· " + o.period : "")])]),
      ]));
    }
    right.append(el("a", { href: "#painel", class: "btn" }, "Ver todas as obrigações"));
  }

  if (isStaff && inbound.length) {
    right.append(el("div", { class: "eyebrow", style: "margin-top:8px" }, "Remetentes por associar"));
    for (const m of inbound.slice(0, 5)) {
      const sel = el("select"); companyOptions(sel, false);
      right.append(el("div", { class: "item" }, [
        el("div", {}, [el("div", { class: "title" }, m.sender), el("div", { class: "meta" }, [badge(m.channel), m.subject || m.body_excerpt || (m.attachments + " anexo(s)")])]),
        el("div", { class: "actions" }, [sel, el("button", { class: "btn small primary", onclick: async () => { try { await api("/api/inbound/" + m.id + "/assign", { method: "POST", json: { company_id: Number(sel.value) } }); toast("Remetente associado."); render(); } catch (e) { toast(e.message, true); } } }, "Associar")]),
      ]));
    }
  }

  if (!isStaff) {
    const docs = (await api("/api/documents")).documents.slice(0, 6);
    left.append(el("div", { class: "eyebrow" }, "Últimos documentos"));
    if (!docs.length) left.append(el("div", { class: "empty" }, "Ainda não enviou documentos. Use a vista Documentos, o email ou o WhatsApp do gabinete."));
    for (const d of docs) left.append(el("div", { class: "item" }, [
      el("div", {}, [el("div", { class: "title" }, d.original_name), el("div", { class: "meta" }, [DOC_TYPE_LABEL[d.doc_type] || d.doc_type, d.doc_date || "", badge(d.status), readingQuality(d.ocr_method, d.ocr_confidence)])]),
      el("div", { class: "actions" }, [el("button", { class: "btn small", onclick: () => openDocModal(d.id, d.original_name) }, "Ver")]),
    ]));
    left.append(el("a", { href: "#documentos", class: "btn primary" }, "Enviar documento"));
  }

  main.append(el("div", { class: "triage" }, [left, right]));

  if (isStaff && dash.knowledge && dash.knowledge.some((k) => k.stale)) {
    main.append(el("div", { class: "card", style: "border-left:4px solid var(--warn)" }, [el("strong", {}, "Conhecimento fiscal desactualizado"), el("div", { class: "small muted" }, "As regras de IVA ou os benchmarks ultrapassaram o prazo de revisão. Confirme a lei em vigor antes de confiar nos alertas.")]));
  }
}

function triageEntry(e) {
  const low = e.confidence < 0.8;
  let sources = [];
  try { sources = e.sources || []; } catch (x) { /* ignore */ }
  const decide = async (action) => {
    let reason;
    if (action === "rejeitar") { reason = prompt("Motivo da rejeição:"); if (!reason) return; }
    try { await api("/api/entries/" + e.id + "/decision", { method: "POST", json: { action, reason } }); toast(action === "aprovar" ? "Aprovado." : "Rejeitado."); render(); }
    catch (err) { toast(err.message, true); }
  };
  const lines = el("div", { class: "lines" });
  for (const l of e.lines) lines.append(el("span", { class: "acc" }, l.account), el("span", {}, l.description), el("span", { class: "num" }, l.debit ? fmtEur(l.debit) : ""), el("span", { class: "num" }, l.credit ? fmtEur(l.credit) : ""));
  return el("div", { class: "item" }, [
    el("div", {}, [
      el("div", { class: "title" }, e.description),
      el("div", { class: "meta" }, [e.company_name, "· " + e.original_name, "· " + e.entry_date, el("span", { class: "badge " + (low ? "warn" : "ok") + " conf" }, "confiança " + fmtConf(e.confidence)), readingQuality(e.ocr_method, e.ocr_confidence)]),
    ]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn small", title: "Ver o documento original", onclick: () => openDocModal(e.document_id, e.original_name) }, "Ver documento"),
      el("button", { class: "btn small primary", onclick: () => decide("aprovar") }, "Aprovar"),
      el("a", { class: "btn small", href: "#validacao?id=" + e.id }, "Rever"),
      el("button", { class: "btn small danger", onclick: () => decide("rejeitar") }, "Rejeitar"),
    ]),
    lines,
  ]);
}

/* ---------- digitalizar (telemovel) ---------- */

let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installPrompt = e; document.querySelectorAll(".install-btn").forEach((b) => { b.hidden = false; }); });
window.addEventListener("appinstalled", () => { installPrompt = null; document.querySelectorAll(".install-btn").forEach((b) => { b.hidden = true; }); });
async function promptInstall() {
  if (!installPrompt) { toast("No Android: menu do Chrome > Adicionar ao ecrã principal. No iPhone: Partilhar > Adicionar ao ecrã principal."); return; }
  installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null;
}
const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true || !!window.__contaiNative;

function installCard() {
  if (isStandalone()) return null;
  const btn = el("button", { class: "btn gold install-btn", type: "button", onclick: promptInstall }, "Instalar no telemóvel");
  if (!installPrompt) btn.hidden = false; // sem evento (iOS/desktop) mostra instrucoes ao clicar
  return el("div", { class: "card install-card" }, [
    el("div", {}, [el("strong", {}, "Cont.ai no seu telemóvel"), el("div", { class: "muted small" }, "Instale a app para fotografar facturas e recibos e enviá-los ao gabinete em segundos, mesmo a partir do menu Partilhar do Android.")]),
    btn,
  ]);
}

async function viewScan(main) {
  const isStaff = user.role === "staff";
  const pages = []; // { file, blob, rotation, mode, isPdf, name, thumb }
  main.append(el("div", { class: "hero" }, [el("div", {}, [el("h1", {}, "Digitalizar documentos"), el("div", { class: "sub" }, "Fotografe facturas, recibos e extractos. A app endireita o contraste, junta as páginas num PDF e envia para o gabinete; a leitura é feita por IA e conferida por uma pessoa.")])]));
  const camera = el("input", { type: "file", accept: "image/*", capture: "environment", multiple: "", hidden: "" });
  const gallery = el("input", { type: "file", accept: "image/*,application/pdf", multiple: "", hidden: "" });
  const cta = el("div", { class: "scan-cta" }, [
    el("button", { class: "btn gold", type: "button", onclick: () => camera.click() }, [el("span", { class: "ico" }, "📷"), "Fotografar"]),
    el("button", { class: "btn", type: "button", onclick: () => gallery.click() }, [el("span", { class: "ico" }, "🖼"), "Escolher da galeria ou PDF"]),
  ]);
  main.append(el("div", { class: "card" }, [cta, camera, gallery]));

  const list = el("div", { class: "pages" });
  const empty = el("div", { class: "empty" }, [el("div", { class: "big" }, "▣"), el("div", {}, "Ainda sem páginas. Fotografe o documento ou escolha imagens da galeria.")]);
  const pagesCard = el("div", { class: "card" }, [el("h2", {}, "Páginas"), empty, list]);
  main.append(pagesCard);

  const modeSel = el("select", {}, [el("option", { value: "cinza" }, "Melhorar (cinzentos)"), el("option", { value: "cor" }, "Cor com contraste"), el("option", { value: "pb" }, "Preto e branco"), el("option", { value: "original" }, "Original")]);
  const groupSel = el("select", {}, [el("option", { value: "um" }, "Um documento (todas as páginas num PDF)"), el("option", { value: "varios" }, "Cada página é um documento diferente")]);
  const companySelect = el("select"); if (isStaff) companyOptions(companySelect, false);
  const sendBtn = el("button", { class: "btn primary", type: "button" }, "Enviar para o gabinete");
  const actions = el("div", { class: "scan-actions sticky" }, [
    el("label", {}, [el("span", { class: "lbl" }, "Tratamento"), modeSel]), el("label", {}, [el("span", { class: "lbl" }, "Agrupar"), groupSel]),
    isStaff ? el("label", {}, [el("span", { class: "lbl" }, "Empresa"), companySelect]) : null, el("span", { class: "spacer" }), sendBtn,
  ]);
  main.append(actions);
  const inst = installCard(); if (inst) main.append(inst);
  const results = el("div", { class: "stack" }); main.append(results);

  const refresh = () => {
    list.innerHTML = ""; empty.hidden = pages.length > 0; sendBtn.disabled = pages.length === 0;
    sendBtn.textContent = pages.length ? "Enviar " + pages.length + " página(s)" : "Enviar para o gabinete";
    pages.forEach((p, i) => {
      const img = el("img", { src: p.thumb, alt: p.name, style: p.isPdf ? "object-fit:contain;padding:20px" : p.rotation ? "transform:rotate(" + p.rotation + "deg) scale(0.75);object-fit:contain;background:var(--surface)" : "" });
      const tools = el("div", { class: "tools" }, [
        el("button", { class: "btn small", type: "button", title: "Rodar", onclick: () => { p.rotation = (p.rotation + 90) % 360; refresh(); }, ...(p.isPdf ? { disabled: "" } : {}) }, "↻"),
        el("button", { class: "btn small", type: "button", title: "Mover para trás", onclick: () => { if (i > 0) { pages.splice(i - 1, 0, pages.splice(i, 1)[0]); refresh(); } } }, "←"),
        el("button", { class: "btn small", type: "button", title: "Mover para a frente", onclick: () => { if (i < pages.length - 1) { pages.splice(i + 1, 0, pages.splice(i, 1)[0]); refresh(); } } }, "→"),
        el("button", { class: "btn small danger", type: "button", title: "Remover", onclick: () => { pages.splice(i, 1); refresh(); } }, "✕"),
      ]);
      list.append(el("div", { class: "page" }, [img, tools, el("div", { class: "name" }, (i + 1) + ". " + p.name)]));
    });
  };
  const addFiles = async (files) => {
    for (const f of files) {
      const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
      pages.push({ file: f, rotation: 0, isPdf, name: f.name || "fotografia", thumb: isPdf ? "/icon.svg" : URL.createObjectURL(f) });
    }
    refresh();
  };
  camera.addEventListener("change", () => { addFiles(Array.from(camera.files)); camera.value = ""; });
  gallery.addEventListener("change", () => { addFiles(Array.from(gallery.files)); gallery.value = ""; });

  // Ficheiros recebidos pelo menu Partilhar do Android (guardados pelo service worker).
  const shared = Number((location.hash.split("?")[1] || "").replace(/^.*shared=(\d+).*$/, "$1")) || 0;
  // Ficheiros entregues pela app nativa iOS (extensao de partilha -> WKWebView injecta window.__contaiShared).
  if (Array.isArray(window.__contaiShared) && window.__contaiShared.length) {
    const items = window.__contaiShared; window.__contaiShared = null;
    for (const f of items) {
      const bin = atob(f.base64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      await addFiles([new File([arr], f.name || "partilha", { type: f.type || "application/octet-stream" })]);
    }
    history.replaceState(null, "", "#digitalizar");
    toast(items.length + " ficheiro(s) recebido(s) da partilha.");
  }
  if (shared && "caches" in window) {
    try {
      const cache = await caches.open("contai-share");
      for (let i = 0; i < shared; i++) {
        const r = await cache.match("/shared/" + i); if (!r) continue;
        const blob = await r.blob(); const name = decodeURIComponent(r.headers.get("x-filename") || "partilha-" + i);
        await addFiles([new File([blob], name, { type: blob.type })]);
      }
      await Promise.all((await cache.keys()).map((k) => cache.delete(k)));
      history.replaceState(null, "", "#digitalizar");
      if (pages.length) toast(pages.length + " ficheiro(s) recebido(s) da partilha.");
    } catch (e) { /* sem partilha */ }
  }

  const upload = async (blob, filename) => {
    const fd = new FormData(); fd.append("file", blob, filename);
    if (isStaff) fd.append("company_id", companySelect.value);
    return api("/api/documents", { method: "POST", body: fd });
  };
  const stamp = () => { const d = new Date(); const z = (n) => String(n).padStart(2, "0"); return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + "-" + z(d.getHours()) + z(d.getMinutes()); };
  sendBtn.addEventListener("click", async () => {
    if (!pages.length) return;
    sendBtn.disabled = true; const label = sendBtn.textContent; sendBtn.textContent = "A preparar...";
    try {
      const outcomes = [];
      const photos = pages.filter((p) => !p.isPdf), pdfs = pages.filter((p) => p.isPdf);
      for (const p of pdfs) outcomes.push(await upload(p.file, p.name));
      if (photos.length) {
        const prepared = [];
        for (let i = 0; i < photos.length; i++) { sendBtn.textContent = "A tratar página " + (i + 1) + " de " + photos.length; prepared.push(await ContaiScan.preparePage(photos[i].file, { mode: modeSel.value, rotation: photos[i].rotation })); }
        sendBtn.textContent = "A enviar...";
        if (groupSel.value === "um") {
          const pdf = ContaiScan.jpegsToPdf(prepared, { title: "Digitalizacao " + stamp() });
          outcomes.push(await upload(new Blob([pdf], { type: "application/pdf" }), "digitalizacao-" + stamp() + ".pdf"));
        } else {
          for (let i = 0; i < prepared.length; i++) {
            const pdf = ContaiScan.jpegsToPdf([prepared[i]], { title: "Digitalizacao " + stamp() + " " + (i + 1) });
            outcomes.push(await upload(new Blob([pdf], { type: "application/pdf" }), "digitalizacao-" + stamp() + "-" + (i + 1) + ".pdf"));
          }
        }
      }
      results.innerHTML = "";
      results.append(el("div", { class: "card" }, [el("h2", {}, "Enviado"), el("div", { class: "stack" }, outcomes.map((o) => el("div", { class: "item" }, [
        el("div", {}, [el("div", { class: "title" }, o.duplicate ? "Já existia (não duplicado)" : "Recebido e classificado como " + (DOC_TYPE_LABEL[o.docType] || o.docType)), el("div", { class: "meta" }, [readingQuality(o.ocr && o.ocr.method, o.ocr && o.ocr.confidence), (o.findings || []).length ? badge("aviso") : null, (o.findings || []).length ? (o.findings.length + " alerta(s) para o gabinete") : "sem alertas"])]),
        o.documentId ? el("div", { class: "actions" }, [el("button", { class: "btn small", onclick: () => openDocModal(o.documentId, "Documento enviado") }, "Ver")]) : null,
      ])))]));
      toast(outcomes.length + " documento(s) enviado(s) ao gabinete.");
      pages.splice(0, pages.length); refresh();
    } catch (e) {
      toast(e.message, true);
    } finally { sendBtn.disabled = pages.length === 0; sendBtn.textContent = label; }
  });
  refresh();
}

/* ---------- integracoes ---------- */

const SETTING_GROUPS = {
  ia: { title: "Inteligência artificial (Anthropic)", intro: "A chave fica cifrada na base de dados e nunca volta a ser mostrada. Sem chave, o OCR usa só o Tesseract local e o QR da AT." },
  email: { title: "Recepção por email", intro: "Recomendado: uma caixa do Microsoft 365 (ex.: documentos@lumarcont.pt) lida com a autenticação da aplicação Microsoft 365, sem guardar palavras-passe. Alternativas: webhook (o serviço de email envia cada mensagem para a app) ou IMAP para caixas fora do 365. Os remetentes autorizados definem-se em Empresas." },
  whatsapp: { title: "WhatsApp Cloud API (Meta)", intro: "Dados da app Meta e do número. Registe o webhook abaixo na Meta com o token de verificação." },
  android: { title: "Aplicação Android (Play Store)", intro: "A app Android é uma Trusted Web Activity desta web app (projecto em apps/contai-android). Depois de publicada, indique aqui o identificador e as impressões SHA-256 da chave de assinatura para a app abrir em ecrã inteiro. Sem Play Store, os clientes instalam directamente pelo Chrome (Adicionar ao ecrã principal)." },
  microsoft365: { title: "Microsoft 365 (OneDrive como arquivo)", intro: "Cada documento recebido é copiado para o OneDrive (ou SharePoint) da Lumarcont, em pastas por empresa, ano, mês e tipo, com o número do documento no nome do ficheiro. Registo de aplicação no Entra ID com permissão de aplicação Files.ReadWrite.All e consentimento do administrador; o teste abaixo confirma o acesso à drive." },
  gestobrig: { title: "GestObrig (obrigações declarativas e acessos)", intro: "O GestObrig não tem API pública. A ligação faz-se por ficheiros: exporte do GestObrig a lista de obrigações (e, se quiser, a lista de acessos às entidades) em CSV ou Excel e carregue-a aqui; as empresas são reconhecidas pelo NIF. Os prazos aparecem em Análise > Indicadores e prazos e na página Hoje, do gabinete e de cada cliente; os acessos ficam cifrados no cofre de cada empresa." },
  centralgest: { title: "CentralGest (API)", intro: "Lançamento directo dos lançamentos aprovados no CentralGest Cloud, com idempotência (idExterno contai-entry-<id>). Peça a adesão à API à CentralGest (suporte@centralgest.com); enquanto não houver credenciais pode usar o simulador local para ensaiar o fluxo. Sem API, a entrega faz-se por CSV Primavera." },
};

async function viewIntegrations(main) {
  main.append(el("h2", {}, "Integrações"));
  main.append(el("p", { class: "muted" }, "Chaves e credenciais dos serviços ligados ao Cont.ai. Só o gabinete vê esta página; os valores secretos guardam-se cifrados e mostram-se apenas os últimos 4 caracteres."));
  const data = await api("/api/settings");
  const status = await api("/api/channels/status");
  const origin = location.origin;

  const sys = await api("/api/system").catch(() => null);
  if (sys) {
    const since = new Date(sys.startedAt).toLocaleString("pt-PT");
    const dep = sys.deploy ? "commit " + sys.deploy.commit + " (" + sys.deploy.branch + ") em " + new Date(sys.deploy.updatedAt).toLocaleString("pt-PT") : "sem registo de deploy (ambiente local)";
    const sysCard = el("div", { class: "card" }, [
      el("h2", {}, "Sistema"),
      el("p", { class: "small" }, ["Versão ", el("strong", {}, sys.version), " · a correr desde " + since + " · " + dep]),
    ]);
    if (sys.autoupdate) sysCard.append(el("p", { class: "muted small" }, sys.lastCheck ? "Última verificação do ramo: " + new Date(sys.lastCheck).toLocaleString("pt-PT") : "O servidor ainda não verificou o ramo (o temporizador arranca 3 minutos após o boot)."));
    if (sys.autoupdate) sysCard.append(el("details", {}, [el("summary", { class: "small" }, "Registo da actualização automática (" + sys.autoupdateLog.length + " linhas)"), el("pre", { class: "small", style: "white-space:pre-wrap;max-height:240px;overflow:auto;margin:8px 0 0" }, sys.autoupdateLog.join("\n") || "Ainda sem actualizações. O servidor verifica o ramo de 5 em 5 minutos.")]));
    main.append(sysCard);
  }

  await domainCard(main);

  const st = el("div", { class: "card" });
  st.append(el("h2", {}, "Estado actual"));
  st.append(el("ul", { class: "small" }, [
    el("li", {}, "OCR: " + status.ocr.join(" > ") + (status.ai_extraction ? " + extracção estruturada por IA" : "")),
    el("li", {}, "Webhook de email: " + (status.email_webhook ? "activo" : "inactivo") + " · URL " + origin + "/api/inbound/email"),
    el("li", {}, "Caixa de email: " + (status.graph_mail ? "Microsoft 365 activa" : status.imap ? "IMAP activo" : "inactiva")),
    el("li", {}, "WhatsApp: " + (status.whatsapp ? "activo" : "inactivo") + " · URL do webhook " + origin + "/webhooks/whatsapp"),
    el("li", {}, "Arquivo OneDrive: " + (status.onedrive ? "activo" : "inactivo")),
  ]));
  main.append(st);

  const inputs = {};
  for (const [g, meta] of Object.entries(SETTING_GROUPS)) {
    const card = el("div", { class: "card" });
    card.append(el("h2", {}, meta.title));
    card.append(el("p", { class: "muted small" }, meta.intro));
    const col = el("div", { class: "form-col wide" });
    for (const s of data.settings.filter((x) => x.group === g)) {
      const input = el("input", { type: s.secret ? "password" : "text", autocomplete: "off", placeholder: s.placeholder || "" });
      if (!s.secret && s.value) input.value = s.value;
      if (s.secret && s.masked) input.placeholder = "definido " + s.masked + " (escreva para substituir)";
      inputs[s.key] = { input, def: s };
      const state = s.source === "definicoes" ? "guardado na app" : s.source === "ambiente" ? "vem do .env do servidor" : "por definir";
      const row = el("label", {}, [
        el("span", {}, [s.label, " ", el("span", { class: "badge " + (s.source === "nenhum" ? "muted" : "ok") }, state)]),
        input,
      ]);
      if (s.hint) row.append(el("span", { class: "muted small" }, s.hint));
      col.append(row);
    }
    card.append(col);
    if (g === "centralgest") await centralGestPanel(card, inputs);
    if (g === "gestobrig") gestObrigPanel(card);
    if (g === "microsoft365") await oneDrivePanel(card);
    if (["ia", "email", "whatsapp", "microsoft365"].includes(g)) {
      const tBtn = el("button", { class: "btn", type: "button" }, "Testar com os valores acima");
      const tOut = el("p", { class: "small muted" });
      tBtn.addEventListener("click", async () => {
        tBtn.disabled = true; tOut.textContent = "A testar..."; tOut.className = "small muted";
        try {
          const values = {};
          for (const s of data.settings.filter((x) => x.group === g)) { const val = inputs[s.key].input.value; if (val.trim()) values[s.key] = val.trim(); }
          const r = await api("/api/settings/test/" + g, { method: "POST", json: { values } });
          tOut.textContent = (r.ok ? "OK" : "Falhou") + " em " + r.ms + " ms: " + r.detail + (r.ok ? " Os valores ainda não foram guardados." : "");
          tOut.className = "small " + (r.ok ? "ok" : "error");
        } catch (e) { tOut.textContent = e.message; tOut.className = "small error"; }
        finally { tBtn.disabled = false; }
      });
      card.append(el("div", { class: "form-row", style: "margin-top:10px" }, [tBtn]), tOut);
    }
    main.append(card);
  }

  const bar = el("div", { class: "card" });
  const btn = el("button", { class: "btn primary" }, data.restart ? "Guardar e reiniciar a app" : "Guardar");
  bar.append(el("p", { class: "muted small" }, data.restart
    ? "Só os campos preenchidos são alterados. A app reinicia em poucos segundos para aplicar as novas definições; para remover um valor guardado, escreva um só espaço."
    : "Só os campos preenchidos são alterados. Em desenvolvimento, reinicie o servidor para aplicar."));
  btn.addEventListener("click", async () => {
    const values = {};
    for (const [k, { input, def }] of Object.entries(inputs)) {
      const v = input.value;
      if (v === "") continue;                       // não mexer
      if (v.trim() === "") { values[k] = null; continue; } // um espaço limpa
      if (!def.secret && v === def.value) continue;   // sem alteração
      values[k] = v;
    }
    if (!Object.keys(values).length) { toast("Nada para guardar."); return; }
    btn.disabled = true;
    try {
      const out = await api("/api/settings", { method: "PUT", json: { values } });
      toast(out.saved.length + " definição(ões) guardada(s)" + (out.cleared.length ? ", " + out.cleared.length + " removida(s)" : "") + (out.restart ? ". A reiniciar..." : "."));
      if (out.restart) {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          try { const h = await fetch("/health"); if (h.ok) break; } catch (e) { /* a reiniciar */ }
        }
      }
      render();
    } catch (e) {
      toast(e.message, true);
      btn.disabled = false;
    }
  });
  bar.append(btn);
  main.append(bar);
}

/** Dominio e TLS: instrucoes de DNS, verificacao e activacao sem SSH. */
async function domainCard(main) {
  const card = el("div", { class: "card" });
  card.append(el("h2", {}, "Domínio e TLS"));
  const body = el("div");
  card.append(body);
  main.append(card);
  const draw = async () => {
    body.innerHTML = "";
    const s = await api("/api/domain");
    const ip = s.serverIp || location.hostname;
    const state = el("p", { class: "small" });
    if (!s.domain) state.append(el("span", { class: "badge muted" }, "sem domínio"), " A app está acessível por IP em HTTP. Defina um domínio para activar o certificado TLS e as apps de loja.");
    else {
      state.append(el("strong", {}, s.domain), " · DNS: ", s.dns.length ? s.dns.join(", ") : "sem registo A", " ",
        s.dnsOk === true ? el("span", { class: "badge ok" }, "aponta para este servidor") : s.dnsOk === false ? el("span", { class: "badge warn" }, s.dns.length ? "aponta para outro IP" : "ainda sem DNS") : el("span", { class: "badge muted" }, "por confirmar"),
        " · TLS: ", s.tls === "ok" ? el("span", { class: "badge ok" }, "activo") : s.tls === "erro" ? el("span", { class: "badge warn" }, "ainda não (" + (s.tlsDetail || "erro") + ")") : el("span", { class: "badge muted" }, "por verificar"),
        s.applied === false ? el("span", { class: "badge info", style: "margin-left:6px" }, "o servidor aplica nos próximos 5 minutos") : null);
    }
    body.append(state);
    body.append(el("ol", { class: "small muted" }, [
      el("li", {}, ["No painel onde gere o DNS do domínio, crie um registo ", el("strong", {}, "A"), " com o nome do subdomínio (ex.: ", el("code", {}, "app"), ") a apontar para ", el("strong", {}, ip), ". TTL curto (300 s) acelera a activação."]),
      el("li", {}, "Escreva abaixo o domínio completo (ex.: app.lumarcont.pt) e guarde. O servidor reconfigura-se sozinho e pede o certificado Let's Encrypt quando o DNS estiver a apontar."),
      el("li", {}, "Depois, entre por https://<domínio>. O acesso por IP continua a funcionar em HTTP."),
    ]));
    const input = el("input", { type: "text", placeholder: "app.lumarcont.pt", value: s.domain || "", style: "min-width:260px" });
    const save = el("button", { class: "btn primary", type: "button" }, "Guardar domínio");
    const check = el("button", { class: "btn", type: "button" }, "Verificar DNS e TLS");
    const clear = el("button", { class: "btn ghost small", type: "button" }, "Remover domínio");
    save.addEventListener("click", async () => {
      save.disabled = true;
      try { const r = await api("/api/domain", { method: "PUT", json: { domain: input.value } }); toast(r.domain ? "Domínio guardado. O servidor aplica-o nos próximos " + r.applyWithinMinutes + " minutos." : "Domínio removido."); await draw(); }
      catch (e) { toast(e.message, true); } finally { save.disabled = false; }
    });
    check.addEventListener("click", async () => { check.disabled = true; try { await draw(); } finally { check.disabled = false; } });
    clear.addEventListener("click", async () => { try { await api("/api/domain", { method: "PUT", json: { domain: "" } }); toast("Domínio removido; volta a HTTP por IP em 5 minutos."); await draw(); } catch (e) { toast(e.message, true); } });
    if (!s.configurable) body.append(el("p", { class: "small error" }, "Este servidor não tem a pasta de configuração partilhada; defina o domínio com contai-update na consola."));
    body.append(el("div", { class: "form-row" }, [el("label", {}, ["Domínio da app", input]), save, check, s.domain ? clear : null]));
  };
  await draw();
}

/** Estado do arquivo OneDrive: contagens e sincronizacao manual. */
async function oneDrivePanel(card) {
  const s = await api("/api/onedrive/status");
  const line = el("p", { class: "small" });
  const render = (st) => {
    line.innerHTML = "";
    if (!st.configured) { line.append(el("span", { class: "badge muted" }, "não configurado"), " Preencha os campos e guarde; a sincronização arranca sozinha."); return; }
    line.append(el("span", { class: "badge ok" }, "activo"), " " + st.target + " / " + st.root + " · ", el("strong", {}, st.synced + " sincronizado(s)"), ", " + st.pending + " por enviar" + (st.failed ? ", " : ""), st.failed ? el("span", { class: "badge warn" }, st.failed + " com erro") : null);
  };
  render(s);
  card.append(el("h3", {}, "Estado do arquivo"), line);
  if (s.configured) {
    const btn = el("button", { class: "btn", type: "button" }, "Sincronizar agora");
    const retry = el("button", { class: "btn ghost small", type: "button" }, "Repetir os com erro");
    const run = async (retryFailed) => { btn.disabled = retry.disabled = true; try { const r = await api("/api/onedrive/sync", { method: "POST", json: { retry_failed: retryFailed } }); toast(r.outcomes.filter((o) => o.status === "sincronizado").length + " documento(s) enviados para o OneDrive."); render(r); } catch (e) { toast(e.message, true); } finally { btn.disabled = retry.disabled = false; } };
    btn.addEventListener("click", () => run(false)); retry.addEventListener("click", () => run(true));
    card.append(el("div", { class: "form-row" }, [btn, s.failed ? retry : null]));
  }
}

/** Estado da ligacao CentralGest, teste sem guardar e mapa de codigos de empresa. */
async function centralGestPanel(card, inputs) {
  const status = await api("/api/centralgest/status");
  const stateLine = el("p", { class: "small" });
  const renderState = (s) => {
    stateLine.innerHTML = "";
    if (!s.configured) stateLine.append(el("span", { class: "badge muted" }, "não configurado"), " Preencha o URL e a chave, ou active o simulador local, e guarde.");
    else if (s.connection === "ok") stateLine.append(el("span", { class: "badge ok" }, "ligação OK"), " Empresas acessíveis: " + (s.remoteCompanies.map((c) => c.codigo + " (" + c.nome + ")").join(", ") || "nenhuma"));
    else stateLine.append(el("span", { class: "badge warn" }, "erro"), " " + s.detail);
  };
  renderState(status);

  const testBtn = el("button", { class: "btn", type: "button" }, "Testar ligação");
  const testOut = el("p", { class: "small muted" });
  testBtn.addEventListener("click", async () => {
    testBtn.disabled = true; testOut.textContent = "A testar...";
    try {
      const body = {};
      const url = inputs.CENTRALGEST_BASE_URL.input.value.trim(); const key = inputs.CENTRALGEST_API_KEY.input.value.trim();
      if (url) body.baseUrl = url; if (key) body.apiKey = key;
      const r = await api("/api/centralgest/test", { method: "POST", json: body });
      testOut.textContent = r.ok
        ? "OK em " + r.ms + " ms (" + r.where + "): " + r.remoteCompanies.length + " empresa(s) acessível(eis). As credenciais ainda não foram guardadas."
        : "Falhou (" + r.where + "): " + r.detail;
      testOut.className = "small " + (r.ok ? "ok" : "error");
    } catch (e) {
      testOut.textContent = e.message; testOut.className = "small error";
    } finally { testBtn.disabled = false; }
  });

  const remoteCodes = new Set(status.configured && status.connection === "ok" ? status.remoteCompanies.map((c) => c.codigo) : []);
  const tbody = el("tbody");
  for (const c of companies) {
    const code = c.centralgest_code || "";
    const ok = code && remoteCodes.has(code);
    tbody.append(el("tr", {}, [
      el("td", {}, c.name), el("td", {}, c.nif),
      el("td", {}, code ? el("code", {}, code) : el("span", { class: "muted" }, "sem código")),
      el("td", {}, !code ? el("span", { class: "badge muted" }, "por mapear") : !status.configured || status.connection !== "ok" ? el("span", { class: "badge muted" }, "por verificar") : ok ? el("span", { class: "badge ok" }, "existe no CentralGest") : el("span", { class: "badge warn" }, "não encontrado")),
    ]));
  }
  const map = el("details", {}, [
    el("summary", {}, "Códigos de empresa no CentralGest (" + companies.filter((c) => c.centralgest_code).length + " de " + companies.length + " mapeadas)"),
    el("p", { class: "muted small" }, "Cada empresa cliente precisa do código com que existe no CentralGest. Edita-se em Empresas."),
    el("div", { class: "table-wrap" }, el("table", {}, [el("thead", {}, el("tr", {}, [el("th", {}, "Empresa"), el("th", {}, "NIF"), el("th", {}, "Código"), el("th", {}, "Estado")])), tbody])),
  ]);

  card.append(el("h3", {}, "Estado da ligação"), stateLine, el("div", { class: "form-row" }, [testBtn]), testOut, map,
    el("p", { class: "muted small" }, "Contrato da API assumido e documentado em docs/centralgest-api.md até à recepção da documentação oficial; os lançamentos seguem em Entrega > CentralGest."));
}

function gestObrigPanel(card) {
  const fileInput = el("input", { type: "file", accept: ".csv,.txt,.xlsx,.xls" });
  const scope = el("select"); companyOptions(scope, true); scope.firstChild.textContent = "Reconhecer empresas pelo NIF (ficheiro com várias empresas)";
  const preview = el("div", { class: "small", style: "margin-top:8px" });
  const previewBtn = el("button", { class: "btn", type: "button" }, "Pré-visualizar");
  const importBtn = el("button", { class: "btn primary", type: "button" }, "Importar obrigações");
  const send = async (dry) => {
    if (!fileInput.files[0]) { toast("Escolha o ficheiro exportado do GestObrig.", true); return; }
    const fd = new FormData(); fd.append("file", fileInput.files[0]); if (scope.value) fd.append("company_id", scope.value);
    previewBtn.disabled = importBtn.disabled = true; preview.className = "small muted"; preview.textContent = dry ? "A ler o ficheiro..." : "A importar...";
    try {
      const r = await api("/api/obligations/import" + (dry ? "?dry_run=1" : ""), { method: "POST", body: fd });
      preview.innerHTML = "";
      const mapped = Object.keys(r.mapping || {}).map((k) => ({ nif: "NIF", company: "empresa", label: "obrigação", period: "período", due: "prazo", status: "estado", submitted: "entrega", responsible: "responsável", notes: "notas", ref: "referência" }[k] || k));
      preview.append(el("div", {}, [el("strong", {}, dry ? "Pré-visualização: " : "Importação concluída: "), dry ? r.matched + " de " + r.total + " linha(s) com empresa reconhecida." : r.imported + " nova(s), " + r.updated + " actualizada(s), " + r.skippedTotal + " ignorada(s)."]));
      preview.append(el("div", { class: "muted" }, "Colunas reconhecidas: " + (mapped.join(", ") || "nenhuma") + "."));
      if (dry && r.rows) {
        const tb = el("tbody");
        for (const row of r.rows.slice(0, 15)) tb.append(el("tr", {}, [el("td", {}, row.companyName || ""), el("td", {}, row.nif || ""), el("td", {}, row.label), el("td", {}, row.period || ""), el("td", {}, row.dueDate || ""), el("td", {}, (OBLIGATION_STATUS[row.status] || [row.status])[0]), el("td", {}, row.matched ? el("span", { class: "badge ok" }, "reconhecida") : el("span", { class: "badge warn" }, "sem empresa"))]));
        preview.append(el("div", { class: "table-wrap" }, el("table", {}, [el("thead", {}, el("tr", {}, [el("th", {}, "Empresa"), el("th", {}, "NIF"), el("th", {}, "Obrigação"), el("th", {}, "Período"), el("th", {}, "Prazo"), el("th", {}, "Estado"), el("th", {}, "")])), tb])));
        if (r.rows.length > 15) preview.append(el("div", { class: "muted" }, "... e mais " + (r.rows.length - 15) + " linha(s)."));
      }
      if (!dry && r.skipped && r.skipped.length) preview.append(el("details", {}, [el("summary", {}, r.skippedTotal + " linha(s) ignorada(s)"), el("ul", {}, r.skipped.map((sk) => el("li", {}, (sk.company || sk.nif || "?") + " · " + sk.label + ": " + sk.reason)))]));
      if (!dry) toast("Obrigações importadas.");
    } catch (e) { preview.className = "small error"; preview.textContent = e.message; }
    finally { previewBtn.disabled = importBtn.disabled = false; }
  };
  previewBtn.addEventListener("click", () => send(true)); importBtn.addEventListener("click", () => send(false));

  const accFile = el("input", { type: "file", accept: ".csv,.txt,.xlsx,.xls" });
  const accBtn = el("button", { class: "btn primary", type: "button" }, "Importar acessos");
  const accOut = el("p", { class: "small muted" });
  accBtn.addEventListener("click", async () => {
    if (!accFile.files[0]) { toast("Escolha o ficheiro de acessos.", true); return; }
    const fd = new FormData(); fd.append("file", accFile.files[0]);
    accBtn.disabled = true; accOut.className = "small muted"; accOut.textContent = "A importar...";
    try {
      const r = await api("/api/credentials/import", { method: "POST", body: fd });
      accOut.className = "small ok"; accOut.textContent = r.imported + " acesso(s) novo(s), " + r.updated + " actualizado(s), " + r.skippedTotal + " ignorado(s)" + (r.skipped.length ? ": " + r.skipped.map((sk) => (sk.company || sk.nif || "?") + " (" + sk.reason + ")").join("; ") : ".");
      accFile.value = "";
    } catch (e) { accOut.className = "small error"; accOut.textContent = e.message; }
    finally { accBtn.disabled = false; }
  });

  card.append(
    el("h3", {}, "Importar obrigações"),
    el("p", { class: "muted small" }, "No GestObrig: Obrigações > Listagem > Exportar (Excel ou CSV), com as colunas empresa ou NIF, obrigação, período, prazo, estado e data de entrega. Reimportar o mesmo ficheiro actualiza os estados sem duplicar."),
    el("div", { class: "form-row" }, [el("label", { style: "flex:2" }, ["Ficheiro exportado", fileInput]), el("label", { style: "flex:2" }, ["Empresa", scope]), previewBtn, importBtn]),
    preview,
    el("h3", { style: "margin-top:16px" }, "Importar acessos às entidades"),
    el("p", { class: "muted small" }, "Ficheiro com as colunas empresa ou NIF, entidade (Finanças, Segurança Social, IAPMEI...), utilizador, palavra-passe e, opcionalmente, endereço e notas. As palavras-passe ficam cifradas; apague o ficheiro depois de importar."),
    el("div", { class: "form-row" }, [el("label", { style: "flex:2" }, ["Ficheiro de acessos", accFile]), accBtn]),
    accOut,
  );
}

/* ---------- conta ---------- */

async function viewAccount(main) {
  main.append(el("h2", {}, "A minha conta"));
  const info = el("div", { class: "card" });
  info.append(el("p", {}, [el("strong", {}, user.name), " · " + user.email + " · " + (user.role === "staff" ? "gabinete" : "cliente")]));
  main.append(info);

  const card = el("div", { class: "card" });
  card.append(el("h2", {}, "Alterar palavra-passe"));
  card.append(el("p", { class: "muted small" }, "Mínimo de 10 caracteres. Depois de alterar, volte a entrar nos outros dispositivos."));
  const cur = el("input", { type: "password", autocomplete: "current-password", required: "" });
  const nxt = el("input", { type: "password", autocomplete: "new-password", required: "", minlength: "10" });
  const rep = el("input", { type: "password", autocomplete: "new-password", required: "", minlength: "10" });
  const btn = el("button", { class: "btn primary", type: "submit" }, "Guardar");
  const form = el("form", { class: "form-col" }, [
    el("label", {}, ["Palavra-passe actual", cur]),
    el("label", {}, ["Nova palavra-passe", nxt]),
    el("label", {}, ["Repetir a nova palavra-passe", rep]),
    btn,
  ]);
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (nxt.value !== rep.value) { toast("As duas palavras-passe não coincidem.", true); return; }
    btn.disabled = true;
    try {
      await api("/api/auth/password", { method: "POST", json: { current: cur.value, next: nxt.value } });
      toast("Palavra-passe alterada.");
      cur.value = nxt.value = rep.value = "";
    } catch (e) {
      toast(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });
  card.append(form);
  main.append(card);
}

/* ---------- navegacao ---------- */

const ROUTES = {
  hoje: { label: "Hoje", ico: "☀", group: "Trabalho", view: viewToday, roles: ["staff", "client"] },
  digitalizar: { label: "Digitalizar", ico: "▣", group: "Trabalho", view: viewScan, roles: ["staff", "client"] },
  documentos: { label: "Documentos", ico: "▤", group: "Trabalho", view: viewDocuments, roles: ["staff", "client"] },
  validacao: { label: "Validação", ico: "✓", group: "Trabalho", view: viewValidation, roles: ["staff"] },
  conferencia: { label: "Conferência", ico: "⚑", group: "Trabalho", view: viewAudit, roles: ["staff", "client"] },
  recepcao: { label: "Recepção", ico: "✉", group: "Trabalho", view: viewInbox, roles: ["staff"] },
  pedidos: { label: "Pedidos", ico: "◔", group: "Trabalho", view: viewRequests, roles: ["staff", "client"] },
  balancetes: { label: "Balancetes", ico: "≡", group: "Análise", view: viewBalances, roles: ["staff"] },
  relatorios: { label: "Relatórios", ico: "◫", group: "Análise", view: viewReports, roles: ["staff", "client"] },
  painel: { label: "Indicadores e prazos", ico: "◷", group: "Análise", view: viewDashboard, roles: ["staff", "client"] },
  empresas: { label: "Empresas", ico: "⌂", group: "Configuração", view: viewCompanies, roles: ["staff"] },
  exportacao: { label: "Entrega", ico: "⇪", group: "Configuração", view: viewExport, roles: ["staff"] },
  integracoes: { label: "Integrações", ico: "⚙", group: "Configuração", view: viewIntegrations, roles: ["staff"] },
  conta: { label: "A minha conta", ico: "☺", group: "Configuração", view: viewAccount, roles: ["staff", "client"] },
};

function currentRoute() {
  const hash = (location.hash.replace("#", "").split("?")[0]) || "hoje";
  const route = ROUTES[hash];
  if (!route || !route.roles.includes(user.role)) return "hoje";
  return hash;
}

async function loadCompanies() {
  companies = (await api("/api/companies")).companies;
}

async function render() {
  const loginView = $("#login-view");
  const appView = $("#app-view");
  if (!token || !user) {
    loginView.hidden = false;
    appView.hidden = true;
    return;
  }
  loginView.hidden = true;
  appView.hidden = false;
  $("#user-label").textContent = user.name + " (" + (user.role === "staff" ? "gabinete" : "cliente") + ")";

  const nav = $("#nav");
  nav.innerHTML = "";
  const active = currentRoute();
  let lastGroup = null;
  for (const [key, r] of Object.entries(ROUTES)) {
    if (!r.roles.includes(user.role)) continue;
    if (r.group !== lastGroup) { nav.append(el("div", { class: "group" }, r.group)); lastGroup = r.group; }
    nav.append(el("a", { href: "#" + key, class: key === active ? "active" : "" }, [el("span", { class: "ico" }, r.ico), r.label]));
  }

  // Renderiza fora do DOM e só troca se esta ainda for a navegação mais recente
  // (evita misturar duas vistas quando o utilizador muda de página a meio do carregamento).
  const seq = ++renderSeq;
  const main = $("#main");
  const staging = el("div", { class: "content-inner" });
  try {
    if (!companies.length) await loadCompanies();
    await ROUTES[active].view(staging);
  } catch (e) {
    staging.append(el("div", { class: "card error" }, e.message));
  }
  if (seq !== renderSeq) return;
  main.innerHTML = "";
  main.append(...Array.from(staging.childNodes));
}
let renderSeq = 0;

$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const errEl = $("#login-error");
  errEl.hidden = true;
  try {
    const out = await api("/api/auth/login", {
      method: "POST",
      json: { email: $("#login-email").value, password: $("#login-password").value },
    });
    token = out.token;
    user = out.user;
    localStorage.setItem("cd_token", token);
    localStorage.setItem("cd_user", JSON.stringify(user));
    location.hash = "";
    render();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.hidden = false;
  }
});

$("#logout-btn").addEventListener("click", logout);
$("#install-btn-login").addEventListener("click", promptInstall);
$("#install-btn-login").classList.add("install-btn");
if (/Android|iPhone|iPad/i.test(navigator.userAgent) && !isStandalone()) $("#install-btn-login").hidden = false;
// A dica de credenciais de demonstração só aparece quando o servidor tem os dados de demonstração.
fetch("/api/public-config").then((r) => r.json()).then((c) => { if (c.demo) $("#demo-hint").hidden = false; }).catch(() => {});
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem("cd_theme"); } catch (e) { /* ignore */ }
  if (saved) document.documentElement.setAttribute("data-theme", saved);
  else if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.setAttribute("data-theme", "dark");
  $("#theme-btn").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("cd_theme", next); } catch (e) { /* ignore */ }
  });
})();
window.addEventListener("hashchange", () => { window.onkeydown = null; render(); });
render();
