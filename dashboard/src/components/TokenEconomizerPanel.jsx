import React, { useState, useEffect, useCallback } from 'react';
import { toast } from './Toast.jsx';

const TAB_LABELS = {
  overview: 'Overview',
  microskills: 'Micro-skills',
  toolprune: 'Tool Pruning',
  sessions: 'Sessions',
  settings: 'Settings',
};

function TokenEconomizerPanel({ onClose }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [status, setStatus] = useState(null);
  const [config, setConfig] = useState(null);
  const [microskills, setMicroskills] = useState({ confirmed: [], proposed: [], rejected: [] });
  const [toolprune, setToolprune] = useState({ prunable: [], evidence: [] });
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState({});
  const [repoRoot, setRepoRoot] = useState('');

  const fetchStatus = useCallback(async () => {
    setLoading(prev => ({ ...prev, status: true }));
    try {
      const res = await fetch(`/api/tokeneconomizer/status?repoRoot=${encodeURIComponent(repoRoot || process.cwd())}`);
      const data = await res.json();
      if (data.success) setStatus(data.status);
    } catch (error) {
      toast.error(`Failed to fetch status: ${error.message}`);
    } finally {
      setLoading(prev => ({ ...prev, status: false }));
    }
  }, [repoRoot]);

  const fetchConfig = useCallback(async () => {
    setLoading(prev => ({ ...prev, config: true }));
    try {
      const res = await fetch('/api/tokeneconomizer/config');
      const data = await res.json();
      if (data.success) setConfig(data.config);
    } catch (error) {
      toast.error(`Failed to fetch config: ${error.message}`);
    } finally {
      setLoading(prev => ({ ...prev, config: false }));
    }
  }, []);

  const fetchMicroskills = useCallback(async () => {
    setLoading(prev => ({ ...prev, microskills: true }));
    try {
      const res = await fetch(`/api/tokeneconomizer/microskills?repoRoot=${encodeURIComponent(repoRoot || process.cwd())}`);
      const data = await res.json();
      if (data.success) setMicroskills(data.microskills);
    } catch (error) {
      toast.error(`Failed to fetch micro-skills: ${error.message}`);
    } finally {
      setLoading(prev => ({ ...prev, microskills: false }));
    }
  }, [repoRoot]);

  const fetchToolprune = useCallback(async () => {
    setLoading(prev => ({ ...prev, toolprune: true }));
    try {
      const res = await fetch(`/api/tokeneconomizer/toolprune?repoRoot=${encodeURIComponent(repoRoot || process.cwd())}&experience=developer`);
      const data = await res.json();
      if (data.success) setToolprune({ prunable: data.prunable, evidence: data.evidence });
    } catch (error) {
      toast.error(`Failed to fetch tool pruning: ${error.message}`);
    } finally {
      setLoading(prev => ({ ...prev, toolprune: false }));
    }
  }, [repoRoot]);

  const fetchSessions = useCallback(async () => {
    setLoading(prev => ({ ...prev, sessions: true }));
    try {
      const res = await fetch(`/api/tokeneconomizer/sessions?repoRoot=${encodeURIComponent(repoRoot || process.cwd())}&limit=50`);
      const data = await res.json();
      if (data.success) setSessions(data.sessions);
    } catch (error) {
      toast.error(`Failed to fetch sessions: ${error.message}`);
    } finally {
      setLoading(prev => ({ ...prev, sessions: false }));
    }
  }, [repoRoot]);

  const handleConfigSet = async (key, value) => {
    try {
      const res = await fetch('/api/tokeneconomizer/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      });
      const data = await res.json();
      if (data.success) {
        setConfig(data.config);
        toast.success(`Config updated: ${key}`);
      } else {
        toast.error(data.error || 'Failed to update config');
      }
    } catch (error) {
      toast.error(`Failed to update config: ${error.message}`);
    }
  };

  const handleMicroskillAction = async (action, skillId) => {
    try {
      const res = await fetch(`/api/tokeneconomizer/microskills/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skillId }),
      });
      const data = await res.json();
      if (data.success) {
        fetchMicroskills();
        toast.success(`Micro-skill ${action}d`);
      } else {
        toast.error(data.error || `Failed to ${action} micro-skill`);
      }
    } catch (error) {
      toast.error(`Failed to ${action} micro-skill: ${error.message}`);
    }
  };

  const handleToolpruneAction = async (action, tools) => {
    try {
      const res = await fetch(`/api/tokeneconomizer/toolprune/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoRoot: repoRoot || process.cwd(),
          experience: 'developer',
          tools
        }),
      });
      const data = await res.json();
      if (data.success) {
        fetchToolprune();
        toast.success(`Tool pruning ${action}d`);
      } else {
        toast.error(data.error || `Failed to ${action} tools`);
      }
    } catch (error) {
      toast.error(`Failed to ${action} tools: ${error.message}`);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchConfig();
  }, [fetchStatus, fetchConfig]);

  useEffect(() => {
    if (activeTab === 'microskills') fetchMicroskills();
    if (activeTab === 'toolprune') fetchToolprune();
    if (activeTab === 'sessions') fetchSessions();
  }, [activeTab, fetchMicroskills, fetchToolprune, fetchSessions]);

  const renderOverview = () => {
    if (!status) return <div className="te-loading">Loading...</div>;

    const { config, microskills: ms, tools, sessions: sess } = status;
    const totalTokensSaved = (ms.facts?.length || 0) * 50; // rough estimate
    const toolsPruned = tools.prunable || 0;

    return (
      <div className="te-panel">
        <div className="te-stats-grid">
          <div className="te-stat-card">
            <div className="te-stat-value">{ms.confirmed || 0}</div>
            <div className="te-stat-label">Confirmed Facts</div>
          </div>
          <div className="te-stat-card">
            <div className="te-stat-value">{ms.proposed || 0}</div>
            <div className="te-stat-label">Proposed Facts</div>
          </div>
          <div className="te-stat-card">
            <div className="te-stat-value">{tools.totalPrompts || 0}</div>
            <div className="te-stat-label">Total Prompts</div>
          </div>
          <div className="te-stat-card">
            <div className="te-stat-value">{tools.totalSessions || 0}</div>
            <div className="te-stat-label">Sessions Tracked</div>
          </div>
          <div className="te-stat-card">
            <div className="te-stat-value">{toolsPruned}</div>
            <div className="te-stat-label">Prunable Tools</div>
          </div>
          <div className="te-stat-card">
            <div className="te-stat-value">~{totalTokensSaved}</div>
            <div className="te-stat-label">Est. Tokens Saved</div>
          </div>
        </div>

        <div className="te-section">
          <h4>Configuration</h4>
          <div className="te-config-grid">
            <div className="te-config-item">
              <label>Micro-skills</label>
              <select
                value={config.microskills?.microskills || 'off'}
                onChange={(e) => handleConfigSet('microskills', e.target.value)}
                disabled={loading.config}
              >
                <option value="off">Off</option>
                <option value="envfacts">Env Facts Only</option>
                <option value="envfacts+distiller">Env Facts + Distiller</option>
              </select>
            </div>
            <div className="te-config-item">
              <label>Tool Pruning</label>
              <select
                value={config.toolprune?.toolprune || 'off'}
                onChange={(e) => handleConfigSet('toolprune', e.target.value)}
                disabled={loading.config}
              >
                <option value="off">Off</option>
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="te-config-item">
              <label>Loop Guard</label>
              <select
                value={config.loopguard?.loopguard || 'off'}
                onChange={(e) => handleConfigSet('loopguard', e.target.value)}
                disabled={loading.config}
              >
                <option value="off">Off</option>
                <option value="nudge">Nudge</option>
                <option value="halt">Halt</option>
              </select>
            </div>
            <div className="te-config-item">
              <label>Judge Confidence</label>
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.loopguard?.thresholds?.judge_confidence || 0.7}
                onChange={(e) => handleConfigSet('loopguard.thresholds.judge_confidence', parseFloat(e.target.value))}
                disabled={loading.config}
              />
              <span>{(config.loopguard?.thresholds?.judge_confidence || 0.7).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <div className="te-section">
          <h4>Learned Facts (Confirmed)</h4>
          {ms.facts && ms.facts.length > 0 ? (
            <ul className="te-facts-list">
              {ms.facts.map((fact, i) => (
                <li key={i} className="te-fact-item">{fact}</li>
              ))}
            </ul>
          ) : (
            <p className="te-empty">No facts learned yet. Micro-skills will propose facts after a few sessions.</p>
          )}
        </div>
      </div>
    );
  };

  const renderMicroskills = () => {
    if (loading.microskills) return <div className="te-loading">Loading micro-skills...</div>;

    return (
      <div className="te-panel">
        <div className="te-section">
          <h4>Proposed Facts</h4>
          {microskills.proposed && microskills.proposed.length > 0 ? (
            microskills.proposed.map(skill => (
              <div key={skill.id} className="te-microskill-card proposed">
                <div className="te-microskill-fact">{skill.fact}</div>
                <div className="te-microskill-meta">
                  <span className="te-badge proposed">Proposed</span>
                  <span>{skill.source || 'auto'}</span>
                  <span>{new Date(skill.proposedAt).toLocaleString()}</span>
                  <div className="te-actions">
                    <button className="btn-sm" onClick={() => handleMicroskillAction('confirm', skill.id)}>Confirm</button>
                    <button className="btn-sm btn-danger" onClick={() => handleMicroskillAction('reject', skill.id)}>Reject</button>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <p className="te-empty">No proposed facts.</p>
          )}
        </div>

        <div className="te-section">
          <h4>Confirmed Facts</h4>
          {microskills.confirmed && microskills.confirmed.length > 0 ? (
            microskills.confirmed.map(skill => (
              <div key={skill.id} className="te-microskill-card confirmed">
                <div className="te-microskill-fact">{skill.fact}</div>
                <div className="te-microskill-meta">
                  <span className="te-badge confirmed">Confirmed</span>
                  <span>{skill.source || 'auto'}</span>
                  <span>Confirmed: {skill.confirmedAt ? new Date(skill.confirmedAt).toLocaleString() : 'N/A'}</span>
                </div>
              </div>
            ))
          ) : (
            <p className="te-empty">No confirmed facts yet.</p>
          )}
        </div>

        <div className="te-section">
          <h4>Rejected Facts</h4>
          {microskills.rejected && microskills.rejected.length > 0 ? (
            microskills.rejected.map(skill => (
              <div key={skill.id} className="te-microskill-card rejected">
                <div className="te-microskill-fact">{skill.fact}</div>
                <div className="te-microskill-meta">
                  <span className="te-badge rejected">Rejected</span>
                  <span>Rejected: {skill.rejectedAt ? new Date(skill.rejectedAt).toLocaleString() : 'N/A'}</span>
                </div>
              </div>
            ))
          ) : (
            <p className="te-empty">No rejected facts.</p>
          )}
        </div>
      </div>
    );
  };

  const renderToolprune = () => {
    if (loading.toolprune) return <div className="te-loading">Loading tool pruning...</div>;

    return (
      <div className="te-panel">
        <div className="te-section">
          <h4>Prunable Tools</h4>
          {toolprune.prunable && toolprune.prunable.length > 0 ? (
            <div className="te-tool-list">
              {toolprune.prunable.map(tool => (
                <div key={tool} className="te-tool-item prunable">
                  <span className="te-tool-name">{tool}</span>
                  <span className="te-badge prunable">Prunable</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="te-empty">No tools meet pruning criteria yet.</p>
          )}
        </div>

        <div className="te-section">
          <h4>All Tracked Tools</h4>
          {toolprune.evidence && toolprune.evidence.length > 0 ? (
            <div className="te-tool-evidence-table">
              <div className="te-evidence-header">
                <span>Tool</span>
                <span>Uses</span>
                <span>Sessions</span>
                <span>Last Used</span>
                <span>Status</span>
              </div>
              {toolprune.evidence.map(e => (
                <div key={`${e.repo}::${e.experience}::${e.tool}`} className="te-evidence-row">
                  <span>{e.tool}</span>
                  <span>{e.uses || 0}</span>
                  <span>{(e.sessions || []).length}</span>
                  <span>{e.lastUsed ? new Date(e.lastUsed).toLocaleDateString() : 'Never'}</span>
                  <span className={toolprune.prunable?.includes(e.tool) ? 'te-badge prunable' : 'te-badge active'}>
                    {toolprune.prunable?.includes(e.tool) ? 'Prunable' : 'Active'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="te-empty">No tool usage recorded yet.</p>
          )}
        </div>

        <div className="te-section">
          <h4>Actions</h4>
          <div className="te-actions-row">
            {toolprune.prunable && toolprune.prunable.length > 0 && (
              <button className="btn-primary" onClick={() => handleToolpruneAction('prune', toolprune.prunable)} disabled={loading.toolprune}>
                Prune All ({toolprune.prunable.length})
              </button>
            )}
            <button className="btn-secondary" onClick={fetchToolprune} disabled={loading.toolprune}>
              Refresh
            </button>
          </div>
        </div>
      </div>
    );
  };

  const renderSessions = () => {
    if (loading.sessions) return <div className="te-loading">Loading sessions...</div>;

    return (
      <div className="te-panel">
        <div className="te-section">
          <h4>Recent Sessions ({sessions.length})</h4>
          {sessions.length > 0 ? (
            <div className="te-sessions-list">
              {sessions.slice().reverse().map(session => (
                <div key={session.id} className="te-session-item">
                  <div className="te-session-header">
                    <span className="te-session-id">{session.id.slice(0, 8)}</span>
                    <span className="te-session-time">{new Date(session.timestamp).toLocaleString()}</span>
                  </div>
                  <div className="te-session-details">
                    <span>Tokens: {session.tokens || 0}</span>
                    <span>Tools: {session.toolsUsed || 0}</span>
                    <span>Turns: {session.turns || 0}</span>
                    <span>Experience: {session.experience || 'unknown'}</span>
                  </div>
                  {session.factsInjected && (
                    <div className="te-session-facts">
                      Facts injected: {session.factsInjected.join(', ')}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="te-empty">No sessions recorded yet.</p>
          )}
        </div>
      </div>
    );
  };

  const renderSettings = () => {
    if (!config) return <div className="te-loading">Loading settings...</div>;

    return (
      <div className="te-panel">
        <div className="te-section">
          <h4>Micro-skills Settings</h4>
          <div className="te-settings-grid">
            <div className="te-setting-row">
              <label>Propose Every N Sessions</label>
              <input
                type="number"
                min="1"
                max="10"
                value={config.microskills?.microskills_propose_every || 3}
                onChange={(e) => handleConfigSet('microskills_propose_every', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Max Facts per Session</label>
              <input
                type="number"
                min="1"
                max="10"
                value={config.microskills?.microskills_max_facts || 4}
                onChange={(e) => handleConfigSet('microskills_max_facts', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Max Tokens per Fact</label>
              <input
                type="number"
                min="50"
                max="500"
                value={config.microskills?.microskills_max_tokens || 150}
                onChange={(e) => handleConfigSet('microskills_max_tokens', parseInt(e.target.value))}
              />
            </div>
          </div>
        </div>

        <div className="te-section">
          <h4>Tool Pruning Settings</h4>
          <div className="te-settings-grid">
            <div className="te-setting-row">
              <label>Min Evidence (Prompts)</label>
              <input
                type="number"
                min="1"
                max="50"
                value={config.toolprune?.toolprune_evidence || 10}
                onChange={(e) => handleConfigSet('toolprune_evidence', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Min Sessions</label>
              <input
                type="number"
                min="1"
                max="10"
                value={config.toolprune?.toolprune_min_sessions || 2}
                onChange={(e) => handleConfigSet('toolprune_min_sessions', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Quiet Period (Days)</label>
              <input
                type="number"
                min="1"
                max="180"
                value={config.toolprune?.toolprune_sessions || 5}
                onChange={(e) => handleConfigSet('toolprune_sessions', parseInt(e.target.value))}
              />
            </div>
          </div>
        </div>

        <div className="te-section">
          <h4>Loop Guard Settings</h4>
          <div className="te-settings-grid">
            <div className="te-setting-row">
              <label>Min Turns Before Nudge</label>
              <input
                type="number"
                min="5"
                max="50"
                value={config.loopguard?.thresholds?.min_turns || 20}
                onChange={(e) => handleConfigSet('loopguard.thresholds.min_turns', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Edit Churn Threshold</label>
              <input
                type="number"
                min="1"
                max="20"
                value={config.loopguard?.thresholds?.edit_churn || 4}
                onChange={(e) => handleConfigSet('loopguard.thresholds.edit_churn', parseInt(e.target.value))}
              />
            </div>
            <div className="te-setting-row">
              <label>Judge Confidence</label>
              <input
                type="range"
                min="0.5"
                max="0.95"
                step="0.05"
                value={config.loopguard?.thresholds?.judge_confidence || 0.7}
                onChange={(e) => handleConfigSet('loopguard.thresholds.judge_confidence', parseFloat(e.target.value))}
              />
              <span>{(config.loopguard?.thresholds?.judge_confidence || 0.7).toFixed(2)}</span>
            </div>
          </div>
        </div>

        <div className="te-section">
          <h4>Data Location</h4>
          <p className="te-path">{typeof window !== 'undefined' ? (require('os').homedir() + '/.tokeneconomizer') : '~/.tokeneconomizer'}</p>
        </div>
      </div>
    );
  };

  const renderTab = () => {
    switch (activeTab) {
      case 'overview': return renderOverview();
      case 'microskills': return renderMicroskills();
      case 'toolprune': return renderToolprune();
      case 'sessions': return renderSessions();
      case 'settings': return renderSettings();
      default: return renderOverview();
    }
  };

  return (
    <aside className="drawer drawer-right drawer-token-economizer">
      <div className="drawer-header">
        <h2>TokenEconomizer</h2>
        <button className="icon-btn" onClick={() => { fetchStatus(); fetchConfig(); }} title="Refresh">↻</button>
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>

      <div className="te-tabs">
        {Object.entries(TAB_LABELS).map(([key, label]) => (
          <button
            key={key}
            className={`te-tab ${activeTab === key ? 'active' : ''}`}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="te-content">
        {renderTab()}
      </div>
    </aside>
  );
}

export default TokenEconomizerPanel;