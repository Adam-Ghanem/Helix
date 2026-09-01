const EXECUTION_ACTIONS = new Set(['pause', 'resume', 'cancel', 'retry', 'checkpoint']);
const APPROVAL_ACTIONS = new Set(['approve', 'deny']);

export function executionActionPath(executionId, action) {
  if (!EXECUTION_ACTIONS.has(action)) throw new Error(`Unsupported execution action: ${action}`);
  return `/executions/${encodeURIComponent(String(executionId))}/${action}`;
}

export function approvalActionPath(approvalId, action) {
  if (!APPROVAL_ACTIONS.has(action)) throw new Error(`Unsupported approval action: ${action}`);
  return `/approvals/${encodeURIComponent(String(approvalId))}/${action}`;
}

export function renderConsole(container, view, state, handlers = {}) {
  if (!(container instanceof Element)) throw new Error('Dashboard renderer requires a DOM element');
  container.replaceChildren();
  if (view === 'overview') renderOverview(container, state, handlers);
  else if (view === 'executions') renderExecutions(container, state, handlers);
  else if (view === 'agents') renderAgents(container, state);
  else if (view === 'approvals') renderApprovals(container, state, handlers);
  else if (view === 'telemetry') renderTelemetry(container, state);
  else if (view === 'events') renderEvents(container, state);
  else renderEmpty(container, 'Unknown view', 'Select a valid Helix console view.');
}

export function setText(element, value) {
  if (element) element.textContent = value == null ? '' : String(value);
}

function renderOverview(container, state, handlers) {
  const stats = element('div', 'stat-grid');
  const running = state.executions.filter((execution) => execution?.status === 'running').length;
  const failed = state.executions.filter((execution) => execution?.status === 'failed').length;
  stats.append(
    statCard('Runtime', state.health?.status ?? 'unknown'),
    statCard('Provider', state.health?.provider ?? 'unknown'),
    statCard('Agents', state.agents.length),
    statCard('Running', running),
    statCard('Failed', failed),
    statCard('Pending approvals', state.approvals.length),
  );
  container.append(stats);

  const grid = element('div', 'two-column');
  grid.append(
    panel('Recent executions', renderExecutionTable(state.executions.slice(-8).reverse(), handlers)),
    panel('Live event feed', renderEventList(state.recentEvents.slice(-10).reverse())),
  );
  container.append(grid);
}

function renderExecutions(container, state, handlers) {
  const header = element('div', 'section-header');
  const copy = element('div');
  copy.append(text('h2', 'Executions'), text('p', 'Durable workflows, lifecycle controls, tasks and replanning evidence.', 'muted'));
  header.append(copy);
  container.append(header);

  if (!state.executions.length) {
    renderEmpty(container, 'No executions yet', 'Submit work through the Helix API or CLI to see it here.');
  } else {
    container.append(panel('Execution history', renderExecutionTable(state.executions.slice().reverse(), handlers)));
  }

  if (state.selectedExecution) container.append(renderExecutionDetail(state.selectedExecution, handlers));
}

function renderExecutionDetail(view, handlers) {
  const execution = view.execution ?? {};
  const wrapper = element('section', 'panel execution-detail');
  const heading = element('div', 'detail-heading');
  const titleWrap = element('div');
  titleWrap.append(text('p', 'Selected execution', 'eyebrow'), text('h2', execution.goal ?? execution.id ?? 'Execution'));
  heading.append(titleWrap, statusPill(execution.status ?? 'unknown'));
  wrapper.append(heading);

  const meta = element('div', 'detail-meta');
  meta.append(
    labeledValue('ID', execution.id ?? '—', true),
    labeledValue('Plan revision', view.planRevision ?? 0),
    labeledValue('Updated', formatTime(execution.updatedAt)),
    labeledValue('Tasks', Array.isArray(view.tasks) ? view.tasks.length : 0),
  );
  wrapper.append(meta);

  const actions = element('div', 'action-row');
  for (const action of allowedExecutionActions(execution.status)) {
    const button = text('button', titleCase(action), action === 'cancel' ? 'button danger' : 'button secondary');
    button.type = 'button';
    button.addEventListener('click', () => handlers.onExecutionAction?.(execution.id, action));
    actions.append(button);
  }
  if (actions.childElementCount) wrapper.append(actions);

  const tasks = Array.isArray(view.tasks) ? view.tasks : [];
  const taskTable = element('div', 'table-wrap');
  const table = element('table');
  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['Task', 'Status', 'Agent', 'Dependencies']) headRow.append(text('th', label));
  head.append(headRow);
  table.append(head);
  const body = element('tbody');
  for (const task of tasks) {
    const row = element('tr');
    row.append(
      cell(task?.title ?? task?.id ?? '—'),
      cellWith(statusPill(task?.status ?? 'unknown')),
      cell(task?.assignedAgent ?? task?.agentId ?? '—'),
      cell(Array.isArray(task?.dependsOn) ? task.dependsOn.join(', ') || '—' : '—'),
    );
    body.append(row);
  }
  table.append(body);
  taskTable.append(table);
  wrapper.append(text('h3', 'Task graph'), taskTable);

  const executionEvents = Array.isArray(view.events) ? view.events.slice(-30).reverse() : [];
  wrapper.append(text('h3', 'Execution events'), renderEventList(executionEvents));
  return wrapper;
}

