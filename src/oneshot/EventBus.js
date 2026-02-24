/**
 * EventBus.js
 * Central event bus for the OneShot engine.
 * All inter-service communication flows through this singleton.
 *
 * Event catalogue:
 *   snapshot          MarketFeedService → FeatureEngine, orchestrator
 *   features          FeatureEngine     → SignalEngine, orchestrator
 *   signal            SignalEngine      → orchestrator
 *   state:transition  StateMachine      → orchestrator, Telemetry
 */

import { EventEmitter } from 'events';

class OneShotEventBus extends EventEmitter {}

const bus = new OneShotEventBus();

// Prevent memory-leak warnings for high subscriber counts across many markets
bus.setMaxListeners(50);

export default bus;
