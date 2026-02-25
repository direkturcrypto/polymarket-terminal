import type { StreamEvent } from '@polymarket/shared';

import { getApiWsUrl } from './api';

export type StreamConnectionState = 'connecting' | 'connected' | 'disconnected';

interface StreamCallbacks {
  onStateChange: (state: StreamConnectionState) => void;
  onEvent: (event: StreamEvent) => void;
  onError: (message: string) => void;
}

const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 10_000;

export function createStreamConnection(callbacks: StreamCallbacks): () => void {
  let socket: WebSocket | null = null;
  let retryTimer: number | null = null;
  let retryAttempt = 0;
  let closed = false;
  const localToken = process.env.NEXT_PUBLIC_LOCAL_API_TOKEN?.trim();

  const connect = () => {
    if (closed) {
      return;
    }

    callbacks.onStateChange('connecting');

    const streamPath = '/api/v1/stream';
    const tokenQuery = localToken ? `?localToken=${encodeURIComponent(localToken)}` : '';
    const url = `${getApiWsUrl().replace(/\/$/, '')}${streamPath}${tokenQuery}`;
    socket = new WebSocket(url);

    socket.onopen = () => {
      retryAttempt = 0;
      callbacks.onStateChange('connected');
    };

    socket.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as StreamEvent;
        callbacks.onEvent(payload);
      } catch {
        callbacks.onError('Failed to parse stream payload');
      }
    };

    socket.onerror = () => {
      callbacks.onError('WebSocket stream error');
    };

    socket.onclose = () => {
      callbacks.onStateChange('disconnected');
      if (closed) {
        return;
      }

      const nextDelay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
      retryAttempt += 1;
      retryTimer = window.setTimeout(connect, nextDelay);
    };
  };

  connect();

  return () => {
    closed = true;

    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.close();
    }
  };
}
