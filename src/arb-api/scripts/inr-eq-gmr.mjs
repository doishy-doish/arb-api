// inr-eq-gmr.mjs — zero-K India equities verification (runs on GitHub Actions, NOT in workspace).
// Leg A: intraday Gap Mean-Reversion backtest on 15 liquid sub-₹500 NSE stocks.
// Leg B: sub-₹100 delivery backtest (IDEA/YESBANK/SUZLON) with Sharekhan ₹0 DP.
// Data: Yahoo Finance (no key). Fail-closed: coverage gate aborts with NO write.
// Writes: inr-eq/results.json (relative to src/arb-api CWD).
// Spec: user 2026-11-10 (MIS 5x, +1.0%/-0.8%/11:30 exit, kill bar N>=120/win>50%/exp>=+0.25%).
import { writeFileSync, mkdirSync } from "node:fs";

const fail = (m) => { console.error("EQ ABORT: " + m); process.exit(1); };
const UA = { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) inr-eq-gmr/1.0" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Yahoo crumb flow (query1 401s without cookie+crumb since 2024 tightening).
// Best-effort: datacenter egress sometimes blocks fc.yahoo.com; fall back to
// cookieless requests (enforcement is inconsistent) rather than dying instantly.
let YCK = "", CRUMB = "", YMODE = "none";
async function yahooInit() {
  try {
    const r = await fetch("https://fc.yahoo.com", { headers: UA });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")];
    YCK = sc.filter(Boolean).map((c) => c.split(";")[0]).join("; ");
    const c = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, Cookie: YCK } });
    if (!c.ok) throw new Error("crumb HTTP " + c.status);
    CRUMB = (await c.text()).trim();
    if (!CRUMB || /html/i.test(CRUMB)) throw new Error("crumb body invalid");
    YMODE = "crumb";
  } catch (e) { console.log("crumb flow failed (" + String(e).slice(0, 120) + ") — continuing cookieless"); }
}
async function get(url, tries = 4) {
  for (let a = 0; a < tries; a++) {
    try {
      const sep = url.includes("?") ? "&" : "?";
      const full = CRUMB ? url + sep + "crumb=" + CRUMB : url;
      const hdr = CRUMB ? { ...UA, Cookie: YCK } : UA;
      const r = await fetch(full, { headers: hdr });
      if (r.ok) return await r.json();
      if (r.status === 401 && CRUMB && a < tries - 1) { await yahooInit(); continue; } // crumb expired
      if (r.status === 429) await sleep(4000);
      else await sleep(1200);
    } catch (e) { await sleep(1500); }
  }
  throw new Error("fetch failed (" + YMODE + ") " + url);
}
const IST = 19800;
const dayKey = (t) => new Date((t + IST) * 1000).toISOString().slice(0, 10);
const todMin = (t) => { const d = new Date((t + IST) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

// ---------- universe ----------
const STOCKS = ["TATASTEEL.NS","COALINDIA.NS","BEL.NS","ONGC.NS","PNB.NS","IOC.NS","ZOMATO.NS",
  "NTPC.NS","POWERGRID.NS","NHPC.NS","BANKBARODA.NS","GAIL.NS","VEDL.NS","NMDC.NS","TATAPOWER.NS"];
const NIFTY = "%5ENSEI";
const LEGB = ["IDEA.NS","YESBANK.NS","SUZLON.NS"];

// ---------- download 1m bars, 7-day chunks, 370d back ----------
async function fetch1m(sym) {
  const now = Math.floor(Date.now() / 1000), DAY = 86400;
  const chunks = [];
  for (let s = now - 370 * DAY; s < now; s += 7 * DAY) chunks.push([s, Math.min(s + 7 * DAY - 3600, now)]);
  const all = [];
  for (let i = 0; i < chunks.length; i += 6) {
    const batch = chunks.slice(i, i + 6).map(async ([p1, p2]) => {
      const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1m&includePrePost=false`);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r) return;
      const q = r.indicators.quote[0], ts = r.timestamp || [];
      for (let k = 0; k < ts.length; k++) {
        if (q.close[k] == null) continue;
        all.push({ t: ts[k], o: q.open[k], h: q.high[k], l: q.low[k], c: q.close[k], v: q.quote ? 0 : (q.volume[k] || 0) });
      }
    });
    await Promise.all(batch);
    console.log(`  ${sym} chunk ${Math.min(i + 6, chunks.length)}/${chunks.length}`);
  }
  all.sort((a, b) => a.t - b.t);
  const seen = new Set(), ded = [];
  for (const b of all) if (!seen.has(b.t)) { seen.add(b.t); ded.push(b); }
  return ded;
}
async function fetchDaily(sym, range) {
  const j = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=1d`);
  const r = j.chart.result[0];
  const q = r.indicators.quote[0], ts = r.timestamp, adj = (r.indicators.adjclose || [])[0];
  return ts.map((t, i) => ({ t, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i],
    a: adj ? adj.adjclose[i] : q.close[i], v: q.volume[i] || 0 })).filter(b => b.c != null);
}

// ================= LEG A =================
console.log("LEG A: yahoo crumb...");
await yahooInit();
console.log("LEG A: downloading 1m bars...");
const bars1m = {};
for (const s of [...STOCKS, NIFTY]) { bars1m[s] = await fetch1m(s); console.log(`${s}: ${bars1m[s].length} bars`); }
console.log("LEG A: downloading daily bars...");
const daily = {};
for (const s of [...STOCKS, "^NSEI"]) daily[s] = await fetchDaily(s, "2y");

// sessions: group 1m bars by IST day, keep 09:15-15:30
function sessionsOf(bars) {
  const m = new Map();
  for (const b of bars) {
    const mnt = todMin(b.t);
    if (mnt < 555 || mnt >= 930) continue; // 09:15=555 .. 15:30=930
    const k = dayKey(b.t);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(b);
  }
  return [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
    .filter(([k, v]) => v.length >= 200).map(([k, v]) => ({ day: k, bars: v }));
}
const sess = {};
for (const s of [...STOCKS, NIFTY]) sess[s] = sessionsOf(bars1m[s]);
// coverage gate
const nDays = sess[NIFTY].length;
if (nDays < 200) fail(`nifty sessions ${nDays} < 200`);
for (const s of STOCKS) if (sess[s].length < 150) fail(`${s} sessions ${sess[s].length} < 150`);
// daily lookup by IST day
function dailyByDay(rows) { const m = new Map(); for (const r of rows) m.set(dayKey(r.t), r); return m; }
const dBy = {}; for (const s of [...STOCKS, "^NSEI"]) dBy[s] = dailyByDay(daily[s]);
// ATR14 (Wilder) + 60d returns for beta, per symbol, keyed by day
function trailingStats(rows) {
  const out = new Map(); let atr = null; const rets = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (i > 0) {
      const p = rows[i - 1];
      const tr = Math.max(r.h - r.l, Math.abs(r.h - p.c), Math.abs(r.l - p.c));
      atr = atr == null ? tr : (atr * 13 + tr) / 14;
      if (p.c > 0 && r.c > 0) rets.push(r.c / p.c - 1);
    }
    out.set(dayKey(r.t), { atr, rets: rets.slice(-61) });
  }
  return out;
}
const stats = {}; for (const s of [...STOCKS, "^NSEI"]) stats[s] = trailingStats(daily[s]);
function betaOf(sRet, nRet) {
  const n = Math.min(sRet.length, nRet.length);
  if (n < 50) return null;
  const s = sRet.slice(-n), m = nRet.slice(-n);
  const ms = s.reduce((a, b) => a + b) / n, mm = m.reduce((a, b) => a + b) / n;
  let cov = 0, vm = 0;
  for (let i = 0; i < n; i++) { cov += (s[i] - ms) * (m[i] - mm); vm += (m[i] - mm) * (m[i] - mm); }
  return vm > 0 ? cov / vm : null;
}
// per-day candidate evaluation
const niftyDays = new Map(sess[NIFTY].map(d => [d.day, d]));
const sigHist = []; // trailing ΔG for sigma
const trades = [];
let warm = 0;
const allDays = [...niftyDays.keys()].sort();
for (const day of allDays) {
  const nd = niftyDays.get(day);
  const nStat = stats["^NSEI"].get(day);
  if (!nStat || !(nStat.atr > 0) || nStat.rets.length < 50) continue;
  const nOpen = nd.bars[0].o, nPrev = (() => {
    const i = allDays.indexOf(day); if (i <= 0) return null;
    const pd = niftyDays.get(allDays[i - 1]); return pd ? pd.bars[pd.bars.length - 1].c : null;
  })();
  if (!(nOpen > 0 && nPrev > 0)) continue;
  const gN = (nOpen - nPrev) / nStat.atr;
  const cands = [];
  for (const s of STOCKS) {
    const sd = sess[s].find(d => d.day === day);
    const st = stats[s].get(day);
    if (!sd || !st || !(st.atr > 0) || st.rets.length < 50) continue;
    const prev = sess[s][sess[s].findIndex(d => d.day === day) - 1];
    if (!prev) continue;
    const open = sd.bars[0].o, pc = prev.bars[prev.bars.length - 1].c;
    if (!(open > 0 && pc > 0)) continue;
    const beta = betaOf(st.rets, nStat.rets);
    if (beta == null) continue;
    const g = (open - pc) / st.atr, dg = g - beta * gN;
    // RVOL: first 15 bars vol vs mean of same window prior 20 sessions
    const si = sess[s].findIndex(d => d.day === day);
    const vols = [];
    for (let k = Math.max(0, si - 20); k < si; k++) {
      const dd = sess[s][k]; if (!dd) continue;
      vols.push(dd.bars.slice(0, 15).reduce((a, b) => a + (b.v || 0), 0));
    }
    if (vols.length < 15) continue;
    const meanV = vols.reduce((a, b) => a + b) / vols.length;
    const rvol = meanV > 0 ? sd.bars.slice(0, 15).reduce((a, b) => a + (b.v || 0), 0) / meanV : 0;
    cands.push({ s, dg, rvol, sd, open });
  }
  // trailing sigma of ΔG pooled
  const pool = sigHist.slice(-60 * 10);
  let trig = null;
  if (pool.length >= 300) {
    const mu = pool.reduce((a, b) => a + b) / pool.length;
    const sd = Math.sqrt(pool.reduce((a, b) => a + (b - mu) * (b - mu)) / pool.length);
    const q = cands.filter(c => sd > 0 && c.dg <= -1.75 * sd && c.rvol >= 1.5)
      .sort((a, b) => a.dg - b.dg)[0];
    if (q) trig = { ...q, sigma: sd, mu };
  }
  for (const c of cands) sigHist.push(c.dg);
  if (warm < 80) { warm++; continue; }
  if (!trig) continue;
  // execute: fill at 09:15 bar close, Q=floor(500/fill)
  const fill = trig.sd.bars[0].c;
  const Q = Math.floor(500 / fill);
  if (Q < 1 || !(fill > 0)) continue;
  const tgt = fill * 1.01, stp = fill * 0.992;
  let exit = null, how = "time";
  for (let bi = 1; bi < trig.sd.bars.length; bi++) {
    const b = trig.sd.bars[bi];
    if (todMin(b.t) >= 690) break; // 11:30
    const hitT = b.h >= tgt, hitS = b.l <= stp;
    if (hitT && hitS) { exit = stp; how = "stop"; break; } // conservative
    if (hitS) { exit = stp; how = "stop"; break; }
    if (hitT) { exit = tgt; how = "target"; break; }
  }
  if (exit == null) {
    const last = [...trig.sd.bars].reverse().find(b => todMin(b.t) < 690);
    exit = last ? last.c : trig.sd.bars[trig.sd.bars.length - 1].c; how = "time";
  }
  const gross = Q * (exit - fill), net = gross - 0.18;
  trades.push({ day, stock: trig.s.replace(".NS",""), fill: +fill.toFixed(2), Q, exit: +exit.toFixed(2), how,
    dg: +trig.dg.toFixed(3), rvol: +trig.rvol.toFixed(2), gross: +gross.toFixed(2), net: +net.toFixed(2) });
}
const N = trades.length;
const wins = trades.filter(t => t.net > 0).length;
const totNet = trades.reduce((a, t) => a + t.net, 0);
const expPct = N ? (totNet / N / 500 * 100) : 0;
let eq = 100, peak = 100, maxDD = 0;
for (const t of trades) { eq += t.net; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, (peak - eq) / peak * 100); }
const legA = { N, winRate: N ? +(wins / N * 100).toFixed(1) : 0,
  expectancyPctTurnover: +expPct.toFixed(3), expectancyRsPerTrade: N ? +(totNet / N).toFixed(2) : 0,
  totalNetRs: +totNet.toFixed(2), equityEnd: +eq.toFixed(2), maxDDpct: +maxDD.toFixed(1),
  targets: trades.filter(t => t.how === "target").length, stops: trades.filter(t => t.how === "stop").length,
  times: trades.filter(t => t.how === "time").length,
  verdict: (N >= 120 && (wins / Math.max(N,1)) > 0.50 && expPct >= 0.25) ? "PASS" : "FAIL",
  sessions: nDays, trades };

// ================= LEG B =================
console.log("LEG B: downloading daily bars...");
const legB = { universe: LEGB.map(s=>s.replace(".NS","")), rules: "dip<-3% vs 20DMA, vol20d-median>1M shares, price>=2; enter next open Q=floor(100/P); +3% tgt/-10% stop(stop-first)/20-session exit; costs: Sharekhan 0.30%/side + STT 0.1% sell + stamp 0.003% buy + NSE 0.00325%/side, DP=Rs0 (counterfactual DP=14.75)", byStock: {}, trades: [] };
for (const s of LEGB) {
  const rows = await fetchDaily(s, "5y");
  // split mask via adj/close ratio jumps
  const bad = new Set();
  for (let i = 1; i < rows.length; i++) {
    const r0 = rows[i-1].a / rows[i-1].c, r1 = rows[i].a / rows[i].c;
    if (Math.abs(r1 / r0 - 1) > 0.01) for (let k = Math.max(0,i-25); k < Math.min(rows.length,i+26); k++) bad.add(k);
  }
  const med = (a) => { const x=[...a].sort((p,q)=>p-q); return x[Math.floor(x.length/2)] || 0; };
  let n=0,w=0,grossSum=0,netSum=0,dpSum=0;
  const t0 = rows.length;
  for (let i = 20; i < t0 - 21; i++) {
    if (bad.has(i)) continue;
    const dma = rows.slice(i-20,i).reduce((a,r)=>a+r.c,0)/20;
    const vmed = med(rows.slice(i-20,i).map(r=>r.v));
    const c = rows[i].c;
    if (!(c < 0.97*dma && vmed > 1e6 && c >= 2)) continue;
    const o = rows[i+1].o; if (!(o>0)) continue;
    const Q = Math.floor(100/o); if (Q<1) continue;
    const tgt=o*1.03, stp=o*0.90;
    let exit=null,how="time";
    for (let k=i+1;k<Math.min(i+21,t0);k++) {
      const b=rows[k];
      const hT=b.h>=tgt, hS=b.l<=stp;
      if (hT&&hS){exit=stp;how="stop";break;}
      if (hS){exit=stp;how="stop";break;}
      if (hT){exit=tgt;how="target";break;}
    }
    if (exit==null){exit=rows[Math.min(i+20,t0-1)].c;how="time";}
    const buyV=Q*o, sellV=Q*exit;
    const cost=buyV*(0.003+0.00003+0.0000325)+sellV*(0.003+0.001+0.0000325); // brokerage+stamp+exch / brokerage+STT+exch
    const net=sellV-buyV-cost, netDP=net-14.75;
    n++; if(net>0)w++; grossSum+=sellV-buyV; netSum+=net; dpSum+=netDP;
    legB.trades.push({day:dayKey(rows[i+1].t),stock:s.replace(".NS",""),Q,buy:+o.toFixed(2),exit:+exit.toFixed(2),how,gross:+(sellV-buyV).toFixed(2),net:+net.toFixed(2),netDP:+netDP.toFixed(2)});
  }
  legB.byStock[s.replace(".NS","")]={N:n,winPct:n?+(w/n*100).toFixed(1):0,netRs:+netSum.toFixed(2),netRsDP1475:+dpSum.toFixed(2)};
}
const BN=legB.trades.length, BW=legB.trades.filter(t=>t.net>0).length;
legB.summary={N:BN,winPct:BN?+(BW/BN*100).toFixed(1):0,
  netRs:+legB.trades.reduce((a,t)=>a+t.net,0).toFixed(2),
  netRsDP1475:+legB.trades.reduce((a,t)=>a+t.netDP,0).toFixed(2)};

const results = { at: new Date().toISOString(), legA, legB,
  coverage: { niftySessions: nDays, perStock: Object.fromEntries(STOCKS.map(s=>[s.replace(".NS",""),sess[s].length])) } };
mkdirSync("inr-eq", { recursive: true });
writeFileSync("inr-eq/results.json", JSON.stringify(results, null, 1));
console.log("LEG A:", JSON.stringify({ N, win: legA.winRate, exp: legA.expectancyPctTurnover, verdict: legA.verdict }));
console.log("LEG B:", JSON.stringify(legB.summary));
console.log("WROTE inr-eq/results.json");
