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

/** Inline document preview (PDF via visualizador do browser, imagem, ou texto). */
async function previewPane(docId) {
  const pane = el("div", { class: "preview" });
  try {
    const info = await api("/api/documents/" + docId + "/preview-url");
    if (info.kind === "image") {
      pane.append(el("img", { src: info.url, alt: info.name, class: "preview-img" }));
    } else {
      pane.append(el("iframe", { src: info.url, title: info.name, class: "preview-frame" }));
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
    const w = window.open("", "_blank");
    if (!w) return toast("Permita janelas pop-up para ver o texto.", true);
    const esc = (t) => String(t == null ? "" : t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    w.document.write("<title>" + esc(name) + "</title><body style='font:14px/1.4 monospace;padding:20px;white-space:pre-wrap'>" +
      "<b>Método:</b> " + esc(out.method) + (out.confidence != null ? " · confiança " + Math.round(out.confidence * 100) + "%" : "") +
      "\n\n<b>Dados extraídos:</b>\n" + esc(JSON.stringify(out.extracted, null, 2)) + "\n\n<b>Texto:</b>\n" + esc(out.text || "(documento de texto: ver ficheiro original)") + "</body>");
    w.document.close();
  } catch (e) { toast(e.message, true); }
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
        el("td", {}, DOC_TYPE_LABEL[d.doc_type] || d.doc_type),
        el("td", {}, d.doc_date || ""),
        el("td", {}, fmtConf(d.classification_confidence)),
        el("td", {}, [ocrBadge(d), " ", sourcesBadges(d)]),
        el("td", {}, badge(d.status)),
        el("td", {}, [
          el("button", { class: "btn small", onclick: async () => { const info = await api("/api/documents/" + d.id + "/preview-url"); window.open(info.url, "_blank", "noopener"); } }, "Ver"),
          el("button", { class: "btn small", onclick: () => showDocumentText(d.id, d.original_name) }, "Texto"),
          isStaff ? " " : null,
          isStaff ? el("button", { class: "btn small", onclick: async () => { try { const o = await api("/api/documents/" + d.id + "/reprocess", { method: "POST" }); toast("Reprocessado: " + (OCR_LABEL[o.ocr.method] || o.ocr.method) + ", " + o.findings.length + " alerta(s)."); render(); } catch (e) { toast(e.message, true); } } }, "Reprocessar") : null,
        ]),
      ])
    );
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
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
    const info = el("div", { class: "vinfo stack" }, [
      el("div", { class: "card flat" }, [el("h2", {}, "Dados extraídos"), facts]),
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
      el("div", {}, [el("div", { class: "title" }, d.original_name), el("div", { class: "meta" }, [DOC_TYPE_LABEL[d.doc_type] || d.doc_type, d.doc_date || "", badge(d.status)])]),
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
      el("div", { class: "meta" }, [e.company_name, "· " + e.original_name, "· " + e.entry_date, el("span", { class: "badge " + (low ? "warn" : "ok") + " conf" }, "confiança " + fmtConf(e.confidence))]),
    ]),
    el("div", { class: "actions" }, [
      el("button", { class: "btn small primary", onclick: () => decide("aprovar") }, "Aprovar"),
      el("a", { class: "btn small", href: "#validacao?id=" + e.id }, "Rever"),
      el("button", { class: "btn small danger", onclick: () => decide("rejeitar") }, "Rejeitar"),
    ]),
    lines,
  ]);
}

/* ---------- navegacao ---------- */

const ROUTES = {
  hoje: { label: "Hoje", ico: "☀", group: "Trabalho", view: viewToday, roles: ["staff", "client"] },
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
