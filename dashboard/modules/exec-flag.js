/**
 * Opt-in switch for workspace shell execution: the `/workspace/exec` route and
 * the agent `bash` tool. Off unless WORKSPACE_EXEC is `1` or `true`.
 * Read at call time so the value can change between requests (and in tests).
 */
export function shellExecEnabled(env = process.env) {
  return ['1', 'true'].includes(String(env.WORKSPACE_EXEC ?? '').trim().toLowerCase());
}
