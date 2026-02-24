/**
 * StateMachine.js
 * Explicit per-market state machine with strict transition guards.
 *
 * Rule: never derive state from floating booleans.
 * Every state change must go through transition() to be validated and logged.
 */

import { State, TRANSITIONS } from './constants.js';

export class StateMachine {
    /**
     * @param {string} marketSlug  - Market identifier (used in error messages and logs)
     * @param {import('./EventBus.js').default} eventBus
     */
    constructor(marketSlug, eventBus) {
        this._state    = State.IDLE;
        this._slug     = marketSlug;
        this._eventBus = eventBus;
    }

    /** Current state string */
    get state() {
        return this._state;
    }

    /**
     * Attempt a state transition.
     * Throws if the transition is not in the allowed graph — this is intentional:
     * a programming error that bypasses the guard should be loud and traceable.
     *
     * @param {string} nextState - One of the State enum values
     * @param {string} [reason]  - Human-readable reason for the transition
     * @returns {StateMachine}   - Returns `this` for chaining
     */
    transition(nextState, reason = '') {
        const allowed = TRANSITIONS[this._state] ?? [];

        if (!allowed.includes(nextState)) {
            throw new Error(
                `[StateMachine] Invalid transition: ${this._state} → ${nextState}` +
                ` (market: ${this._slug}, reason: ${reason})`,
            );
        }

        const from = this._state;
        this._state = nextState;

        this._eventBus.emit('state:transition', {
            marketSlug: this._slug,
            from,
            to:     nextState,
            reason,
            ts:     Date.now(),
        });

        return this;
    }

    /** @param {string} state */
    is(state) {
        return this._state === state;
    }

    /** @param {string} state */
    canTransitionTo(state) {
        return (TRANSITIONS[this._state] ?? []).includes(state);
    }
}
