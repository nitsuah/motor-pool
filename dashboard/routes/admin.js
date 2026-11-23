/**
 * Principal and token administration (superadmin only; the guard is applied
 * where this router is mounted, see server.js).
 *
 * GET    /api/admin/principals
 * POST   /api/admin/principals        { id, role, name?, tenant? }
 * DELETE /api/admin/principals/:id    disable it and revoke all of its tokens
 * GET    /api/admin/tokens?principal=<id>
 * POST   /api/admin/tokens            { principalId, label?, expiresInDays?, scopes? }
 *                                      -> 201, the plaintext token once
 * DELETE /api/admin/tokens/:id        revoke
 *
 * Plus GET /api/me (any principal): who the presented credential belongs to.
 */
import express from 'express';
import { AuthError, publicPrincipal } from '../modules/principals.js';

function sendError(res, err, logStructured, action) {
  if (err instanceof AuthError) return res.status(err.status).json({ success: false, error: err.message });
  logStructured('error', 'auth_admin_failed', { action, error: err.message });
  return res.status(500).json({ success: false, error: 'Internal error' });
}

export function createAdminRouter({ service, logStructured = () => {} }) {
  const router = express.Router();
  // Responses may carry a token or principal list; never cache them.
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  const by = (req) => req.principal?.id ?? null;

  router.get('/principals', async (_req, res) => {
    try {
      res.json({ success: true, principals: await service.listPrincipals() });
    } catch (err) { sendError(res, err, logStructured, 'list_principals'); }
  });

  router.post('/principals', async (req, res) => {
    try {
      const { id, name, role, tenant } = req.body || {};
      const principal = await service.createPrincipal({ id, name, role, tenant });
      logStructured('info', 'auth_principal_created', { principalId: principal.id, role: principal.role, by: by(req) });
      res.status(201).json({ success: true, principal });
    } catch (err) { sendError(res, err, logStructured, 'create_principal'); }
  });

  router.delete('/principals/:id', async (req, res) => {
    try {
      const principal = await service.disablePrincipal(req.params.id);
      logStructured('info', 'auth_principal_disabled', { principalId: principal.id, by: by(req) });
      res.json({ success: true, principal });
    } catch (err) { sendError(res, err, logStructured, 'disable_principal'); }
  });

  router.get('/tokens', async (req, res) => {
    try {
      const principalId = typeof req.query.principal === 'string' ? req.query.principal : undefined;
      res.json({ success: true, tokens: await service.listTokens(principalId) });
    } catch (err) { sendError(res, err, logStructured, 'list_tokens'); }
  });

  router.post('/tokens', async (req, res) => {
    try {
      const { principalId, label, expiresInDays, scopes } = req.body || {};
      const minted = await service.mintToken({
        principalId, label, scopes: scopes ?? [], ...(expiresInDays === undefined ? {} : { expiresInDays }),
      });
      logStructured('info', 'auth_token_minted', { tokenId: minted.id, principalId: minted.principalId, by: by(req) });
      res.status(201).json({ success: true, token: minted });
    } catch (err) { sendError(res, err, logStructured, 'mint_token'); }
  });

  router.delete('/tokens/:id', async (req, res) => {
    try {
      const token = await service.revokeToken(req.params.id);
      logStructured('info', 'auth_token_revoked', { tokenId: token.id, principalId: token.principalId, by: by(req) });
      res.json({ success: true, token });
    } catch (err) { sendError(res, err, logStructured, 'revoke_token'); }
  });

  return router;
}

export function whoAmIHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const p = req.principal;
  res.json({ success: true, principal: { ...publicPrincipal(p), via: p.via } });
}
