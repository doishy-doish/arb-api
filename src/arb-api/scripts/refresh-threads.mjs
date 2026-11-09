// refresh-threads.mjs — K-free live refresh of threads.json (no keys, zero deps).
// Run: node scripts/refresh-threads.mjs   (also: npm run refresh:threads)
// Sources: NonKYC/KoinBX/Icrypex public tickers + live order books
// (IX RENDER/S/CRV, KB TRUMP) + GeckoTerminal Solana TRUMP pools.
// Fail-closed: any fetch/parse failure aborts with NO write (previous snapshot
// + .backup.json stay intact). A thread whose edge falls below +15bp ex-transfer
// is moved to excluded.decayed with its numbers, not shipped as live.
// Logs stay quiet: ids + rounded bp only (the snapshot itself is the product).
import { writeFileSync, readFileSync, copyFileSync } from "node:fs";

const fail = (m) => { console.error("REFRESH ABORT: " + m); process.exit(1); };
const get = async (u) => {
  const r = await fetch(u, { headers: { "user-agent": "arb-threads-refresh/1.0" } });
  if (!r.ok) throw new Error("upstream " + r.status + " " + u);
  return r.json();
};

const F = { ix: 0.0035, nk: 0.002, kbx: 0.0025, dexSwap: 0.003, solGas: 0.01 };
const LIVE_BP = 15;

function vwapBuyAsk(levels, usd) {
  // levels: [[price, qty], ...] ascending. Returns {base, avgAsk, complete}.
  let rem = usd, base = 0;
  for (const l of levels) {
    const p = +l[0], q = +l[1];
    if (!(p > 0 && q > 0)) continue;
    const take = Math.min(rem, p * q);
    base += take / p; rem -= take;
    if (rem <= 1e-9) break;
  }
  return { base, avgAsk: usd / Math.max(base, 1e-12), complete: rem <= 1e-9 };
}
const ixLevels = (ob) => (ob.asks || []).map((a) => [+a.p, +a.q]);
const kbxLevels = (ob) => (ob.data.asks || []).map((a) => [+a[0], +a[1]]);

const now = new Date().toISOString();
const nk = await get("https://nonkyc.io/api/v2/tickers").catch((e) => fail("nonkyc " + e.message));
const kbx = await get("https://api.koinbx.com/markets").catch((e) => fail("koinbx " + e.message));
const ix = await get("https://api.icrypex.com/v1/tickers").catch((e) => fail("icrypex " + e.message));
const nkR = (id) => nk.find((t) => t.ticker_id === id);
const kbxR = (p) => kbx.markets.find((m) => m.trading_pairs === p);
const ixR = (s) => ix.find((t) => t.symbol === s);

const threads = [], decayed = [];

// ---- 1. RENDER IX->NK ----
{
  const n = nkR("RENDER_USDT"), x = ixR("RENDERUSDT");
  if (!n || !x || !(+n.bid > 0 && +x.ask > 0)) fail("RENDER legs missing");
  const ob = await get("https://api.icrypex.com/v1/orderbook?symbol=RENDERUSDT").catch((e) => fail("RENDER book " + e.message));
  const edgeBp = (+n.bid / +x.ask) * (1 - F.ix) * (1 - F.nk);
  const bp = Math.round((edgeBp - 1) * 10000);
  const sizes = {};
  for (const s of [50, 87]) {
    const w = vwapBuyAsk(ixLevels(ob), s);
    if (!w.complete) { sizes[s] = { in: s, net: "BOOK-THIN" }; continue; }
    const end = w.base * (1 - F.ix) * +n.bid * (1 - F.nk);
    sizes[s] = { in: s, net: (end >= s ? "+" : "") + (end - s).toFixed(2) };
  }
  const row = { id: "render-ix-nk", dir: "IX->NK", buy: "Icrypex RENDER/USDT ask (book VWAP)", sell: "NonKYC RENDER/USDT bid " + n.bid, edgeBp: bp, edgeNote: "net of 0.35% Icrypex taker + 0.2% NonKYC taker, ex-transfer", minGate: "20 RENDER (~$32) Icrypex minWd - blocks $5 and $10", doors: { ixDeposit: true, ixWithdraw: true, nkDepositAssumedOpen: "UNVERIFIED - confirm before sizing" }, capUSD: 87, capNote: "5% of NonKYC book; sized nets use live book VWAP", transferFee: "UNKNOWN - verify RENDER network fee before sizing", sizes };
  (bp >= LIVE_BP ? threads : decayed).push(bp >= LIVE_BP ? row : ("RENDER IX->NK decayed to " + bp + "bp"));
}

