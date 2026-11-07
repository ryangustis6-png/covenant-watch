import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {parseCSV} from '../lib/csv.js';
import {covenantCheck, minor, amount} from '../lib/finance.js';
import {evaluateRow, buildWatchlist, policyEvidence, quarterEnd} from '../lib/covenants.js';

const load = async p => fs.readFile(new URL(`../data/${p}`, import.meta.url), 'utf8');
const base = {record_id: 'T-1', borrower_id: 'BOR-T', period: '2026-Q2', currency: 'USD', debt_usd: '300.00',
  ttm_ebitda_usd: '100.00', ttm_debt_service_usd: '100.00', ttm_available_cashflow_usd: '120.00',
  max_leverage: '3.00', min_dscr: '1.20', source_document: 'documents/loan-policy.txt'};

test('acceptance 1 (valid input): exact threshold passes, one cent over breaches, cushions in cents', () => {
  const atLimit = evaluateRow(base);
  assert.equal(atLimit.leverage.status, 'watch');            // passes, zero cushion
  assert.equal(atLimit.leverage.ebitda_cushion_usd, '0.00');
  assert.equal(atLimit.dscr.status, 'watch');
  assert.equal(atLimit.dscr.cashflow_cushion_usd, '0.00');
  const over = evaluateRow({...base, debt_usd: '300.01', ttm_available_cashflow_usd: '119.99'});
  assert.equal(over.leverage.status, 'breach');
  assert.equal(over.dscr.status, 'breach');
  assert.equal(over.dscr.cashflow_cushion_usd, '-0.01');
  const comfy = evaluateRow({...base, debt_usd: '200.00', ttm_available_cashflow_usd: '200.00'});
  assert.equal(comfy.status, 'pass');
  assert.equal(comfy.leverage.debt_capacity_usd, '100.00');
});

test('acceptance 2 (missing/invalid input): flagged for review, never guessed', () => {
  const missing = evaluateRow({...base, ttm_ebitda_usd: ''});
  assert.equal(missing.status, 'review');
  assert.match(missing.issues.join(' '), /ttm_ebitda_usd is missing/);
  assert.equal(evaluateRow({...base, currency: 'EUR'}).status, 'review');
  assert.equal(evaluateRow({...base, period: 'Q2-2026'}).status, 'review');
  assert.equal(evaluateRow({...base, debt_usd: '1,000.00'}).status, 'review');
  const negative = evaluateRow({...base, ttm_ebitda_usd: '-5.00'});
  assert.equal(negative.leverage.status, 'review');
  assert.equal(negative.leverage.value, null);
  assert.equal(evaluateRow({...base, ttm_debt_service_usd: '0.00'}).dscr.status, 'review');
});

test('acceptance 3 (financial/source reconciliation): full dataset matches starter check and cited agreement', async () => {
  const rows = parseCSV(await load('loan_covenants.csv'));
  const policy = await load('documents/loan-policy.txt');
  const w = buildWatchlist(rows, policy);
  assert.equal(w.summary.rows, 36);
  assert.equal(w.summary.quarters_evaluated, 36);
  assert.equal(w.summary.projected_rows, 9);                 // Q4 2026 is after the 2026-09-30 as-of date
  const all = w.borrowers.flatMap(b => b.quarters);
  for (const r of rows) {                                      // independent engine in lib/finance.js agrees
    const ours = all.find(q => q.record_id === r.record_id), ref = covenantCheck(r);
    assert.equal(ours.leverage.status === 'breach', ref.leverageBreach, r.record_id);
    assert.equal(ours.dscr.status === 'breach', ref.dscrBreach, r.record_id);
    assert.equal(rows[ours.source_row - 2].record_id, r.record_id);
    // cushion reconciles: EBITDA - cushion = minimum compliant EBITDA
    assert.equal(amount(minor(ours.ttm_ebitda_usd) - minor(ours.leverage.ebitda_cushion_usd, {signed: true})),
      ours.leverage.min_compliant_ebitda_usd);
  }
  const exposure = rows.filter(r => r.period === '2026-Q3').reduce((s, r) => s + minor(r.debt_usd), 0n);
  assert.equal(w.summary.exposure_usd, amount(exposure));
  assert.ok(w.evidence.leverage.verified && w.evidence.dscr.verified);
  assert.equal(policy.slice(w.evidence.leverage.start, w.evidence.leverage.end), w.evidence.leverage.quote);
  assert.match(w.evidence.leverage.quote, /maximum 3\.00\.$/);
  assert.match(w.evidence.dscr.quote, /minimum 1\.20\.$/);
});

test('quarter mapping and missing definitions', () => {
  assert.equal(quarterEnd('2026-Q4'), '2026-12-31');
  assert.equal(quarterEnd('2026-Q5'), null);
  assert.equal(policyEvidence('no definitions here').leverage, null);
});
