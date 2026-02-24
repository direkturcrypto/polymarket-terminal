import WebSocket from 'ws';

const wsUrl = process.env.WS_URL ?? 'ws://127.0.0.1:18789/api/v1/stream';
const durationMs = Number.parseInt(process.env.DURATION_MS ?? '60000', 10);

if (!Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error('DURATION_MS must be a positive integer');
}

let closed = false;
let reconnects = 0;
let messages = 0;
let botStateEvents = 0;
let socket = null;
let reconnectTimer = null;

const startedAt = Date.now();

function scheduleReconnect() {
  if (closed) {
    return;
  }

  reconnects += 1;
  const delay = Math.min(1000 * reconnects, 10000);
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  if (closed) {
    return;
  }

  socket = new WebSocket(wsUrl);

  socket.on('message', (data) => {
    messages += 1;
    try {
      const payload = JSON.parse(data.toString());
      if (payload.topic === 'bot_state') {
        botStateEvents += 1;
      }
    } catch {
      // ignore malformed payload in soak loop
    }
  });

  socket.on('close', () => {
    scheduleReconnect();
  });

  socket.on('error', () => {
    scheduleReconnect();
  });
}

function closeAll() {
  closed = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.close();
  }
}

async function run() {
  console.log(`Starting WS soak on ${wsUrl} for ${durationMs}ms`);
  connect();

  await new Promise((resolve) => setTimeout(resolve, durationMs));
  closeAll();

  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  console.log(
    `WS soak summary: ${elapsedSeconds}s, reconnects=${reconnects}, messages=${messages}, bot_state=${botStateEvents}`,
  );

  if (botStateEvents === 0) {
    console.error('No bot_state events observed during soak window.');
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