function renderAgents(container, state) {
  if (!state.agents.length) {
    renderEmpty(container, 'No agents registered', 'The runtime has not exposed any agent profiles.');
    return;
  }
  const grid = element('div', 'agent-grid');
  for (const agent of state.agents) {
    const card = element('article', 'panel agent-card');
    card.append(text('p', agent?.role ?? agent?.category ?? 'Agent', 'eyebrow'));
    card.append(text('h3', agent?.name ?? agent?.id ?? 'Unnamed agent'));
    if (agent?.description) card.append(text('p', agent.description, 'muted'));
    const capabilities = Array.isArray(agent?.capabilities) ? agent.capabilities : [];
    if (capabilities.length) {
      const chips = element('div', 'chips');
      for (const capability of capabilities.slice(0, 8)) chips.append(text('span', capability, 'chip'));
      card.append(chips);
    }
    grid.append(card);
  }
  container.append(grid);
}

function renderApprovals(container, state, handlers) {
  if (!state.approvals.length) {
    renderEmpty(container, 'No pending approvals', 'Helix has no governed actions waiting for a decision.');
    return;
  }
  const list = element('div', 'approval-list');
  for (const approval of state.approvals) {
    const card = element('article', 'panel approval-card');
    const heading = element('div', 'detail-heading');
    const copy = element('div');
    copy.append(text('p', 'Approval request', 'eyebrow'), text('h3', approval?.reason ?? approval?.action ?? approval?.id ?? 'Pending action'));
    heading.append(copy, statusPill(approval?.status ?? 'pending'));
    card.append(heading);
    const meta = element('div', 'detail-meta');
    meta.append(
      labeledValue('ID', approval?.id ?? '—', true),
      labeledValue('Requested by', approval?.requestedBy ?? '—'),
      labeledValue('Execution', approval?.executionId ?? '—', true),
      labeledValue('Created', formatTime(approval?.createdAt)),
    );
    card.append(meta);
    const actions = element('div', 'action-row');
    const approve = text('button', 'Approve', 'button');
    const deny = text('button', 'Deny', 'button danger');
    approve.type = deny.type = 'button';
    approve.addEventListener('click', () => handlers.onApprovalAction?.(approval.id, 'approve'));
    deny.addEventListener('click', () => handlers.onApprovalAction?.(approval.id, 'deny'));
    actions.append(approve, deny);
    card.append(actions);
    list.append(card);
  }
  container.append(list);
}

function renderTelemetry(container, state) {
  if (!state.telemetry || typeof state.telemetry !== 'object') {
    renderEmpty(container, 'Telemetry unavailable', 'No runtime telemetry snapshot has been loaded.');
    return;
  }
  const grid = element('div', 'two-column');
  for (const [key, value] of Object.entries(state.telemetry)) {
    const section = element('section', 'panel');
    section.append(text('h3', titleCase(key)));
    if (Array.isArray(value)) section.append(renderKeyValueList(value));
    else if (value && typeof value === 'object') section.append(renderObject(value));
    else section.append(text('p', value ?? '—', 'metric-value'));
    grid.append(section);
  }
  container.append(grid);
}

