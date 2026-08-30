/* ContaDesk - portal do gabinete de contabilidade (frontend) */
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
    ])
  );

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
  const fileInput = el("input", { type: "file", required: "true" });
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
      toast(out.duplicate ? "Documento já existia (não duplicado)." : "Documento carregado e classificado: " + (DOC_TYPE_LABEL[out.docType] || out.docType));
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
        el("td", {}, badge(d.status)),
      ])
    );
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Documento"), el("th", {}, "Tipo"), el("th", {}, "Data"), el("th", {}, "Confiança"), el("th", {}, "Estado")])),
        docs.length ? tbody : el("tbody", {}, el("tr", {}, el("td", { colspan: "5", class: "muted" }, "Sem documentos."))),
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
  main.append(el("h2", {}, "Fila de validação"));
  main.append(el("p", { class: "muted" }, "Nenhum lançamento é exportado sem aprovação humana. Pode editar as linhas antes de aprovar."));
  const entries = (await api("/api/entries?status=pendente")).entries;
  if (!entries.length) {
    main.append(el("div", { class: "card muted" }, "Sem lançamentos pendentes."));
    return;
  }
  for (const e of entries) main.append(entryCard(e));
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
      el("button", { class: "btn primary", onclick: () => decide("aprovar") }, "Aprovar"),
      el("label", { style: "flex:2" }, ["", reason]),
      el("button", { class: "btn danger", onclick: () => decide("rejeitar") }, "Rejeitar"),
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
    const cgInput = el("input", { value: c.centralgest_code || "", placeholder: "ex.: PADARIA", style: "width:110px" });
    const cgBtn = el("button", { class: "btn small" }, "Guardar");
    cgBtn.addEventListener("click", async () => {
      try {
        await api("/api/companies/" + c.id, { method: "PATCH", json: { centralgest_code: cgInput.value.trim() || null } });
        toast("Código CentralGest guardado.");
        await loadCompanies();
      } catch (e) {
        toast(e.message, true);
      }
    });
    tbody.append(el("tr", {}, [
      el("td", {}, c.name),
      el("td", {}, c.nif),
      el("td", {}, c.vat_regime),
      el("td", {}, [cgInput, " ", cgBtn]),
      el("td", {}, userBtn),
    ]));
  }
  main.append(
    el("div", { class: "card table-wrap" },
      el("table", {}, [
        el("thead", {}, el("tr", {}, [el("th", {}, "Nome"), el("th", {}, "NIF"), el("th", {}, "Regime IVA"), el("th", {}, "Código CentralGest"), el("th", {}, "")])),
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

/* ---------- navegacao ---------- */

const ROUTES = {
  painel: { label: "Painel", view: viewDashboard, roles: ["staff", "client"] },
  documentos: { label: "Documentos", view: viewDocuments, roles: ["staff", "client"] },
  validacao: { label: "Validação", view: viewValidation, roles: ["staff"] },
  pedidos: { label: "Pedidos", view: viewRequests, roles: ["staff", "client"] },
  empresas: { label: "Empresas", view: viewCompanies, roles: ["staff"] },
  exportacao: { label: "Exportação", view: viewExport, roles: ["staff"] },
};

function currentRoute() {
  const hash = location.hash.replace("#", "") || "painel";
  const route = ROUTES[hash];
  if (!route || !route.roles.includes(user.role)) return "painel";
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
  for (const [key, r] of Object.entries(ROUTES)) {
    if (!r.roles.includes(user.role)) continue;
    nav.append(el("a", { href: "#" + key, class: key === active ? "active" : "" }, r.label));
  }

  const main = $("#main");
  main.innerHTML = "";
  try {
    if (!companies.length) await loadCompanies();
    await ROUTES[active].view(main);
  } catch (e) {
    main.append(el("div", { class: "card error" }, e.message));
  }
}

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
window.addEventListener("hashchange", render);
render();
