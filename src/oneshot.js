/**
 * src/oneshot.js
 * Anti-Flip 5m OneShot Engine — main orchestrator entry point.
 *
 * Wires all seven engine services together via the central EventBus and
 * manages a per-market StateMachine lifecycle.
 *
 * Runtime sequence (per market, per tick):
 *   A → MarketFeedService emits 'snapshot'
 *   B → FeatureEngine processes snapshot, emits 'features'
 *   C+D → SignalEngine evaluates gates + score, emits 'signal'
 *   E → Orchestrator submits order on ENTER signal
 *   F → Fill handling (full / partial / timeout)
 *   G → PositionEngine evaluates exit on each snapshot
 *   H → RiskEngine updated on every close
 *
 * State machine (per market):
 *   IDLE → SETUP_READY → ORDER_PENDING → POSITION_OPEN → REDUCE_ONLY → IDLE
 *   ANY → COOLDOWN → IDLE
 *   ANY → HALTED  (terminal for the session)
 */

import { initClient, getClient } from './services/client.js';
import logger from './utils/logger.js';

import eventBus             from './oneshot/EventBus.js';
import { StateMachine }     from './oneshot/StateMachine.js';
import { MarketFeedService } from './oneshot/MarketFeedService.js';
import { FeatureEngine }    from './oneshot/FeatureEngine.js';
import { SignalEngine }     from './oneshot/SignalEngine.js';
import { ExecutionEngine }  from './oneshot/ExecutionEngine.js';
import { RiskEngine }       from './oneshot/RiskEngine.js';
import { PositionEngine }   from './oneshot/PositionEngine.js';
import { Telemetry }        from './oneshot/Telemetry.js';
import { State, Signal, ReasonCode } from './oneshot/constants.js';
import { DEBUG, dbg } from './oneshot/debug.js';

// ── Configuration ──────────────────────────────────────────────────────────────
// All values read from .env.  Sensible defaults are provided for optional fields.

const cfg = {
    assets:          (process.env.ONESHOT_ASSETS        || 'btc').split(',').map((s) => s.trim().toLowerCase()),
    duration:         process.env.ONESHOT_DURATION       || '5m',
    baseRiskUsdc:    parseFloat(process.env.ONESHOT_BASE_RISK_USDC   || '5'),
    tpTicks:         parseInt(process.env.ONESHOT_TP_TICKS           || '1',  10),
    scoreThreshold:  parseFloat(process.env.ONESHOT_SCORE_THRESHOLD  || '0.60'),
    pollIntervalMs:  parseInt(process.env.ONESHOT_POLL_INTERVAL_MS   || '300', 10),
    minTopSize:      parseFloat(process.env.ONESHOT_MIN_TOP_SIZE      || '10'),
    maxConsecLosses: parseInt(process.env.ONESHOT_MAX_CONSEC_LOSSES  || '2',  10),
    cooldownRounds:  parseInt(process.env.ONESHOT_COOLDOWN_ROUNDS    || '3',  10),
    dailyLossCap:    parseFloat(process.env.ONESHOT_DAILY_LOSS_CAP   || '20'),
    fillTimeoutMs:   parseInt(process.env.ONESHOT_FILL_TIMEOUT_MS    || '800', 10),
    dryRun:          process.env.DRY_RUN !== 'false',
};

// ── Per-market state ───────────────────────────────────────────────────────────

/** @type {Map<string, StateMachine>} */
const stateMachines = new Map();

// ── Service instances ─────────────────────────────────────────────────────────