function renderEvents(container, state) {
  const header = element('div', 'section-header');
  const copy = element('div');
  copy.append(text('h2', 'Durable events'), text('p', `Latest ${state.recentEvents.length} retained in the console. Cursor ${state.lastSequence}.`, 'muted'));
  header.append(copy);
  container.append(header, panel('Event stream', renderEventList(state.recentEvents.slice().reverse())));
}

function renderExecutionTable(executions, handlers) {
  const wrap = element('div', 'table-wrap');
  const table = element('table');
  const head = element('thead');
  const row = element('tr');
  for (const label of ['Execution', 'Goal', 'Status', 'Updated']) row.append(text('th', label));
  head.append(row);
  table.append(head);
  const body = element('tbody');
  for (const execution of executions) {
    const tableRow = element('tr', 'clickable-row');
    tableRow.tabIndex = 0;
    tableRow.addEventListener('click', () => handlers.onExecutionSelect?.(execution.id));
    tableRow.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        handlers.onExecutionSelect?.(execution.id);
      }
    });
    tableRow.append(
      cell(execution?.id ?? '—', true),
      cell(execution?.goal ?? '—'),
      cellWith(statusPill(execution?.status ?? 'unknown')),
      cell(formatTime(execution?.updatedAt)),
    );
    body.append(tableRow);
  }
  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderEventList(events) {
  const list = element('div', 'event-list');
  if (!events.length) {
    list.append(text('p', 'No events loaded.', 'muted'));
    return list;
  }
  for (const event of events) {
    const item = element('article', 'event-item');
    const top = element('div', 'event-top');
    top.append(text('code', `#${event?.sequence ?? '?'}`), text('strong', event?.type ?? 'unknown'));
    if (event?.timestamp || event?.createdAt) top.append(text('time', formatTime(event.timestamp ?? event.createdAt), 'muted'));
    item.append(top);
    const details = [];
    if (event?.executionId) details.push(`execution ${event.executionId}`);
    if (event?.taskId) details.push(`task ${event.taskId}`);
    if (event?.agentId) details.push(`agent ${event.agentId}`);
    if (details.length) item.append(text('p', details.join(' · '), 'muted mono'));
    list.append(item);
  }
  return list;
}

function renderKeyValueList(items) {
  const list = element('div', 'metric-list');
  for (const item of items.slice(0, 100)) {
    if (item && typeof item === 'object') list.append(renderObject(item));
    else list.append(text('div', item ?? '—', 'metric-row'));
  }
  return list;
}

function renderObject(value) {
  const list = element('dl', 'object-list');
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    list.append(text('dt', titleCase(key)));
    list.append(text('dd', displayValue(item)));
  }
  return list;
}

function renderEmpty(container, title, message) {
  const empty = element('div', 'panel empty-state');
  empty.append(text('h2', title), text('p', message, 'muted'));
  container.append(empty);
}

function statCard(label, value) {
  const card = element('article', 'stat-card');
  card.append(text('span', label, 'muted'), text('strong', value, 'stat-value'));
  return card;
}

function panel(title, content) {
  const section = element('section', 'panel');
  section.append(text('h3', title), content);
  return section;
}

function labeledValue(label, value, mono = false) {
  const item = element('div', 'meta-item');
  item.append(text('span', label, 'muted'), text('strong', value, mono ? 'mono' : ''));
  return item;
}

function statusPill(status) {
  const normalized = String(status ?? 'unknown').toLowerCase();
  return text('span', normalized, `status status-${normalized.replace(/[^a-z0-9-]/g, '-')}`);
}

function allowedExecutionActions(status) {
  if (status === 'running') return ['pause', 'cancel', 'checkpoint'];
  if (status === 'paused') return ['resume', 'cancel', 'checkpoint'];
  if (status === 'failed') return ['retry', 'checkpoint'];
  return ['checkpoint'];
}

function element(tag, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function text(tag, value, className = '') {
  const node = element(tag, className);
  node.textContent = value == null ? '' : String(value);
  return node;
}

function cell(value, mono = false) {
  const td = element('td', mono ? 'mono' : '');
  td.textContent = value == null ? '' : String(value);
  return td;
}

function cellWith(node) {
  const td = element('td');
  td.append(node);
  return td;
}

function displayValue(value) {
  if (value == null) return '—';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  try { return JSON.stringify(value); } catch { return '[unserializable]'; }
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function titleCase(value) {
  return String(value ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
