# Journeys

Nightly "AI user" journeys: the happy paths an operator or developer takes in the dashboard, one visual baseline per step. Run by `.github/workflows/journeys.yml` through the shared harness in `nitsuah/.github` (contract: `journeys/STANDARD.md`). Failures become `bot:journey` issues; `BUGS.md` lives on the `bot/journeys` branch.

- `journey.js` is the vendored `step()` helper. `motor-pool.js` is the fixture: the built dashboard bundle is the only real part, every `/api` call is answered from an in-memory store of fictional demo data, `/ws/events` is a silent WebSocket, the clock is frozen (2027-01-15), and the animated 3D hub canvas is hidden.
- Journeys are tagged `@feature:<id>` with ids from `promo/spots.json`. `step(..., { docs: '<id>' })` also writes `docs/screenshots/<id>.png` when `DOCS_SCREENSHOTS` is set, which `npm run capture:screenshots` (and the visual-docs workflow) uses.
- Tolerance is `maxDiffPixels: 20` (0 px of noise over 63 soak runs).

## Run and update baselines

Baselines are Linux-only. Always use the Playwright image (same version as `@playwright/test`):

```sh
docker run --rm -v "$PWD:/w" -w /w mcr.microsoft.com/playwright:v1.64.0-jammy \
  sh -c "npm ci && npm run test:journeys -- --update-snapshots"
```

Drop `--update-snapshots` to check. CI sets `CI=true`, where a missing baseline fails. Soak new journeys with `CI=true ... --retries 0 --repeat-each 3`.
