import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import { logStructured } from './logger.js';
import { persistEvent } from '../persistence.js';
import { eventVisibleTo } from './visibility.js';

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
const canReceive = (client) => Boolean(client.principal) || client.gateOk !== false;
const MAX_WS_AUTH_FAILURES = 5;
const WS_REVALIDATE_MS = Number(process.env.WS_PRINCIPAL_REVALIDATE_MS) || 30_000;
const WS_AUTH_TIMEOUT_MS = Number(process.env.WS_AUTH_TIMEOUT_MS) || 10_000;

const principalSummary = (p) => (p ? { id: p.id, role: p.role } : null);

/**
 * verifyRequest(request, principal) -> boolean, when given, must accept the
 * upgrade (Host/Origin checks; dashboard auth too when isGateAuthorized is not given).
 * isGateAuthorized(request) -> boolean, when given, is the dashboard gate. A
 * socket that fails it and has no principal is still upgraded so it can send
 * `{ type: 'auth', token }`, but it receives no events and cannot subscribe
 * until it authenticates, and it is closed after WS_AUTH_TIMEOUT_MS.
 * authenticate(request) -> Promise<principal|null> attributes the socket to a
 * principal from its upgrade headers; authenticateToken(token) does the same
 * for a later `{ type: 'auth', token }` message. Job events (`job_*`) reach a
 * socket only when its principal may see the job (see visibility.js); a socket
 * without a principal gets no job events at all. revalidate(principal) ->
 * Promise<principal|null> is re-run on every attributed socket periodically,
 * so a revoked or expired token stops receiving job events.
 */
export function attachEventWebSocketServer(server, verifyRequest, { authenticate, authenticateToken, revalidate, isGateAuthorized } = {}) {
  if (!server || wsEventServerAttached) return;

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    if (!request.url?.startsWith('/ws/events')) {
      socket.destroy();
      return;
    }
    let principal = null;
    if (authenticate) {
      try { principal = await authenticate(request); } catch { principal = null; }
    }
    if (socket.destroyed) return;
    if (verifyRequest && !verifyRequest(request, principal)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const gateOk = isGateAuthorized ? Boolean(isGateAuthorized(request)) : true;
    wss.handleUpgrade(request, socket, head, (client) => {
      client.principal = principal;
      client.gateOk = gateOk;
      wss.emit('connection', client, request);
    });
  });

  wss.on('connection', (client) => {
    client.principal ??= null;
    client.gateOk ??= true;
    client.send(JSON.stringify({ type: 'hello', timestamp: new Date().toISOString(), principal: principalSummary(client.principal) }));
    let authFailures = 0;
    // A socket admitted only to authenticate must do so promptly.
    const authTimer = canReceive(client) ? null : setTimeout(() => {
      if (!canReceive(client) && client.readyState === client.OPEN) client.close(1008, 'Unauthorized');
    }, WS_AUTH_TIMEOUT_MS);
    authTimer?.unref?.();

    // Per-client channel subscriptions
    const clientChannelUnsubs = new Map();

    client.on('message', async (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'auth') {
          const principal = authenticateToken && typeof msg.token === 'string'
            ? await authenticateToken(msg.token).catch(() => null)
            : null;
          if (client.readyState !== client.OPEN) return;
          if (principal) {
            authFailures = 0;
            client.principal = principal;
            client.send(JSON.stringify({ type: 'authenticated', principal: principalSummary(principal) }));
          } else {
            authFailures += 1;
            client.send(JSON.stringify({ type: 'auth_failed' }));
            if (authFailures >= MAX_WS_AUTH_FAILURES) client.close(1008, 'Unauthorized');
          }
        } else if (!canReceive(client)) {
          client.send(JSON.stringify({ type: 'auth_required' }));
        } else if (msg.type === 'subscribe_channel' && msg.channel) {
          const ch = String(msg.channel).slice(0, 128);
          if (!clientChannelUnsubs.has(ch)) {
            const unsub = eventBus.subscribeChannel(ch, (event) => {
              if (client.readyState === client.OPEN && canReceive(client) && eventVisibleTo(event, client.principal)) {
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
      if (authTimer) clearTimeout(authTimer);
      for (const unsub of clientChannelUnsubs.values()) unsub();
      clientChannelUnsubs.clear();
    });
  });

  const unsubscribe = eventBus.subscribe((event) => {
    const payload = JSON.stringify({ type: 'event', event });
    wss.clients.forEach((client) => {
      if (client.readyState === client.OPEN && canReceive(client) && eventVisibleTo(event, client.principal)) client.send(payload);
    });
  });

  let revalidating = false;
  const revalidateTimer = revalidate ? setInterval(async () => {
    if (revalidating) return;
    revalidating = true;
    try {
      for (const client of wss.clients) {
        if (!client.principal) continue;
        const before = client.principal;
        const current = await revalidate(before).catch(() => null);
        if (client.principal !== before) continue; // re-authenticated meanwhile
        client.principal = current;
        if (!current && client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: 'auth_expired' }));
          if (!client.gateOk) client.close(1008, 'Unauthorized');
        }
      }
    } finally {
      revalidating = false;
    }
  }, WS_REVALIDATE_MS) : null;
  revalidateTimer?.unref?.();

  server.on('close', () => {
    if (revalidateTimer) clearInterval(revalidateTimer);
    unsubscribe();
    wss.close();
    wsEventServerAttached = false;
  });

  wsEventServerAttached = true;
}
