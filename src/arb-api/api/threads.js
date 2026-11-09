// threads — ranked one-way threads the $5 float cannot use (no user numerics).
// GET /api/threads -> static snapshot from threads.json (same rails as cheapest.js).
// No query params by design: fixed snapshot, no sizes into arithmetic, no clamps.
// Zero runtime deps. Traps/toys/fossils are excluded in the snapshot, and the
// excluded{} block names every kill so buyers can audit what they are NOT getting.
// Snapshot refresh = rebuild threads.json from a fresh hunt, redeploy. Never
// present a net as executable depth: nets are ex-transfer, doors/minimums gate.
var fs = require("fs");
var path = require("path");

function loadThreads() {
  var p = path.join(__dirname, "..", "threads.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadGas() {
  try {
    var c = path.join(__dirname, "..", "catalogue.json");
    var cat = JSON.parse(fs.readFileSync(c, "utf8"));
    return cat.gas || { solana: 0.05, tron: 1, bsc: 0.2, ethereum: 3.0 };
  } catch (e) {
    return { solana: 0.05, tron: 1, bsc: 0.2, ethereum: 3.0 };
  }
}

function loadPricing() {
  try {
    var p = path.join(__dirname, "..", "pricing.json");
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return { version: 0, note: "pricing snapshot unreadable" };
  }
}

module.exports = function (req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "public, max-age=600");
  var snap;
  try {
    snap = loadThreads();
  } catch (e) {
    res.status(500).json({ error: "threads snapshot unreadable" });
    return;
  }
  // Defensive: never serve a snapshot that smuggles a trap/toy into threads.
  var bad = (snap.threads || []).filter(function (t) {
    return !t || !t.id || !t.dir || t.edgeBp == null || !t.minGate || !t.transferFee;
  });
  if (bad.length) {
    res.status(500).json({ error: "threads snapshot failed shape guard" });
    return;
  }
  res.status(200).json({
    updated: snap.updated,
    source: snap.source,
    gasAssumptions: snap.gasAssumptions,
    catalogueGas: loadGas(),
    threads: snap.threads,
    killed: snap.excluded,
    killedCount: snap.killedCount,
    pricing: loadPricing(),
    marginNote: "Shovel pricing: this data via x402 micropayments (see README). Spreads move in minutes; re-pull before sizing.",
    disclaimer: snap.disclaimer
  });
};
