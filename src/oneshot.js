/**
 * src/oneshot.js
 * Dominant Side Hold Engine — main orchestrator entry point.
 *
 * Strategy: enter the probable winner (dominant side, mid >= minDominantMid),
 * hold the position until the market expires, then let redeemer.js claim
 * the on-chain payout.  There are no take-profit sells or momentum-based exits.
 *
 * Runtime sequence (per market, per tick):
 *   A → MarketFeedService emits 'snapshot'
 *   B → FeatureEngine processes snapshot, emits 'features'
 *   C+D → SignalEngine evaluates gates + dominant side, emits 'signal'
 *   E → Orchestrator submits FOK buy on ENTER signal
 *   F → Fill handling (full / partial / timeout)
 *   G → PositionEngine evaluates exit on each snapshot
 *   H → RiskEngine updated on emergency exits only
 *
 * State machine (per market):
 *   IDLE → SETUP_READY → ORDER_PENDING → POSITION_OPEN → IDLE (expired)
 *   POSITION_OPEN → IDLE (emergency stop-loss exit)
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
import { RedeemEngine }      from './oneshot/RedeemEngine.js';
import { State, Signal, ReasonCode } from './oneshot/constants.js';
import { DEBUG, dbg } from './oneshot/debug.js';

// ── Configuration ──────────────────────────────────────────────────────────────

const cfg = {
    assets:           (process.env.ONESHOT_ASSETS         || 'btc').split(',').map((s) => s.trim().toLowerCase()),
    duration:          process.env.ONESHOT_DURATION        || '5m',
    baseRiskUsdc:     parseFloat(process.env.ONESHOT_BASE_RISK_USDC    || '5'),
    minDominantMid:   parseFloat(process.env.ONESHOT_MIN_DOMINANT_MID  || '0.60'),
    stopLossMid:      parseFloat(process.env.ONESHOT_STOP_LOSS_MID     || '0.20'),
    scoreThreshold:   parseFloat(process.env.ONESHOT_SCORE_THRESHOLD   || '0.55'),
    pollIntervalMs:   parseInt(process.env.ONESHOT_POLL_INTERVAL_MS    || '300',  10),
    minTopSize:       parseFloat(process.env.ONESHOT_MIN_TOP_SIZE      || '10'),
    tteMin:           parseInt(process.env.ONESHOT_TTE_MIN             || '20',   10),
    tteMax:           parseInt(process.env.ONESHOT_TTE_MAX             || '90',   10),
    maxConsecLosses:  parseInt(process.env.ONESHOT_MAX_CONSEC_LOSSES   || '2',    10),
    cooldownRounds:   parseInt(process.env.ONESHOT_COOLDOWN_ROUNDS     || '3',    10),
    dailyLossCap:     parseFloat(process.env.ONESHOT_DAILY_LOSS_CAP    || '20'),
    fillTimeoutMs:    parseInt(process.env.ONESHOT_FILL_TIMEOUT_MS     || '800',  10),
    redeemPollMs:     parseInt(process.env.ONESHOT_REDEEM_POLL_MS      || '30000', 10),
    dryRun:           process.env.DRY_RUN !== 'false',
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
let redeemEngine;
let telemetry;

// ── Entry point ───────────────────────────────────────────────────────────────

async function main() {
    logger.success('=== OneShot Dominant Side Hold Engine starting ===');
    logger.info(`Assets: [${cfg.assets}] | Duration: ${cfg.duration} | DRY_RUN: ${cfg.dryRun}`);
    logger.info(
        `Strategy: enter dominant side (mid >= ${cfg.minDominantMid}) | ` +
        `TTE window: ${cfg.tteMin}–${cfg.tteMax}s | hold to expiry`,
    );
    logger.info(
        `Risk: baseRisk=$${cfg.baseRiskUsdc} | stopLoss=${cfg.stopLossMid > 0 ? cfg.stopLossMid : 'disabled'} | ` +
        `scoreMin=${cfg.scoreThreshold}`,
    );

    await initClient();
    const client = getClient();

    telemetry     = new Telemetry();
    redeemEngine  = new RedeemEngine({
        dryRun:         cfg.dryRun,
        pollIntervalMs: cfg.redeemPollMs,
        eventBus,
    });
    riskEngine   = new RiskEngine({
        maxConsecLosses: cfg.maxConsecLosses,
        cooldownRounds:  cfg.cooldownRounds,
        dailyLossCap:    cfg.dailyLossCap,
    });
    posEngine    = new PositionEngine({ stopLossMid: cfg.stopLossMid });
    execEngine   = new ExecutionEngine({ client, dryRun: cfg.dryRun, fillTimeoutMs: cfg.fillTimeoutMs });
    featureEngine = new FeatureEngine({ eventBus });
    signalEngine  = new SignalEngine({
        eventBus,
        scoreThreshold:  cfg.scoreThreshold,
        minTopSize:      cfg.minTopSize,
        minDominantMid:  cfg.minDominantMid,
        tteMin:          cfg.tteMin,
        tteMax:          cfg.tteMax,
    });
    feedService  = new MarketFeedService({
        client,
        assets:         cfg.assets,
        duration:       cfg.duration,
        pollIntervalMs: cfg.pollIntervalMs,
        eventBus,
    });

    // Wire orchestrator handlers
    eventBus.on('signal',           onSignal);
    eventBus.on('snapshot',         onSnapshotForPositionMgmt);
    eventBus.on('state:transition', onStateTransition);

    redeemEngine.start();
    await feedService.start();

    // Report final P&L when a redemption settles
    eventBus.on('redemption:complete', ({ marketSlug, won, pnl }) => {
        riskEngine.recordResult(pnl);
        logger.info(`[REDEEM] ${marketSlug} settled | ${won ? 'WIN' : 'LOSS'} | pnl=${won ? '+' : ''}$${pnl.toFixed(4)}`);
    });

    logger.success('OneShot Engine running — waiting for dominant side signals...');

    if (DEBUG) {
        logger.info(
            '[DBG] Debug mode active. Tags: FEED=discovery/poll, GATE=hard gates, ' +
            'SCORE=dominant side scoring, SIGNAL=entry trigger, SM=state changes, HEART=heartbeat',
        );
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

    // Only enter from IDLE — one position per market slot
    if (!sm.is(State.IDLE)) return;

    // Global position limit: never open a new position while any other market
    // is still being held. The engine is designed to focus on one bet at a time.
    if (posEngine.hasAnyPosition()) {
        dbg('SIGNAL', `${marketSlug} | blocked — position already open in another market`);
        return;
    }

    // ── Risk gate ─────────────────────────────────────────────────────────

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

    // Size: floor(baseRiskUSDC / entryPrice), minimum 5 shares
    const rawSize = cfg.baseRiskUsdc / entryPrice;
    const size    = Math.max(5, Math.floor(rawSize));

    logger.trade(
        `OneShot ENTER | ${signal} | ${marketSlug} | ` +
        `mid=${bookSide.mid.toFixed(4)} px=$${entryPrice} | size=${size} | score=${score.toFixed(3)} | tte=${snapshot.tteSec}s`,
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
                tokenId:     bookSide.tokenId,
                side,
                shares:      result.filledSize,
                entryPrice:  result.avgFillPrice || entryPrice,
                tickSize:    snapshot.tickSize,
                conditionId: snapshot.conditionId,
                negRisk:     snapshot.negRisk,
            });
            sm.transition(State.POSITION_OPEN, 'fill_confirmed');
            logger.success(
                `OneShot: position OPEN | ${marketSlug} | ` +
                `${result.filledSize} shares @ $${(result.avgFillPrice || entryPrice).toFixed(4)} | ` +
                `holding to expiry`,
            );

        } else if (result.status === 'partial' && result.filledSize > 0) {
            // Accept partial fill and hold to expiry
            posEngine.open(marketSlug, {
                tokenId:     bookSide.tokenId,
                side,
                shares:      result.filledSize,
                entryPrice:  result.avgFillPrice || entryPrice,
                tickSize:    snapshot.tickSize,
                conditionId: snapshot.conditionId,
                negRisk:     snapshot.negRisk,
            });
            sm.transition(State.POSITION_OPEN, 'partial_fill_accepted');
            logger.warn(`OneShot: partial fill accepted | ${result.filledSize}/${size} shares | holding to expiry`);

        } else {
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

async function onSnapshotForPositionMgmt(snapshot) {
    const { marketSlug, tteSec } = snapshot;
    const sm = stateMachines.get(marketSlug);
    if (!sm) return;

    // Clean up state machines for fully expired markets with no open position
    if (tteSec < -10 && sm.is(State.IDLE)) {
        stateMachines.delete(marketSlug);
        return;
    }

    if (!sm.is(State.POSITION_OPEN)) return;

    const pos = posEngine.getPosition(marketSlug);
    if (!pos) {
        if (sm.canTransitionTo(State.IDLE)) sm.transition(State.IDLE, 'position_missing');
        return;
    }

    // Evaluate exit conditions
    const exitResult = posEngine.evaluateExit(marketSlug, snapshot);

    // Market expired — position goes to on-chain redeemer
    if (exitResult.isExpired) {
        await expirePosition(marketSlug, pos);
        return;
    }

    // Emergency stop-loss (catastrophic market reversal)
    if (exitResult.shouldExit) {
        const bookSide = pos.side === 'up' ? snapshot.up : snapshot.down;
        await flattenPosition(marketSlug, pos, bookSide, exitResult.reason, snapshot);
    }
}

// ── Expire helper (market closed, pending on-chain redemption) ────────────────

async function expirePosition(marketSlug, pos) {
    const sm = stateMachines.get(marketSlug);
    if (!sm) return;

    logger.success(
        `OneShot: market EXPIRED | ${marketSlug} | ` +
        `${pos.shares} shares of ${pos.side.toUpperCase()} @ entry $${pos.entryPrice.toFixed(4)} | ` +
        `queuing for auto-redemption`,
    );

    posEngine.closeExpired(marketSlug);

    telemetry.logExit({
        marketSlug,
        exitReason: ReasonCode.EXIT_EXPIRED,
        entryPx:    pos.entryPrice,
        exitPx:     null,   // settled on-chain — see redemption:complete event
        pnl:        null,
        shares:     pos.shares,
    });

    // Hand off to RedeemEngine — it will poll until settled and report final P&L
    redeemEngine.queueRedemption({
        conditionId: pos.conditionId,
        marketSlug,
        side:        pos.side,
        shares:      pos.shares,
        entryPrice:  pos.entryPrice,
        negRisk:     pos.negRisk,
    });

    if (sm.canTransitionTo(State.IDLE)) {
        sm.transition(State.IDLE, ReasonCode.EXIT_EXPIRED);
    }
}

// ── Emergency flatten helper (adverse-move stop-loss only) ────────────────────

async function flattenPosition(marketSlug, pos, bookSide, reason, snapshot) {
    const sm = stateMachines.get(marketSlug);
    if (!sm || !sm.is(State.POSITION_OPEN)) return;

    const exitPrice = bookSide.bestBid;

    logger.warn(
        `OneShot: EMERGENCY EXIT | ${marketSlug} | reason=${reason} | ` +
        `mid=${bookSide.mid.toFixed(4)} exitPx=$${exitPrice.toFixed(4)}`,
    );

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

        const { ok, halted } = riskEngine.canTrade();

        if (halted && sm.canTransitionTo(State.HALTED)) {
            sm.transition(State.HALTED, ReasonCode.RISK_DAILY_CAP);
        } else if (!ok && riskEngine.isCooldown() && sm.canTransitionTo(State.COOLDOWN)) {
            sm.transition(State.COOLDOWN, ReasonCode.RISK_CONSEC_LOSS);
        } else {
            sm.transition(State.IDLE, `emergency_exit_${reason}`);
        }

    } catch (err) {
        logger.error(`OneShot: flatten error on ${marketSlug} — ${err.message}`);
    }
}

// ── State transition logging ──────────────────────────────────────────────────

function onStateTransition(evt) {
    telemetry.logTransition(evt);
    dbg('SM', `${evt.marketSlug}: ${evt.from} → ${evt.to} | ${evt.reason}`);
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
    redeemEngine?.stop();

    // Report any positions still open at shutdown
    const markets = feedService?.activeMarkets ?? [];
    for (const slug of markets) {
        const pos = posEngine?.getPosition(slug);
        if (pos) {
            logger.warn(
                `OneShot: position still open at shutdown — ${slug} | ` +
                `${pos.shares} shares @ $${pos.entryPrice.toFixed(4)} | redeemer.js will settle`,
            );
        }
    }

    const stats = riskEngine?.stats();
    if (stats) {
        const sign = stats.dailyPnl >= 0 ? '+' : '';
        logger.money(
            `Session summary | emergencyExitPnl=${sign}$${stats.dailyPnl.toFixed(4)} | ` +
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
