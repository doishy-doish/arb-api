# AGENT RULES — arb-api (read before touching anything here)

Frozen invariants (change only on explicit operator order):
1. Trap venues stay flagged AND excluded. `cheapest.js` filters `!v.trap` on BOTH legs.
   Never add a venue with |ask-1|>3% (USD-quoted) without trap:true + trapReason.
2. Fixed size tiers [100, 1000, 10000, 50000]. Never accept user-supplied numerics
   into arithmetic (no ?size= parsing) — smaller attack surface, no clamp bugs.
3. `chain` param allowlist is implicit: unknown chains fall back to tron gas
   (`?? cat.gas.tron`). If you add a chain, add its gas number to catalogue.json.
4. Zero runtime dependencies. Never add one (Vercel cold-start + audit surface).
5. `update.mjs` guards G1-G4 abort before write. Never weaken a guard to make a
   run pass — investigate the data instead. Backup file is catalogue.backup.json.
6. pricing.wat is the source of truth for math; pricing.wasm is built from it via
   wabt; pricing.js is glue. If you change the formula, change all three AND
   re-run the 52-cell differential (see scratch/arb/AUDIT.md A3).
7. No secrets in this directory, ever. Vercel token lives in the vault
   (scratch/vault/keys/vercel.json); deploys use `npx vercel --prod` on the
   operator's machine. Never print, log, or commit token material.
8. Catalogue numbers only move via `npm run update` (live fetch). Never hand-edit
   a quote except to flag a trap. Every quote carries `updated`; stale >24h =
   re-run before quoting to anyone.

Deploy checklist: update → guards green → diff catalogue.json → vercel --prod →
smoke GET /api/cheapest?chain=tron → log the URL + timestamp in CURRENT_TASK.
