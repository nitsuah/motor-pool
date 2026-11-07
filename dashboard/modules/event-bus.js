import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import { logStructured } from './logger.js';
import { persistEvent } from '../persistence.js';

const _eventStore = [];
const MAX_EVENTS = 10000;
const _eventSubscribers = new Set();

// Named pub/sub channels: Map<channelName, Set<listener>>
const _channelSubscribers = new Map();
const _channelHistory = new Map(); // Map<channelName, event[]>
const MAX_CHANNEL_HISTORY = 200;
const MAX_DISTINCT_CHANNELS = 500;

export const eventBus = {
  emit(type, data = {}) {
    const event = {
      event_id: randomUUID(),
      session_id: data.session_id || null,
      user_id: data.user_id || 'anonymous',
      timestamp: new Date().toISOString(),
      event_type: type,
      model: data.model || null,
      endpoint: data.endpoint || null,
      experience: data.experience || null,
      channel: data.channel || null,
      metadata: data.metadata || {},
    };
    _eventStore.push(event);
    if (_eventStore.length > MAX_EVENTS) _eventStore.shift();

    // Broadcast to all-event subscribers
    for (const listener of _eventSubscribers) {
      try { listener(event); } catch (err) {
        logStructured('warn', 'event_subscriber_failed', { error: err.message });
      }
    }

    // Route to named channel subscribers
    if (event.channel) {
      const subs = _channelSubscribers.get(event.channel);
      if (subs) {
        for (const listener of subs) {
          try { listener(event); } catch (err) {
            logStructured('warn', 'channel_subscriber_failed', { channel: event.channel, error: err.message });
          }
        }
      }
      // Persist channel history (cap distinct channels to prevent unbounded growth)
      if (!_channelHistory.has(event.channel)) {
        if (_channelHistory.size >= MAX_DISTINCT_CHANNELS) {
          const oldest = _channelHistory.keys().next().value;
          _channelHistory.delete(oldest);
        }
        _channelHistory.set(event.channel, []);
      }
      const hist = _channelHistory.get(event.channel);
      hist.push(event);
      if (hist.length > MAX_CHANNEL_HISTORY) hist.shift();
    }

    persistEvent(event, logStructured);
    return event;
  },

  /** Publish directly to a named channel (shorthand for emit with channel set) */
  publish(channel, type, data = {}) {
    return this.emit(type, { ...data, channel });
  },

  getAll() { return _eventStore; },
  getByType(type) { return _eventStore.filter(e => e.event_type === type); },
  getSince(iso) {
    const since = new Date(iso).getTime();
    return _eventStore.filter(e => new Date(e.timestamp).getTime() >= since);
  },
  subscribe(listener) {
    _eventSubscribers.add(listener);
    return () => _eventSubscribers.delete(listener);
  },

  /** Subscribe to a named channel. Returns unsubscribe function. */
  subscribeChannel(channel, listener) {
    if (!_channelSubscribers.has(channel)) _channelSubscribers.set(channel, new Set());
    _channelSubscribers.get(channel).add(listener);
    return () => {
      const subs = _channelSubscribers.get(channel);
      if (subs) { subs.delete(listener); if (subs.size === 0) _channelSubscribers.delete(channel); }
    };
  },

  /** List all known channels with subscriber count and recent event count */
  listChannels() {
    const channels = new Set([..._channelSubscribers.keys(), ..._channelHistory.keys()]);
    return [...channels].map(name => ({
      name,
      subscribers: _channelSubscribers.get(name)?.size || 0,
      recentEvents: _channelHistory.get(name)?.length || 0,
    }));
  },

  /** Get recent events for a channel */
  getChannelHistory(channel, limit = 50) {
    return (_channelHistory.get(channel) || []).slice(-limit);
  },
};

let wsEventServerAttached = false;

// verifyRequest(request) -> boolean, when given, must accept the upgrade (Host/Origin checks).
export function attachEventWebSocketServer(server, verifyRequest) {
  if (!server || wsEventServerAttached) return;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/ws/events')) {
      socket.destroy();
      return;
    }
    if (verifyRequest && !verifyRequest(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (client) => {
    client.send(JSON.stringify({ type: 'hello', timestamp: new Date().toISOString() }));

    // Per-client channel subscriptions
    const clientChannelUnsubs = new Map();

    client.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'subscribe_channel' && msg.channel) {
          const ch = String(msg.channel).slice(0, 128);
          if (!clientChannelUnsubs.has(ch)) {
            const unsub = eventBus.subscribeChannel(ch, (event) => {
              if (client.readyState === client.OPEN) {
                client.send(JSON.stringify({ type: 'channel_event', channel: ch, event }));
              }
            });
            clientChannelUnsubs.set(ch, unsub);
            client.send(JSON.stringify({ type: 'subscribed', channel: ch }));
          }
        } else if (msg.type === 'unsubscribe_channel' && msg.channel) {
          const ch = String(msg.channel).slice(0, 128);
          const unsub = clientChannelUnsubs.get(ch);
          if (unsub) { unsub(); clientChannelUnsubs.delete(ch); }
          client.send(JSON.stringify({ type: 'unsubscribed', channel: ch }));
        }
      } catch { /* ignore malformed messages */ }
    });

    client.on('close', () => {
      for (const unsub of clientChannelUnsubs.values()) unsub();
      clientChannelUnsubs.clear();
    });
  });

  const unsubscribe = eventBus.subscribe((event) => {
    const payload = JSON.stringify({ type: 'event', event });
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN) client.send(payload);
    });
  });

  server.on('close', () => {
    unsubscribe();
    wss.close();
    wsEventServerAttached = false;
  });

  wsEventServerAttached = true;
}
