import { ApiAuthError, ResyncRequiredError, createApiClient } from './api.js';
import { applyHelixEvent, applySnapshot, createConsoleState, nextReconnectDelay } from './state.js';
import { approvalActionPath, executionActionPath, renderConsole, setText } from './render.js';

const content = document.querySelector('#content');
const notice = document.querySelector('#notice');
const tokenInput = document.querySelector('#api-token');
const connectButton = document.querySelector('#connect');
const refreshButton = document.querySelector('#refresh');
const navigation = document.querySelector('#navigation');
const viewTitle = document.querySelector('#view-title');
const connectionDot = document.querySelector('#connection-dot');
const connectionLabel = document.querySelector('#connection-label');
const sequenceLabel = document.querySelector('#sequence-label');

if (!content || !notice || !tokenInput || !connectButton || !refreshButton || !navigation || !viewTitle || !connectionDot || !connectionLabel || !sequenceLabel) {
  throw new Error('Helix dashboard shell is incomplete');
}

let apiToken = '';
let state = createConsoleState();
let activeView = 'overview';
let streamController = null;
let reconnectTimer = null;
let reconnectDelay = 0;
let streamGeneration = 0;
let selectedRefreshTimer = null;
let refreshPromise = null;

const api = createApiClient({
  origin: window.location.origin,
  getToken: () => apiToken,
});

const handlers = {
  onExecutionSelect: (executionId) => selectExecution(executionId),
  onExecutionAction: (executionId, action) => mutateExecution(executionId, action),
  onApprovalAction: (approvalId, action) => mutateApproval(approvalId, action),
};

navigation.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('[data-view]') : null;
  const view = target?.getAttribute('data-view');
  if (!view) return;
  activeView = view;
  render();
});

tokenInput.addEventListener('input', () => {
  apiToken = tokenInput.value;
});

connectButton.addEventListener('click', () => {
  apiToken = tokenInput.value;
  void refreshAndConnect({ reason: 'manual reconnect' });
});

refreshButton.addEventListener('click', () => {
  void refreshAndConnect({ reason: 'manual refresh' });
});

window.addEventListener('beforeunload', () => stopStream());

render();
void refreshAndConnect({ reason: 'initial load' });

