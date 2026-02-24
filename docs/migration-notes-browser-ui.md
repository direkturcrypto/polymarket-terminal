# Browser UI Migration Notes

## Overview

This repository now runs as a workspace with API, web UI, shared contracts, and engine controllers.

## Key migrations

1. CLI lifecycle is now controller-backed (`ProcessBotController`) with legacy scripts preserved.
2. API now persists runtime config, secrets presence state, and audit events under `data/api/`.
3. Browser shell includes:
   - Session sidebar (pin/archive/search)
   - Streaming assistant pane with tool-call cards
   - Runtime right panel (bots/logs/alerts)
4. Risk hardening adds kill switch arm/reset and start-time guardrails.
5. Stack boot scripts added for one-command startup:
   - `npm run stack:dev`
   - `npm run stack:start`

## New API surfaces

- `GET /api/v1/audit`
- `GET /api/v1/alerts`
- `POST /api/v1/bots/kill-switch`
- `POST /api/v1/bots/kill-switch/reset`
- `GET /api/v1/positions`
- `GET /api/v1/orders`
- `GET /api/v1/trades`
- `GET /api/v1/markets`

## Operator command quick reference (web)

- `/help`
- `/health`
- `/start <copy|mm|sniper> [dry|live]`
- `/stop <copy|mm|sniper>`
- `/restart <copy|mm|sniper> [dry|live]`
- `/status <copy|mm|sniper>`
- `/logs`
- `/alerts`
- `/audit`
- `/metrics`
- `/kill`
- `/kill-reset`
