/**
 * Who may see a job and its events (imps plan, "Visibility and auth").
 *
 * A job is visible to its owner, to every superadmin, and, when its
 * visibility is `tenant`, to principals of the same tenant. Anything without
 * an owner is hidden from everyone but superadmins.
 *
 * Job events are bus events whose event_type starts with `job_`; they carry
 * the job's { id, owner_id, tenant, visibility } in `metadata.job`. Other
 * events are not job-scoped and keep their existing audience.
 */
export function canSee(principal, job) {
  if (!principal || !job) return false;
  if (principal.role === 'superadmin') return true;
  if (job.owner_id && job.owner_id === principal.id) return true;
  return job.visibility === 'tenant' && Boolean(job.tenant) && job.tenant === principal.tenant;
}

export function isJobEvent(event) {
  return typeof event?.event_type === 'string' && event.event_type.startsWith('job_');
}

/** Job event types are emitted by the server only; clients may not publish them. */
export function isReservedEventType(type) {
  return typeof type === 'string' && type.toLowerCase().startsWith('job_');
}

export function eventVisibleTo(event, principal) {
  if (!isJobEvent(event)) return true;
  return canSee(principal, event.metadata?.job);
}
