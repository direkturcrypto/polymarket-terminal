# Browser UI Implementation Plan

Repository: `https://github.com/50sotero/polymarket-terminal`
Working branch: `feat/browser-ui-implementation`
Last updated: 2026-02-24

## 1) Vision and success criteria

Build a browser-based control plane that fully replaces the terminal dashboard while preserving all current bot capabilities:

- Copy-trade bot (current `src/index.js` flow)
- Market maker bot (current `src/mm.js` flow)
- Sniper bot (current `src/sniper.js` flow)

Primary outcomes:

1. One UI to configure, start, stop, and monitor all bots.
2. Real-time positions, orders, fills, PnL, logs, and alerts.
3. Strong secret isolation (private key never exposed to browser).
4. Efficient updates with low CPU, low memory, and low network overhead.
5. Production-grade reliability and observability.

## 2) Scope

### In scope

- New web frontend (responsive desktop/mobile).
- New backend API service to orchestrate existing bot logic.
- Bot runtime manager (start/stop/restart/status).
- Event streaming from bots to browser (WebSocket).
- Config management with validation and persistence.
- Structured logs, metrics, alerts, and health checks.
- Test suite (unit, integration, end-to-end, performance).

### UI mode decision gate (phase 0)

- Minimal: chat-only browser UI for command + logs.
- Full dashboard: control-dashboard-first UI with sidebar, panels, metrics, and strategy controls.
- Hybrid: dashboard + chat workspace in one shell.

Recommended path for this repo: **Hybrid** (full dashboard as primary surface, chat as an operator assistant panel).

### Out of scope (phase 1)

- Multi-tenant SaaS and team accounts.
- Cloud key custody/HSM integration.
- Mobile native app.

## 3) Current-state assessment

Current project is CLI-first and tightly coupled:

- Entrypoints are script-based (`src/index.js`, `src/mm.js`, `src/sniper.js`).
- Runtime output is terminal UI via `blessed` (`src/ui/dashboard.js`).
- Configuration is environment-driven (`.env`) with minimal runtime validation.
- No HTTP API, no browser client, no persistent operational store.
- No formal test harness or CI pipeline.

Implication: we should not bolt on a browser directly. We need a clean separation between engine, API, and presentation.

## 4) Target architecture

```
Browser (React/Next) <-> API Gateway (Fastify) <-> Bot Orchestrator
                                             \-> Engine adapters (copy/mm/sniper)
                                             \-> Persistence (Postgres/SQLite)
                                             \-> Cache/Event Bus (Redis optional)
```

### Recommended stack

- Frontend: Next.js 15 + TypeScript + TanStack Query + Zustand + Tailwind + shadcn/ui + Framer Motion + React Markdown (`remark-gfm`, `rehype-highlight`) + `@tanstack/react-virtual` + `next-themes` + `cmdk`
- Backend API: Fastify + TypeScript + Zod + ws (native WebSocket with heartbeat/reconnect contract)
- Persistence:
  - Phase 1 local-first: SQLite via Prisma
  - Phase 2 production: Postgres + Redis
- Testing: Vitest, React Testing Library, Playwright, Supertest, k6
- Tooling: pnpm workspaces, ESLint, Prettier, Husky, GitHub Actions

## 5) Repository restructuring plan

Introduce workspace layout while preserving existing source until parity is proven:

```
apps/
  api/
  web/
packages/
  engine/      # extracted reusable trading logic
  shared/      # schemas, types, constants
docs/
```

Migration rule: copy current logic into `packages/engine` in thin wrappers first; refactor incrementally after behavior parity tests pass.

## 6) Backend/API design

### 6.1 Core services

- `BotManager`: lifecycle (start/stop/restart), one controller per bot.
- `ConfigService`: load, validate, encrypt-at-rest sensitive values.
- `StateService`: normalized in-memory state + persistence snapshots.
- `TelemetryService`: logs, metrics, event stream.
- `RiskService`: guardrails (max order size, max exposure, kill switch).

### 6.2 API contracts (v1)

- `GET /api/v1/health`
- `GET /api/v1/config`
- `PUT /api/v1/config`
- `POST /api/v1/bots/:bot/start`
- `POST /api/v1/bots/:bot/stop`
- `POST /api/v1/bots/:bot/restart`
- `GET /api/v1/bots/:bot/status`
- `GET /api/v1/positions`
- `GET /api/v1/orders`
- `GET /api/v1/trades`
- `GET /api/v1/markets`
- `GET /api/v1/logs`
- `GET /api/v1/metrics`
- `WS /api/v1/stream` (event topics: bot_state, order, trade, position, log, alert)

All payloads use shared Zod schemas from `packages/shared`.

### 6.3 Security model

- Backend-only key usage; browser never receives private key.
- Secrets encrypted at rest with machine-level key.
- Session auth for local mode (password or local token).
- CSRF protection, rate limits, strict CORS, secure headers.
- Audit log for config changes and bot lifecycle actions.

## 7) Frontend design