let feedService;
let featureEngine;
let signalEngine;
let execEngine;
let riskEngine;
let posEngine;
let telemetry;

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
    logger.success('=== OneShot Anti-Flip Engine starting ===');
    logger.info(`Assets: [${cfg.assets}] | Duration: ${cfg.duration} | DRY_RUN: ${cfg.dryRun}`);
    logger.info(`Risk: baseRisk=$${cfg.baseRiskUsdc} | tpTicks=${cfg.tpTicks} | scoreMin=${cfg.scoreThreshold}`);

    await initClient();
    const client = getClient();

    // Initialise all services
    telemetry    = new Telemetry();
    riskEngine   = new RiskEngine({
        maxConsecLosses: cfg.maxConsecLosses,
        cooldownRounds:  cfg.cooldownRounds,
        dailyLossCap:    cfg.dailyLossCap,
    });
    posEngine    = new PositionEngine({ tpTicks: cfg.tpTicks });
    execEngine   = new ExecutionEngine({ client, dryRun: cfg.dryRun, fillTimeoutMs: cfg.fillTimeoutMs });
    featureEngine = new FeatureEngine({ eventBus });
    signalEngine  = new SignalEngine({
        eventBus,
        scoreThreshold: cfg.scoreThreshold,
        minTopSize:     cfg.minTopSize,
    });
    feedService  = new MarketFeedService({
        client,
        assets:          cfg.assets,
        duration:        cfg.duration,
        pollIntervalMs:  cfg.pollIntervalMs,
        eventBus,
    });

    // Wire orchestrator handlers
    eventBus.on('signal',           onSignal);
    eventBus.on('snapshot',         onSnapshotForPositionMgmt);
    eventBus.on('state:transition', onStateTransition);

    await feedService.start();
    logger.success('OneShot Engine running — waiting for market signals...');

    if (DEBUG) {
        logger.info('[DBG] Debug mode active. Tags: FEED=discovery/poll, GATE=hard gates, FEAT=features, SCORE=scores, SIGNAL=entry trigger, SM=state changes');
        // Heartbeat: every 5s log the overall engine status
        setInterval(() => {
            const markets = feedService.activeMarkets;
            const states  = markets.map((slug) => {
                const sm = stateMachines.get(slug);
                return `${slug.split('-')[0]}:${sm?.state ?? 'none'}`;
            }).join(' | ') || '(none)';
            const risk = riskEngine.stats();
            dbg('HEART',
                `active=${markets.length} | states=[${states}] | ` +
                `dailyPnl=$${risk.dailyPnl.toFixed(4)} | consec=${risk.consecLosses} | ` +
                `cooldown=${risk.cooldownLeft} | halted=${risk.halted}`,
            );
        }, 5_000);
    }

    process.on('SIGINT',  shutdown);
    process.on('SIGTERM', shutdown);
}

// ── Signal handler (Steps C/D/E/F) ───────────────────────────────────────────

/**
 * Process a signal emitted by SignalEngine.
 * Coordinates state transitions and order submission for the target market.
 */