// ---- 2. S IX->NK ----
{
  const n = nkR("S_USDT"), x = ixR("SUSDT");
  if (!n || !x || !(+n.bid > 0 && +x.ask > 0)) fail("S legs missing");
  const ob = await get("https://api.icrypex.com/v1/orderbook?symbol=SUSDT").catch((e) => fail("S book " + e.message));
  const edgeBp = (+n.bid / +x.ask) * (1 - F.ix) * (1 - F.nk);
  const bp = Math.round((edgeBp - 1) * 10000);
  const sizes = {};
  for (const s of [10, 50, 100]) {
    const w = vwapBuyAsk(ixLevels(ob), s);
    if (!w.complete) { sizes[s] = { in: s, net: "BOOK-THIN" }; continue; }
    const end = w.base * (1 - F.ix) * +n.bid * (1 - F.nk);
    sizes[s] = { in: s, net: (end >= s ? "+" : "") + (end - s).toFixed(2) };
  }
  const row = { id: "s-ix-nk", dir: "IX->NK", buy: "Icrypex S/USDT ask (book VWAP)", sell: "NonKYC S/USDT bid " + n.bid, edgeBp: bp, edgeNote: "net of takers, ex-transfer", minGate: "250 S (~$9.30) Icrypex minWd - blocks $5", doors: { ixDeposit: true, ixWithdraw: true, nkDepositAssumedOpen: "UNVERIFIED" }, capUSD: 190, capNote: "5% of NonKYC book", transferFee: "UNKNOWN - verify Sonic-chain fee before sizing", sizes };
  (bp >= LIVE_BP ? threads : decayed).push(bp >= LIVE_BP ? row : ("S IX->NK decayed to " + bp + "bp"));
}

// ---- 3. TRUMP KB->NK ----
{
  const n = nkR("TRUMP_USDT"), k = kbxR("TRUMP_USDT");
  if (!n || !k || !(+n.bid > 0 && +k.lowest_ask > 0)) fail("TRUMP KB legs missing");
  const ob = await get("https://api.koinbx.com/orderbook?market_pair=TRUMP_USDT").catch((e) => fail("TRUMP KB book " + e.message));
  const edgeBp = (+n.bid / +k.lowest_ask) * (1 - F.kbx) * (1 - F.nk);
  const bp = Math.round((edgeBp - 1) * 10000);
  const sizes = {};
  for (const s of [50, 100]) {
    const w = vwapBuyAsk(kbxLevels(ob), s);
    if (!w.complete) { sizes[s] = { in: s, net: "BOOK-THIN" }; continue; }
    const end = w.base * (1 - F.kbx) * +n.bid * (1 - F.nk);
    sizes[s] = { in: s, net: (end >= s ? "+" : "") + (end - s).toFixed(2) };
  }
  const row = { id: "trump-kb-nk", dir: "KB->NK", buy: "KoinBX TRUMP/USDT ask (book VWAP)", sell: "NonKYC TRUMP/USDT bid " + n.bid, edgeBp: bp, edgeNote: "net of 0.25% KoinBX taker + 0.2% NonKYC taker, ex-transfer", minGate: "8.87 TRUMP (~$9.90) KoinBX minWd - blocks $5", doors: { kbxDeposit: true, kbxWithdraw: true, nkDepositAssumedOpen: "UNVERIFIED - confirm before sizing" }, capUSD: 100, capNote: "VWAP holds to $100", transferFee: "UNKNOWN - TRUMP Solana transfer expected ~$0.01. Verify before sizing.", sizes };
  (bp >= LIVE_BP ? threads : decayed).push(bp >= LIVE_BP ? row : ("TRUMP KB->NK decayed to " + bp + "bp"));
}

