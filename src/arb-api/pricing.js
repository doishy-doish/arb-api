// pricing.js — loads pricing.wasm (built from pricing.wat via wabt).
// Identical arithmetic to api/cheapest.js. Verify: node -e "require('./pricing.js').check().then(console.log)"
const fs = require("fs"), path = require("path");
let inst = null;
async function load() {
  if (!inst) {
    const buf = fs.readFileSync(path.join(__dirname, "pricing.wasm"));
    inst = (await WebAssembly.instantiate(buf, {})).instance.exports;
  }
  return inst;
}
async function check() {
  const w = await load();
  const cases = [
    [1.0, 0.002, 1.0, 1.0, 1000], [1.00097, 0.001, 2.0, 1.0, 10000],
    [99.86 / 94.047485, 0.002, 0, 1.0, 50000]
  ];
  return cases.map(([a, f, wd, g, s]) => {
    const js = (a * s + a * s * f + wd + g) / s;
    const ws = w.allin(a, f, wd, g, s);
    const jb = (a * s - a * s * f - wd - g) / s - a * 0.01;
    const wb = w.netbid(a, f, wd, g, s, 0.01);
    return { allinJs: js, allinWasm: ws, netbidJs: jb, netbidWasm: wb, bitIdentical: js === ws && jb === wb };
  });
}
module.exports = { load, check };