async function onSignal(evt) {
    const { marketSlug, signal, side, score, reason, snapshot, features } = evt;

    const sm = getOrCreateSM(marketSlug);

    // Log every evaluation tick for later analysis
    const sideFeatures = side ? features[side] : (features.up ?? features.down ?? {});
    telemetry.logDecision({
        marketSlug,
        ts:         snapshot.ts,
        tteSec:     snapshot.tteSec,
        spread:     sideFeatures.spread       ?? 0,
        imbalance:  sideFeatures.imbalance    ?? 0,
        slope:      sideFeatures.midSlope6s   ?? 0,
        retrace:    sideFeatures.retrace3s    ?? 0,
        depth:      sideFeatures.depthTop3    ?? 0,
        gatePass:   signal !== Signal.NO_TRADE,
        reasonCode: reason ?? '',
        score,
        action:     signal,
    });

    if (signal === Signal.NO_TRADE) return;

    // Only enter from IDLE
    if (!sm.is(State.IDLE)) return;

    // ── Step H pre-check: risk gate ────────────────────────────────────────
    const riskCheck = riskEngine.canTrade();

    if (!riskCheck.ok) {
        if (riskCheck.halted && sm.canTransitionTo(State.HALTED)) {
            sm.transition(State.HALTED, ReasonCode.RISK_DAILY_CAP);
        } else if (riskEngine.isCooldown()) {
            riskEngine.decrementCooldown();
        }
        return;
    }

    // ── Step E: order submission ───────────────────────────────────────────
    const bookSide   = side === 'up' ? snapshot.up : snapshot.down;
    const entryPrice = bookSide.bestAsk;

    // Size per spec: floor(baseRiskUSDC / entryPrice), clamped to ≥ 5 shares
    const rawSize = cfg.baseRiskUsdc / entryPrice;
    const size    = Math.max(5, Math.floor(rawSize));

    logger.trade(
        `OneShot ENTER | ${signal} | ${marketSlug} | ` +
        `px=$${entryPrice} | size=${size} | score=${score.toFixed(3)} | tte=${snapshot.tteSec}s`,
    );

    sm.transition(State.SETUP_READY, 'signal_passed');

    try {
        sm.transition(State.ORDER_PENDING, 'submitting');

        const result = await execEngine.submitBuy({
            tokenId:    bookSide.tokenId,
            size,
            price:      entryPrice,
            marketSlug,
        });

        // Log order lifecycle
        telemetry.logOrder({
            clientOrderId: result.orderId,
            side:          signal,
            marketSlug,
            px:            entryPrice,
            qty:           size,
            ackMs:         result.ackMs,
            fillMs:        result.fillMs,
            status:        result.status,
        });

        // ── Step F: fill handling ──────────────────────────────────────────
        if (result.status === 'filled') {
            posEngine.open(marketSlug, {
                tokenId:    bookSide.tokenId,
                side,
                shares:     result.filledSize,
                entryPrice: result.avgFillPrice || entryPrice,
                tickSize:   snapshot.tickSize,
            });
            sm.transition(State.POSITION_OPEN, 'fill_confirmed');
            logger.success(
                `OneShot: position OPEN | ${marketSlug} | ` +
                `${result.filledSize} shares @ $${(result.avgFillPrice || entryPrice).toFixed(4)}`,
            );

        } else if (result.status === 'partial' && result.filledSize > 0) {
            if (snapshot.tteSec <= 25) {
                // Immediate reduce-only: close the partial fill right away
                logger.warn(`OneShot: partial fill + low TTE (${snapshot.tteSec}s) — reducing immediately`);
                await execEngine.submitSell({
                    tokenId:    bookSide.tokenId,
                    size:       result.filledSize,
                    price:      bookSide.bestBid,
                    marketSlug,
                });
                sm.transition(State.IDLE, ReasonCode.EXEC_PARTIAL_REDUCE);
            } else {
                // Accept partial and manage as a smaller position
                posEngine.open(marketSlug, {
                    tokenId:    bookSide.tokenId,
                    side,
                    shares:     result.filledSize,
                    entryPrice: result.avgFillPrice || entryPrice,
                    tickSize:   snapshot.tickSize,
                });
                sm.transition(State.POSITION_OPEN, 'partial_fill_accepted');
                logger.warn(`OneShot: partial fill accepted | ${result.filledSize}/${size} shares`);
            }

        } else {
            // FOK timed out or was cancelled
            logger.warn(`OneShot: no fill on ${marketSlug} — returning to IDLE`);
            sm.transition(State.IDLE, ReasonCode.EXEC_TIMEOUT_NO_FILL);
        }

    } catch (err) {
        logger.error(`OneShot: order error on ${marketSlug} — ${err.message}`);
        if (sm.is(State.ORDER_PENDING) || sm.is(State.SETUP_READY)) {
            sm.transition(State.IDLE, ReasonCode.EXEC_SUBMIT_ERROR);
        }
    }
}

// ── Position management handler (Step G) ──────────────────────────────────────

/**
 * Called on every snapshot tick.
 * If the market has an open position, evaluates exit conditions and
 * coordinates exits through ExecutionEngine.
 */