// ---- 4. TRUMP DEX->NK ----
{
  const n = nkR("TRUMP_USDT");
  if (!n || !(+n.bid > 0)) fail("TRUMP NK leg missing");
  const pools = await get("https://api.geckoterminal.com/api/v2/networks/solana/tokens/6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN/pools?page=1").catch((e) => fail("TRUMP pools " + e.message));
  const px = +(pools.data && pools.data[0] && pools.data[0].attributes.base_token_price_usd);
  if (!(px > 0)) fail("TRUMP DEX mark missing");
  const edgeBp = ((+n.bid / px) * (1 - F.dexSwap) * (1 - F.nk) - 1);
  const bp = Math.round(edgeBp * 10000);
  const sizes = {};
  for (const s of [5, 50, 100]) {
    const tr = ((s - F.solGas) / px) * (1 - F.dexSwap) * +n.bid * (1 - F.nk);
    sizes[s] = { stayNet: (tr >= s ? "+" : "") + (tr - s).toFixed(2), withdrawNet: (tr - 1 >= s ? "+" : "") + (tr - 1 - s).toFixed(2) };
  }
  const row = { id: "trump-dex-nk", dir: "DEX->NK", buy: "Solana DEX TRUMP/USDC ~" + px + " ($5.3M pool)", sell: "NonKYC TRUMP/USDT bid " + n.bid, edgeBp: bp, edgeNote: "net of ~0.3% swap + $0.01 Solana gas x2 + 0.2% NonKYC taker; funds STAY on NonKYC (no $1 USDT withdrawal in stay-nets)", minGate: "none known - dust-friendly Solana side", doors: { nkDepositActive: true, nkDepositMin: "UNKNOWN - confirm dust acceptance before sizing" }, capUSD: 100, capNote: "pool impact <0.01% at $100", transferFee: "$0.01 Solana deposit, included in nets. $1 NonKYC USDT withdrawal shown separately.", sizes };
  (bp >= LIVE_BP ? threads : decayed).push(bp >= LIVE_BP ? row : ("TRUMP DEX->NK decayed to " + bp + "bp"));
}

// ---- 5. CRV IX->NK (graduated: book wired) ----
{
  const n = nkR("CRV_USDT"), x = ixR("CRVUSDT");
  if (!n || !x || !(+n.bid > 0 && +x.ask > 0)) fail("CRV legs missing");
  const ob = await get("https://api.icrypex.com/v1/orderbook?symbol=CRVUSDT").catch((e) => fail("CRV book " + e.message));
  const edgeBp = (+n.bid / +x.ask) * (1 - F.ix) * (1 - F.nk);
  const bp = Math.round((edgeBp - 1) * 10000);
  const sizes = {};
  for (const s of [50, 100]) {
    const w = vwapBuyAsk(ixLevels(ob), s);
    if (!w.complete) { sizes[s] = { in: s, net: "BOOK-THIN" }; continue; }
    const end = w.base * (1 - F.ix) * +n.bid * (1 - F.nk);
    sizes[s] = { in: s, net: (end >= s ? "+" : "") + (end - s).toFixed(2) };
  }
  const row = { id: "crv-ix-nk", dir: "IX->NK", buy: "Icrypex CRV/USDT ask (book VWAP)", sell: "NonKYC CRV/USDT bid " + n.bid, edgeBp: bp, edgeNote: "net of takers, ex-transfer", minGate: "195 CRV (~$51) Icrypex minWd - blocks $5-50", doors: { ixDeposit: true, ixWithdraw: true, nkDepositAssumedOpen: "UNVERIFIED" }, capUSD: 77, capNote: "5% of NonKYC book", transferFee: "UNKNOWN. Verify before sizing.", sizes };
  (bp >= LIVE_BP ? threads : decayed).push(bp >= LIVE_BP ? row : ("CRV IX->NK decayed to " + bp + "bp"));
}

// ---- fossil/toy guard: refuse to ship a snapshot that lost its books ----
if (!threads.length && !decayed.length) fail("no live or decayed threads computed");

const prev = JSON.parse(readFileSync("./threads.json", "utf8"));
copyFileSync("./threads.json", "./threads.backup.json");
const snap = {
  updated: now,
  source: "auto-refresh " + now.slice(0, 16) + "Z: NonKYC/KoinBX/Icrypex tickers + live books (IX RENDER/S/CRV, KB TRUMP) + Solana TRUMP pools; fail-closed on any fetch/parse error",
  gasAssumptions: prev.gasAssumptions,
  threads,
  killedCount: 14,
  excluded: Object.assign({}, prev.excluded, { decayed: [...(prev.excluded.decayed || []), ...decayed].slice(-20) }),
  disclaimer: prev.disclaimer,
};
writeFileSync("./threads.json", JSON.stringify(snap, null, 1));
console.log("threads refresh " + now + " | live " + threads.length + " | " + threads.map((t) => t.id + " " + t.edgeBp + "bp").join(", "));
