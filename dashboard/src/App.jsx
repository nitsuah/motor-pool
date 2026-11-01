import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './App.css';
import { toast } from './components/Toast.jsx';
import MetricsPanel from './components/MetricsPanel.jsx';
import SystemPanel from './components/SystemPanel.jsx';
import ChatColumn from './components/ChatColumn.jsx';
import TopBar from './components/TopBar.jsx';
import WorkspaceView from './components/WorkspaceView.jsx';
import StatusBar from './components/StatusBar.jsx';
import OnboardingStrip from './components/OnboardingStrip.jsx';
import KeyboardShortcutsModal from './components/KeyboardShortcutsModal.jsx';
import { useWebSocket } from './hooks/useWebSocket.js';
import { useSessionStreaming } from './hooks/useSessionStreaming.js';
import { useServiceActions } from './hooks/useServiceActions.js';
import { useWorkspaceOps } from './hooks/useWorkspaceOps.js';
import { useTaskManagement } from './hooks/useTaskManagement.js';
import {
  getOrCreateUserId, getUserRole, shouldShowOnboarding,
  ENDPOINT_META, EXPERIENCE_ENDPOINTS, EXPERIENCE_TOOLS, EXPERIENCE_META, SAFETY_COLORS,
} from './constants/app-config.js';

