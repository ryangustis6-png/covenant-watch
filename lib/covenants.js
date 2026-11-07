// Covenant Watch engine: deterministic covenant tests, cushions and source evidence.
// All money is BigInt cents. Ratios are presentation values only; pass/fail and
// cushions come from exact integer cross-multiplication, never from rounded ratios.
import {minor, amount, ratio} from './finance.js';
import {sha256, verifyCitation} from './citations.js';

export const DEFAULTS = {asOf: '2026-09-30', watchBps: 1000}; // watch = cushion under 10.00%
const REQUIRED = ['record_id', 'borrower_id', 'period', 'currency', 'debt_usd', 'ttm_ebitda_usd',
  'ttm_debt_service_usd', 'ttm_available_cashflow_usd', 'max_leverage', 'min_dscr'];
const RANK = {breach: 3, review: 2, watch: 1, pass: 0};

const ceilDiv = (n, d) => (n + d - 1n) / d;            // n >= 0, d > 0
const floorDiv = (n, d) => (n >= 0n ? n / d : -ceilDiv(-n, d));
const bps = (part, whole) => (whole > 0n ? Number((part * 10000n) / whole) : null);

export function quarterEnd(period) {
  const m = /^(\d{4})-Q([1-4])$/.exec(period || '');
  if (!m) return null;
  return {1: '-03-31', 2: '-06-30', 3: '-09-30', 4: '-12-31'}[m[2]].replace(/^/, m[1]);
}

// Locate each covenant definition in the agreement text and return an exact, verifiable citation.
export function policyEvidence(text, source = 'documents/loan-policy.txt') {
  const hash = sha256(Buffer.from(text, 'utf8'));
  const find = (startsWith) => {
    const start = text.indexOf(startsWith);
    if (start < 0) return null;
    // A sentence ends at a period followed by whitespace or end of text ("3.00" is not a sentence end).
    const m = /\.(?=\s|$)/g; m.lastIndex = start;
    const end = (m.exec(text)?.index ?? text.length - 1) + 1;
    const quote = text.slice(start, end);
    return {source, sha256: hash, start, end, quote, verified: verifyCitation(text, {start, end, quote})};
  };
  return {leverage: find('Leverage is'), dscr: find('DSCR is')};
}

function money(row, field, issues, {signed = false} = {}) {
  try { return minor(row[field], {signed}); }
  catch { issues.push(`${field} is missing or not a valid USD amount ("${row[field] ?? ''}")`); return null; }
}

// Evaluate one borrower-quarter. sourceRow is the 1-based CSV line (header = line 1).
export function evaluateRow(row, {sourceRow = null, asOf = DEFAULTS.asOf, watchBps = DEFAULTS.watchBps} = {}) {
  const issues = [];
  for (const f of REQUIRED) if (row[f] === undefined || String(row[f]).trim() === '') issues.push(`${f} is missing`);
  if (row.currency && row.currency !== 'USD') issues.push(`currency ${row.currency} not supported; no conversion rule defined`);
  const periodEnd = quarterEnd(row.period);
  if (row.period && !periodEnd) issues.push(`period "${row.period}" is not YYYY-Qn`);
  const base = {record_id: row.record_id ?? null, borrower_id: row.borrower_id ?? null, period: row.period ?? null,
    period_end: periodEnd, projected: periodEnd ? periodEnd > asOf : null, source_row: sourceRow,
    source_document: row.source_document || null};
  if (issues.length) return {...base, status: 'review', issues, leverage: null, dscr: null};

  const debt = money(row, 'debt_usd', issues), ebitda = money(row, 'ttm_ebitda_usd', issues, {signed: true});
  const service = money(row, 'ttm_debt_service_usd', issues), cash = money(row, 'ttm_available_cashflow_usd', issues, {signed: true});
  const maxLev = money(row, 'max_leverage', issues), minDscr = money(row, 'min_dscr', issues);
  if (maxLev === 0n) issues.push('max_leverage must be positive');
  if (minDscr === 0n) issues.push('min_dscr must be positive');
  if (issues.length) return {...base, status: 'review', issues, leverage: null, dscr: null};

  // Leverage = gross debt / TTM EBITDA <= max. Compliant iff debt*100 <= maxLev*ebitda.
  let leverage;
  if (ebitda <= 0n) {
    leverage = {status: 'review', value: null, limit: amount(maxLev),
      reason: 'TTM EBITDA is zero or negative; leverage is not meaningful under the stated definition'};
  } else {
    const minEbitda = ceilDiv(debt * 100n, maxLev);          // lowest EBITDA (cents) that still complies
    const maxDebt = floorDiv(maxLev * ebitda, 100n);         // highest debt (cents) that still complies
    const cushion = ebitda - minEbitda;
    const breach = debt * 100n > maxLev * ebitda;
    const cushionBps = bps(cushion, ebitda);
    leverage = {status: breach ? 'breach' : cushionBps < watchBps ? 'watch' : 'pass',
      value: ratio(debt, ebitda), limit: amount(maxLev), test: 'max',
      ebitda_cushion_usd: amount(cushion), ebitda_cushion_bps: cushionBps,
      min_compliant_ebitda_usd: amount(minEbitda), debt_capacity_usd: amount(maxDebt - debt),
      formula: `${amount(debt)} / ${amount(ebitda)}`};
  }

  // DSCR = TTM available cash flow / TTM debt service >= min. Compliant iff cash*100 >= minDscr*service.
  let dscr;
  if (service <= 0n) {
    dscr = {status: 'review', value: null, limit: amount(minDscr),
      reason: 'TTM debt service is zero; DSCR is not meaningful under the stated definition'};
  } else {
    const minCash = ceilDiv(minDscr * service, 100n);
    const cushion = cash - minCash;
    const breach = cash * 100n < minDscr * service;
    const cushionBps = cash > 0n ? bps(cushion, cash) : null;
    dscr = {status: breach ? 'breach' : cushionBps === null || cushionBps < watchBps ? 'watch' : 'pass',
      value: ratio(cash, service), limit: amount(minDscr), test: 'min',
      cashflow_cushion_usd: amount(cushion), cashflow_cushion_bps: cushionBps,
      min_compliant_cashflow_usd: amount(minCash), formula: `${amount(cash)} / ${amount(service)}`};
  }

  const status = [leverage.status, dscr.status].sort((a, b) => RANK[b] - RANK[a])[0];
  return {...base, status, issues: [], debt_usd: amount(debt), ttm_ebitda_usd: amount(ebitda),
    ttm_debt_service_usd: amount(service), ttm_available_cashflow_usd: amount(cash), leverage, dscr};
}

