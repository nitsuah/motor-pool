/**
 * Unit tests for task-runner.js priority queue and dispatch.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomBytes } from 'crypto';
import { startTaskRunner } from '../task-runner.js';

function makeTask(overrides = {}) {
  const id = `task_test_${randomBytes(3).toString('hex')}`;
  return {
    id, title: 'Test task', status: 'pending',
    priority: 'medium', assignedUserId: null, experience: null,
    sessionId: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), completedAt: null,
    ...overrides,
  };
}

// Test 1: stub mode completes tasks without dispatchMessage
await (async () => {
  const tasks = new Map();
  const bus = new EventEmitter();
  const statusChanges = [];
  bus.on('task_status_changed', e => statusChanges.push(e.metadata));

  const t = makeTask({ id: 'task_1' });
  tasks.set(t.id, t);

  const stop = startTaskRunner(tasks, bus, undefined, { intervalMs: 50 });
  await new Promise(r => setTimeout(r, 700)); // wait for one tick + stub delay
  stop();

  assert.equal(t.status, 'completed', 'task should complete in stub mode');
  assert.ok(t.completedAt, 'completedAt should be set');
  assert.ok(statusChanges.some(s => s.status === 'running'), 'should emit running');
  assert.ok(statusChanges.some(s => s.status === 'completed'), 'should emit completed');
  console.log('✅ stub mode completes task');
})();

// Test 2: priority ordering — high priority runs before low
await (async () => {
  const tasks = new Map();
  const bus = new EventEmitter();
  const order = [];

  const dispatchMessage = async (task) => {
    order.push(task.priority);
    return { content: 'done' };
  };

  const low = makeTask({ id: 'task_low', priority: 'low', createdAt: new Date(Date.now() - 1000).toISOString() });
  const high = makeTask({ id: 'task_high', priority: 'high', createdAt: new Date().toISOString() });
  tasks.set(low.id, low);
  tasks.set(high.id, high);

  const stop = startTaskRunner(tasks, bus, dispatchMessage, { intervalMs: 100 });
  await new Promise(r => setTimeout(r, 600)); // wait for 2 ticks at 100ms each + buffer
  stop();

  assert.equal(order[0], 'high', 'high priority should run first');
  assert.equal(order[1], 'low', 'low priority should run second');
  console.log('✅ priority ordering respected');
})();

// Test 3: failed dispatchMessage marks task as failed
await (async () => {
  const tasks = new Map();
  const bus = new EventEmitter();

  const dispatchMessage = async () => { throw new Error('LLM unreachable'); };

  const t = makeTask({ id: 'task_fail' });
  tasks.set(t.id, t);

  const stop = startTaskRunner(tasks, bus, dispatchMessage, { intervalMs: 50 });
  await new Promise(r => setTimeout(r, 200));
  stop();

  assert.equal(t.status, 'failed', 'task should be failed when dispatch throws');
  console.log('✅ dispatch error marks task as failed');
})();

// Test 4: only one task runs at a time (no double-dispatch)
await (async () => {
  const tasks = new Map();
  const bus = new EventEmitter();
  let concurrent = 0;
  let maxConcurrent = 0;

  const dispatchMessage = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 200));
    concurrent--;
    return { content: 'ok' };
  };

  for (let i = 0; i < 3; i++) {
    const t = makeTask({ id: `task_c${i}` });
    tasks.set(t.id, t);
  }

  const stop = startTaskRunner(tasks, bus, dispatchMessage, { intervalMs: 100 });
  await new Promise(r => setTimeout(r, 1500)); // enough for 3+ ticks at 100ms
  stop();

  assert.equal(maxConcurrent, 1, 'at most 1 task should run at a time');
  console.log('✅ tasks run serially, no double-dispatch');
})();

console.log('Task runner unit tests passed.');