### 7.1 Product surface

- Left sidebar: session list, navigation, pinned/archived sections, quick actions.
- Top nav: environment badge (dry/live), connection state, command palette trigger.
- Main workspace: dashboard tabs (overview, bots, positions/orders, trades, logs, settings).
- Chat workspace: streaming assistant panel for operational commands and diagnostics.
- Right panel (optional): live logs tail, config inspector/editor, and HTML canvas host.

### 7.2 Dashboard layout blueprint

- Desktop: resizable shell (`Sidebar` + `TopNav` + `Main` + optional `RightPanel`).
- Mobile: sheet-based sidebar + stacked panels with sticky command/input bar.
- Safety-first visuals: distinct dry vs live color states and persistent mode badge.

### 7.3 Bot operations and strategy controls

- Overview dashboard: account value, exposure, bot status, alerts.
- Bot control center: start/stop/restart, mode toggle (dry/live), health indicators.
- Strategy panels with validation + presets:
  - Copy trade settings
  - MM settings
  - Sniper settings
- Positions and orders tables (sortable/filterable, virtualized rows).
- Trade timeline + structured logs console.
- Settings + secrets (write-only secret fields).

### 7.4 Streaming chat and tool timeline

- Message types: user, assistant stream, tool-call cards, attachments, canvas blocks.
- Tool cards are collapsible and show `pending/running/success/error` with raw output.
- Live markdown rendering for streamed assistant output.
- Keyboard shortcuts: `Cmd/Ctrl+K` (palette), `Cmd/Ctrl+N` (new session), `Cmd/Ctrl+L` (focus input).

### 7.5 UX requirements

- Mobile-first responsive layout, then desktop enhancement.
- Distinct live vs dry-run visual states to prevent mistakes.
- Confirmation dialogs for risky actions (live start, approval refresh, kill switch disable).
- Error surfaces that map directly to backend error codes.
- Smooth transitions for session switch, panel open/close, and tool-card state changes.

### 7.6 Performance requirements

- Initial page load under 2.5s on broadband.
- Stream update latency under 300ms p95 from backend event emit.
- Tables and session/message lists remain smooth with 10k+ rows (virtualization).
- Avoid re-render storms with keyed selectors and memoization.
- WebSocket reconnect recovers state without full-page reload.

## 8) Engine extraction strategy

Create adapters around current script flows:

- `CopyBotController` wraps logic from `src/index.js`.
- `MmBotController` wraps logic from `src/mm.js`.
- `SniperBotController` wraps logic from `src/sniper.js`.

Controller contract:

- `start(config)`
- `stop()`
- `status()`
- `subscribe(listener)` for state/events

During migration, CLI scripts remain supported by using the same controller layer, ensuring no behavior drift between CLI and UI modes.

## 9) Data and persistence model

Minimum entities:

- `app_config`
- `bot_runtime`
- `orders`
- `trades`
- `positions`
- `alerts`
- `audit_events`

Retention policy:

- High-frequency logs/events: 7-14 days local default.
- Trade/order history: configurable, default 90 days.

## 10) Reliability and operations

- Health probes: liveness/readiness for API and each bot controller.
- Supervisor restarts with exponential backoff.
- Circuit breakers for upstream API failures.
- Graceful degradation if websocket feed drops (fallback polling).
- One-click kill switch to stop all bots and cancel open orders.

## 11) Testing strategy

### Unit

- Schema validation, risk guards, config transforms, event reducers.
- UI store reducers/selectors (sessions/messages/config), markdown renderer, shortcut handlers.

### Integration

- API endpoints with mocked Polymarket clients.
- Bot manager lifecycle flows and failure recovery.
- WebSocket stream contract, heartbeat, reconnect backoff, auth token refresh flow.

### End-to-end

- Playwright user journeys: configure -> dry run -> live confirm -> monitor -> stop.
- Chat journey: create session -> stream response -> tool card visible -> finalize message.

### Performance

- k6 API throughput and websocket fan-out tests.
- Frontend render profiling on large datasets and long chat/session lists.

### Regression

- CLI parity suite comparing outputs/events before and after extraction.

## 12) Integrated delivery roadmap

## Phase 0 - Scope lock + foundation (0.5-2 days)

- Confirm UI mode (Hybrid recommended: dashboard + chat).
- Add workspace tooling, lint/format/test baseline, CI skeleton.
- Define shared schemas and stream event contracts.

## Phase 1 - Engine abstraction (4-6 days)

- Extract controllers from existing scripts.
- Keep CLI commands functioning against new controllers.
- Add parity fixtures for CLI vs controller event/output behavior.

## Phase 2 - API service + realtime backbone (4-6 days)

- Implement config, bot lifecycle, health, logs, metrics endpoints.
- Implement `WS /api/v1/stream` with heartbeat, reconnect hints, and replay cursor support.
- Add local auth/session guard and audit events for operator actions.

## Phase 3 - Web shell, theming, and layout (2-4 days)

