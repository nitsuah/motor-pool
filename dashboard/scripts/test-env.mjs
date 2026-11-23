// Preloaded (node --import) by the integration and SSRF test scripts: they call the
// in-process app from loopback without a token, so enable the local-dev opt-out and
// keep an inherited NODE_ENV=production from disabling it. Cross-platform, unlike
// a `VAR=1 node ...` prefix.
process.env.DASHBOARD_ALLOW_LOOPBACK_NOAUTH = '1';
if (String(process.env.NODE_ENV || '').toLowerCase() === 'production') process.env.NODE_ENV = 'test';