function App() {
  const userId = useRef(getOrCreateUserId());

  // ── UI state ────────────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState([]);
  const [models, setModels] = useState([]);
  const [activeSession, setActiveSession] = useState(null);
  const [activeSessionMessages, setActiveSessionMessages] = useState([]);
  const [currentModel, setCurrentModel] = useState(ENDPOINT_META.primary.model);
  const [currentEndpoint, setCurrentEndpoint] = useState('primary');
  const [messageInput, setMessageInput] = useState('');
  const [useNemoClaw, setUseNemoClaw] = useState(false);
  const [dockerStatus, setDockerStatus] = useState(null);
  const [systemServices, setSystemServices] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [liveEvents, setLiveEvents] = useState([]);
  const [showSystemPanel, setShowSystemPanel] = useState(false);
  const [showNewSessionMenu, setShowNewSessionMenu] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showMetricsPanel, setShowMetricsPanel] = useState(false);
  const [demoMode, setDemoMode] = useState({ enabled: false, enforcedExperience: null, allowedEndpoints: [] });
  const [selectedExperience, setSelectedExperience] = useState('developer');
  const [taskExperience, setTaskExperience] = useState('research');
  const [activeTab, setActiveTab] = useState('chat');
  const [showOnboarding, setShowOnboarding] = useState(shouldShowOnboarding);
  const [metricsSummary, setMetricsSummary] = useState(null);
  const [metricsSafety, setMetricsSafety] = useState(null);
  const [metricsFeedback, setMetricsFeedback] = useState(null);
  const [metricsErrors, setMetricsErrors] = useState(null);
  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('agent_board_theme');
    const isDark = saved !== 'light';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    return isDark;
  });

  const newSessionMenuRef = useRef(null);
  const chatBottomRef = useRef(null);
  const createSessionRef = useRef(null);
  const fetchTasksRef = useRef(null);
  const activeSessionRef = useRef(activeSession);
  activeSessionRef.current = activeSession;
  const endpointSwitchSerialRef = useRef({});
  const [nineRouterCombo, setNineRouterCombo] = useState('MAX');

  // ── Stable data fetchers (passed to hooks — deps are all React state setters) ──
  const fetchDockerStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/docker/status');
      const data = await res.json();
      setDockerStatus(data);
    } catch {
      setDockerStatus({ dockerRunning: false, errors: ['Failed to connect'] });
    }
  }, []);

  const fetchSystemServices = useCallback(async () => {
    try {
      const res = await fetch('/api/system/services');
      const data = await res.json();
      if (data.success) setSystemServices(data);
    } catch { setSystemServices(null); }
  }, []);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch('/api/sessions');
      const data = await res.json();
      if (data.success) setSessions(data.sessions);
    } catch (error) { console.error('Error fetching sessions:', error); }
  }, []);

  const fetchSessionDetails = useCallback(async (id) => {
    try {
      const res = await fetch(`/api/sessions/${id}`);
      const data = await res.json();
      if (data.success && data.session) {
        setSessions(prev => prev.map(s => s.id === id
          ? { ...s, messageCount: (data.session.messages || []).length, endpoint: data.session.endpoint, model: data.session.model, experience: data.session.experience, safetyMode: data.session.safetyMode }
          : s
        ));
        if (id === activeSessionRef.current) {
          setActiveSessionMessages(data.session.messages || []);
          setCurrentEndpoint(data.session.endpoint);
          setCurrentModel(data.session.model);
        }
      }
    } catch (error) { toast.error(`Failed to load session: ${error.message}`); }
  }, []);

  // ── Derived endpoint helpers ──────────────────────────────────────────────
  const allEndpointMeta = useMemo(() => {
    const result = { ...ENDPOINT_META };
    if (!dockerStatus?.endpoints) return result;
    for (const [key, ep] of Object.entries(dockerStatus.endpoints)) {
      if (!result[key]) {
        result[key] = {
          model: ep.model || '',
          label: ep.name || key,
          desc: ep.hasApiKey ? `${ep.type || 'custom'} · API key set` : (ep.backendType || 'custom'),
          backendBadge: ep.type === 'cloud' ? 'Cloud API' : 'Custom',
        };
      }
    }
    return result;
  }, [dockerStatus]);

  const getAvailableEndpoints = useCallback((experienceKey) => {
    if (demoMode.enabled) return ['primary'];
    const base = EXPERIENCE_ENDPOINTS[experienceKey] || EXPERIENCE_ENDPOINTS.developer;
    if (experienceKey === 'safechat') return base;
    const customKeys = Object.entries(dockerStatus?.endpoints || {})
      .filter(([, ep]) => ep.backendType === 'custom' || ep.backendType === 'byok')
      .map(([k]) => k);
    return customKeys.length ? [...new Set([...base, ...customKeys])] : base;
  }, [demoMode.enabled, dockerStatus]);

  const getPreferredModelForEndpoint = useCallback((endpoint) => {
    const configuredModel = allEndpointMeta[endpoint]?.model || currentModel;
    const endpointModels = models.filter((m) => m.id === endpoint);
    const getId = (m) => m?.name || m?.model;
    if (!endpointModels.length) return configuredModel;
    const exact = endpointModels.find((m) => { const id = getId(m); return id === configuredModel || m?.model === configuredModel; });
    if (exact) return getId(exact);
    const tagged = endpointModels.find((m) => { const id = getId(m); return typeof configuredModel === 'string' && typeof id === 'string' && id.startsWith(`${configuredModel}:`); });
    if (tagged) return getId(tagged);
    const def = endpointModels.find((m) => m?.default || m?.isDefault || m?.is_default);
    if (def) return getId(def);
    return configuredModel || getId(endpointModels[0]);
  }, [models, currentModel, allEndpointMeta]);

  // ── Custom hooks ──────────────────────────────────────────────────────────
  const wsOps = useWorkspaceOps();

  const onWsEventRef = useRef(null);
  const { wsConnected } = useWebSocket({ onEvent: (event) => onWsEventRef.current?.(event) });

  const {
    serviceActionsInFlight, serviceActionErrors, servicesStarting,
    modelPulls, setModelPulls, knownModels,
    contentClients, contentFiles, contentExpanded, setContentExpanded,
    runServiceAction, fetchModelPullStatus, pullModel,
    fetchContentClients, fetchContentFiles, downloadContentFile,
  } = useServiceActions({
    dockerStatus, systemServices,
    onDockerStatusRefresh: fetchDockerStatus,
    onSystemServicesRefresh: fetchSystemServices,
  });

  const {
    loadingSessions, streamingBySession, sessionPendingReply, sessionErrors,
    queueLengths, pausedSessions, sendMessageCore, enqueueMessage,
    togglePause, stopSession, forceSend,
  } = useSessionStreaming({
    activeSession, setActiveSessionMessages, useNemoClaw, fetchSessions, fetchSessionDetails, nineRouterCombo,
  });

  const {
    tasks, taskSummary, taskTitle, setTaskTitle, taskPriority, setTaskPriority,
    fetchTasks, createTask, updateTask, updateTaskStatus, routeTaskToSession, dispatchTask, deleteTask, clearCompletedTasks,
    taskDescription, setTaskDescription,
  } = useTaskManagement({
    activeSession, selectedExperience,
    wsLayout: wsOps.wsLayout, setActiveTab,
    sendMessageCore,
    getAvailableEndpoints, currentEndpoint, getPreferredModelForEndpoint,
    fetchSessions, fetchSessionDetails, setActiveSession,
  });
  fetchTasksRef.current = fetchTasks;

  // WS event handler assigned to ref each render so it always reads current state
  onWsEventRef.current = (event) => {
    const { event_type: eventType, endpoint, model, metadata } = event;
    setLiveEvents(prev => [event, ...prev].slice(0, 30));
    if (eventType?.startsWith('model_pull_') && endpoint && model) {
      setModelPulls(prev => ({ ...prev, [`${endpoint}:${model}`]: { endpoint, model, ...metadata } }));
    }
    if (eventType === 'artifact_created') wsOps.fetchArtifacts?.();
    if (eventType === 'task_status_changed') {
      const { status } = metadata || {};
      if (status === 'completed') toast.success('Task completed');
      else if (status === 'failed') toast.error(`Task failed${metadata?.error ? `: ${metadata.error}` : ''}`);
      fetchTasksRef.current?.();
    }
  };

  // ── Other data fetchers ───────────────────────────────────────────────────
  const fetchModels = useCallback(async () => {
    try {
      const res = await fetch('/api/models');
      const data = await res.json();
      if (data.success) setModels(data.models);
    } catch (error) { console.error('Error fetching models:', error); }
  }, []);

  const fetchSystemInfo = useCallback(async () => {
    try {
      const res = await fetch('/api/system/info');
      const data = await res.json();
      if (data.success) setSystemInfo(data.system);
    } catch (error) { console.error('Error fetching system info:', error); }
  }, []);

  const fetchDemoMode = useCallback(async () => {
    try {
      const res = await fetch('/api/demo-mode');
      const data = await res.json();
      if (data.success) {
        setDemoMode({ enabled: !!data.enabled, enforcedExperience: data.enforcedExperience || null, allowedEndpoints: data.allowedEndpoints || [] });
      }
    } catch (error) { console.error('Error fetching demo mode:', error); }
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const [summary, safety, feedback, errors] = await Promise.all([
        fetch('/api/metrics/summary').then(r => r.json()),
        fetch('/api/metrics/safety').then(r => r.json()),
        fetch('/api/metrics/feedback').then(r => r.json()),
        fetch('/api/metrics/errors').then(r => r.json()),
      ]);
      if (summary.success) setMetricsSummary(summary.summary);
      if (safety.success) setMetricsSafety(safety.safety);
      if (feedback.success) setMetricsFeedback(feedback.feedback);
      if (errors.success) setMetricsErrors(errors.errors);
    } catch (error) { console.error('Error fetching metrics:', error); }
  }, []);

  // ── Main data fetch effect ────────────────────────────────────────────────
  useEffect(() => {
    fetchModels(); fetchSessions(); fetchTasks(); fetchDockerStatus();
    fetchSystemServices(); fetchSystemInfo(); fetchDemoMode(); fetchModelPullStatus();
    const timers = [
      setInterval(fetchSessions, 5000),
      setInterval(fetchTasks, 7000),
      setInterval(fetchDockerStatus, 10000),
      setInterval(fetchSystemServices, 10000),
      setInterval(fetchModelPullStatus, 10000),
    ];
    return () => timers.forEach(clearInterval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (demoMode.enabled) {
      setSelectedExperience('safechat');
      setCurrentEndpoint('primary');
      setCurrentModel(ENDPOINT_META.primary.model);
    }
  }, [demoMode.enabled]);

  useEffect(() => {
    const onKey = (e) => {
      const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && e.key === 'n' && !e.shiftKey) {
        if (inInput) return;
        e.preventDefault();
        createSessionRef.current?.();
      }
      if (e.key === '?' && !e.ctrlKey && !e.metaKey && !inInput) setShowShortcuts(p => !p);
      if ((e.ctrlKey || e.metaKey) && e.key === 'm' && !inInput) {
        e.preventDefault();
        setShowMetricsPanel(p => !p);
        setShowSystemPanel(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (activeTab === 'metrics' || showMetricsPanel) {
      fetchMetrics();
      const interval = setInterval(fetchMetrics, 10000);
      return () => clearInterval(interval);
    }
  }, [activeTab, showMetricsPanel, fetchMetrics]);

  useEffect(() => {
    if (!showNewSessionMenu) return;
    const handle = (e) => { if (!newSessionMenuRef.current?.contains(e.target)) setShowNewSessionMenu(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [showNewSessionMenu]);

  useEffect(() => {
    if (!wsOps.wsGitPopover) return;
    const handle = (e) => { if (!wsOps.wsGitPopoverRef.current?.contains(e.target)) wsOps.setWsGitPopover(false); };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [wsOps.wsGitPopover, wsOps.wsGitPopoverRef, wsOps.setWsGitPopover]);

  useEffect(() => {
    chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSessionMessages]);

  useEffect(() => {
    setActiveSessionMessages([]);
    if (activeSession) fetchSessionDetails(activeSession);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSession]);

  const activeSessionData = activeSession ? sessions.find(s => s.id === activeSession) : null;

  useEffect(() => {
    const available = getAvailableEndpoints(activeSessionData?.experience || selectedExperience);
    const online = available.filter((key) => {
      const ep = dockerStatus?.endpoints?.[key];
      return ep ? ep.live === true : true;
    });
    const pool = online.length ? online : available;
    if (!pool.includes(currentEndpoint)) {
      const next = pool[0];
      setCurrentEndpoint(next);
      setCurrentModel(allEndpointMeta[next]?.model || ENDPOINT_META.primary.model);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionData, currentEndpoint, dockerStatus, selectedExperience]);

  // ── Session helpers ───────────────────────────────────────────────────────
  const toggleTheme = () => {
    setDarkMode(prev => {
      const next = !prev;
      document.documentElement.setAttribute('data-theme', next ? 'dark' : 'light');
      localStorage.setItem('agent_board_theme', next ? 'dark' : 'light');
      return next;
    });
  };

  // Hub experience chips pass the chosen key; other callers pass nothing (or a click event).
  const createSession = async (experienceKey) => {
    const experience = typeof experienceKey === 'string' ? experienceKey : selectedExperience;
    if (experience !== selectedExperience) setSelectedExperience(experience);
    try {
      const availableEndpoints = getAvailableEndpoints(experience);
      const onlineEndpoints = availableEndpoints.filter((key) => {
        const ep = dockerStatus?.endpoints?.[key];
        if (dockerStatus?.endpoints) return ep ? ep.live === true : false;
        return true;
      });
      const pool = onlineEndpoints.length ? onlineEndpoints : availableEndpoints;
      const endpoint = pool.includes(currentEndpoint) ? currentEndpoint : pool[0];
      const model = getPreferredModelForEndpoint(endpoint);
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, endpoint, userId: userId.current, userRole: getUserRole(), experience }),
      });
      const data = await res.json();
      if (data.success) {
        setCurrentEndpoint(data.session.endpoint);
        setCurrentModel(data.session.model);
        setActiveSession(data.session.id);
        fetchSessions();
      }
    } catch (error) { toast.error(`Failed to create session: ${error.message}`); }
  };
  createSessionRef.current = createSession;

  const renameSession = async (id, name) => {
    if (!name?.trim()) return;
    try {
      const res = await fetch(`/api/sessions/${id}/name`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (data.success) { fetchSessions(); toast.success('Session renamed'); }
      else toast.error(data.error || 'Rename failed');
    } catch (err) { toast.error(`Rename failed: ${err.message}`); }
  };

  const deleteSession = async (id) => {
    try {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
      if (activeSession === id) setActiveSession(null);
      fetchSessions();
    } catch (error) { toast.error(`Delete failed: ${error.message}`); }
  };

  const forkSession = async (sessionId, messageIndex) => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ atMessageIndex: messageIndex }),
      });
      const data = await res.json();
      if (!data.success) { toast.error(data.error || 'Fork failed'); return; }
      toast.success?.(`Forked: ${data.session.name} (${data.session.messageCount} messages)`);
      fetchSessions();
      setActiveSession(data.session.id);
    } catch (err) { toast.error(`Fork failed: ${err.message}`); }
  };

  const sendFeedback = async (messageIndex, positive) => {
    if (!activeSession) return;
    const targetMessage = activeSessionMessages[messageIndex];
    if (!targetMessage || targetMessage.role !== 'assistant' || targetMessage.feedback) return;
    try {
      const res = await fetch(`/api/sessions/${activeSession}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageIndex, positive }),
      });
      const data = await res.json();
      if (!data.success) { toast.error(data.error || 'Failed to send feedback'); return; }
      setActiveSessionMessages((prev) => prev.map((msg, idx) => (idx === messageIndex ? { ...msg, feedback: positive ? 'up' : 'down' } : msg)));
    } catch (error) { toast.error(`Failed to send feedback: ${error.message}`); }
  };

  const switchEndpoint = async (endpoint, model, prevEndpoint, prevModel) => {
    const sessionId = activeSession;
    if (!sessionId) return;
    const serial = (endpointSwitchSerialRef.current[sessionId] || 0) + 1;
    endpointSwitchSerialRef.current[sessionId] = serial;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/model`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint, model }),
      });
      const data = await res.json();
      const isLatest = endpointSwitchSerialRef.current[sessionId] === serial && activeSessionRef.current === sessionId;
      if (!data.success) {
        toast.error(data.error || data.message || 'Failed to switch model');
        if (isLatest) { setCurrentEndpoint(prevEndpoint); setCurrentModel(prevModel); }
        return;
      }
      if (isLatest) { setCurrentEndpoint(endpoint); setCurrentModel(model); }
      fetchSessions();
    } catch (error) {
      const isLatest = endpointSwitchSerialRef.current[sessionId] === serial && activeSessionRef.current === sessionId;
      toast.error(`Model switch failed: ${error.message}`);
      if (isLatest) { setCurrentEndpoint(prevEndpoint); setCurrentModel(prevModel); }
    }
  };

  const handleEndpointSelection = (endpoint) => {
    const model = getPreferredModelForEndpoint(endpoint);
    const prevEndpoint = currentEndpoint;
    const prevModel = currentModel;
    setCurrentEndpoint(endpoint);
    setCurrentModel(model);
    switchEndpoint(endpoint, model, prevEndpoint, prevModel);
  };

  const sendMessage = (e) => {
    e.preventDefault();
    const sessionId = activeSession;
    if (!sessionId || !messageInput.trim()) return;
    const message = messageInput.trim();
    setMessageInput('');
    if (loadingSessions.has(sessionId)) { enqueueMessage(sessionId, message); return; }
    sendMessageCore(sessionId, message);
  };

  const handleMessageInputKeyDown = (e) => {
    const ctrlSend = (e.ctrlKey || e.metaKey) && e.key === 'Enter';
    const enterSend = e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey;
    if (ctrlSend || enterSend) { e.preventDefault(); if (activeSession && messageInput.trim()) sendMessage(e); }
  };

  // ── Derived state ─────────────────────────────────────────────────────────
  const loading = loadingSessions.has(activeSession);
  const streamingContent = streamingBySession[activeSession] || '';
  const visibleEndpointKeys = getAvailableEndpoints(activeSessionData?.experience || selectedExperience);
  const selectableEndpointKeys = visibleEndpointKeys.filter((key) => {
    const ep = dockerStatus?.endpoints?.[key];
    return ep ? ep.live === true : true;
  });
  const allServiceEntries = [
    ...Object.values(dockerStatus?.containers || {}),
    ...Object.entries(systemServices?.services || {})
      .filter(([k]) => !(dockerStatus?.containers || {})[k] && k !== 'docker-runner')
      .map(([, v]) => v),
  ];
  const runningServices = allServiceEntries.filter(s => s.running).length;
  const totalServices = allServiceEntries.length;

  const dismissOnboarding = () => {
    localStorage.setItem('agent_board_onboarding_dismissed', '1');
    setShowOnboarding(false);
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <TopBar
        activeTab={activeTab} setActiveTab={setActiveTab}
        wsLayout={wsOps.wsLayout} setWsLayout={wsOps.setWsLayout}
        browseWorkspace={wsOps.browseWorkspace} refreshWorkspaceGit={wsOps.refreshWorkspaceGit}
        fetchBranches={wsOps.fetchBranches} fetchArtifacts={wsOps.fetchArtifacts}
        demoMode={demoMode}
        showNewSessionMenu={showNewSessionMenu} setShowNewSessionMenu={setShowNewSessionMenu}
        newSessionMenuRef={newSessionMenuRef}
        selectedExperience={selectedExperience} setSelectedExperience={setSelectedExperience}
        allEndpointMeta={allEndpointMeta} selectableEndpointKeys={selectableEndpointKeys}
        currentEndpoint={currentEndpoint} handleEndpointSelection={handleEndpointSelection}
        sessions={sessions} activeSession={activeSession}
        setActiveSession={setActiveSession} fetchSessionDetails={fetchSessionDetails}
        deleteSession={deleteSession}
        wsConnected={wsConnected}
        createSession={createSession}
        systemServices={systemServices}
        loadingSessions={loadingSessions}
        sessionPendingReply={sessionPendingReply}
        sessionErrors={sessionErrors}
      />

      {showOnboarding && activeSession && (
        <OnboardingStrip
          runningServices={runningServices}
          totalServices={totalServices}
          demoMode={demoMode}
          onCreateSession={createSession}
          onDismiss={dismissOnboarding}
        />
      )}

      <div className="layout">
        <div
          className={`content${wsOps.wsLayout !== 'single' ? ` layout-${wsOps.wsLayout}` : ''}`}
          style={wsOps.wsLayout === 'split-h' ? { '--ws-split-pos': `${wsOps.wsSplitPos}%` } : wsOps.wsLayout === 'split-v' ? { '--ws-split-pos': `${wsOps.wsSplitPos}%` } : undefined}
        >
          {(wsOps.wsLayout !== 'single' || activeTab === 'workspace') && (
            <WorkspaceView
              dockerStatus={dockerStatus}
              {...wsOps}
              tasks={tasks}
              taskTitle={taskTitle} setTaskTitle={setTaskTitle}
              taskDescription={taskDescription} setTaskDescription={setTaskDescription}
              taskPriority={taskPriority} setTaskPriority={setTaskPriority}
              taskExperience={taskExperience} setTaskExperience={setTaskExperience}
              createTask={createTask} updateTask={updateTask} updateTaskStatus={updateTaskStatus}
              dispatchTask={dispatchTask} deleteTask={deleteTask} clearCompletedTasks={clearCompletedTasks}
              activeSession={activeSession} setActiveSession={setActiveSession}
              fetchSessionDetails={fetchSessionDetails} setActiveTab={setActiveTab}
              selectedExperience={selectedExperience}
              contentClients={contentClients} contentFiles={contentFiles}
              contentExpanded={contentExpanded} setContentExpanded={setContentExpanded}
              fetchContentClients={fetchContentClients} fetchContentFiles={fetchContentFiles}
              downloadContentFile={downloadContentFile}
            />
          )}
          {wsOps.wsLayout === 'split-h' && (
            <div className="ws-split-handle ws-split-handle-h" onMouseDown={wsOps.startSplitResize} title="Drag to resize" />
          )}
          {wsOps.wsLayout === 'split-v' && (
            <div className="ws-split-handle ws-split-handle-v" onMouseDown={wsOps.startSplitResizeV} title="Drag to resize" />
          )}
          {(wsOps.wsLayout !== 'single' || activeTab !== 'workspace') && (
            <ChatColumn
              activeSessionData={activeSessionData}
              activeSessionMessages={activeSessionMessages}
              activeSession={activeSession}
              loading={loading}
              streamingContent={streamingContent}
              queueLengths={queueLengths}
              pausedSessions={pausedSessions}
              messageInput={messageInput}
              setMessageInput={setMessageInput}
              sendMessage={sendMessage}
              handleMessageInputKeyDown={handleMessageInputKeyDown}
              sendFeedback={sendFeedback}
              forkSession={forkSession}
              togglePause={togglePause}
              deleteSession={deleteSession}
              renameSession={renameSession}
              fetchSessionDetails={fetchSessionDetails}
              forceSend={forceSend}
              stopSession={stopSession}
              handleEndpointSelection={handleEndpointSelection}
              selectableEndpointKeys={selectableEndpointKeys}
              currentEndpoint={currentEndpoint}
              allEndpointMeta={allEndpointMeta}
              useNemoClaw={useNemoClaw}
              setUseNemoClaw={setUseNemoClaw}
              demoMode={demoMode}
              chatBottomRef={chatBottomRef}
              serviceActionsInFlight={serviceActionsInFlight}
              runServiceAction={runServiceAction}
              EXPERIENCE_TOOLS={EXPERIENCE_TOOLS}
              SAFETY_COLORS={SAFETY_COLORS}
              EXPERIENCE_META={EXPERIENCE_META}
              selectedExperience={selectedExperience}
              setSelectedExperience={setSelectedExperience}
              createSession={createSession}
              dockerStatus={dockerStatus}
              sessions={sessions}
              setActiveSession={setActiveSession}
              systemServices={systemServices}
              runningServices={runningServices}
              totalServices={totalServices}
              wsConnected={wsConnected}
              showSystemPanel={showSystemPanel}
              setShowSystemPanel={setShowSystemPanel}
              showMetricsPanel={showMetricsPanel}
              setShowMetricsPanel={setShowMetricsPanel}
              browseWorkspace={wsOps.browseWorkspace}
              refreshWorkspaceGit={wsOps.refreshWorkspaceGit}
              fetchContentClients={fetchContentClients}
              modelPulls={modelPulls}
              onPullModel={pullModel}
              knownModels={knownModels}
              serviceActionErrors={serviceActionErrors}
              servicesStarting={servicesStarting}
              sessionPendingReply={sessionPendingReply}
              sessionErrors={sessionErrors}
              nineRouterCombo={nineRouterCombo}
              onNineRouterComboChange={setNineRouterCombo}
            />
          )}
        </div>

        {showMetricsPanel && (
          <MetricsPanel
            metricsSummary={metricsSummary}
            metricsSafety={metricsSafety}
            metricsFeedback={metricsFeedback}
            metricsErrors={metricsErrors}
            liveEvents={liveEvents}
            taskSummary={taskSummary}
            onRefresh={fetchMetrics}
            onClose={() => setShowMetricsPanel(false)}
          />
        )}

        {showSystemPanel && (
          <SystemPanel
            dockerStatus={dockerStatus}
            systemServices={systemServices}
            modelPulls={modelPulls}
            systemInfo={systemInfo}
            darkMode={darkMode}
            onToggleTheme={toggleTheme}
            onClose={() => setShowSystemPanel(false)}
            serviceActionsInFlight={serviceActionsInFlight}
            serviceActionErrors={serviceActionErrors}
            servicesStarting={servicesStarting}
            onRunServiceAction={runServiceAction}
            onPullModel={pullModel}
            runningServices={runningServices}
            totalServices={totalServices}
            knownModels={knownModels}
            showMetricsPanel={showMetricsPanel}
            onToggleMetrics={() => setShowMetricsPanel(p => !p)}
            onEndpointAdded={fetchDockerStatus}
          />
        )}

        {showShortcuts && <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />}
      </div>

      <StatusBar
        wsConnected={wsConnected}
        currentEndpoint={currentEndpoint}
        allEndpointMeta={allEndpointMeta}
        runningServices={runningServices}
        totalServices={totalServices}
        showSystemPanel={showSystemPanel}
        onToggleSystemPanel={() => {
          const next = !showSystemPanel;
          setShowSystemPanel(next);
          if (next) {
            setShowMetricsPanel(false);
            if (dockerStatus?.workspace?.configured) { wsOps.browseWorkspace(''); wsOps.refreshWorkspaceGit(); }
            fetchContentClients();
          }
        }}
      />
    </div>
  );
}

export default App;
