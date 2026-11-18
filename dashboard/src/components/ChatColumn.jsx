import React, { Suspense, lazy, useEffect, useState } from 'react';
import MessageList from './MessageList.jsx';
import ToolWorkbench from './ToolWorkbench.jsx';

import SessionHeader from './SessionHeader.jsx';
import MessageComposer from './MessageComposer.jsx';
import ReplayPanel from './ReplayPanel.jsx';
import { toast } from './Toast.jsx';

const LiminalDashboard = lazy(() => import('./LiminalDashboard.jsx'));

export default function ChatColumn({
  renameSession,
  activeSessionData,
  activeSessionMessages,
  activeSession,
  loading,
  streamingContent,
  queueLengths,
  pausedSessions,
  messageInput,
  setMessageInput,
  sendMessage,
  handleMessageInputKeyDown,
  sendFeedback,
  togglePause,
  deleteSession,
  fetchSessionDetails,
  forceSend,
  stopSession,
  forkSession,
  handleEndpointSelection,
  selectableEndpointKeys,
  currentEndpoint,
  allEndpointMeta,
  useNemoClaw,
  setUseNemoClaw,
  demoMode,
  chatBottomRef,
  serviceActionsInFlight,
  runServiceAction,
  EXPERIENCE_TOOLS,
  SAFETY_COLORS,
  EXPERIENCE_META,
  selectedExperience,
  setSelectedExperience,
  createSession,
  dockerStatus,
  sessions,
  setActiveSession,
  systemServices,
  runningServices,
  totalServices,
  wsConnected,
  showSystemPanel,
  setShowSystemPanel,
  browseWorkspace,
  refreshWorkspaceGit,
  fetchContentClients,
  showMetricsPanel,
  setShowMetricsPanel,
  modelPulls,
  onPullModel,
  knownModels,
  serviceActionErrors,
  servicesStarting,
  sessionPendingReply,
  sessionErrors,
  nineRouterCombo,
  onNineRouterComboChange,
}) {
  const [replayMode, setReplayMode] = useState(false);
  const [replayData, setReplayData] = useState(null);
  const [replayStep, setReplayStep] = useState(0);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replaySessionId, setReplaySessionId] = useState(null);

  const [nineRouterCombos, setNineRouterCombos] = useState([]);
  const is9Router = allEndpointMeta[currentEndpoint]?.label?.toLowerCase().includes('9router')
    || currentEndpoint?.toLowerCase().includes('9router')
    || currentEndpoint?.toLowerCase().includes('local_20128');

  useEffect(() => {
    if (!is9Router) { setNineRouterCombos([]); return; }
    setNineRouterCombos([]);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/proxy-models?endpoint=' + encodeURIComponent(currentEndpoint));
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.models)) {
          setNineRouterCombos(data.models.map(m => (typeof m === 'string' ? m : m.id || m.name)).filter(Boolean));
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [is9Router, currentEndpoint]);

  // Clear replay when the user switches away from the session that owns it
  useEffect(() => {
    if (replayMode && replaySessionId !== activeSession) {
      setReplayMode(false);
      setReplayData(null);
      setReplaySessionId(null);
    }
  }, [activeSession, replayMode, replaySessionId]);

  const handleStartReplay = async () => {
    const sessionId = activeSession;
    setReplayBusy(true);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/replay`);
      if (!res.ok) { toast.error(`Replay failed: HTTP ${res.status}`); return; }
      const data = await res.json();
      if (!data.success) { toast.error(data.error || 'Replay unavailable'); return; }
      if (sessionId !== activeSession) return;
      setReplayData(data.replay);
      setReplaySessionId(sessionId);
      setReplayStep(0);
      setReplayMode(true);
    } catch (err) { toast.error(`Replay error: ${err.message}`); }
    finally { setReplayBusy(false); }
  };

  return (
    <div className={`chat-column${!activeSessionData ? ' liminal-mode' : ''}`}>
      {activeSessionData ? (
        <>
          <SessionHeader
            activeSession={activeSession}
            activeSessionData={activeSessionData}
            activeSessionMessages={activeSessionMessages}
            loading={loading}
            queueLengths={queueLengths}
            pausedSessions={pausedSessions}
            renameSession={renameSession}
            deleteSession={deleteSession}
            togglePause={togglePause}
            forceSend={forceSend}
            stopSession={stopSession}
            fetchSessionDetails={fetchSessionDetails}
            selectableEndpointKeys={selectableEndpointKeys}
            currentEndpoint={currentEndpoint}
            allEndpointMeta={allEndpointMeta}
            handleEndpointSelection={handleEndpointSelection}
            demoMode={demoMode}
            SAFETY_COLORS={SAFETY_COLORS}
            EXPERIENCE_META={EXPERIENCE_META}
            selectedExperience={selectedExperience}
            nineRouterCombos={nineRouterCombos}
            nineRouterCombo={nineRouterCombo}
            onComboChange={onNineRouterComboChange}
            is9Router={is9Router}
            onStartReplay={handleStartReplay}
            replayBusy={replayBusy}
          />

          {EXPERIENCE_TOOLS[activeSessionData.experience] && (
            <ToolWorkbench
              toolKey={EXPERIENCE_TOOLS[activeSessionData.experience].toolKey}
              serviceKey={EXPERIENCE_TOOLS[activeSessionData.experience].serviceKey}
              onRunService={runServiceAction}
              serviceActionsInFlight={serviceActionsInFlight}
            />
          )}

          <MessageList
            messages={activeSessionMessages}
            loading={loading}
            streamingContent={streamingContent}
            onFeedback={sendFeedback}
            onFork={forkSession ? (msgIdx) => forkSession(activeSession, msgIdx) : undefined}
            chatBottomRef={chatBottomRef}
          />

          <MessageComposer
            activeSession={activeSession}
            loading={loading}
            queueLengths={queueLengths}
            messageInput={messageInput}
            setMessageInput={setMessageInput}
            sendMessage={sendMessage}
            handleMessageInputKeyDown={handleMessageInputKeyDown}
            forceSend={forceSend}
            stopSession={stopSession}
          />

          {systemServices?.services?.nemoclaw?.status === 'up' && (
            <div className="chat-model-row">
              <label className="chat-nemo-toggle" title="Enable NemoClaw safety layer">
                <input type="checkbox" checked={useNemoClaw} onChange={e => setUseNemoClaw(e.target.checked)} className="sr-only" />
                <span style={{ opacity: useNemoClaw ? 1 : 0.45, fontSize: '0.85rem' }}>🦅</span>
                <span style={{ fontSize: '0.7rem', color: useNemoClaw ? 'var(--text-muted)' : 'var(--text-faint)' }}>NemoClaw</span>
              </label>
            </div>
          )}
        </>
      ) : (
        <Suspense fallback={null}>
          <LiminalDashboard
          systemServices={systemServices}
          dockerStatus={dockerStatus}
          sessions={sessions}
          allEndpointMeta={allEndpointMeta}
          selectableEndpointKeys={selectableEndpointKeys}
          runningServices={runningServices}
          totalServices={totalServices}
          wsConnected={wsConnected}
          onSelectSession={setActiveSession}
          onCreateSession={createSession}
          selectedExperience={selectedExperience}
          EXPERIENCE_META={EXPERIENCE_META}
          onRunServiceAction={runServiceAction}
          serviceActionsInFlight={serviceActionsInFlight}
          modelPulls={modelPulls}
          onPullModel={onPullModel}
          knownModels={knownModels}
          activeSessionId={activeSession}
          loading={loading}
          sessionPendingReply={sessionPendingReply}
          sessionErrors={sessionErrors}
          />
        </Suspense>
      )}

      {replayMode && replayData && replaySessionId === activeSession && (
        <ReplayPanel
          replayData={replayData}
          replayStep={replayStep}
          setReplayStep={setReplayStep}
          onClose={() => { setReplayMode(false); setReplayData(null); setReplaySessionId(null); }}
        />
      )}
    </div>
  );
}
