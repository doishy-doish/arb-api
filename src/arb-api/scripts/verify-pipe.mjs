// verify-pipe.mjs — pre-flight pipe assertion for cross-venue threads.
// Runs K-free (same public sources as refresh-threads). NEVER moves funds,
// NEVER touches threads.json (no live-API impact). Fail-closed: any leg whose
// wallet/fee status cannot be confirmed K-free is NOT EXECUTABLE.
// Usage: node scripts/verify-pipe.mjs  (writes pipe-report.json to stdout + file)
import { writeFileSync } from "node:fs";

const fail = (m) => { console.error("PIPE ABORT: " + m); process.exit(1); };
const get = async (u) => {
  const r = await fetch(u, { headers: { "user-agent": "pipe-verify/1.0" } });
  if (!r.ok) throw new Error("upstream " + r.status + " " + u);
  return r.json();
};

// Venue-published facts (K-free, re-verify before sizing):
// - NonKYC fee page (nonkyc.io/fees): "All withdrawal fees are $1, except for
//   expensive networks such as ERC-20, BTC, and similar chains."
const NK_WD_FLAT = 1.0; // USD
const NK_WD_EXPENSIVE = ["BTC"]; // chains billed above $1 (fee UNPRICED -> kill)
// - CoinDCX crypto-DEPOSIT status: NO public endpoint (account-gated).
//   Per fail-closed rule, every NK->CDC leg is PENDING-DEPOSIT-VERIFY.
// - Typical confirmation horizons (estimates, NOT venue-published):
const TRANSIT = {
  KAS: { min: 30, note: "GhostDAG fast; CEX crediting varies, maintenance-prone" },
  XLM: { min: 5, note: "fast finality; CEX crediting usually minutes" },
  BCH: { min: 90, note: "10-15 confs typical on majors" },
  ETC: { min: 660, note: "51%-history: majors demand thousands of confs (11h+)" },
  INJ: { min: 30, note: "network depends on route (native vs ERC-20); ERC-20 = expensive-fee class" },
};
const TRANSIT_CAP_MIN = 10; // alpha lifetime: hold in transit longer -> TRANSIT_RISK

const FEE_DRAG_CAP_BP = 100; // >1% toll on capital -> FEE_TRAP

function vwapBid(bids, units) {
  const lv = Object.entries(bids).map(([p, q]) => [+p, +q]).sort((a, b) => b[0] - a[0]);
  let rem = units, v = 0;
  for (const [p, q] of lv) {
    if (!(p > 0 && q > 0)) continue;
    const t = Math.min(rem, q); v += t * p; rem -= t;
    if (rem <= 1e-9) break;
  }
  return rem > 1e-9 ? null : v / units;
}

const now = new Date().toISOString();
const nk = await get("https://nonkyc.io/api/v2/tickers").catch((e) => fail("nonkyc " + e.message));
const fxJ = await get("https://api.exchangerate-api.com/v4/latest/USD").catch((e) => fail("fx " + e.message));
const fx = fxJ.rates.INR;
const report = { at: now, fx, nkWdFlatUSD: NK_WD_FLAT, legs: [] };

for (const coin of ["KAS", "BCH", "XLM", "INJ", "ETC"]) {
  const n = nk.find((t) => t.ticker_id === coin + "_USDT");
  const leg = { coin, checks: [] };
  if (!n || !(+n.ask > 0)) { leg.verdict = "NO-QUOTE"; report.legs.push(leg); continue; }
  const ask = +n.ask;
  // 1. wallet status: NonKYC exposes NO deposit/withdraw endpoint (404 on /currencies)
  leg.checks.push({ k: "nk_withdraw_status", v: "UNVERIFIABLE (no public endpoint)", pass: null });
  leg.checks.push({ k: "cdc_deposit_status", v: "UNVERIFIABLE (account-gated, no public endpoint)", pass: null });
  // 2. flat-fee drag at $35 / $100 / $500
  for (const S of [35, 100, 500]) {
    const units = (S * 0.998) / ask;
    const feeCoin = NK_WD_FLAT / ask;
    const dragBp = Math.round((feeCoin / units) * 10000);
    leg.checks.push({ k: `fee_drag_${S}`, v: dragBp + "bp", pass: dragBp <= FEE_DRAG_CAP_BP });
    if (NK_WD_EXPENSIVE.includes(coin)) leg.checks.push({ k: `fee_unpriced_${S}`, v: "expensive-network class, fee >$1 UNKNOWN", pass: false });
  }
  // 3. transit
  const tr = TRANSIT[coin];
  leg.checks.push({ k: "transit_min", v: "~" + tr.min + "min (" + tr.note + ")", pass: tr.min <= TRANSIT_CAP_MIN });
  // 4. sell-side depth (live CDC book)
  try {
    const ob = await get(`https://public.coindcx.com/market_data/orderbook?pair=I-${coin}_INR`);
    const avg = vwapBid(ob.bids, 1000 / ask);
    leg.checks.push({ k: "cdc_book_$1k", v: avg ? "holds" : "THIN", pass: !!avg });
  } catch (e) { leg.checks.push({ k: "cdc_book_$1k", v: "FETCH-FAIL", pass: false }); }
  const hardFail = leg.checks.some((c) => c.pass === false);
  const unverified = leg.checks.some((c) => c.pass === null);
  leg.verdict = hardFail ? "NOT-EXECUTABLE" : (unverified ? "PAPER-ONLY (pipes unverified)" : "EXECUTABLE");
  report.legs.push(leg);
}
writeFileSync("pipe-report.json", JSON.stringify(report, null, 1));
console.log(JSON.stringify(report.legs.map((l) => ({ coin: l.coin, verdict: l.verdict }))));
