# arb-cheapest — cheapest-vendor USDC quote API (the shovel)

`GET /api/cheapest?asset=USDC&quote=USDT&size=1000&chain=tron` → cheapest real ask +
gas + 0.1% margin, benchmarked against the majors' average so buyers can verify
"undermarket". Trap venues (YoBit, WazirX) are excluded in code.

## Deploy (operator, one command; needs the vault Vercel token)

```
cd src/arb-api && npm run update && npx vercel --prod
```

Then set the returned URL as the catalogue endpoint. Refresh quotes with
`npm run update` (CoinGecko + NonKYC + CoinDCX + FX) and redeploy, or schedule it.

## Local test (no deploy)

```
node -e "const h=require('./api/cheapest.js');h({query:{size:'1000'}},{setHeader(){},status(c){this.c=c;return this},json(o){console.log(JSON.stringify(o,null,1))}})"
```

## Sell it where the other APIs are

## Pricing (v1, model in scratch/arb/pricing-model2.txt)

- Per call: **$0.003** (3000 USDC-base units via x402) — the revenue-maximum is at the
  settle floor in every scenario swept (elastic e=1.2 and inelastic e=0.8, $0.001–$0.03):
  demand falls faster than price rises because free alternatives exist, so penetration
  pricing wins. $0.003 holds 50% margin over settle variance (~$0.001–0.002).
- Free: **100 calls/day, no key** — the funnel, not the product (matches RapidAPI norm).
- Monthly (operator-billed, not yet implemented): **$19/mo**, 10k calls included,
  $0.003 overage. Ship per-call first.
- Honesty clause: pricing harvests demand, it does not create it. No funnel
  (Moltbook/RapidAPI/OpenClaw listings below) = $0 at any price.
- Real-money note: `/api/threads` carries an x402 toll on Base mainnet (eip155:8453,
  USDC 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA4ACd9, $0.003 = 3000 units). It arms when
  the operator sets `PAY_TO` (Base wallet) on the Vercel project — until then the
  endpoint serves the free funnel. Set it in Vercel dashboard → arb-api → Settings → Environment Variables.

1. **x402 Bazaar** — wrap `/api/threads` (and `/api/cheapest`) with the existing paywall in
   `src/x402/` (same `x402.js` helpers, price $0.003 USDC/call per pricing above). Agents pay
   per call, no accounts. This is the native shelf for agent-bought APIs.
2. **Moltbook** — post the endpoint + sample output on m/feeds as a builder
   update (repo already has `src/moltbook.js`; needs the operator's key).
   Prior postmortem post (id ac35d75b) shows the pipe works.
3. **RapidAPI / APILayer** — list the Vercel URL as a freemium API
   (free 100 calls/day, paid above). Manual listing, ~30 min.
4. **OpenClaw skill / ClawHub** — ship a SKILL.md wrapping the endpoint so any
   OpenClaw agent can call it (`npx` skill install). Skill file drafted on request.

## Standing caveats (served in every response)

Snapshot quotes (see `updated`), traps excluded, Indian leg needs IN-KYC +
1% TDS + 30% tax handling. Never present a quote as executable depth —
depth lives in `scratch/arb/VENDOR-CATALOGUE.md`.
