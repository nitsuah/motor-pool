import express from 'express';

// defaultRepoRoot must match the repoRoot the session/task paths record under
// (WORKSPACE_ROOT in Compose), or the panel queries a key nothing writes to.
export function createTokenEconomizerRouter({ TokenEconomizer, logStructured, defaultRepoRoot = process.cwd() }) {
  const router = express.Router();
  const rootOf = (value) => ((typeof value === 'string' && value) ? value : defaultRepoRoot);

  // Get status
  router.get('/status', async (req, res) => {
    try {
      const { repoRoot } = req.query;
      const status = await TokenEconomizer.getStatus(rootOf(repoRoot));
      res.json({ success: true, status });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_status_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Get config
  router.get('/config', async (req, res) => {
    try {
      const config = await TokenEconomizer.loadConfig();
      res.json({ success: true, config });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_config_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Set config
  router.post('/config', async (req, res) => {
    const check = TokenEconomizer.validateConfigUpdate(req.body);
    if (!check.ok) return res.status(400).json({ success: false, error: check.error });
    try {
      const config = await TokenEconomizer.saveConfig(check.value);
      res.json({ success: true, config });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_config_set_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Micro-skills
  router.get('/microskills', async (req, res) => {
    try {
      const { repoRoot } = req.query;
      const microskills = await TokenEconomizer.loadMicroskills();
      const filtered = {
        confirmed: microskills.confirmed.filter(m => m.repo === (rootOf(repoRoot)) || m.global),
        proposed: microskills.proposed.filter(m => m.repo === (rootOf(repoRoot))),
        rejected: microskills.rejected.filter(m => m.repo === (rootOf(repoRoot))),
      };
      res.json({ success: true, microskills: filtered });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_microskills_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/microskills/propose', async (req, res) => {
    try {
      const { fact, repoRoot, source } = req.body;
      if (!fact) return res.status(400).json({ success: false, error: 'fact is required' });
      const result = await TokenEconomizer.proposeMicroskill(fact, rootOf(repoRoot), source || 'manual');
      res.json({ success: true, ...result });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_microskill_propose_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/microskills/confirm', async (req, res) => {
    try {
      const { skillId } = req.body;
      if (!skillId) return res.status(400).json({ success: false, error: 'skillId is required' });
      const result = await TokenEconomizer.confirmMicroskill(skillId);
      res.json({ success: true, ...result });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_microskill_confirm_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/microskills/reject', async (req, res) => {
    try {
      const { skillId } = req.body;
      if (!skillId) return res.status(400).json({ success: false, error: 'skillId is required' });
      const result = await TokenEconomizer.rejectMicroskill(skillId);
      res.json({ success: true, ...result });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_microskill_reject_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Tool pruning
  router.get('/toolprune', async (req, res) => {
    try {
      const { repoRoot, experience } = req.query;
      const prunable = await TokenEconomizer.getPrunableTools(rootOf(repoRoot), experience || 'developer');
      const evidence = await TokenEconomizer.loadToolEvidence();
      const repoEvidence = Object.values(evidence).filter(
        e => e.repo === (rootOf(repoRoot)) && e.experience === (experience || 'developer')
      );
      res.json({ success: true, prunable, evidence: repoEvidence });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_toolprune_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/toolprune/prune', async (req, res) => {
    try {
      const { repoRoot, experience, tools } = req.body;
      if (!Array.isArray(tools) || tools.length === 0) {
        return res.status(400).json({ success: false, error: 'tools array is required' });
      }
      const pruned = await TokenEconomizer.pruneTools(rootOf(repoRoot), experience || 'developer', tools);
      res.json({ success: true, pruned });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_toolprune_prune_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  router.post('/toolprune/restore', async (req, res) => {
    try {
      const { repoRoot, experience, tool } = req.body;
      if (!tool) return res.status(400).json({ success: false, error: 'tool is required' });
      const restored = await TokenEconomizer.restoreTool(rootOf(repoRoot), experience || 'developer', tool);
      res.json({ success: true, restored });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_toolprune_restore_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Session history
  router.get('/sessions', async (req, res) => {
    try {
      const { repoRoot, limit } = req.query;
      const history = await TokenEconomizer.loadSessionHistory();
      const filtered = history.filter(h => h.repo === (rootOf(repoRoot)));
      res.json({ success: true, sessions: filtered.slice(-(Number(limit) || 50)) });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_sessions_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Loop guard check
  router.post('/loopguard/check', async (req, res) => {
    try {
      const { sessionId, turnCount, lastTurnTime } = req.body;
      if (!sessionId || typeof turnCount !== 'number' || !lastTurnTime) {
        return res.status(400).json({ success: false, error: 'sessionId, turnCount, and lastTurnTime are required' });
      }
      const result = await TokenEconomizer.getLoopGuardNudge(sessionId, turnCount, lastTurnTime);
      res.json({ success: true, ...result });
    } catch (error) {
      logStructured('error', 'tokeneconomizer_loopguard_failed', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    }
  });

  return router;
}
