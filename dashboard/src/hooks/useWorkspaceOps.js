import { useState, useRef } from 'react';
import { toast } from '../components/Toast.jsx';

export function useWorkspaceOps() {
  const [workspacePath, setWorkspacePath] = useState('');
  const [workspaceLs, setWorkspaceLs] = useState(null);
  const [openFiles, setOpenFiles] = useState([]);
  const [activeFilePath, setActiveFilePath] = useState(null);
  const [workspaceGitStatus, setWorkspaceGitStatus] = useState(null);
  const [workspaceBranches, setWorkspaceBranches] = useState({ branches: [], remotes: [], current: '' });
  const [wsNewBranch, setWsNewBranch] = useState(null); // null=hidden, ''=show input
  const [wsGitBusy, setWsGitBusy] = useState('');
  const [wsGitMsg, setWsGitMsg] = useState('');
  const [wsGitPopover, setWsGitPopover] = useState(false);
  const [workspaceCommitMsg, setWorkspaceCommitMsg] = useState('');
  const [workspaceActions, setWorkspaceActions] = useState({ committing: false, pushing: false, saving: false, error: null });
  const [artifactFiles, setArtifactFiles] = useState([]);
  const [wsShowExplorer, setWsShowExplorer] = useState(true);
  const [wsSearch, setWsSearch] = useState('');
  const [wsSearchResults, setWsSearchResults] = useState(null);
  const [wsSearchBusy, setWsSearchBusy] = useState(false);
  const [wsNewName, setWsNewName] = useState('');
  const [wsCreateMode, setWsCreateMode] = useState('');
  const [wsRenaming, setWsRenaming] = useState(null);
  const [wsBottomTab, setWsBottomTab] = useState('terminal');
  const [termHistory, setTermHistory] = useState([]);
  const [termInput, setTermInput] = useState('');
  const [termBusy, setTermBusy] = useState(false);
  const termCmdHistoryRef = useRef([]); // past commands (oldest first)
  const termCmdIndexRef = useRef(-1);   // -1 = not browsing history
  const termEndRef = useRef(null);
  const [wsLayout, setWsLayout] = useState('single');
  const [wsExplorerWidth, setWsExplorerWidth] = useState(220);
  const [wsBottomHeight, setWsBottomHeight] = useState(220);
  const [wsSplitPos, setWsSplitPos] = useState(50); // percent for horizontal split
  const wsResizingRef = useRef(false);
  const wsGitPopoverRef = useRef(null);

  const browseWorkspace = async (path) => {
    try {
      const res = await fetch(`/api/workspace/ls?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data.error) {
        setWorkspacePath(path);
        setWorkspaceLs(data);
      }
    } catch (err) { toast.error(`Workspace ls failed: ${err.message}`); }
  };

  const openWorkspaceFile = async (path) => {
    const existing = openFiles.find(f => f.path === path);
    if (existing) { setActiveFilePath(path); return; }
    try {
      const res = await fetch(`/api/workspace/read?path=${encodeURIComponent(path)}`);
      const data = await res.json();
      if (!data.error) {
        setOpenFiles(prev => [...prev, { path: data.path, content: data.content, editContent: data.content, editing: true }]);
        setActiveFilePath(data.path);
      }
    } catch (err) { toast.error(`Workspace read failed: ${err.message}`); }
  };

  const closeFile = (path) => {
    setOpenFiles(prev => {
      const remaining = prev.filter(f => f.path !== path);
      setActiveFilePath(cur => {
        if (cur !== path) return cur;
        return remaining.length ? remaining[remaining.length - 1].path : null;
      });
      return remaining;
    });
  };

  const refreshWorkspaceGit = async () => {
    try {
      const res = await fetch('/api/workspace/git/status');
      const data = await res.json();
      if (!data.error) setWorkspaceGitStatus(data);
    } catch (err) { toast.error(`Git status failed: ${err.message}`); }
  };

  const fetchArtifacts = async () => {
    try {
      const res = await fetch('/api/workspace/ls?path=artifacts');
      const data = await res.json();
      setArtifactFiles(data.error ? [] : (data.entries || []).filter(e => e.type === 'file'));
    } catch { setArtifactFiles([]); }
  };

  const commitWorkspace = async () => {
    if (!workspaceCommitMsg) return;
    setWorkspaceActions(p => ({ ...p, committing: true, error: null }));
    try {
      const res = await fetch('/api/workspace/git/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: workspaceCommitMsg }),
      });
      const data = await res.json();
      if (data.error) {
        setWorkspaceActions(p => ({ ...p, committing: false, error: data.error }));
      } else {
        setWorkspaceCommitMsg('');
        setWorkspaceActions(p => ({ ...p, committing: false, error: null }));
        refreshWorkspaceGit();
      }
    } catch (err) {
      setWorkspaceActions(p => ({ ...p, committing: false, error: err.message }));
    }
  };

  const pushWorkspace = async () => {
    setWorkspaceActions(p => ({ ...p, pushing: true, error: null }));
    try {
      const res = await fetch('/api/workspace/git/push', { method: 'POST' });
      const data = await res.json();
      if (data.error) {
        setWorkspaceActions(p => ({ ...p, pushing: false, error: data.error }));
      } else {
        setWorkspaceActions(p => ({ ...p, pushing: false, error: null }));
        refreshWorkspaceGit();
      }
    } catch (err) {
      setWorkspaceActions(p => ({ ...p, pushing: false, error: err.message }));
    }
  };

  const saveWorkspaceFile = async (path) => {
    const file = openFiles.find(f => f.path === (path || activeFilePath));
    if (!file || !file.editing) return;
    const content = file.editContent ?? file.content;
    setWorkspaceActions(p => ({ ...p, saving: true, error: null }));
    try {
      const res = await fetch('/api/workspace/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file.path, content }),
      });
      const data = await res.json();
      if (data.error) {
        setWorkspaceActions(p => ({ ...p, saving: false, error: data.error }));
      } else {
        setOpenFiles(prev => prev.map(f => f.path === file.path ? { ...f, content, editContent: null, editing: false } : f));
        setWorkspaceActions(p => ({ ...p, saving: false, error: null }));
        refreshWorkspaceGit();
      }
    } catch (err) {
      setWorkspaceActions(p => ({ ...p, saving: false, error: err.message }));
    }
  };

  const handleTermKeyDown = (e, cmd) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      const hist = termCmdHistoryRef.current;
      if (!hist.length) return;
      const newIdx = termCmdIndexRef.current === -1
        ? hist.length - 1
        : Math.max(0, termCmdIndexRef.current - 1);
      termCmdIndexRef.current = newIdx;
      setTermInput(hist[newIdx]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const hist = termCmdHistoryRef.current;
      const newIdx = termCmdIndexRef.current + 1;
      if (newIdx >= hist.length) {
        termCmdIndexRef.current = -1;
        setTermInput('');
      } else {
        termCmdIndexRef.current = newIdx;
        setTermInput(hist[newIdx]);
      }
    } else if (e.key === 'Enter') {
      runTermCommand(cmd);
    }
  };

  // With WORKSPACE_EXEC_TOKEN set on the server, the terminal must send that
  // token. The user types it once per tab (kept in sessionStorage); the server
  // never hands it out.
  const EXEC_TOKEN_KEY = 'workspace_exec_token';
  const readExecToken = () => {
    try { return sessionStorage.getItem(EXEC_TOKEN_KEY) || ''; } catch { return ''; }
  };
  const postExec = async (cmd) => {
    const send = (token) => fetch('/api/workspace/exec', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ command: cmd }),
    });
    let res = await send(readExecToken());
    if (res.status === 401) {
      const entered = window.prompt('Workspace exec token (WORKSPACE_EXEC_TOKEN):') || '';
      if (entered.trim()) {
        try { sessionStorage.setItem(EXEC_TOKEN_KEY, entered.trim()); } catch { /* storage blocked */ }
        res = await send(entered.trim());
        if (res.status === 401) {
          try { sessionStorage.removeItem(EXEC_TOKEN_KEY); } catch { /* storage blocked */ }
        }
      }
    }
    return res;
  };

  const runTermCommand = async (cmd) => {
    if (!cmd.trim() || termBusy) return;
    termCmdHistoryRef.current = [...termCmdHistoryRef.current.filter(c => c !== cmd), cmd].slice(-100);
    termCmdIndexRef.current = -1;
    const entry = { cmd, stdout: '', stderr: '', exitCode: null, ts: Date.now() };
    setTermHistory(h => [...h, entry]);
    setTermInput('');
    setTermBusy(true);
    try {
      const res = await postExec(cmd);
      // A refusal may have no JSON body; a completed command's body must parse
      // (a read failure there reaches the catch below and is shown as an error).
      const body = res.ok ? await res.json() : await res.json().catch(() => ({}));
      // A refused request (401/403/...) carries only `error`; show it as output.
      const hasOutput = 'stdout' in body || 'stderr' in body;
      const data = res.ok || hasOutput ? body : { stderr: body.error || `Request failed (HTTP ${res.status})`, exitCode: body.exitCode ?? 1 };
      setTermHistory(h => h.map((e, i) => i === h.length - 1 ? { ...e, ...data } : e));
    } catch (err) {
      setTermHistory(h => h.map((e, i) => i === h.length - 1 ? { ...e, stderr: err.message, exitCode: 1 } : e));
    }
    setTermBusy(false);
    setTimeout(() => termEndRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);
  };

  const startExplorerResize = (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wsExplorerWidth;
    wsResizingRef.current = true;
    const onMove = (ev) => {
      if (!wsResizingRef.current) return;
      setWsExplorerWidth(Math.max(140, Math.min(480, startW + ev.clientX - startX)));
    };
    const onUp = () => { wsResizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startSplitResize = (e) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    const startX = e.clientX;
    const startPos = wsSplitPos;
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      const pct = Math.max(20, Math.min(80, ((ev.clientX - rect.left) / rect.width) * 100));
      setWsSplitPos(pct);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startSplitResizeV = (e) => {
    e.preventDefault();
    const container = e.currentTarget.parentElement;
    const onMove = (ev) => {
      const rect = container.getBoundingClientRect();
      const pct = Math.max(20, Math.min(80, ((ev.clientY - rect.top) / rect.height) * 100));
      setWsSplitPos(pct);
    };
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const startBottomResize = (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = wsBottomHeight;
    const onMove = (ev) => setWsBottomHeight(Math.max(80, Math.min(600, startH - (ev.clientY - startY))));
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const moveWorkspaceEntry = async (fromPath, toPath) => {
    try {
      await fetch('/api/workspace/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromPath, to: toPath }),
      });
      browseWorkspace(workspacePath);
    } catch (err) { toast.error(`Move failed: ${err.message}`); }
  };

  const deleteWorkspaceEntry = async (path) => {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      await fetch(`/api/workspace/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
      closeFile(path);
      browseWorkspace(workspacePath);
      refreshWorkspaceGit();
    } catch (err) { toast.error(`Delete failed: ${err.message}`); }
  };

  const createWorkspaceEntry = async (type) => {
    if (!wsNewName.trim()) return;
    const newPath = workspacePath ? `${workspacePath}/${wsNewName.trim()}` : wsNewName.trim();
    if (type === 'dir') {
      await fetch('/api/workspace/mkdir', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath }),
      });
    } else {
      await fetch('/api/workspace/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath, content: '' }),
      });
    }
    setWsNewName('');
    setWsCreateMode('');
    browseWorkspace(workspacePath);
  };

  const renameWorkspaceEntry = async (oldName, newName) => {
    if (!newName.trim() || newName === oldName) { setWsRenaming(null); return; }
    const basePath = workspacePath;
    const fromPath = basePath ? `${basePath}/${oldName}` : oldName;
    const toPath = basePath ? `${basePath}/${newName.trim()}` : newName.trim();
    await fetch('/api/workspace/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromPath, to: toPath }),
    });
    setWsRenaming(null);
    closeFile(fromPath);
    browseWorkspace(workspacePath);
  };

  const searchWorkspace = async () => {
    if (!wsSearch.trim()) return;
    setWsSearchBusy(true);
    setWsSearchResults(null);
    try {
      const res = await fetch('/api/workspace/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: wsSearch }),
      });
      const data = await res.json();
      setWsSearchResults(data.files || []);
    } catch { setWsSearchResults([]); }
    finally { setWsSearchBusy(false); }
  };

  const fetchBranches = async () => {
    try {
      const res = await fetch('/api/workspace/git/branches');
      const data = await res.json();
      if (!data.error) setWorkspaceBranches(data);
    } catch { /* ignore */ }
  };

  const checkoutBranch = async (branch, create = false) => {
    setWsGitBusy('checkout');
    setWsGitMsg('');
    try {
      const res = await fetch('/api/workspace/git/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch, create }),
      });
      const data = await res.json();
      if (data.error) { setWsGitMsg(`✗ ${data.error}`); }
      else { setWsGitMsg(`✓ On ${data.branch}`); setWsNewBranch(''); refreshWorkspaceGit(); fetchBranches(); browseWorkspace(''); }
    } catch (err) { setWsGitMsg(`✗ ${err.message}`); }
    finally { setWsGitBusy(''); }
  };

  const pullBranch = async () => {
    setWsGitBusy('pull');
    setWsGitMsg('');
    try {
      const res = await fetch('/api/workspace/git/pull', { method: 'POST' });
      const data = await res.json();
      if (data.error) setWsGitMsg(`✗ ${data.error}`);
      else { setWsGitMsg(`✓ ${data.result || 'Up to date'}`); refreshWorkspaceGit(); }
    } catch (err) { setWsGitMsg(`✗ ${err.message}`); }
    finally { setWsGitBusy(''); }
  };

  const discardFile = async (file) => {
    setWsGitBusy('discard');
    try {
      const res = await fetch('/api/workspace/git/discard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file }),
      });
      const data = await res.json();
      if (data.error) setWsGitMsg(`✗ ${data.error}`);
      else { refreshWorkspaceGit(); if (file && openFiles.find(f => f.path === file)) { closeFile(file); openWorkspaceFile(file); } }
    } catch { /* ignore */ }
    finally { setWsGitBusy(''); }
  };

  return {
    workspacePath, workspaceLs, openFiles, setOpenFiles, activeFilePath, setActiveFilePath,
    workspaceGitStatus, workspaceBranches, wsNewBranch, setWsNewBranch,
    wsGitBusy, wsGitMsg, wsGitPopover, setWsGitPopover,
    workspaceCommitMsg, setWorkspaceCommitMsg, workspaceActions,
    artifactFiles, wsShowExplorer, setWsShowExplorer,
    wsSearch, setWsSearch, wsSearchResults, setWsSearchResults, wsSearchBusy,
    wsNewName, setWsNewName, wsCreateMode, setWsCreateMode, wsRenaming, setWsRenaming,
    wsBottomTab, setWsBottomTab, termHistory, setTermHistory, termInput, setTermInput, termBusy, termEndRef,
    wsLayout, setWsLayout, wsExplorerWidth, wsBottomHeight, wsSplitPos, wsGitPopoverRef,
    browseWorkspace, openWorkspaceFile, closeFile, refreshWorkspaceGit, fetchArtifacts,
    commitWorkspace, pushWorkspace, saveWorkspaceFile, runTermCommand, handleTermKeyDown,
    startExplorerResize, startBottomResize, startSplitResize, startSplitResizeV,
    deleteWorkspaceEntry, createWorkspaceEntry, moveWorkspaceEntry,
    renameWorkspaceEntry, searchWorkspace, fetchBranches, checkoutBranch, pullBranch, discardFile,
  };
}
