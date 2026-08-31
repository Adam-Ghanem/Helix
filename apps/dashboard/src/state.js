const RECENT_EVENT_LIMIT = 200;

export function createConsoleState() {
  return {
    lastSequence: 0,
    health: null,
    agents: [],
    executions: [],
    approvals: [],
    telemetry: null,
    recentEvents: [],
    selectedExecution: null,
    selectedExecutionRefreshRequired: false,
  };
}

export function applySnapshot(state, snapshot) {
  const next = {
    ...state,
    health: snapshot.health ?? state.health,
    agents: Array.isArray(snapshot.agents?.agents) ? clone(snapshot.agents.agents) : state.agents,
    executions: Array.isArray(snapshot.executions?.executions) ? clone(snapshot.executions.executions) : state.executions,
    approvals: Array.isArray(snapshot.approvals?.approvals) ? clone(snapshot.approvals.approvals) : state.approvals,
    telemetry: snapshot.telemetry !== undefined ? clone(snapshot.telemetry) : state.telemetry,
    recentEvents: Array.isArray(snapshot.events?.events)
      ? clone(snapshot.events.events.slice(-RECENT_EVENT_LIMIT))
      : state.recentEvents,
  };
  const sequences = [
    state.lastSequence,
    safeSequence(snapshot.health?.sequence),
    safeSequence(snapshot.events?.sequence),
    ...next.recentEvents.map((event) => safeSequence(event?.sequence)),
  ];
  next.lastSequence = Math.max(...sequences);
  return next;
}

export function applyHelixEvent(state, event) {
  const sequence = safeSequence(event?.sequence);
  if (sequence < 1) return { state, resyncRequired: true };
  if (sequence <= state.lastSequence) return { state, resyncRequired: false };
  if (sequence !== state.lastSequence + 1) return { state, resyncRequired: true };

  const next = {
    ...state,
    lastSequence: sequence,
    recentEvents: [...state.recentEvents, clone(event)].slice(-RECENT_EVENT_LIMIT),
  };

  const execution = event?.payload?.execution;
  if (execution && typeof execution === 'object' && typeof execution.id === 'string') {
    next.executions = upsertById(state.executions, execution);
    const selectedId = state.selectedExecution?.execution?.id;
    if (selectedId === execution.id && state.selectedExecution) {
      next.selectedExecution = { ...clone(state.selectedExecution), execution: clone(execution) };
    }
  }

  if (typeof event?.type === 'string' && event.type.startsWith('approval.')) {
    const approval = event.payload;
    if (approval && typeof approval === 'object' && typeof approval.id === 'string') {
      if (approval.status === 'pending') next.approvals = upsertById(state.approvals, approval);
      else next.approvals = state.approvals.filter((candidate) => candidate?.id !== approval.id).map(clone);
    }
  }

  const selectedExecutionId = state.selectedExecution?.execution?.id;
  if (
    typeof selectedExecutionId === 'string' &&
    event?.executionId === selectedExecutionId &&
    typeof event?.type === 'string' &&
    (event.type.startsWith('task.') || event.type.startsWith('plan.'))
  ) {
    next.selectedExecutionRefreshRequired = true;
  }

  return { state: next, resyncRequired: false };
}

export function nextReconnectDelay(previous) {
  if (!Number.isFinite(previous) || previous <= 0) return 500;
  return Math.min(10_000, Math.max(500, Math.floor(previous * 2)));
}

function upsertById(items, value) {
  let replaced = false;
  const next = items.map((item) => {
    if (item?.id !== value.id) return clone(item);
    replaced = true;
    return clone(value);
  });
  if (!replaced) next.push(clone(value));
  return next;
}

function safeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}
