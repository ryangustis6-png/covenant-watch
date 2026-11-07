# Covenant Watch

**Borrower covenant monitoring for commercial lending teams.** Redhawk Builds 2026, Challenge 5.

A credit analyst covering a loan book has to check each borrower's quarterly numbers against the covenants in the credit agreement, spot who is drifting toward a breach, and write it up for the credit officer. That is usually a spreadsheet, a PDF of the agreement and a lot of copy-paste. Covenant Watch does the math exactly, shows the cushion in dollars (not just ratios), links every test to the clause that defines it, and drafts the watchlist memo.

## What it does

- **Tests every borrower-quarter** for maximum leverage (gross debt / TTM EBITDA) and minimum DSCR (TTM available cash flow / TTM debt service).
- **Shows cushion in dollars:** how far EBITDA or cash flow can fall before a breach, plus the minimum compliant figure. This is the number a relationship manager actually negotiates around.
- **Migration grid:** Pass → Watch (cushion under 10%) → Breach across quarters, ranked by severity, with an early-warning lead time.
- **Source evidence:** each covenant definition is quoted from the agreement with exact character offsets and a SHA-256 of the source file. The excerpt is re-verified against the text, and every calculation shows its CSV source row.
- **Credit memo draft:** figures come from the engine. A model (Claude, optional) writes the prose, and **every number in the draft is checked against the computed facts**. Anything it cannot trace is highlighted. Without an API key, a deterministic template is used.

## Run it

Requires Node.js 22+.

```bash
npm run build      # precompute public/watchlist.json
npm run dev        # http://127.0.0.1:4180
npm run test:covenants
```

Optional: set `ANTHROPIC_API_KEY` (server-side only) to have Claude write the memo prose.

## How it's built

| Piece | File |
|---|---|
| Covenant engine (BigInt cents, exact cross-multiplication) | `lib/covenants.js` |
| Memo facts, template, model call, figure verification | `lib/memo.js` |
| Dashboard (static, no framework) | `public/index.html` |
| Local server routes `/api/covenants`, `/api/memo` | `server.js` |
| Vercel function | `api/memo.js` |
| Acceptance tests | `tests/covenants.test.js` |

Acceptance checks: (1) a valid input at the exact threshold passes, and one cent over breaches; (2) missing, non-USD, malformed or non-meaningful inputs go to *Needs review* and are never guessed; (3) all 36 rows reconcile with the starter pack's independent covenant function, cushions reconcile to the minimum compliant figure, exposure ties to the source CSV, and the cited excerpts match the agreement text.

## Limitations

- All borrowers and figures are synthetic (Redhawk Builds starter data). The agreement text is a two-sentence fictional policy. No cure rights, equity cures, EBITDA add-backs or step-downs are modeled.
- Q4 2026 rows fall after the dataset's 2026-09-30 as-of date and are shown as **projected**, not reported.
- The memo is a draft for analyst review, not a credit decision.

## Credits

Built on the Redhawk Builds Backend and Data Starter v1.2 (data, CSV parser, exact-money utilities, citation helpers). Built with Claude.
