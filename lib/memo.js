// Credit memo drafting. Figures come only from the covenant engine; an optional model
// writes the prose, and every number it writes is checked against the computed facts.
const usd = s => {
  const neg = String(s).startsWith('-'); const [w, f = '00'] = String(s).replace('-', '').split('.');
  return `${neg ? '-' : ''}$${w.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
};
const x = v => (v == null ? 'n/a' : `${(Math.trunc(v * 100) / 100).toFixed(2)}x`);
const pct = b => (b == null ? 'n/a' : `${(b / 100).toFixed(2)}%`);
const label = {pass: 'Pass', watch: 'Watch', breach: 'Breach', review: 'Needs review'};

export function factsFor(watchlist, borrowerId) {
  const b = watchlist.borrowers.find(r => r.borrower_id === borrowerId);
  if (!b) throw Error('Unknown borrower');
  const q = b.current;
  return {
    borrower: b.borrower_id, as_of: watchlist.as_of, current_period: b.current_period, overall_status: label[b.status],
    gross_debt: usd(q.debt_usd), ttm_ebitda: usd(q.ttm_ebitda_usd),
    ttm_available_cash_flow: usd(q.ttm_available_cashflow_usd), ttm_debt_service: usd(q.ttm_debt_service_usd),
    leverage: {value: x(q.leverage.value), limit: `${q.leverage.limit}x maximum`, status: label[q.leverage.status],
      ebitda_cushion: q.leverage.ebitda_cushion_usd ? usd(q.leverage.ebitda_cushion_usd) : 'n/a',
      ebitda_cushion_pct: pct(q.leverage.ebitda_cushion_bps),
      min_compliant_ebitda: q.leverage.min_compliant_ebitda_usd ? usd(q.leverage.min_compliant_ebitda_usd) : 'n/a',
      first_watch: b.first_watch.leverage, first_breach: b.first_breach.leverage},
    dscr: {value: x(q.dscr.value), limit: `${q.dscr.limit}x minimum`, status: label[q.dscr.status],
      cash_flow_cushion: q.dscr.cashflow_cushion_usd ? usd(q.dscr.cashflow_cushion_usd) : 'n/a',
      cash_flow_cushion_pct: pct(q.dscr.cashflow_cushion_bps),
      min_compliant_cash_flow: q.dscr.min_compliant_cashflow_usd ? usd(q.dscr.min_compliant_cashflow_usd) : 'n/a',
      first_watch: b.first_watch.dscr, first_breach: b.first_breach.dscr},
    history: b.quarters.map(h => ({period: h.period, projected: h.projected, leverage: x(h.leverage?.value),
      dscr: x(h.dscr?.value), status: label[h.status]})),
    definitions: {leverage: watchlist.evidence.leverage?.quote, dscr: watchlist.evidence.dscr?.quote},
    source: {document: watchlist.evidence.leverage?.source, sha256: watchlist.evidence.leverage?.sha256,
      csv_rows: b.quarters.map(h => h.source_row)},
  };
}

export function templateMemo(f) {
  const hist = f.history.map(h => `${h.period}${h.projected ? ' (projected)' : ''}: ${h.leverage} leverage, ${h.dscr} DSCR`).join('; ');
  const actions = f.overall_status === 'Breach'
    ? 'Notify the relationship manager and credit officer; request the compliance certificate and management explanation; assess waiver, amendment or reserve options before the next reporting date.'
    : f.overall_status === 'Watch'
      ? 'Add to the watchlist; request an interim covenant forecast and confirm cushions with management.'
      : 'No action beyond routine quarterly monitoring.';
  return [
    `${f.borrower} — covenant status ${f.overall_status} for ${f.current_period} (as of ${f.as_of}).`,
    `Leverage: ${f.leverage.value} against a ${f.leverage.limit} (${f.leverage.status}). EBITDA cushion ${f.leverage.ebitda_cushion} (${f.leverage.ebitda_cushion_pct}); minimum compliant EBITDA ${f.leverage.min_compliant_ebitda}.`,
    `DSCR: ${f.dscr.value} against a ${f.dscr.limit} (${f.dscr.status}). Cash-flow cushion ${f.dscr.cash_flow_cushion} (${f.dscr.cash_flow_cushion_pct}); minimum compliant cash flow ${f.dscr.min_compliant_cash_flow}.`,
    `Trend: ${hist}.`,
    `First watch signal: leverage ${f.leverage.first_watch || 'none'}, DSCR ${f.dscr.first_watch || 'none'}. First breach: leverage ${f.leverage.first_breach || 'none'}, DSCR ${f.dscr.first_breach || 'none'}.`,
    `Recommended next step: ${actions}`,
    'Draft for analyst review. Cure rights, add-backs and waivers in the full agreement are not modeled.',
  ].join('\n\n');
}

// Every number-like token in the draft must appear in the facts (years, quarter labels and list numbers excepted).
export function verifyFigures(text, facts) {
  const norm = t => t.replace(/[$,x%]/gi, '').replace(/^-/, '-');
  const allowed = new Set((JSON.stringify(facts).match(/-?\$?\d[\d,]*(\.\d+)?/g) || []).map(norm));
  const tokens = text.match(/-?\$?\d[\d,]*(\.\d+)?[x%]?/gi) || [];
  const unverified = [...new Set(tokens.filter(t => {
    const n = norm(t);
    if (/^\d+$/.test(n) && (Number(n) <= 12 || (Number(n) >= 2000 && Number(n) <= 2100))) return false;
    return !allowed.has(n) && !allowed.has(n.replace(/^-/, ''));
  }))];
  return {checked: tokens.length, unverified};
}

const SYSTEM = `You are a commercial banking credit analyst writing a short covenant watchlist memo for a credit officer.
Rules: use ONLY the figures in FACTS and copy them exactly as written (same rounding, $ and x formatting). Never compute,
estimate or round new numbers. Quote covenant definitions only from FACTS.definitions. If something is unknown, say so.
Format: 4 short sections with bold headers - Status, What changed, Why it matters, Recommended next steps. Under 220 words.
End with: "Draft for analyst review."`;

export async function draftMemo(facts, {key = process.env.ANTHROPIC_API_KEY, model = process.env.MEMO_MODEL || 'claude-haiku-5-5', fetcher = fetch} = {}) {
  if (!key) {
    const text = templateMemo(facts);
    return {mode: 'template', model: null, text, verification: verifyFigures(text, facts),
      note: 'No ANTHROPIC_API_KEY configured; deterministic template used.'};
  }
  const r = await fetcher('https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: {'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'},
    body: JSON.stringify({model, max_tokens: 700, system: SYSTEM,
      messages: [{role: 'user', content: `FACTS (computed in code, authoritative):\n${JSON.stringify(facts, null, 1)}`}]}),
  });
  if (!r.ok) throw Error(`Model request failed (HTTP ${r.status})`);
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
  return {mode: 'model', model, text, verification: verifyFigures(text, facts)};
}
