import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from './Toast.jsx';

/**
 * Launch a parallel agent in its own tmux window + git worktree.
 *
 * Backed by /api/worktrees. Self-contained: owns its own fetch/state so the
 * topbar only has to render it. When AGENT_BOARD_ENABLE_TMUX is not set the
 * API reports enabled:false and this renders a disabled button with the hint.
 */
export default function WorktreeLauncher() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ enabled: false, worktrees: [], naming: null, tmuxAvailable: false, authRequired: false });
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/worktrees');
      if (res.status === 401 || res.status === 403) {
        setState(s => ({ ...s, enabled: false, worktrees: [], authRequired: true }));
        return;
      }
      const data = await res.json();
      if (data.success) {
        setState({
          authRequired: false,
          enabled: !!data.enabled,
          worktrees: data.worktrees || [],
          naming: data.naming || null,
          tmuxAvailable: !!data.tmuxAvailable,
        });
      }
    } catch { /* dashboard works fine without the worktree API */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Close on outside click, matching the other topbar dropdowns.
  useEffect(() => {
    if (!open) return undefined;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const launch = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch('/api/worktrees', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), command: command.trim() || null }),
      });
      const data = await res.json();
      if (data.success) {
        toast(`Agent launched in ${data.worktree.target}`, 'success');
        if (data.warning) toast(data.warning, 'warn');
        setName('');
        setCommand('');
        refresh();
      } else {
        toast(data.error || 'Failed to launch agent worktree', 'error');
      }
    } catch (err) {
      toast(`Failed to launch agent worktree: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const stop = async (slug) => {
    try {
      const res = await fetch(`/api/worktrees/${encodeURIComponent(slug)}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) { toast(`Stopped ${slug}`, 'success'); refresh(); }
      else toast(data.error || 'Failed to stop worktree', 'error');
    } catch (err) {
      toast(`Failed to stop worktree: ${err.message}`, 'error');
    }
  };

  return (
    <div className="topbar-new-wrap" ref={wrapRef} style={{ marginRight: '0.1rem' }}>
      <button
        className="topbar-chat-btn"
        onClick={() => { setOpen(p => !p); if (!open) refresh(); }}
        title="Launch a parallel agent in its own tmux window and git worktree"
      >
        Agents{state.worktrees.length > 0 ? ` (${state.worktrees.length})` : ''} <span className="topbar-logo-caret">▾</span>
      </button>

      {open && (
        <div className="topbar-new-panel" style={{ minWidth: '18rem' }}>
          <div className="topbar-new-section-label">Launch agent worktree</div>

          {state.authRequired ? (
            <div style={{ fontSize: '0.75rem', opacity: 0.75, padding: '0.35rem 0' }}>
              Worktrees need an operator or superadmin API token. Sign out and sign in with your <code>mp_…</code> token.
            </div>
          ) : !state.enabled ? (
            <div style={{ fontSize: '0.75rem', opacity: 0.75, padding: '0.35rem 0' }}>
              tmux worktrees are disabled. Set <code>AGENT_BOARD_ENABLE_TMUX=true</code> on the dashboard to enable.
            </div>
          ) : (
            <>
              <input
                className="session-search-input"
                style={{ width: '100%', marginBottom: '0.35rem' }}
                type="text"
                placeholder="Agent name (e.g. refactor-auth)"
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch(); }}
              />
              <input
                className="session-search-input"
                style={{ width: '100%', marginBottom: '0.35rem' }}
                type="text"
                placeholder="Startup command (optional)"
                value={command}
                onChange={e => setCommand(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') launch(); }}
              />
              {state.naming && (
                <div style={{ fontSize: '0.68rem', opacity: 0.6, marginBottom: '0.35rem' }}>
                  → tmux <code>{state.naming.targetPattern}</code> · branch <code>{state.naming.branchPattern}</code>
                </div>
              )}
              {!state.tmuxAvailable && (
                <div style={{ fontSize: '0.7rem', color: 'var(--warn, #d19a2f)', marginBottom: '0.35rem' }}>
                  tmux not detected on the dashboard host.
                </div>
              )}
              <button
                className="btn-primary"
                style={{ width: '100%' }}
                disabled={busy || !name.trim()}
                onClick={launch}
              >{busy ? 'Launching…' : '+ Launch Agent'}</button>
            </>
          )}

          {state.worktrees.length > 0 && (
            <>
              <div className="topbar-new-section-label" style={{ marginTop: '0.6rem' }}>Running</div>
              {state.worktrees.map(w => (
                <div
                  key={w.slug}
                  className="topbar-new-option"
                  title={`${w.target}\nbranch: ${w.branch}\n${w.attachCommand}`}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>🖥️ {w.slug}</span>
                  <button
                    className="session-tab-close"
                    onClick={e => { e.stopPropagation(); stop(w.slug); }}
                    title={`Kill ${w.target}`}
                  >×</button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
