# Local Operations Runbook

## 1) Start services

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start both API and web together (recommended):

   ```bash
   npm run stack:dev
   ```

   Production mode (expects web build artifacts):

   ```bash
   npm run stack:start
   ```

3. Start API service only:

   ```bash
   npm run api:start
   ```

4. Start web shell only:

   ```bash
   npm run dev -w @polymarket/web
   ```

5. Open dashboard at `http://127.0.0.1:3000`.

## 2) Bot lifecycle operations

- Start/stop/restart through UI command panel or API routes.
- CLI fallback commands:
  - Copy: `npm start`
  - MM: `npm run mm` / `npm run mm-sim`
  - Sniper: `npm run sniper` / `npm run sniper-sim`

## 3) Kill switch operations

- Arm kill switch and stop all bots:

  ```bash
  curl -X POST http://127.0.0.1:18789/api/v1/bots/kill-switch
  ```

- Reset kill switch when ready:

  ```bash
  curl -X POST http://127.0.0.1:18789/api/v1/bots/kill-switch/reset
  ```

## 4) Validation and health

- API health:

  ```bash
  curl http://127.0.0.1:18789/api/v1/health
  ```

- Logs and audit:

  ```bash
  curl http://127.0.0.1:18789/api/v1/logs
  curl http://127.0.0.1:18789/api/v1/audit
  ```

- Quality checks:

  ```bash
  npm run format
  npm run lint
  npm run typecheck
  npm run test
  ```

## 5) Performance and soak checks

- API latency benchmark:

  ```bash
  npm run qa:bench:api
  ```

- WebSocket soak check:

  ```bash
  npm run qa:soak:ws
  ```

## 6) Backup and recovery

- Persisted API data path: `data/api/`
- Backup files:
  - `data/api/runtime-config.json`
  - `data/api/runtime-secrets.json`
  - `data/api/audit-events.json`

Recovery:

1. Stop API.
2. Restore the backup files.
3. Start API and verify `GET /api/v1/config` + `GET /api/v1/audit`.
