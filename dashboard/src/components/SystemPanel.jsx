import React, { useState, useEffect, useCallback } from 'react';
import { toast } from './Toast.jsx';
import ServiceRow from './ServiceRow.jsx';
import ByokEndpointForm from './ByokEndpointForm.jsx';
import ServiceDiscovery from './ServiceDiscovery.jsx';
import { BACKEND_TYPES } from '../constants/app-config.js';

const SVC_ORDER = ['ollama', 'tool_content_gen', 'tool_website', 'docker-runner', 'nemoclaw', 'llm_openllm', 'bb_mcp'];

function SystemPanel({
  dockerStatus, systemServices, modelPulls, systemInfo,
  darkMode, onToggleTheme, onClose,
  serviceActionsInFlight, serviceActionErrors, servicesStarting,
  onRunServiceAction, onPullModel,
  runningServices, totalServices, knownModels,
  showMetricsPanel, onToggleMetrics,
  onEndpointAdded,
}) {
  const [diagResults, setDiagResults] = useState(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const [byokEndpoints, setByokEndpoints] = useState([]);

  const fetchByokEndpoints = useCallback(async () => {
    try {
      const res = await fetch('/api/config/endpoints');
      const data = await res.json();
      if (data.success) setByokEndpoints(data.endpoints.filter(e => !e.builtin));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchByokEndpoints(); }, [fetchByokEndpoints]);

  const handleEndpointAdded = () => {
    fetchByokEndpoints();
    onEndpointAdded?.();
  };

  // Build endpoint → container map and docker-runner virtual endpoints
  const containerToEndpoints = {};
  const dockerRunnerEndpoints = [];
  if (dockerStatus?.endpoints) {
    for (const [epKey, ep] of Object.entries(dockerStatus.endpoints)) {
      if (ep.backendType === BACKEND_TYPES.OLLAMA) {
        if (!containerToEndpoints['ollama']) containerToEndpoints['ollama'] = [];
        containerToEndpoints['ollama'].push({ epKey, ep });
      } else if (ep.backendType === BACKEND_TYPES.OPENLLM) {
        if (!containerToEndpoints['llm_openllm']) containerToEndpoints['llm_openllm'] = [];
        containerToEndpoints['llm_openllm'].push({ epKey, ep });
      } else if (ep.backendType === BACKEND_TYPES.DOCKER_RUNNER) {
        dockerRunnerEndpoints.push({ epKey, ep });
      }
    }
  }

  // Unified service list
  const allSvcs = [];
  if (dockerStatus?.containers) {
    for (const [name, status] of Object.entries(dockerStatus.containers)) {
      if (name === 'docker-runner') continue;
      const sk = name === 'bb-mcp' ? 'bb_mcp' : name;
      const sm = systemServices?.services?.[sk];
      allSvcs.push({ key: sk, info: {
        label: status.label || name, running: status.running,
        status: status.status, ports: status.ports,
        controllable: sm?.controllable, disabledReason: sm?.disabledReason,
        backendType: sm?.backendType, stats: status.stats,
      }, endpoints: containerToEndpoints[name] || null });
    }
  }
  if (dockerRunnerEndpoints.length > 0) {
    const runnerAnyLive = dockerRunnerEndpoints.some(({ ep }) => ep.live && !ep.disabledReason);
    const runnerAllDisabled = dockerRunnerEndpoints.every(({ ep }) => !!ep.disabledReason);
    const runnerDisabledReason = runnerAllDisabled
      ? `Models exceed device VRAM (${dockerStatus?.deviceProfile?.name || 'current'} profile)`
      : null;
    allSvcs.push({ key: 'docker-runner', info: {
      label: 'Docker Model Runner',
      running: runnerAnyLive,
      status: runnerAllDisabled ? 'disabled' : 'offline', ports: 'host-internal',
      controllable: false, disabledReason: runnerDisabledReason, backendType: 'docker-runner',
    }, endpoints: dockerRunnerEndpoints });
  }
  if (systemServices?.services) {
    for (const [key, meta] of Object.entries(systemServices.services)) {
      if (dockerStatus?.containers && key in dockerStatus.containers) continue;
      if (key === 'docker-runner') continue;
      allSvcs.push({ key, info: {
        label: meta.label, running: meta.running, status: meta.status,
        ports: meta.ports, controllable: meta.controllable,
        disabledReason: meta.disabledReason, backendType: meta.backendType,
      }, endpoints: null });
    }
  }
  allSvcs.sort((a, b) => {
    const r = info => info.running ? 0 : info.disabledReason ? 2 : 1;
    const dr = r(a.info) - r(b.info);
    if (dr) return dr;
    const pa = SVC_ORDER.indexOf(a.key), pb = SVC_ORDER.indexOf(b.key);
    return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb);
  });

  const deviceProfile = dockerStatus?.deviceProfile;
  const isLaptop = deviceProfile?.name?.toLowerCase().includes('laptop') || deviceProfile?.name?.toLowerCase().includes('macbook');
  const deviceIcon = isLaptop ? '💻' : '🖥️';
  const deviceColor = isLaptop ? 'var(--orange)' : 'var(--green)';
  const deviceTitle = deviceProfile
    ? `${deviceProfile.name}${deviceProfile.gpu ? ' · GPU' : ' · CPU-only'}`
    : 'Device unknown';

  return (
    <aside className="drawer drawer-right">
      <div className="drawer-header">
        <h2>System</h2>
        <span title={deviceTitle} style={{ fontSize: '1rem', cursor: 'default', color: deviceColor, display: 'flex', alignItems: 'center' }}>
          {deviceIcon}
        </span>
        <button className="icon-btn" onClick={onToggleTheme} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
          {darkMode ? '☀️' : '🌙'}
        </button>
        <button className={`icon-btn ${showMetricsPanel ? 'active' : ''}`} onClick={onToggleMetrics} title="Metrics">📊</button>
        <button className="icon-btn" onClick={onClose} title="Close">✕</button>
      </div>

      {/* ── Stack Status ── */}
      <div className="system-info">
        <div className="system-info-item system-info-item-wide">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h3>Stack Status</h3>
            <button
              className="btn-docker-action"
              style={{ fontSize: '0.65rem', padding: '0.1rem 0.4rem' }}
              disabled={diagBusy}
              onClick={async () => {
                setDiagBusy(true);
                try {
                  const res = await fetch('/api/system/config-check');
                  if (!res.ok) { setDiagResults({ error: `HTTP ${res.status}` }); return; }
                  const data = await res.json();
                  if (!data?.summary || !Array.isArray(data?.checks)) {
                    setDiagResults({ error: 'Unexpected response shape' });
                  } else {
                    setDiagResults(data);
                  }
                } catch (err) { setDiagResults({ error: err.message }); }
                finally { setDiagBusy(false); }
              }}
            >{diagBusy ? '…' : '⟳ Diag'}</button>
          </div>
          {(() => {
            const anyNotReady = dockerStatus?.endpoints &&
              Object.values(dockerStatus.endpoints).some(ep => !ep.live && !ep.disabledReason);
            const healthy = dockerStatus?.dockerRunning && !anyNotReady;
            return (
              <div className={`value ${healthy ? '' : anyNotReady ? 'warning' : 'error'}`} style={{ marginTop: '0.2rem' }}>
                {healthy ? 'Healthy' : anyNotReady ? 'Degraded' : 'Offline'}
                <span style={{ fontSize: '0.65rem', color: 'var(--text-faint)', marginLeft: '0.5rem' }}>
                  {runningServices}/{totalServices} up
                </span>
              </div>
            );
          })()}
          {diagResults && !diagResults.error && (
            <div style={{ marginTop: '0.4rem', fontSize: '0.68rem' }}>
              <div style={{ marginBottom: '0.3rem', color: 'var(--text-muted)' }}>
                {diagResults.summary.passing} passing · {diagResults.summary.failing} failing
                {' · '}<span style={{ color: diagResults.dockerControlEnabled ? 'var(--green)' : 'var(--text-faint)' }}>
                  {diagResults.dockerControlEnabled ? 'control on' : 'control off'}
                </span>
              </div>
              {diagResults.checks.map(c => (
                <div key={c.key} style={{ display: 'flex', gap: '0.3rem', alignItems: 'baseline', lineHeight: 1.5 }}>
                  <span style={{ color: c.reachable === true ? 'var(--green)' : c.reachable === false ? 'var(--red)' : 'var(--text-faint)' }}>
                    {c.reachable === true ? '✓' : c.reachable === false ? '✗' : '—'}
                  </span>
                  <span style={{ color: 'var(--text)' }}>{c.label}</span>
                  {c.hint && <span style={{ color: 'var(--text-faint)', fontSize: '0.63rem' }}>— {c.hint}</span>}
                </div>
              ))}
            </div>
          )}
          {diagResults?.error && (
            <div style={{ fontSize: '0.68rem', color: 'var(--red)', marginTop: '0.3rem' }}>{diagResults.error}</div>
          )}
        </div>
        <div className="system-info-item">
          <h3>Memory</h3>
          <div className="value">{systemInfo?.memory?.rss ? `${Math.round(systemInfo.memory.rss / 1024 / 1024)} MB` : 'N/A'}</div>
        </div>
        <div className="system-info-item">
          <h3>Uptime</h3>
          <div className="value">{systemInfo?.uptime ? `${Math.round(systemInfo.uptime / 60)} min` : 'N/A'}</div>
        </div>
        <div className="system-info-item">
          <h3>LLM</h3>
          <div style={{ fontSize: '0.68rem', color: 'var(--text)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all', lineHeight: 1.4, marginTop: '0.1rem' }}>
            {systemServices?.primaryLlm?.resolvedUrl?.replace(/^https?:\/\//, '') || 'N/A'}
          </div>
          <div style={{ fontSize: '0.65rem', marginTop: '0.2rem' }}>
            <span style={{ color: systemServices?.dockerControlEnabled ? 'var(--green)' : 'var(--text-faint)' }}>
              {systemServices?.dockerControlEnabled ? '● control on' : '● control off'}
            </span>
          </div>
        </div>
      </div>

      {/* ── Service rows ── */}
      <div className="docker-status">
        {allSvcs.map(({ key, info, endpoints }) => (
          <ServiceRow
            key={key}
            serviceKey={key}
            info={info}
            endpointData={endpoints}
            dockerStatus={dockerStatus}
            modelPulls={modelPulls}
            knownModels={knownModels}
            serviceActionsInFlight={serviceActionsInFlight}
            serviceActionErrors={serviceActionErrors}
            servicesStarting={servicesStarting}
            onRunServiceAction={onRunServiceAction}
            onPullModel={onPullModel}
          />
        ))}
      </div>

      {/* ── External models (BYOK) ── */}
      <div className="docker-status">
        {byokEndpoints.length > 0 && (
          <div style={{ marginBottom: '0.5rem' }}>
            <div style={{ fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-faint)', marginBottom: '0.3rem' }}>External</div>
            {byokEndpoints.map(ep => (
              <div key={ep.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '0.3rem', fontSize: '0.72rem' }}>
                <div>
                  <span style={{ color: 'var(--text)' }}>{ep.name}</span>
                  <span style={{ color: 'var(--text-faint)', marginLeft: '0.4rem' }}>{ep.apiStyle}</span>
                  {ep.hasApiKey && <span style={{ color: 'var(--green)', marginLeft: '0.4rem' }}>● key</span>}
                </div>
                <button
                  className="btn-docker-action"
                  style={{ fontSize: '0.65rem', padding: '0.15rem 0.4rem' }}
                  onClick={async () => {
                    try {
                      const res = await fetch(`/api/config/endpoints/${ep.key}`, { method: 'DELETE' });
                      if (!res.ok) { const d = await res.json().catch(() => ({})); toast.error(d.error || `HTTP ${res.status}`); return; }
                      fetchByokEndpoints();
                      onEndpointAdded?.();
                    } catch (err) { toast.error(err.message); }
                  }}
                >✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: byokEndpoints.length > 0 ? '1px solid var(--border)' : 'none', paddingTop: byokEndpoints.length > 0 ? '0.5rem' : 0 }}>
          <ByokEndpointForm onAdded={handleEndpointAdded} />
          <ServiceDiscovery fetchByokEndpoints={fetchByokEndpoints} onEndpointAdded={handleEndpointAdded} />
        </div>
      </div>
    </aside>
  );
}

export default SystemPanel;
