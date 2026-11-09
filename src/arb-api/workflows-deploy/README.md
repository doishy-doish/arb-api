# Deploy lane (GitHub Actions, same pattern as src/bot/gh/tick.yml)

This directory stages the workflow; the workspace store forbids dot-directories
under src/, so it lives here instead of `.github/workflows/`.

## One-time operator setup (keys stay in vault / repo secrets, never in files)

1. Create a public repo (e.g. `arb-api`) with this layout:
   - `src/arb-api/**` (this directory: api/, scripts/, *.json, vercel.json, package.json)
   - copy `workflows-deploy/deploy.yml` -> `.github/workflows/deploy.yml`
2. First link (one command, token stays in vault):
   `cd src/arb-api && npx vercel link` (uses vault token; records org/project IDs)
   then add three repo secrets (Settings -> Secrets and variables -> Actions):
   `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`
3. Triggers are schedule (every 2h) + manual dispatch ONLY. Never add
   `pull_request` — forked runs must never see secrets.

## What a run does

refresh-threads (fail-closed, no write on any fetch/parse error, threads below
+15bp move to excluded.decayed) -> update (catalogue guards G1-G4) -> commit
snapshots back -> vercel deploy --prod. Logs print ids + rounded bp only.
