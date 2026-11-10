const fs = require("fs");
const path = require("path");

function loadCatalogue() {
  const p = path.join(__dirname, "..", "catalogue.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// All-in unit cost in USD per USDC. INR venues convert via FX; TDS applies on the SELL leg only.
function normalize(v, fx) {
  const inr = v.ask > 10; // INR-quoted venue (asks ~100)
  const conv = inr ? fx.USDINR : 1;
  return {
    id: v.id, name: v.name, kyc: v.kyc, trap: !!v.trap,
    ask: v.ask == null ? null : v.ask / conv, bid: (v.bid ?? v.ask) / conv,
    feeRate: v.feeRate, withdrawFee: v.withdrawFee ?? 0,
    tds: v.tds ?? 0, url: v.url, note: v.note
  };
}

// GET /api/cheapest?size=1000&chain=tron
// Returns cheapest all-in ASK (buy) and dearest net BID (sell) in USD per USDC,
// per-size tiers, and the breakeven size where the no-KYC route beats majors.
module.exports = (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  const cat = loadCatalogue();
  const chain = (req.query.chain || "tron").toLowerCase();
  const gas = (cat.gas && cat.gas[chain]) ?? cat.gas.tron;
  const venues = cat.venues.map(v => normalize(v, cat.fx)).filter(v => !v.trap);
  const majors = venues.filter(v => v.kyc === true);

  const tiers = [100, 1000, 10000, 50000].map(size => {
    const askSide = venues.filter(v => v.ask != null);
    const bidSide = venues.filter(v => v.bid != null);
    const asks = askSide.map(v => ({ venue: v.id, unit: (v.ask * size + v.ask * size * v.feeRate + v.withdrawFee + gas) / size }))
      .sort((a, b) => a.unit - b.unit);
    const bids = bidSide.map(v => ({ venue: v.id, unit: (v.bid * size - v.bid * size * v.feeRate - v.withdrawFee - gas) / size - v.bid * v.tds }))
      .sort((a, b) => b.unit - a.unit);
    const majorsAskSide = majors.filter(v => v.ask != null);
    const majorsAsk = Math.min(...majorsAskSide.map(v => (v.ask * size + v.ask * size * v.feeRate + v.withdrawFee + gas) / size));
    return { size, gas, cheapestAsk: asks[0], dearestBid: bids[0], majorsAsk, beatsMajors: asks[0].unit < majorsAsk };
  });

  // breakeven: size where cheapest-route all-in == majors all-in (linear solve on top two)
  const c = venues.filter(v => v.kyc !== true && v.ask != null).sort((a, b) => a.ask - b.ask)[0];
  const m = majors.filter(v => v.ask != null).sort((a, b) => a.ask - b.ask)[0];
  const denom = (c.ask * c.feeRate - m.ask * m.feeRate);
  const breakeven = denom >= 0 ? null : Math.ceil(((m.withdrawFee + gas) - (c.withdrawFee + gas)) / denom);

  res.status(200).json({
    updated: cat.updated, chain, marginNote: "Shovel pricing: this data via x402 micropayments (see README). Coin itself: add margin " + cat.margin + " to all-in; clears majors only where beatsMajors is true.",
    tiers, breakevenSize: breakeven,
    excludedTraps: cat.venues.filter(v => v.trap).map(v => ({ venue: v.id, reason: v.trapReason })),
    disclaimer: "Snapshot quotes; depth in scratch/arb/VENDOR-CATALOGUE.md. INR leg needs IN-KYC + TDS/tax handling."
  });
};