async function refreshAndConnect({ reason }) {
  if (refreshPromise) return refreshPromise;
  refreshPromise = (async () => {
    stopStream();
    setConnection('syncing');
    setBusy(true);
    try {
      await loadSnapshot();
      clearNotice();
      render();
      startStream();
    } catch (error) {
      handleTopLevelError(error, reason);
    } finally {
      setBusy(false);
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

async function loadSnapshot() {
  const health = await api.json('/health');
  const baseline = safeSequence(health?.sequence);
  const [agents, executions, approvals, telemetry, eventSnapshot] = await Promise.all([
    api.json('/agents'),
    api.json('/executions'),
    api.json('/approvals?status=pending'),
    api.json('/telemetry'),
    loadRecentEvents(baseline),
  ]);

  state = applySnapshot(state, {
    health,
    agents,
    executions,
    approvals,
    telemetry,
    events: eventSnapshot,
  });

  if (state.selectedExecution?.execution?.id) {
    await loadSelectedExecution(state.selectedExecution.execution.id, { quiet: true });
  }
}

async function loadRecentEvents(baseline) {
  let after = Math.max(0, baseline - 200);
  let cursor = after;
  let recent = [];
  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const page = await api.json(`/events?after=${cursor}&limit=200`);
    const events = Array.isArray(page?.events) ? page.events : [];
    if (events.length) {
      const last = safeSequence(events[events.length - 1]?.sequence);
      if (last <= cursor) throw new ResyncRequiredError('Event replay did not advance the dashboard cursor');
      cursor = last;
      recent = [...recent, ...events].slice(-200);
    }
    if (!page?.hasMore) return { sequence: Math.max(baseline, cursor), events: recent };
    if (!events.length) throw new ResyncRequiredError('Event replay reported more data without advancing');
  }
  throw new ResyncRequiredError('Event replay exceeded the dashboard catch-up bound');
}

function startStream() {
  stopStream();
  const generation = ++streamGeneration;
  const controller = new AbortController();
  streamController = controller;
  setConnection('connecting');

  void api.streamEvents({
    after: state.lastSequence,
    signal: controller.signal,
    onOpen: () => {
      if (generation !== streamGeneration) return;
      reconnectDelay = 0;
      setConnection('live');
    },
    onEvent: (event) => {
      if (generation !== streamGeneration) return;
      const applied = applyHelixEvent(state, event);
      if (applied.resyncRequired) {
        controller.abort();
        showNotice('Event sequence gap detected. Reloading authoritative state.', 'warning');
        void refreshAndConnect({ reason: 'event sequence gap' });
        return;
      }
      state = applied.state;
      render();
      if (state.selectedExecutionRefreshRequired) scheduleSelectedExecutionRefresh();
    },
  }).catch((error) => {
    if (generation !== streamGeneration || controller.signal.aborted) return;
    streamController = null;
    if (error instanceof ApiAuthError) {
      setConnection('auth');
      showNotice('API authentication is enabled. Enter the API token and reconnect.', 'warning');
      return;
    }
    if (error instanceof ResyncRequiredError) {
      showNotice('The event stream requires a fresh snapshot. Resynchronizing.', 'warning');
      void refreshAndConnect({ reason: 'stream resync' });
      return;
    }
    setConnection('offline');
    scheduleReconnect(error);
  });
}

function stopStream() {
  streamGeneration += 1;
  if (streamController) {
    streamController.abort();
    streamController = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(error) {
  reconnectDelay = nextReconnectDelay(reconnectDelay);
  showNotice(`Live stream disconnected: ${messageOf(error)}. Reconnecting shortly.`, 'warning');
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    startStream();
  }, reconnectDelay);
}

function scheduleSelectedExecutionRefresh() {
  if (selectedRefreshTimer || !state.selectedExecution?.execution?.id) return;
  selectedRefreshTimer = window.setTimeout(() => {
    selectedRefreshTimer = null;
    const executionId = state.selectedExecution?.execution?.id;
    if (executionId) void loadSelectedExecution(executionId, { quiet: true });
  }, 120);
}

async function selectExecution(executionId) {
  if (typeof executionId !== 'string' || !executionId) return;
  activeView = 'executions';
  render();
  await loadSelectedExecution(executionId, { quiet: false });
}

async function loadSelectedExecution(executionId, { quiet }) {
  try {
    const selectedExecution = await api.json(`/executions/${encodeURIComponent(executionId)}`);
    state = {
      ...state,
      selectedExecution,
      selectedExecutionRefreshRequired: false,
    };
    render();
  } catch (error) {
    if (!quiet) showNotice(`Could not load execution: ${messageOf(error)}`, 'error');
  }
}

async function mutateExecution(executionId, action) {
  if (!confirmMutation(`${action} execution`, executionId)) return;
  setBusy(true);
  try {
    await api.json(executionActionPath(executionId, action), { method: 'POST' });
    await loadSelectedExecution(executionId, { quiet: true });
    showNotice(`Execution ${action} accepted.`, 'success');
  } catch (error) {
    showNotice(`Execution action failed: ${messageOf(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

async function mutateApproval(approvalId, action) {
  if (!confirmMutation(`${action} approval`, approvalId)) return;
  setBusy(true);
  try {
    await api.json(approvalActionPath(approvalId, action), { method: 'POST' });
    const approvals = await api.json('/approvals?status=pending');
    state = applySnapshot(state, { approvals });
    render();
    const decision = action === 'approve' ? 'approved' : 'denied';
    showNotice(`Approval ${decision}.`, 'success');
  } catch (error) {
    showNotice(`Approval action failed: ${messageOf(error)}`, 'error');
  } finally {
    setBusy(false);
  }
}

function confirmMutation(label, id) {
  return window.confirm(`${label}?\n\n${id}`);
}

function render() {
  const titles = {
    overview: 'Overview',
    executions: 'Executions',
    agents: 'Agents',
    approvals: 'Approvals',
    telemetry: 'Telemetry',
    events: 'Events',
  };
  setText(viewTitle, titles[activeView] ?? 'Helix');
  setText(sequenceLabel, `Sequence ${state.lastSequence}`);
  for (const item of navigation.querySelectorAll('[data-view]')) {
    item.classList.toggle('active', item.getAttribute('data-view') === activeView);
  }
  renderConsole(content, activeView, state, handlers);
}

function setConnection(status) {
  const labels = {
    live: 'Live',
    connecting: 'Connecting',
    syncing: 'Syncing',
    auth: 'Authentication required',
    offline: 'Offline',
  };
  setText(connectionLabel, labels[status] ?? status);
  connectionDot.className = `connection-dot connection-${status}`;
}

function setBusy(busy) {
  refreshButton.disabled = busy;
  connectButton.disabled = busy;
  refreshButton.textContent = busy ? 'Syncing…' : 'Refresh';
}

function showNotice(message, kind = 'info') {
  notice.textContent = message;
  notice.className = `notice notice-${kind}`;
}

function clearNotice() {
  notice.textContent = '';
  notice.className = 'notice hidden';
}

function handleTopLevelError(error, reason) {
  if (error instanceof ApiAuthError) {
    setConnection('auth');
    showNotice('API authentication is enabled. Enter the API token and reconnect.', 'warning');
    tokenInput.focus();
    return;
  }
  setConnection('offline');
  showNotice(`Unable to synchronize Helix during ${reason}: ${messageOf(error)}`, 'error');
}

function safeSequence(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
