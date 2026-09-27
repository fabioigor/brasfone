/** Shared helpers for the ROI calculator pages: formatting, steps, persistence, chart, table and lead form. */
(function () {
  const fmtEUR = (v, d = 0) => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR', maximumFractionDigits: d, minimumFractionDigits: d }).format(Number.isFinite(v) ? v : 0);
  const fmtN = (v, d = 0) => new Intl.NumberFormat('pt-PT', { maximumFractionDigits: d, minimumFractionDigits: d }).format(Number.isFinite(v) ? v : 0);
  const fmtPct = (v, d = 0) => fmtN((Number.isFinite(v) ? v : 0) * 100, d) + '%';
  const $ = (id) => document.getElementById(id);
  const num = (id) => { const el = $(id); const v = parseFloat(el && el.value); return Number.isFinite(v) ? v : 0; };
  const pct = (id) => num(id) / 100;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function steps({ storageKey, onEnter }) {
    const btns = Array.from(document.querySelectorAll('.steps button'));
    const panels = Array.from(document.querySelectorAll('section.panel'));
    function go(n) {
      btns.forEach((b, i) => { b.classList.toggle('active', i === n); b.classList.toggle('done', i < n); });
      panels.forEach((p, i) => p.classList.toggle('active', i === n));
      if (onEnter) onEnter(n);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      try { localStorage.setItem(storageKey + '.step', String(n)); } catch (e) { /* storage unavailable */ }
    }
    btns.forEach((b) => b.addEventListener('click', () => go(parseInt(b.dataset.step, 10))));
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(parseInt(b.dataset.go, 10))));
    return go;
  }

  function restoreStep(storageKey, go) {
    try { const s = parseInt(localStorage.getItem(storageKey + '.step') || '0', 10); if (s > 0) go(s); } catch (e) { /* ignore */ }
  }

  function persist(storageKey, ids, onInput) {
    try {
      ids.forEach((id) => { const v = localStorage.getItem(storageKey + '.' + id); if (v !== null && v !== '' && $(id)) $(id).value = v; });
    } catch (e) { /* ignore */ }
    ids.forEach((id) => {
      if (!$(id)) return;
      $(id).addEventListener('input', () => {
        try { localStorage.setItem(storageKey + '.' + id, $(id).value); } catch (e) { /* ignore */ }
        if (onInput) onInput(id);
      });
    });
  }

  /** Grouped bar chart: groups = [{ lbl, a, b, f }], two series (today / with Pipedrive + CAPI). */
  function barChart(el, groups, ariaLabel) {
    const W = 900, H = 230, padL = 20, padR = 20, top = 30, base = 190;
    const gw = (W - padL - padR) / groups.length, bw = Math.min(64, gw * 0.32), gap = 2;
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(ariaLabel)}">`;
    s += `<line x1="${padL}" x2="${W - padR}" y1="${base}" y2="${base}" stroke="#223A62" stroke-width="1"/>`;
    groups.forEach((g, gi) => {
      const max = Math.max(g.a, g.b, 0.0001);
      const cx = padL + gw * gi + gw / 2;
      [[g.a, '#6B8AF0', cx - bw - gap / 2], [g.b, '#22A657', cx + gap / 2]].forEach(([v, c, x]) => {
        const h = Math.max(4, (v / max) * (base - top - 24));
        s += `<rect x="${x}" y="${base - h}" width="${bw}" height="${h}" rx="4" fill="${c}"/>`;
        s += `<rect x="${x}" y="${base - 4}" width="${bw}" height="4" fill="${c}"/>`;
        s += `<text x="${x + bw / 2}" y="${base - h - 8}" text-anchor="middle" font-size="14" font-family="Ubuntu Mono, monospace" fill="#F5F6FA">${esc(g.f(v))}</text>`;
      });
      s += `<text x="${cx}" y="${base + 22}" text-anchor="middle" font-size="13" font-family="Ubuntu, sans-serif" fill="#B8C4DA">${esc(g.lbl)}</text>`;
    });
    s += '</svg>';
    el.innerHTML = s;
  }

  /** rows: [sectionLabel] or [label, before, after, delta]. Same structure is sent to the server for the email. */
  function tableHtml(rows, headers) {
    const h = headers || ['Indicador', 'Hoje', 'Com Pipedrive + CAPI', 'Variação'];
    let s = `<thead><tr>${h.map((x) => `<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>`;
    rows.forEach((r) => {
      if (r.length === 1) s += `<tr class="section"><td colspan="4">${esc(r[0])}</td></tr>`;
      else s += `<tr><td>${esc(r[0])}</td><td class="mono">${esc(r[1])}</td><td class="mono after">${esc(r[2])}</td><td class="mono">${esc(r[3] || '')}</td></tr>`;
    });
    return s + '</tbody>';
  }

  /**
   * Lead form wiring. collect() returns { name, dealValue, report: { title, subtitle, kpis: [{label, value, note}], rows, assumptions } }.
   */
  function wireForm({ kind, collect, source }) {
    const form = $('leadForm'), msg = $('formMsg'), btn = $('submitBtn');
    const API_URL = (window.ROI_CONFIG && window.ROI_CONFIG.apiUrl) || '/api/roi-leads';
    const label = btn.textContent;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.innerHTML = '';
      if (!form.checkValidity()) {
        msg.innerHTML = '<div class="alert warn">Preencha o nome, o contacto, o telefone, o email e a autorização de contacto.</div>';
        return;
      }
      const data = collect();
      const payload = {
        kind, name: data.name, contact: $('contact').value.trim(), phone: $('phone').value.trim(), email: $('email').value.trim(),
        source: source || 'Social Media Hackathon 2026', dealValue: data.dealValue, report: data.report, submittedAt: new Date().toISOString(),
      };
      btn.disabled = true; btn.textContent = 'A enviar…';
      try {
        const res = await fetch(API_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) throw new Error(out.error || ('HTTP ' + res.status));
        if (out.dryRun) {
          msg.innerHTML = `<div class="alert warn">Modo de demonstração: o servidor ainda não tem credenciais do Pipedrive e do email configuradas, por isso nada foi criado nem enviado. Os dados de <b>${esc(payload.name)}</b> devem ser registados manualmente.</div>`;
        } else {
          msg.innerHTML = `<div class="alert ok">Relatório ${out.emailSent ? 'enviado para' : 'preparado para'} <b>${esc(payload.email)}</b>. Contacto e negócio criados no Pipedrive${out.dealUrl ? ` (<a href="${esc(out.dealUrl)}" target="_blank" rel="noopener">abrir negócio</a>)` : ''}. Obrigado, ${esc(payload.contact.split(' ')[0])}.</div>`;
        }
        form.reset();
      } catch (err) {
        msg.innerHTML = `<div class="alert err">Não foi possível enviar agora (${esc(err.message)}). Verifique a ligação do servidor da calculadora ou anote os dados manualmente no Pipedrive.</div>`;
      } finally { btn.disabled = false; btn.textContent = label; }
    });
  }

  window.ROI = { fmtEUR, fmtN, fmtPct, $, num, pct, esc, steps, restoreStep, persist, barChart, tableHtml, wireForm };
})();
