/**
 * constants.js
 * Shared enums and reason codes for the Anti-Flip 5m OneShot Engine.
 * All objects are frozen to prevent accidental mutation at runtime.
 */

// ── State machine states ───────────────────────────────────────────────────────

export const State = Object.freeze({
    IDLE:           'IDLE',           // Waiting for a qualifying signal
    SETUP_READY:    'SETUP_READY',    // Signal passed — about to submit order
    ORDER_PENDING:  'ORDER_PENDING',  // Order submitted, awaiting fill ack
    POSITION_OPEN:  'POSITION_OPEN',  // Filled — actively managing position
    REDUCE_ONLY:    'REDUCE_ONLY',    // Time threshold reached — exit only, no new entry
    COOLDOWN:       'COOLDOWN',       // Short suspension after consecutive losses
    HALTED:         'HALTED',         // Daily stop-loss hit — no more trading today
});

// ── Reason / decision codes ────────────────────────────────────────────────────

export const ReasonCode = Object.freeze({
    // Hard gate failures
    GATE_TTE_FAIL:          'GATE_TTE_FAIL',          // TTE outside [25, 120] range
    GATE_SPREAD_WIDE:       'GATE_SPREAD_WIDE',       // Spread exceeds maximum threshold
    GATE_DEPTH_THIN:        'GATE_DEPTH_THIN',        // Best bid/ask size below minimum
    GATE_STALE_BOOK:        'GATE_STALE_BOOK',        // Book snapshot is stale or empty

    // Signal evaluation failures
    SIG_SCORE_LOW:          'SIG_SCORE_LOW',          // Composite score below threshold
    SIG_NO_CONFIRM:         'SIG_NO_CONFIRM',         // Trend confirmation failed (legacy)
    SIG_NO_DOMINANT:        'SIG_NO_DOMINANT',        // Neither side is clearly dominant (mid gap too small)
    SIG_LOW_DOMINANT:       'SIG_LOW_DOMINANT',       // Dominant side mid below minimum threshold

    // Execution failures
    EXEC_TIMEOUT_NO_FILL:   'EXEC_TIMEOUT_NO_FILL',   // FOK timed out without fill
    EXEC_PARTIAL_REDUCE:    'EXEC_PARTIAL_REDUCE',    // Partial fill reduced & closed
    EXEC_SUBMIT_ERROR:      'EXEC_SUBMIT_ERROR',      // Order submission threw error

    // Risk policy
    RISK_CONSEC_LOSS:       'RISK_CONSEC_LOSS',       // Consecutive loss limit triggered cooldown
    RISK_DAILY_CAP:         'RISK_DAILY_CAP',         // Daily loss cap reached — halted
    RISK_STATE_BLOCK:       'RISK_STATE_BLOCK',       // Risk engine blocked entry (cooldown/halted)

    // Exit reasons
    EXIT_ADVERSE_MOVE:      'EXIT_ADVERSE_MOVE',      // Token mid collapsed below stop-loss floor
    EXIT_EXPIRED:           'EXIT_EXPIRED',           // Market expired — position pending on-chain redemption
    EXIT_RISK_FORCED:       'EXIT_RISK_FORCED',       // Risk engine forced exit
});

// ── Signal directions ──────────────────────────────────────────────────────────

export const Signal = Object.freeze({
    NO_TRADE:    'NO_TRADE',    // Conditions not met — skip
    ENTER_LONG:  'ENTER_LONG',  // Buy UP token
    ENTER_SHORT: 'ENTER_SHORT', // Buy DOWN token
});

// ── Valid state transitions ────────────────────────────────────────────────────
// Used by StateMachine to enforce the explicit transition graph.

export const TRANSITIONS = Object.freeze({
    [State.IDLE]:           [State.SETUP_READY, State.COOLDOWN, State.HALTED],
    [State.SETUP_READY]:    [State.ORDER_PENDING, State.IDLE, State.COOLDOWN, State.HALTED],
    [State.ORDER_PENDING]:  [State.POSITION_OPEN, State.IDLE, State.COOLDOWN, State.HALTED],
    [State.POSITION_OPEN]:  [State.REDUCE_ONLY, State.IDLE, State.COOLDOWN, State.HALTED],
    [State.REDUCE_ONLY]:    [State.IDLE, State.COOLDOWN, State.HALTED],
    [State.COOLDOWN]:       [State.IDLE, State.HALTED],
    [State.HALTED]:         [],
});
