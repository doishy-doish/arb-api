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

// x402 toll (mainnet; armed ONLY when PAY_TO env is set — otherwise free funnel).
// Zero deps: requirements/verify/settle are inlined (same shape as src/x402/x402.js).
// Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4ACd9 (6 decimals), eip155:8453.
// $0.003/call = 3000 base units. No query params; price is fixed, no user numerics.
var X402 = {
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4ACd9",
  price: "3000",
  facilitator: "https://x402.org/facilitator",
  version: 2
};

function payTo() { return process.env.PAY_TO || ""; }

function requirements(resource) {
  return {
    scheme: "exact",
    network: X402.network,
    asset: X402.asset,
    amount: X402.price,
    payTo: payTo(),
    resource: resource,
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    facilitator: { url: process.env.FACILITATOR_URL || X402.facilitator },
    extra: { name: "USDC", version: "2" }
  };
}

function readPaymentHeader(headers) {
  var raw = headers && (headers["x-payment"] || headers["X-Payment"]);
  if (!raw) return null;
  try {
    var json = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch (e) {
    return { invalid: true };
  }
}

async function facilitatorCall(op, paymentPayload, req) {
  var r;
  try {
    r = await fetch(req.facilitator.url + "/" + op, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: paymentPayload, paymentRequirements: req })
    });
  } catch (e) {
    return { ok: false, reason: "facilitator-unreachable" };
  }
  if (!r.ok) return { ok: false, reason: "facilitator-http-" + r.status };
  var j = await r.json().catch(function () { return null; }) || {};
  if (op === "verify") return { ok: j.isValid === true, reason: j.isValid ? null : (j.invalidReason || "invalid") };
  return { ok: j.success === true, tx: j.transaction || null, reason: j.success ? null : (j.errorReason || "unsettled") };
}

function serveData(res, snap, cached) {
  if (cached) res.setHeader("cache-control", "public, max-age=600");
  else res.setHeader("cache-control", "private, no-store");
  res.status(200).json({
    updated: snap.updated,
    source: snap.source,
    gasAssumptions: snap.gasAssumptions,
    catalogueGas: loadGas(),
    threads: snap.threads,
    killed: snap.excluded,
    killedCount: snap.killedCount,
    pricing: loadPricing(),
    toll: tollInfo(),
    marginNote: "Shovel pricing: this data via x402 micropayments (see README). Spreads move in minutes; re-pull before sizing.",
    disclaimer: snap.disclaimer
  });
}

function tollInfo() {
  if (!payTo()) return { armed: false, note: "free funnel (operator has not set PAY_TO); $0.003/call activates on deploy with PAY_TO" };
  return { armed: true, network: X402.network, asset: X402.asset, amount: X402.price, note: "$0.003 USDC/call on Base; free tier enforced at listing layer" };
}

module.exports = async function (req, res) {
  res.setHeader("access-control-allow-origin", "*");
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
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
  // Free funnel until the operator arms the toll (Vercel env PAY_TO).
  if (!payTo()) {
    res.setHeader("cache-control", "public, max-age=600");
    serveData(res, snap, true);
    return;
  }
  var resource = "GET /api/threads";
  var payload = readPaymentHeader(req.headers || {});
  var req402 = requirements(resource);
  if (!payload || payload.invalid) {
    res.setHeader("cache-control", "public, max-age=60");
    res.status(402).json({ x402Version: X402.version, error: "Payment required", accepts: [req402], toll: tollInfo() });
    return;
  }
  var v = await facilitatorCall("verify", payload, req402);
  if (!v.ok) {
    res.status(402).json({ error: "payment invalid", reason: v.reason, accepts: [req402] });
    return;
  }
  var s = await facilitatorCall("settle", payload, req402);
  if (!s.ok) {
    res.status(402).json({ error: "payment unsettled", reason: s.reason, accepts: [req402] });
    return;
  }
  serveData(res, snap, false);
};