- Bootstrap Next.js app shell with shadcn primitives.
- Implement responsive layout (`Sidebar`, `TopNav`, `Main`, optional `RightPanel`).
- Implement theme system (system/dark/oled/custom accent) with persistence.

## Phase 4 - Sessions + streaming chat + tool cards (4-6 days)

- Build searchable session list with create/switch/pin/archive.
- Implement streaming chat messages and markdown rendering.
- Add collapsible tool-call timeline cards with status transitions and raw output expansion.
- Wire keyboard shortcuts and command palette.

## Phase 5 - Bot dashboard MVP + strategy controls (4-6 days)

- Build dashboard, bot controls, logs, positions/trades pages.
- Complete copy/MM/sniper config forms with validation and presets.
- Add confirmation guards for risky live operations.

## Phase 6 - Observability + risk hardening + panel polish (3-5 days)

- Kill switch, exposure limits, alert rules.
- Metrics panel, structured log viewer, and live tail filters.
- Config editor and settings UX polish.

## Phase 7 - Advanced capabilities (optional/feature-flagged, 3-5 days)

- PWA/offline cache for local resilience.
- Export chat/reporting, plugin hooks for custom panels, optional voice input.
- Accessibility hardening (ARIA, keyboard-only, high-contrast).

## Phase 8 - QA, performance, and release readiness (4-6 days)

- E2E suite stabilization, load testing, profiling, bug fixing.
- 24h websocket soak tests and reconnect verification.
- Docs, runbooks, migration notes, tagged release.

## 12.1) Current implementation status

- Phase 0 (Scope lock + foundation): **complete**
  - Workspace + tooling baseline (lint, format, typecheck, test), CI skeleton, shared contracts.
  - UI mode locked to **Hybrid** (dashboard-first + assistant chat panel).
- Phase 1 (Engine abstraction): **complete (MVP)**
  - Added process-based bot controller abstraction and wired CLI bot commands through controller runner.
  - Legacy direct scripts are preserved for fallback.
- Phase 2 (API service + realtime backbone): **complete (MVP)**
  - Fastify API bootstrap with health/config/lifecycle/logs/metrics + websocket stream endpoint.
  - Added persistence-backed config/secrets storage and audit trail (`GET /api/v1/audit`).
- Phase 3 (Web shell, theming, layout): **complete (MVP)**
  - Next.js app-router shell with responsive sidebar/topnav/main/right-panel layout and theme switching.
- Phase 4 (Sessions + streaming chat + tool cards): **complete (MVP)**
  - Searchable session management, command palette, keyboard shortcuts, streaming markdown chat, and tool-call timeline cards.
- Phase 5 (Risk/observability hardening): **complete (MVP)**
  - Added kill switch arm/reset endpoints, risk guardrails (max order/exposure checks), alert streaming, and audit visibility.
- Phase 6 (QA and optimization): **complete (MVP)**
  - Added API integration smoke tests, expanded schema/config regression coverage, and benchmark/soak scripts.
- Phase 7 (Release readiness): **complete (MVP)**
  - Added local operations runbook and migration notes for browser UI migration.
- Phase 8 (Final validation): **complete (MVP)**
  - Validation gates green, API latency benchmark under target, and websocket soak check passed.
- Next milestone:
  - Run extended 24h soak and cut tagged release for production rollout.

## 13) Definition of done (for "100% functional and efficient")

All items below must pass:

1. Browser UI can perform every major CLI operation without terminal interaction.
2. Dry-run and live modes are clearly separated and enforce confirmations.
3. No secret is exposed to frontend network payloads, local storage, or logs.
4. Bot lifecycle is stable across start/stop/restart and process crashes.
5. p95 API latency under 250ms for non-stream endpoints in local benchmarks.
6. Websocket stream remains stable for 24h soak test with reconnect handling.
7. Full automated test suite green in CI.
8. Operator docs cover install, config, backup, recovery, and incident response.

## 14) Branch and implementation workflow

Initial planning branch:

- `feat/browser-ui-implementation` (this branch)

Recommended implementation branches (stacked/parallel):

- `feat/ui-foundation-workspace`
- `feat/api-bot-manager`
- `feat/engine-controller-extraction`
- `feat/web-shell-theming-layout`
- `feat/web-sessions-sidebar`
- `feat/web-chat-streaming-tools`
- `feat/web-dashboard-mvp`
- `feat/web-strategy-forms`
- `feat/risk-observability-hardening`
- `feat/e2e-performance-suite`

Merge policy:

- Small, reviewable PRs with passing CI.
- No direct pushes to `main`.
- Feature flags for incomplete surfaces.

## 15) Immediate next actions

1. Approve this plan as baseline scope.
2. Lock UI mode as Hybrid for phase 1 delivery.
3. Complete API bootstrap (`health`, `config`, `bot lifecycle`, `stream`) against shared contracts.
4. Implement controller interfaces and wire current CLI scripts through them.
5. Build web shell first (`sidebar + topnav + main + right panel`) before deep feature polish.