async function onSnapshotForPositionMgmt(snapshot) {
    const { marketSlug, tteSec } = snapshot;
    const sm = stateMachines.get(marketSlug);
    if (!sm) return;

    // Remove state machines for fully expired markets
    if (tteSec <= 0 && sm.is(State.IDLE)) {
        stateMachines.delete(marketSlug);
        return;
    }

    if (!sm.is(State.POSITION_OPEN) && !sm.is(State.REDUCE_ONLY)) return;

    const pos = posEngine.getPosition(marketSlug);
    if (!pos) {
        // Position state is gone but SM isn't — recover gracefully
        if (sm.canTransitionTo(State.IDLE)) sm.transition(State.IDLE, 'position_missing');
        return;
    }

    const features   = featureEngine.getLatest(marketSlug);
    const bookSide   = pos.side === 'up' ? snapshot.up : snapshot.down;

    // Evaluate exit conditions
    const exitResult = posEngine.evaluateExit(marketSlug, snapshot, features);

    // Transition to REDUCE_ONLY when TTE window triggers
    if (exitResult.isReduceOnly && sm.is(State.POSITION_OPEN)) {
        sm.transition(State.REDUCE_ONLY, ReasonCode.EXIT_TIME_REDUCE);
    }

    // Execute exit if required
    if (exitResult.shouldExit) {
        await flattenPosition(marketSlug, pos, bookSide, exitResult.reason, snapshot);
    }
}

// ── Flatten helper ────────────────────────────────────────────────────────────

async function flattenPosition(marketSlug, pos, bookSide, reason, snapshot) {
    const sm = stateMachines.get(marketSlug);
    if (!sm || (!sm.is(State.POSITION_OPEN) && !sm.is(State.REDUCE_ONLY))) return;

    const exitPrice = bookSide.bestBid;

    logger.warn(`OneShot: flattening ${marketSlug} | reason=${reason} | exitPx=$${exitPrice}`);

    try {
        await execEngine.submitSell({
            tokenId:    pos.tokenId,
            size:       pos.shares,
            price:      exitPrice,
            marketSlug,
        });

        const exitData = posEngine.close(marketSlug, exitPrice);
        riskEngine.recordResult(exitData.pnl);

        telemetry.logExit({
            marketSlug,
            exitReason: reason,
            entryPx:    pos.entryPrice,
            exitPx:     exitPrice,
            pnl:        exitData.pnl,
            shares:     pos.shares,
        });

        // Determine next state after close
        const { ok, halted } = riskEngine.canTrade();

        if (halted && sm.canTransitionTo(State.HALTED)) {
            sm.transition(State.HALTED, ReasonCode.RISK_DAILY_CAP);
        } else if (!ok && riskEngine.isCooldown() && sm.canTransitionTo(State.COOLDOWN)) {
            sm.transition(State.COOLDOWN, ReasonCode.RISK_CONSEC_LOSS);
        } else {
            sm.transition(State.IDLE, `closed_${reason}`);
        }

    } catch (err) {
        logger.error(`OneShot: flatten error on ${marketSlug} — ${err.message}`);
    }
}

// ── State transition logging ──────────────────────────────────────────────────

function onStateTransition(evt) {
    telemetry.logTransition(evt);
    logger.info(`[SM] ${evt.marketSlug}: ${evt.from} → ${evt.to} | ${evt.reason}`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getOrCreateSM(marketSlug) {
    if (!stateMachines.has(marketSlug)) {
        stateMachines.set(marketSlug, new StateMachine(marketSlug, eventBus));
    }
    return stateMachines.get(marketSlug);
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

async function shutdown() {
    logger.warn('OneShot: shutting down...');
    feedService?.stop();

    const stats = riskEngine?.stats();
    if (stats) {
        const sign = stats.dailyPnl >= 0 ? '+' : '';
        logger.money(
            `Session summary | dailyPnl=${sign}$${stats.dailyPnl.toFixed(4)} | ` +
            `consecLosses=${stats.consecLosses} | halted=${stats.halted}`,
        );
    }

    process.exit(0);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

main().catch((err) => {
    logger.error(`OneShot fatal: ${err.message}`);
    process.exit(1);
});
