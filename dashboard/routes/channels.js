/**
 * Named pub/sub event channels API
 *
 * GET  /api/channels               — list active channels
 * GET  /api/channels/:name/history — recent events for a channel (up to 200)
 * POST /api/channels/:name/publish — publish an event to a named channel
 */
import express from 'express';

const CHANNEL_NAME_RE = /^[a-zA-Z0-9_.-]{1,128}$/;

export function createChannelsRouter({ eventBus, logStructured }) {
  const router = express.Router();

  router.get('/channels', (req, res) => {
    res.json({ success: true, channels: eventBus.listChannels() });
  });

  router.get('/channels/:name/history', (req, res) => {
    const { name } = req.params;
    if (!CHANNEL_NAME_RE.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid channel name' });
    }
    const limit = Math.max(1, Math.min(Math.floor(Number(req.query.limit)) || 50, 200));
    const events = eventBus.getChannelHistory(name, limit);
    res.json({ success: true, channel: name, events, count: events.length });
  });

  router.post('/channels/:name/publish', (req, res) => {
    const { name } = req.params;
    if (!CHANNEL_NAME_RE.test(name)) {
      return res.status(400).json({ success: false, error: 'Invalid channel name' });
    }
    const { event_type, metadata = {}, session_id } = req.body || {};
    if (!event_type || typeof event_type !== 'string') {
      return res.status(400).json({ success: false, error: 'event_type is required' });
    }
    const event = eventBus.publish(name, String(event_type).slice(0, 128), {
      metadata: typeof metadata === 'object' ? metadata : {},
      session_id: session_id || null,
    });
    logStructured('info', 'channel_published', { channel: name, event_type: event.event_type });
    res.json({ success: true, channel: name, event });
  });

  return router;
}
