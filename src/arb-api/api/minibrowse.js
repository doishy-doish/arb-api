// minibrowse — K-free venue-discovery proxy (Vercel serverless, zero deps).
// GET /api/minibrowse?mode=cg_exchanges&page=1
// GET /api/minibrowse?mode=ccxt_readme
// GET /api/minibrowse?mode=ddg&q=new+crypto+exchange+2025
// GET /api/minibrowse?mode=github&q=crypto+exchange+api+spot
// Allowlisted upstream hosts only; q is length-clamped text, never eval'd;
// page is clamped 1..4 (no user numerics into arithmetic beyond the clamp).
// CORS * so the static minibrowser.html + any agent can call it.
var ALLOW = {
  cg: "https://api.coingecko.com/api/v3/exchanges?per_page=250&page=",
  ccxt: "https://raw.githubusercontent.com/ccxt/ccxt/master/README.md",
  ddg: "https://html.duckduckgo.com/html/?q=",
  github: "https://api.github.com/search/repositories?q="
};

function clampPage(p) {
  var n = parseInt(p, 10);
  if (!isFinite(n)) return 1;
  if (n < 1) return 1;
  if (n > 4) return 4;
  return n;
}

function clampQ(q) {
  q = String(q == null ? "" : q).slice(0, 80);
  return q.replace(/[<>"\r\n]/g, " ").trim();
}

function pick(mode, q, page, cb) {
  if (mode === "cg_exchanges") return cb(null, ALLOW.cg + page, "json");
  if (mode === "ccxt_readme") return cb(null, ALLOW.ccxt, "text");
  if (mode === "ddg") {
    if (!q) return cb("missing q");
    return cb(null, ALLOW.ddg + encodeURIComponent(q), "text");
  }
  if (mode === "github") {
    if (!q) return cb("missing q");
    return cb(null, ALLOW.github + encodeURIComponent(q) + "+language:TypeScript&per_page=20&sort=updated", "json");
  }
  return cb("unknown mode (cg_exchanges|ccxt_readme|ddg|github)");
}

// Minimal venue extraction so the UI gets rows, not raw dumps.
function extract(mode, q, body) {
  if (mode === "cg_exchanges") {
    var arr = [];
    try { arr = JSON.parse(body); } catch (e) { return { error: "cg parse failed" }; }
    return {
      mode: mode, page: q.page, count: arr.length,
      rows: arr.map(function (e) {
        return { id: e.id, name: e.name, trust: e.trust_score, year: e.year_established, country: e.country, volBtc: e.trade_volume_24h_btc, url: e.url };
      })
    };
  }
  if (mode === "ccxt_readme") {
    var ids = [];
    var re = /\| \[([a-z0-9_\-]+)\]\(https:\/\/github\.com\/ccxt\/ccxt\/blob\/master\/ts\/src\/([a-z0-9_\-]+)\.ts\)/gi;
    var m;
    while ((m = re.exec(body)) && ids.length < 300) ids.push(m[1]);
    // fallback: any | [name](.../ts/src/xxx.ts) shape
    if (!ids.length) {
      var re2 = /ts\/src\/([a-z0-9_\-]+)\.ts/gi;
      while ((m = re2.exec(body)) && ids.length < 300) ids.push(m[1]);
      ids = Array.from(new Set(ids));
    }
    var probe = String(q.q || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return {
      mode: mode, ccxtCount: ids.length,
      probe: probe.map(function (t) { return { t: t, supported: ids.indexOf(t) !== -1 }; }),
      ids: probe.length ? undefined : ids
    };
  }
  if (mode === "ddg") {
    var links = [];
    var re3 = /uddg=([^"&]+)/g;
    var m2;
    while ((m2 = re3.exec(body)) && links.length < 200) {
      try { links.push(decodeURIComponent(m2[1])); } catch (e) { links.push(m2[1]); }
    }
    var uniq = Array.from(new Set(links)).filter(function (u) { return /^https?:\/\//.test(u); });
    // keep venue-ish links first (exchange/review/list domains), cap 40
    var venueish = uniq.filter(function (u) { return /exchange|broker|review|top|best|list|crypto|coin|trade/i.test(u); });
    var rest = uniq.filter(function (u) { return venueish.indexOf(u) === -1; });
    return { mode: mode, q: q.q, count: uniq.length, links: venueish.concat(rest).slice(0, 40) };
  }
  if (mode === "github") {
    var j = {};
    try { j = JSON.parse(body); } catch (e) { return { error: "github parse failed" }; }
    return {
      mode: mode, q: q.q, total: j.total_count,
      rows: (j.items || []).slice(0, 20).map(function (r) {
        return { repo: r.full_name, stars: r.stargazers_count, updated: r.updated_at, desc: (r.description || "").slice(0, 140), url: r.html_url };
      })
    };
  }
  return { error: "extract: unknown mode" };
}

module.exports = function (req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "public, max-age=600");
  var mode = String((req.query && req.query.mode) || "cg_exchanges");
  var page = clampPage(req.query && req.query.page);
  var q = clampQ(req.query && req.query.q);
  pick(mode, q, page, function (err, url, kind) {
    if (err) { res.status(400).json({ error: err }); return; }
    var headers = { "user-agent": "arb-minibrowser/1.0 (venue discovery; contact: generator operator)" };
    if (url.indexOf("api.github.com") === 0) headers.accept = "application/vnd.github+json";
    fetch(url, { headers: headers }).then(function (r) {
      if (!r.ok) { res.status(502).json({ error: "upstream " + r.status, url: url.split("?")[0] }); return null; }
      return r.text();
    }).then(function (text) {
      if (text == null) return;
      res.status(200).json(extract(mode, { q: q, page: page }, text));
    }).catch(function (e) {
      res.status(502).json({ error: "fetch failed: " + String((e && e.message) || e).slice(0, 120) });
    });
  });
};
