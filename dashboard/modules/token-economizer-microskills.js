/**
 * Append TokenEconomizer repository facts to the system prompt.
 * Fail open: unavailable/disabled microskills never change the base prompt.
 */
export async function injectTokenEconomizerMicroskills(systemMessages, client) {
  if (!client || typeof client.getMicroskillsForInjection !== 'function') return systemMessages;
  let microskills = '';
  try {
    microskills = await client.getMicroskillsForInjection();
  } catch {
    return systemMessages;
  }
  if (typeof microskills !== 'string' || !microskills.trim()) return systemMessages;

  const index = systemMessages.findIndex((message) => message.role === 'system');
  if (index < 0) return systemMessages;
  return systemMessages.map((message, i) => i === index
    ? {
        ...message,
        content: `${message.content}\n\nRepository micro-skills (TokenEconomizer):\n${microskills.trim()}`,
      }
    : message);
}
