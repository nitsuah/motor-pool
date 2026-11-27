import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getStatus, summarizeStatus } from '../utils/tokenEconomizerApi.js';

const HEADLINES = {
  disabled: 'Disabled. Enable the tokeneconomizer plugin to use it.',
  'not installed': 'The tokeneconomizer plugin is not installed.',
  unreachable: 'Unreachable. The plugin backend did not answer.',
};

/** Status-only TokenEconomizer dropdown. It has no settings and no actions. */
export default function TokenEconomizerPanel() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(null);
  const wrapRef = useRef(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setState(null);
    const next = await getStatus();
    // A slower, older request must not overwrite a newer answer.
    if (request === requestRef.current) setState(next);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const lines = state?.ok ? summarizeStatus(state.status) : [];
  // Say "unmeasured" only when the backend reported no savings field of its own.
  const reportsSavings = lines.some(line => /^[^:]*saving/i.test(line));

  return (
    <div className="topbar-new-wrap" ref={wrapRef} style={{ marginRight: '0.1rem' }}>
      <button
        className="topbar-chat-btn"
        aria-expanded={open}
        onClick={() => { setOpen(p => !p); if (!open) refresh(); }}
        title="TokenEconomizer status"
      >
        TokenEconomizer <span className="topbar-logo-caret">▾</span>
      </button>
      {open && (
        <div className="topbar-new-panel" style={{ minWidth: '16rem' }} role="status">
          <div className="topbar-new-section-label">TokenEconomizer</div>
          <div style={{ fontSize: '0.75rem', padding: '0.35rem 0' }}>
            {state === null && 'Checking…'}
            {state?.ok && 'Enabled and reachable.'}
            {state && !state.ok && (HEADLINES[state.reason] || HEADLINES.unreachable)}
          </div>
          {lines.map(line => (
            <div key={line} style={{ fontSize: '0.7rem', opacity: 0.75, overflowWrap: 'anywhere' }}>{line}</div>
          ))}
          {state?.ok && !reportsSavings && (
            <div style={{ fontSize: '0.7rem', opacity: 0.6, marginTop: '0.35rem' }}>Token savings: unmeasured</div>
          )}
        </div>
      )}
    </div>
  );
}