// Portfolio view: every borrower-quarter evaluated, then a ranked borrower watchlist.
export function buildWatchlist(rows, policyText, {asOf = DEFAULTS.asOf, watchBps = DEFAULTS.watchBps} = {}) {
  const evidence = policyEvidence(policyText);
  const evaluated = rows.map((r, i) => evaluateRow(r, {sourceRow: i + 2, asOf, watchBps}));
  const byBorrower = new Map();
  for (const e of evaluated) {
    const key = e.borrower_id || '(missing borrower)';
    if (!byBorrower.has(key)) byBorrower.set(key, []);
    byBorrower.get(key).push(e);
  }
  const borrowers = [...byBorrower].map(([borrower_id, quarters]) => {
    quarters.sort((a, b) => String(a.period).localeCompare(String(b.period)));
    const reported = quarters.filter(q => q.projected === false);
    const current = reported.at(-1) || null;
    const firstBreach = name => quarters.find(q => q[name]?.status === 'breach')?.period || null;
    const firstWatch = name => quarters.find(q => ['watch', 'breach'].includes(q[name]?.status))?.period || null;
    const projected = quarters.filter(q => q.projected);
    const cushions = current ? [current.leverage?.ebitda_cushion_bps, current.dscr?.cashflow_cushion_bps].filter(v => v != null) : [];
    const breaches = current ? ['leverage', 'dscr'].filter(n => current[n]?.status === 'breach').length : 0;
    return {borrower_id, status: current?.status || 'review', current_period: current?.period || null, breaches,
      current, projected_next: projected[0] || null, quarters,
      first_watch: {leverage: firstWatch('leverage'), dscr: firstWatch('dscr')},
      first_breach: {leverage: firstBreach('leverage'), dscr: firstBreach('dscr')},
      worst_cushion_bps: cushions.length ? Math.min(...cushions) : null};
  }).sort((a, b) => RANK[b.status] - RANK[a.status] || b.breaches - a.breaches || (a.worst_cushion_bps ?? -1e9) - (b.worst_cushion_bps ?? -1e9)
    || a.borrower_id.localeCompare(b.borrower_id));

  const sumDebt = list => amount(list.reduce((s, b) => s + (b.current?.debt_usd ? minor(b.current.debt_usd) : 0n), 0n));
  const of = s => borrowers.filter(b => b.status === s);
  return {
    as_of: asOf, currency: 'USD', watch_threshold_bps: watchBps,
    summary: {borrowers: borrowers.length, quarters_evaluated: evaluated.filter(e => !e.issues.length).length,
      rows: rows.length, projected_rows: evaluated.filter(e => e.projected).length,
      breach: of('breach').length, watch: of('watch').length, pass: of('pass').length, review: of('review').length,
      exposure_usd: sumDebt(borrowers), exposure_in_breach_usd: sumDebt(of('breach'))},
    evidence, borrowers,
    assumptions: [
      `Status uses the latest reported quarter ending on or before ${asOf}; later quarters are labeled projected.`,
      `Watch = covenant passes but cushion is under ${(watchBps / 100).toFixed(2)}% of EBITDA (leverage) or available cash flow (DSCR).`,
      'Pass/fail uses exact cents with integer cross-multiplication; displayed ratios are truncated to 4 decimals.',
      'Covenant definitions come only from the cited agreement text; no cure rights, equity cures or add-backs are modeled.'],
  };
}
