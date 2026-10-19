// E12.2 (#49) the Factory web UI: a plain ES module (no framework, no bundler,
// no build step). Task 2 renders the read-first dashboard over the public GET
// routes; Task 3 renders one Work Order's snapshot plus the spec §23 drill-down
// chain (`#/wo/<id>`). Every panel/section fetches and renders independently, so
// one failing (or malformed) response shows an inline error in that area and
// never blanks the page or throws unhandled. An empty Factory renders zeros and
// "no …" text — nothing is fabricated. The UI does not mutate; Task 4 adds
// apiSend.

// The dashboard's read surfaces, in render order. Each entry names its locked
// DOM id and the loader that writes into that panel's body. The loader owns its
// own fetch, so a failure stays local to the panel.
const PANELS = [
  { id: 'work-orders', load: loadWorkOrders },
  { id: 'observatory', load: loadObservatory },
  { id: 'approvals', load: loadApprovals },
  { id: 'interactions', load: loadInteractions },
  { id: 'scheduler', load: loadScheduler },
  { id: 'controls', load: loadControls },
];

// The bearer token is supplied by the operator at runtime (Task 4) and read
// from localStorage when a mutating request is sent. It is never embedded in a
// served asset, never rendered back into the DOM, and never logged.
const TOKEN_STORAGE_KEY = 'factory.token';

// How often the dashboard re-renders on its own, so live Factory state stays
// visible without a manual reload.
const REFRESH_INTERVAL_MS = 10000;

/**
 * GET `path` and parse its JSON body. A non-2xx response throws an Error that
 * carries `status` and, when the server sent its documented error envelope, the
 * `code`/`message` too — so a caller can tell "scheduler not configured"
 * (404 NOT_FOUND) from a real failure and render the right state.
 */
async function apiGet(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const error = new Error(`GET ${path} failed with HTTP ${response.status}`);
    error.status = response.status;
    try {
      const body = await response.json();
      if (body && typeof body === 'object' && body.error) {
        error.code = body.error.code;
        if (typeof body.error.message === 'string') error.message = body.error.message;
      }
    } catch {
      // A non-JSON error body (or none) is fine: the status is the signal.
    }
    throw error;
  }
  return await response.json();
}

// --- tiny DOM helpers -------------------------------------------------------

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** The body element of the panel with `id`, or null when it is not present. */
function panelBody(id) {
  const panel = document.getElementById(id);
  return panel ? panel.querySelector('[data-panel-body]') : null;
}

/** Clear a panel before (re)rendering so stale state and errors do not linger. */
function reset(body) {
  body.replaceChildren();
}

/** A neutral "nothing here yet" note — the non-fabricating empty state. */
function renderEmpty(body, message) {
  reset(body);
  body.append(element('p', 'empty', message));
}

/** A per-panel inline error: this panel failed; the rest of the page is open. */
function renderError(body, error) {
  reset(body);
  const message = error instanceof Error ? error.message : String(error);
  body.append(element('p', 'panel-error', `Could not load: ${message}`));
}

/** A simple table. Cell values are set as text, never injected as HTML. */
function table(headers, rows) {
  const node = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of headers) headRow.append(element('th', null, header));
  head.append(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const value of row) {
      const td = document.createElement('td');
      td.textContent = value === null || value === undefined ? '—' : String(value);
      tr.append(td);
    }
    tbody.append(tr);
  }

  node.append(head, tbody);
  return node;
}

// --- value helpers ----------------------------------------------------------

function numberOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sum(values) {
  return values.reduce((total, value) => total + numberOrZero(value), 0);
}

function formatCost(cost) {
  const total = numberOrZero(cost.total);
  const currency = typeof cost.currency === 'string' && cost.currency ? cost.currency : 'USD';
  return `${total} ${currency}`;
}

/** Append a <dt>/<dd> metric pair to a definition list. */
function addMetric(list, label, value) {
  list.append(element('dt', null, label), element('dd', null, value));
}

// --- panel loaders ----------------------------------------------------------

async function loadWorkOrders(body) {
  const data = await apiGet('/api/work-orders');
  const workOrders = Array.isArray(data.workOrders) ? data.workOrders : [];
  if (workOrders.length === 0) {
    renderEmpty(body, 'No work orders yet.');
    return;
  }
  reset(body);
  body.append(workOrdersTable(workOrders));
}

/**
 * The Work Orders table. Each id is a link to that order's detail route
 * (`#/wo/<id>`), so a row drills down into the snapshot + chain. Ids and text
 * are set as text (never injected as HTML).
 */
