// Refreshes catalogue.json from live sources. Run: npm run update
// Sources: CoinGecko USDC tickers (p1-2) + NonKYC tickers + CoinDCX USDC/INR book + FX.
// SANITY GUARDS (agent-proofing: abort instead of writing a corrupt snapshot):
//  G1 every USD-quoted major ask within 0.5% of $1.00
//  G2 any USD-quoted ask deviating >3% must already carry trap:true (never silently list a trap as sellable)
//  G3 CoinDCX INR premium over FX within 0-15%
//  G4 previous snapshot backed up before overwrite
import { writeFileSync, readFileSync, copyFileSync } from "node:fs";

const get = async (u) => (await fetch(u)).json();

const cg = await get("https://api.coingecko.com/api/v3/coins/usd-coin/tickers?include_exchange_logo=false");
const cg2 = await get("https://api.coingecko.com/api/v3/coins/usd-coin/tickers?page=2&include_exchange_logo=false");
const stables = ["USDT", "USD"];
const rows = [...cg.tickers, ...cg2.tickers].filter(t => t.base === "USDC" && stables.includes(t.target) && !t.is_stale);
const byVol = [...rows].sort((a, b) => b.converted_volume.usd - a.converted_volume.usd);
const majorsAvg = rows.reduce((t, r) => t + r.last, 0) / rows.length;

const nk = await get("https://nonkyc.io/api/v2/tickers");
const nkUsdc = nk.find(t => t.ticker_id === "USDC_USDT");

const cdc = await get("https://public.coindcx.com/market_data/orderbook?pair=I-USDC_INR");
const bids = Object.entries(cdc.bids).map(([p, q]) => [+p, +q]).sort((a, b) => b[0] - a[0]);
const asks = Object.entries(cdc.asks).map(([p, q]) => [+p, +q]).sort((a, b) => a[0] - b[0]);

const fx = await get("https://open.er-api.com/v6/latest/USD");

const cat = JSON.parse(readFileSync("./catalogue.json", "utf8"));
const set = (id, patch) => Object.assign(cat.venues.find(v => v.id === id), patch);
set("nonkyc", { ask: +nkUsdc.ask, bid: +nkUsdc.bid, volume24: +nkUsdc.usd_volume_est });
for (const r of byVol.slice(0, 12)) {
  const id = r.market.identifier.replace(/_spot$/, "");
  const v = cat.venues.find(v => v.id === id || v.name.toLowerCase() === r.market.name.toLowerCase());
  if (v) { v.ask = r.last; v.bid = r.last; v.volume24 = Math.round(r.converted_volume.usd); }
}
set("coindcx-inr", { ask: asks[0][0], bid: bids[0][0], askVsFx: asks[0][0] / fx.rates.INR, bidVsFx: bids[0][0] / fx.rates.INR });

// ---- GUARDS (abort before touching the snapshot) ----
const fail = (m) => { console.error("GUARD ABORT: " + m); process.exit(1); };
for (const v of cat.venues.filter(v => v.kyc === true && v.ask != null && v.ask < 10)) {
  if (Math.abs(v.ask - 1) > 0.005) fail(`G1 ${v.id} ask ${v.ask} >0.5% off $1`);
}
for (const v of cat.venues.filter(v => v.ask != null && v.ask < 10)) {
  if (Math.abs(v.ask - 1) > 0.03 && !v.trap) fail(`G2 ${v.id} ask ${v.ask} deviates >3% without trap:true`);
}
const prem = cat.venues.find(v => v.id === "coindcx-inr").bidVsFx - 1;
if (!(prem > 0 && prem < 0.15)) fail(`G3 coindcx premium ${(prem * 100).toFixed(2)}% outside 0-15%`);
copyFileSync("./catalogue.json", "./catalogue.backup.json");
cat.fx = { USDINR: fx.rates.INR };
cat.updated = new Date().toISOString();
writeFileSync("./catalogue.json", JSON.stringify(cat, null, 1));
console.log(`updated ${cat.updated} | majorsAvg ${majorsAvg.toFixed(5)} | nonkyc ${nkUsdc.ask}/${nkUsdc.bid} | cdc ${bids[0][0]}/${asks[0][0]} @ FX ${fx.rates.INR}`);
