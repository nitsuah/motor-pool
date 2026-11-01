export function safeTeError(err = {}) {
  if (Number(err.status) === 504) {
    return { code: 'TE_TIMEOUT', error: 'TokenEconomizer command timed out' };
  }
  return { code: 'TE_COMMAND_FAILED', error: 'TokenEconomizer command failed' };
}