function workOrdersTable(workOrders) {
  const node = document.createElement('table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const header of ['Id', 'Intent', 'State']) headRow.append(element('th', null, header));
  head.append(headRow);

  const tbody = document.createElement('tbody');
  for (const workOrder of workOrders) {
    const tr = document.createElement('tr');
    const idCell = document.createElement('td');
    const link = element('a', null, workOrder.id);
    link.href = `#/wo/${encodeURIComponent(workOrder.id)}`;
    idCell.append(link);
    tr.append(idCell, element('td', null, workOrder.intent), element('td', null, workOrder.state));
    tbody.append(tr);
  }

  node.append(head, tbody);
  return node;
}

async function loadObservatory(body) {
  const metrics = await apiGet('/api/observatory');
  const perDay = Array.isArray(metrics.verifiedPerDay) ? metrics.verifiedPerDay : [];
  const throughput = metrics.throughputPerHumanHour ?? {};
  const cost = metrics.cost ?? {};

  reset(body);
  const cards = document.createElement('dl');
  cards.className = 'metrics';
  addMetric(cards, 'Verified changes / day', sum(perDay.map((day) => day.verifiedChanges)));
  addMetric(
    cards,
    'Verified changes / human hour',
    numberOrZero(throughput.verifiedChangesPerHumanHour),
  );
  addMetric(cards, 'Human hours recorded', numberOrZero(throughput.humanHours));
  addMetric(cards, 'Rework attempts', numberOrZero(metrics.rework));
  addMetric(cards, 'Recorded cost', formatCost(cost));
  body.append(cards);

  if (perDay.length === 0) {
    body.append(element('p', 'empty', 'No verified changes yet.'));
    return;
  }
  body.append(
    table(
      ['Day', 'Verified', 'Lines changed'],
      perDay.map((day) => [
        day.day,
        numberOrZero(day.verifiedChanges),
        numberOrZero(day.linesChanged),
      ]),
    ),
  );
}

async function loadApprovals(body) {
  const data = await apiGet('/api/approvals');
  const approvals = Array.isArray(data.approvals) ? data.approvals : [];
  if (approvals.length === 0) {
    renderEmpty(body, 'No approvals yet.');
    return;
  }
  reset(body);
  body.append(
    table(
      ['Id', 'Capability', 'Status'],
      approvals.map((approval) => [
        approval.id,
        approval.binding && approval.binding.capability ? approval.binding.capability : '—',
        approval.status,
      ]),
    ),
  );
}

async function loadInteractions(body) {
  const data = await apiGet('/api/interactions');
  const interactions = Array.isArray(data.interactions) ? data.interactions : [];
  if (interactions.length === 0) {
    renderEmpty(body, 'No open questions yet.');
    return;
  }
  reset(body);
  body.append(
    table(
      ['Id', 'Question', 'Status'],
      interactions.map((interaction) => [
        interaction.id,
        interaction.question,
        interaction.status,
      ]),
    ),
  );
}

async function loadScheduler(body) {
  let data;
  try {
    data = await apiGet('/api/scheduler');
  } catch (error) {
    // The documented "no scheduler composed" case is a 404, not a failure:
    // render it as a plain note so the panel does not look broken.
    if (error && error.status === 404) {
      renderEmpty(body, 'Scheduler not configured.');
      return;
    }
    throw error;
  }

  const scheduler = data.scheduler ?? {};
  const queue = scheduler.queue ?? {};
  const concurrency = scheduler.concurrency ?? {};
  const parked = Array.isArray(queue.parkedRecovery) ? queue.parkedRecovery : [];
  const blocked = Array.isArray(queue.blocked) ? queue.blocked : [];
  const ready = Array.isArray(queue.readyTaskIds) ? queue.readyTaskIds : [];

  reset(body);
  const cards = document.createElement('dl');
  cards.className = 'metrics';
  addMetric(cards, 'Running', scheduler.running ? 'yes' : 'no');
  addMetric(cards, 'Concurrency', `${numberOrZero(concurrency.current)} / ${numberOrZero(concurrency.max)}`);
  addMetric(cards, 'Ready queue', ready.length);
  addMetric(cards, 'Blocked routes', blocked.length);
  addMetric(cards, 'Parked recoveries', parked.length);
  body.append(cards);

  if (parked.length > 0) {
    body.append(element('h3', null, 'Parked recoveries'));
    body.append(
      table(
        ['Task', 'Work order', 'Kind', 'Reason'],
        parked.map((entry) => [
          entry.taskId,
          entry.workOrderId,
          entry.kind,
          entry.reason,
        ]),
      ),
    );
  }
}

async function loadControls(body) {
  const controls = await apiGet('/api/factory/controls');
  reset(body);
  const flags = document.createElement('ul');
  flags.className = 'flags';
  flags.append(flag('Paused', controls.paused));
  flags.append(flag('Emergency stopped', controls.emergencyStopped));
  body.append(flags);
}

function flag(label, on) {
  const item = document.createElement('li');
  item.className = on ? 'flag on' : 'flag off';
  item.textContent = `${label}: ${on ? 'yes' : 'no'}`;
  return item;
}

// --- Work Order detail + the spec §23 drill-down ----------------------------

// The drill-down chain, in the order spec §23 fixes it. The server already
// returns it in this order; we re-key by stage so a reordering bug on the wire
// cannot reorder the rendered chain, and any stage we do not recognise is
// appended (never dropped) after the known ones.
const DETAIL_CHAIN_ORDER = [
  'work_order',
  'task',
  'attempt',
  'trace',
  'verification',
  'evidence',
  'human_decision',
];

const STAGE_LABELS = {
  work_order: 'Work order',
  task: 'Task',
  attempt: 'Attempt',
  trace: 'trace',
  verification: 'verification',
  evidence: 'evidence',
  human_decision: 'decision',
};

/** Toggle between the dashboard (`#/`) and one Work Order's detail view. */
function showDetail(on) {
  const dashboard = document.getElementById('dashboard');
  const detail = document.getElementById('detail');
  if (dashboard) dashboard.hidden = on;
  if (detail) detail.hidden = !on;
}

/**
 * Render one Work Order's detail view. The snapshot and the drill-down are two
 * independent areas: each is fetched, rendered, and failed *on its own*, so a
 * 404 (or a malformed body) in one shows an inline error there and leaves the
 * other — and the rest of the page — untouched.
 */
async function renderWorkOrderDetail(id) {
  showDetail(true);
  const idLabel = document.getElementById('detail-id');
  if (idLabel) idLabel.textContent = id;

  const body = document.getElementById('detail-body');
  const chain = document.getElementById('detail-chain');

  await Promise.all([
    (async () => {
      if (!body) return;
      body.setAttribute('aria-busy', 'true');
      try {
        const snapshot = await apiGet(`/api/work-orders/${encodeURIComponent(id)}`);
        renderSnapshot(body, snapshot);
      } catch (error) {
        renderError(body, error);
      } finally {
        body.removeAttribute('aria-busy');
      }
    })(),
    (async () => {
      if (!chain) return;
      chain.setAttribute('aria-busy', 'true');
      try {
        const drillDown = await apiGet(
          `/api/observatory/work-orders/${encodeURIComponent(id)}/drill-down`,
        );
        renderChain(chain, drillDown);
      } catch (error) {
        renderChainError(chain, error);
      } finally {
        chain.removeAttribute('aria-busy');
      }
    })(),
  ]);
}

/** The snapshot half: header facts, criteria, tasks, attempts, interactions, DAG. */
function renderSnapshot(body, snapshot) {
  const workOrder = snapshot && snapshot.workOrder;
  if (!workOrder) {
    renderError(body, new Error('the work-order snapshot is missing its workOrder'));
    return;
  }

  reset(body);

  const facts = document.createElement('dl');
  facts.className = 'metrics';
  addMetric(facts, 'Intent', workOrder.intent ?? 'none');
  addMetric(facts, 'State', workOrder.state ?? 'none');
  addMetric(facts, 'Risk tier', workOrder.riskTier ?? 'none');
  addMetric(facts, 'Repository', workOrder.repository ?? 'none');
  body.append(facts);

  const criteria = Array.isArray(workOrder.acceptanceCriteria) ? workOrder.acceptanceCriteria : [];
  body.append(element('h3', null, 'Acceptance criteria'));
  if (criteria.length === 0) {
    body.append(element('p', 'empty', 'No acceptance criteria.'));
  } else {
    const list = document.createElement('ul');
    for (const criterion of criteria) list.append(element('li', null, String(criterion)));
    body.append(list);
  }

  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  body.append(element('h3', null, 'Tasks'));
  if (tasks.length === 0) {
    body.append(element('p', 'empty', 'No tasks yet.'));
  } else {
    body.append(
      table(
        ['Id', 'Title', 'State'],
        tasks.map((task) => [task.id, task.title, task.state]),
      ),
    );
  }

  const attempts = Array.isArray(snapshot.attempts) ? snapshot.attempts : [];
  body.append(element('h3', null, 'Attempts'));
  if (attempts.length === 0) {
    body.append(element('p', 'empty', 'No attempts yet.'));
  } else {
    body.append(
      table(
        ['Id', 'Task', 'Outcome'],
        attempts.map((attempt) => [attempt.id, attempt.taskId, attempt.outcome ?? 'none']),
      ),
    );
  }

  const interactions = Array.isArray(snapshot.interactions) ? snapshot.interactions : [];
  body.append(element('h3', null, 'Interactions'));
  if (interactions.length === 0) {
    body.append(element('p', 'empty', 'No interactions yet.'));
  } else {
    body.append(
      table(
        ['Id', 'Question', 'Status'],
        interactions.map((interaction) => [
          interaction.id,
          interaction.question,
          interaction.status,
        ]),
      ),
    );
  }

  const dag = snapshot.dag ?? null;
  body.append(element('h3', null, 'DAG'));
  if (!dag) {
    body.append(element('p', 'empty', 'No DAG committed.'));
  } else {
    const nodes = Array.isArray(dag.nodes) ? dag.nodes : [];
    if (nodes.length === 0) {
      body.append(element('p', 'empty', 'The committed DAG has no nodes.'));
    } else {
      body.append(
        table(
          ['Node', 'Task', 'Depends on'],
          nodes.map((node) => {
            const dependsOn = Array.isArray(node.dependsOnTaskIds) ? node.dependsOnTaskIds : [];
            return [
              node.nodeId,
              node.taskId,
              dependsOn.length === 0 ? 'none' : dependsOn.join(', '),
            ];
          }),
        ),
      );
    }
  }
}

/** Render the drill-down chain in spec §23 order, non-fabricating per stage. */
function renderChain(chain, drillDown) {
  reset(chain);
  const stages = drillDown && Array.isArray(drillDown.chain) ? drillDown.chain : [];
  if (stages.length === 0) {
    chain.append(element('li', 'empty', 'No drill-down stages for this work order.'));
    return;
  }

  const byStage = new Map(stages.map((stage) => [stage.stage, stage]));
  const ordered = [];
  for (const name of DETAIL_CHAIN_ORDER) {
    if (byStage.has(name)) ordered.push(byStage.get(name));
  }
  for (const stage of stages) {
    if (!DETAIL_CHAIN_ORDER.includes(stage.stage)) ordered.push(stage);
  }

  for (const stage of ordered) chain.append(chainStage(stage));
}

/** One chain stage: its label, its status, and its refs (or an explicit "none"). */
function chainStage(stage) {
  const item = document.createElement('li');
  item.className = `chain-stage ${stage.status === 'stub' ? 'stub' : 'available'}`;
  const label = stage.stage in STAGE_LABELS ? STAGE_LABELS[stage.stage] : String(stage.stage);
  item.append(element('span', 'chain-stage-name', label));
  item.append(
    element(
      'span',
      'chain-status',
      stage.status === 'stub' ? 'stub (not resolved yet)' : 'available',
    ),
  );

  const refs = Array.isArray(stage.refs) ? stage.refs : [];
  if (refs.length === 0) {
    item.append(element('p', 'empty', 'no references'));
  } else {
    const list = document.createElement('ul');
    list.className = 'chain-refs';
    for (const ref of refs) list.append(element('li', null, String(ref)));
    item.append(list);
  }
  return item;
}

/** The chain area's own inline error: the snapshot half is unaffected. */
function renderChainError(chain, error) {
  reset(chain);
  const message = error instanceof Error ? error.message : String(error);
  chain.append(element('li', 'panel-error', `Could not load: ${message}`));
}

// --- dashboard, routing, mounting ------------------------------------------

/**
 * Fetch and render every panel. Each panel is independent: a failure is caught
 * and shown inline in that panel and never propagated, so `renderDashboard`
 * resolves even when every surface is down.
 */
async function renderDashboard() {
  await Promise.all(
    PANELS.map(async (panel) => {
      const body = panelBody(panel.id);
      if (!body) return;
      body.setAttribute('aria-busy', 'true');
      try {
        await panel.load(body);
      } catch (error) {
        renderError(body, error);
      } finally {
        body.removeAttribute('aria-busy');
      }
    }),
  );
}

/**
 * Hash routing. `#/` (or no hash) renders the dashboard; `#/wo/<id>` renders
 * one Work Order's detail + drill-down. Anything else falls back to the
 * dashboard so a stale/typo'd hash never leaves a blank page.
 */
function route() {
  const hash = window.location.hash || '#/';
  const detail = hash.match(/^#\/wo\/(.+)$/);
  if (detail) {
    void renderWorkOrderDetail(decodeURIComponent(detail[1]));
    return;
  }
  showDetail(false);
  void renderDashboard();
}

/**
 * Wire the shell: the Refresh button, the hash route, and a periodic re-render
 * of whichever view is active, so live Factory state stays visible without a
 * manual reload.
 */
function mount() {
  const refresh = document.getElementById('refresh');
  if (refresh) refresh.addEventListener('click', () => route());
  window.addEventListener('hashchange', route);
  route();
  window.setInterval(() => route(), REFRESH_INTERVAL_MS);
}

mount();
