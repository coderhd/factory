import { describe, expect, it } from 'bun:test';

import {
  createApiHandler,
  startFactoryServer,
  type ApiHandler,
} from '../../src/factory/api/server';
import { createEmptyEvidenceReadPort } from '../../src/factory/observatory/observatory';
import { openEventLog } from '../../src/factory/events/log';
import {
  createAttempt,
  createTask,
  createWorkOrder,
} from '../../src/factory/domain/workOrder';
import type { Scheduler, SchedulerStatus } from '../../src/factory/scheduler/scheduler';
import { openStateStore } from '../../src/factory/state/store';

// ---------------------------------------------------------------------------
// E12.2 (#49) basic web UI — Task 1: static asset serving (the server seam).
// The SPA shell is served by the same pure request handler that serves the API,
// on `GET /` and `GET /ui/*`, *before* the E10.4 auth block so the read-public
// GET boundary holds (the documented decision: GET stays public, mutations
// require the bearer credential). These tests drive the pure handler in-process
// and assert what the browser actually receives — no filesystem reads, no
// network. Hash routing / DOM execution is deliberately out of scope (the plan
// calls this limit out); later tasks extend this same file with structural
// assertions over the served bytes.
// ---------------------------------------------------------------------------

/**
 * Build a pure API handler over an in-memory store, optionally with auth, and
 * hand back the same store/events the handler reads. Task 3's drill-down tests
 * seed a Work Order *through the store* — the same seam the server reads — so
 * they assert over real served bytes, not a stubbed handler.
 */
function uiHarness(
  options: { auth?: { token: string; actor: string }; scheduler?: Scheduler } = {},
): { handler: ApiHandler; store: ReturnType<typeof openStateStore>; events: ReturnType<typeof openEventLog> } {
  const store = openStateStore(':memory:');
  const events = openEventLog(store.db);
  const handler = createApiHandler({
    store,
    events,
    evidence: createEmptyEvidenceReadPort(),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
  return { handler, store, events };
}

/** Build a pure API handler over an in-memory store, optionally with auth. */
function uiHandler(
  options: { auth?: { token: string; actor: string }; scheduler?: Scheduler } = {},
): ApiHandler {
  return uiHarness(options).handler;
}

/**
 * A minimal *composed* scheduler double. The scheduler route only reads
 * `status()`, so that is the only method whose return value matters here; the
 * rest are inert stubs that keep the `Scheduler` seam satisfied honestly.
 */
function schedulerStub(): Scheduler {
  const status: SchedulerStatus = {
    running: false,
    tickIntervalMs: 1_000,
    concurrency: { current: 0, max: 2 },
    workers: { idle: 0, busy: 0, reclaimed: 0 },
    provisioning: { enabled: false, min: 0, max: 0 },
    queue: {
      readyTaskIds: [],
      blocked: [],
      blockedPolicy: [],
      blockedRouting: [],
      parkedRecovery: [],
    },
    activeDAGs: [],
  };
  return {
    tick() {},
    start() {},
    stop() {},
    status: () => status,
    async deliverAnswer() {},
  };
}

const UI_TOKEN = 'e12-ui-token-0123456789abcdef';

describe('E12.2 Task 1 — static asset serving', () => {
  it('serves the SPA shell at / with no credential', async () => {
    const handler = uiHandler({ auth: { token: UI_TOKEN, actor: 'operator-ada' } });
    const res = await handler(new Request('http://factory.test/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await res.text();
    expect(html).toContain('id="app"');
    expect(html).toContain('/ui/app.js');
    expect(html).toContain('/ui/styles.css');
  });

  it('serves /index.html the same as /', async () => {
    const handler = uiHandler();
    const a = await (await handler(new Request('http://factory.test/'))).text();
    const b = await (await handler(new Request('http://factory.test/index.html'))).text();
    expect(b).toBe(a);
  });

  it('serves app.js and styles.css with the right content types', async () => {
    const handler = uiHandler();
    const js = await handler(new Request('http://factory.test/ui/app.js'));
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const css = await handler(new Request('http://factory.test/ui/styles.css'));
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toBe('text/css; charset=utf-8');
  });

  it('404s an unknown non-API path and leaves the API untouched', async () => {
    const handler = uiHandler();
    expect((await handler(new Request('http://factory.test/ui/nope.js'))).status).toBe(404);
    const health = await handler(new Request('http://factory.test/api/health'));
    expect(health.status).toBe(200);
    // `Response.json()` types as `unknown` under the pinned `@types/bun`; the
    // repo's convention is `toMatchObject` for this shape (e10-integration.test.ts:2164).
    expect(await health.json()).toMatchObject({ status: 'ok' });
  });

  it('does not answer non-GET on a UI path', async () => {
    const handler = uiHandler({ auth: { token: UI_TOKEN, actor: 'operator-ada' } });
    expect((await handler(new Request('http://factory.test/', { method: 'POST' }))).status).toBe(401);
  });

  it('UI assets never contain the configured token', async () => {
    const handler = uiHandler({ auth: { token: UI_TOKEN, actor: 'operator-ada' } });
    const html = await (await handler(new Request('http://factory.test/'))).text();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    expect(html).not.toContain(UI_TOKEN);
    expect(js).not.toContain(UI_TOKEN);
  });
});

// ---------------------------------------------------------------------------
// E12.2 (#49) basic web UI — Task 2: dashboard (read-first overview).
// The brief notes that the SPA's DOM is not executed headlessly, so the
// dashboard's contract is pinned structurally over the served bytes plus
// behaviorally over the six public GET surfaces it reads. Those assertions run
// through the pure handler — they prove what the browser receives, not what a
// file on disk says.
//
// The scheduler read surface is special: `GET /api/scheduler` is the *only* one
// of the six that 404s when its dependency is not composed (server.ts:453–456).
// The "every read surface answers" test therefore drives a composed scheduler
// double so all six answer 200 with their documented shapes, and a companion
// test pins the documented 404 ("scheduler not configured") that the dashboard's
// scheduler panel degrades on in a default deployment.
// ---------------------------------------------------------------------------

describe('E12.2 Task 2 — dashboard (read-first overview)', () => {
  it('the shell contains the dashboard containers', async () => {
    const handler = uiHandler();
    const html = await (await handler(new Request('http://factory.test/'))).text();
    for (const id of [
      'app',
      'dashboard',
      'work-orders',
      'observatory',
      'approvals',
      'interactions',
      'scheduler',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('app.js fetches every read surface the dashboard shows', async () => {
    const handler = uiHandler();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    for (const path of [
      '/api/work-orders',
      '/api/observatory',
      '/api/approvals',
      '/api/interactions',
      '/api/scheduler',
      '/api/factory/controls',
    ]) {
      expect(js).toContain(path);
    }
    expect(js).toContain('renderDashboard');
  });

  it('every read surface the dashboard fetches answers with its documented shape', async () => {
    const handler = uiHandler({ scheduler: schedulerStub() });
    const get = (path: string) => handler(new Request(`http://factory.test${path}`));

    const workOrders = await get('/api/work-orders');
    expect(workOrders.status).toBe(200);
    expect(await workOrders.json()).toMatchObject({ workOrders: [] });

    const observatory = await get('/api/observatory');
    expect(observatory.status).toBe(200);
    expect(await observatory.json()).toMatchObject({
      verifiedPerDay: [],
      throughputPerHumanHour: { verifiedChanges: 0, humanHours: 0, verifiedChangesPerHumanHour: 0 },
      rework: 0,
      cost: { total: 0, currency: 'USD' },
    });

    const approvals = await get('/api/approvals');
    expect(approvals.status).toBe(200);
    expect(await approvals.json()).toMatchObject({ approvals: [] });

    const interactions = await get('/api/interactions');
    expect(interactions.status).toBe(200);
    expect(await interactions.json()).toMatchObject({ interactions: [] });

    const scheduler = await get('/api/scheduler');
    expect(scheduler.status).toBe(200);
    expect(await scheduler.json()).toMatchObject({
      scheduler: { running: false, queue: { readyTaskIds: [], parkedRecovery: [] } },
    });

    const controls = await get('/api/factory/controls');
    expect(controls.status).toBe(200);
    expect(await controls.json()).toMatchObject({ paused: false, emergencyStopped: false });
  });

  it('the scheduler panel has a real degradation path: an uncomposed scheduler 404s', async () => {
    const handler = uiHandler();
    const res = await handler(new Request('http://factory.test/api/scheduler'));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'NOT_FOUND', message: 'scheduler not configured' },
    });
  });

  it('renders a zero/empty state rather than fabricating on an empty Factory', async () => {
    const handler = uiHandler();

    // The Observatory over an empty store is zeros/[] — never invented data.
    const observatory = await handler(new Request('http://factory.test/api/observatory'));
    expect(observatory.status).toBe(200);
    expect(await observatory.json()).toMatchObject({
      verifiedPerDay: [],
      throughputPerHumanHour: { verifiedChanges: 0, humanHours: 0, verifiedChangesPerHumanHour: 0 },
      rework: 0,
      cost: { total: 0, currency: 'USD' },
    });

    // Every list endpoint returns an empty array on a fresh store.
    const emptyLists: Array<{ path: string; key: string }> = [
      { path: '/api/work-orders', key: 'workOrders' },
      { path: '/api/approvals', key: 'approvals' },
      { path: '/api/interactions', key: 'interactions' },
    ];
    for (const { path, key } of emptyLists) {
      const res = await handler(new Request(`http://factory.test${path}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ [key]: [] });
    }
  });
});

// ---------------------------------------------------------------------------
// E12.2 (#49) basic web UI — Task 3: Work Order detail + drill-down (spec §23).
// The detail view is read-first: it renders one Work Order's snapshot plus the
// `WO → Task → Attempt → trace → verification → evidence → human decision`
// drill-down chain. As in Task 2 the SPA's DOM is not executed headlessly, so
// the view's contract is pinned structurally over the served bytes plus
// behaviorally over the two routes it reads. The third test pins the "a failing
// panel does not blank the page" behavior at the handler-contract level: a
// missing Work Order 404s (`WORK_ORDER_NOT_FOUND`) for *both* the snapshot and
// the drill-down, while the shell and the other surfaces keep answering — which
// is what lets the UI render one inline error and leave the rest usable.
// ---------------------------------------------------------------------------

describe('E12.2 Task 3 — Work Order detail + drill-down', () => {
  it('app.js links the drill-down chain and routes to a work order', async () => {
    const handler = uiHandler();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    expect(js).toContain('/api/work-orders/');
    expect(js).toContain('/drill-down');
    expect(js).toContain('renderWorkOrderDetail');
    expect(js).toContain('#/wo/');
  });

  it('the shell contains the detail containers', async () => {
    const handler = uiHandler();
    const html = await (await handler(new Request('http://factory.test/'))).text();
    for (const id of ['detail', 'detail-chain']) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('the drill-down route returns the chain for a seeded work order', async () => {
    const { handler, store, events } = uiHarness();
    const workOrder = createWorkOrder({ store, events }, { intent: 'drill-down subject' });
    const task = createTask({ store, events }, { workOrderId: workOrder.id, title: 'T' });
    const attempt = createAttempt(
      { store, events },
      { taskId: task.id, model: 'generalist', workerId: null },
    );
    store.set('interactions', 'interaction_1', {
      id: 'interaction_1',
      taskId: task.id,
      status: 'PENDING',
    });

    const res = await handler(
      new Request(`http://factory.test/api/observatory/work-orders/${workOrder.id}/drill-down`),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workOrderId: string;
      chain: Array<{ stage: string; refs: string[]; status: string }>;
    };
    expect(body.workOrderId).toBe(workOrder.id);
    // Spec §23 order: WO → Task → Attempt → trace → verification → evidence → decision.
    expect(body.chain.map((step) => step.stage)).toEqual([
      'work_order',
      'task',
      'attempt',
      'trace',
      'verification',
      'evidence',
      'human_decision',
    ]);
    const byStage = new Map(body.chain.map((step) => [step.stage, step]));
    expect(byStage.get('work_order')?.refs).toEqual([workOrder.id]);
    expect(byStage.get('task')?.refs).toEqual([task.id]);
    expect(byStage.get('attempt')?.refs).toEqual([attempt.id]);
    expect(byStage.get('human_decision')?.refs).toEqual(['interaction_1']);
    // Nothing was recorded for trace/verification/evidence, so those stages are
    // honest stubs with no refs — never fabricated.
    expect(byStage.get('trace')?.status).toBe('stub');
    expect(byStage.get('trace')?.refs).toEqual([]);
    expect(byStage.get('evidence')?.status).toBe('stub');
    expect(byStage.get('evidence')?.refs).toEqual([]);
  });

  it('a failing panel does not blank the page', async () => {
    const { handler } = uiHarness();

    // A missing Work Order 404s on *both* routes the detail view reads, with the
    // documented code — the UI's cue to render an inline error in that area.
    const snapshot = await handler(
      new Request('http://factory.test/api/work-orders/wo_missing'),
    );
    expect(snapshot.status).toBe(404);
    expect(await snapshot.json()).toMatchObject({ error: { code: 'WORK_ORDER_NOT_FOUND' } });

    const drillDown = await handler(
      new Request('http://factory.test/api/observatory/work-orders/wo_missing/drill-down'),
    );
    expect(drillDown.status).toBe(404);
    expect(await drillDown.json()).toMatchObject({ error: { code: 'WORK_ORDER_NOT_FOUND' } });

    // The rest of the page is unaffected: the dashboard surface still answers and
    // the shell still serves — the failure is local to the detail area.
    const list = await handler(new Request('http://factory.test/api/work-orders'));
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({ workOrders: [] });
    expect((await handler(new Request('http://factory.test/'))).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// E12.2 (#49) basic web UI — Task 4: chat panel + authenticated mutations.
// The chat panel is the UI's only write surface, and every affordance that
// mutates goes through one helper (`apiSend`) that attaches the operator's
// bearer token — read from localStorage at runtime — *only* on non-GET and only
// when a non-empty token is set (the E10.4 boundary). The token is never baked
// into a served asset, echoed back into the DOM, or logged. As in Tasks 2–3 the
// SPA's DOM is not executed headlessly, so the panel's contract is pinned
// structurally over the served bytes plus behaviorally over the two acceptance
// paths the plan's Review Focus names: an unauthenticated mutation is rejected
// (401) while an authenticated one is not, and an uncomposed orchestrator 503s
// while the dashboard keeps serving.
// ---------------------------------------------------------------------------

describe('E12.2 Task 4 — chat panel + authenticated mutations', () => {
  it('the chat panel and token control are present', async () => {
    const handler = uiHandler();
    const html = await (await handler(new Request('http://factory.test/'))).text();
    for (const id of [
      'chat',
      'chat-log',
      'chat-input',
      'chat-send',
      'chat-pending',
      'token',
      'save-token',
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  it('app.js posts to the orchestrator and completes the confirmation round-trip', async () => {
    const handler = uiHandler();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    expect(js).toContain('/api/orchestrator/message');
    expect(js).toContain('awaiting_confirmation');
    expect(js).toContain('confirm');
  });

  it('app.js attaches the bearer token only on non-GET and reads it from localStorage', async () => {
    const handler = uiHandler();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    expect(js).toContain('localStorage');
    expect(js).toContain('Authorization');
    expect(js).toContain('Bearer');
    expect(js).not.toContain(UI_TOKEN); // no configured token baked into the asset
  });

  it('app.js routes every mutation affordance through apiSend', async () => {
    const handler = uiHandler();
    const js = await (await handler(new Request('http://factory.test/ui/app.js'))).text();
    expect(js).toContain('apiSend');
    for (const path of [
      '/api/orchestrator/message',
      '/api/interactions/',
      '/api/approvals/',
      '/api/work-orders/',
      '/api/factory/pause',
      '/api/factory/resume',
      '/api/factory/emergency-stop',
    ]) {
      expect(js).toContain(path);
    }
  });

  it('rejects an unauthenticated mutation and accepts an authenticated one', async () => {
    const handler = uiHandler({ auth: { token: UI_TOKEN, actor: 'operator-ada' } });
    // no token → 401 (proves the UI's required wire contract is authenticated)
    const anon = await handler(
      new Request('http://factory.test/api/factory/pause', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    expect(anon.status).toBe(401);
    // with the token → not 401
    const authed = await handler(
      new Request('http://factory.test/api/factory/pause', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${UI_TOKEN}`,
        },
        body: JSON.stringify({ actor: 'x' }),
      }),
    );
    expect(authed.status).not.toBe(401);
  });

  it('the chat panel degrades when no orchestrator is composed', async () => {
    const handler = uiHandler(); // no orchestrator
    const res = await handler(
      new Request('http://factory.test/api/orchestrator/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'hi' }),
      }),
    );
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'ORCHESTRATOR_DISABLED' } });
    expect((await (await handler(new Request('http://factory.test/'))).text())).toContain(
      'id="chat"',
    );
  });
});

// ---------------------------------------------------------------------------
// E12.2 (#49) basic web UI — Task 5: `factory start` end-to-end listener smoke.
// Tasks 1–4 drive the *pure handler* in-process. This closes the last gap the
// acceptance criterion names — "the UI is served by `factory start`" — by
// starting the real listener (`startFactoryServer`, the exact call `cmdServe`
// makes at `factory.ts:910`) on an ephemeral loopback port and fetching it over
// a genuine socket. The store is a fresh in-memory one, so the read surfaces the
// UI consumes must answer empty and non-fabricated. `server.stop()` runs in a
// `finally` so the listener is torn down on the failing path too. No production
// code changes were needed: the boot path already serves the UI through
// `startFactoryServer(createApiHandler(deps))` (`server.ts:768`).
// ---------------------------------------------------------------------------

describe('E12.2 Task 5 — end-to-end listener smoke', () => {
  it('a real listener serves the UI and the live read surfaces', async () => {
    const store = openStateStore(':memory:');
    const events = openEventLog(store.db);
    const server = startFactoryServer(
      { store, events, evidence: createEmptyEvidenceReadPort() },
      { port: 0 },
    );
    try {
      // The SPA shell, over the wire, exactly as a browser would receive it.
      expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const html = await (await fetch(`${server.url}/`)).text();
      expect(html).toContain('id="app"');

      // The served module is the real asset, with its declared content type.
      const js = await fetch(`${server.url}/ui/app.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');

      // A live read surface on the same socket: empty and non-fabricated.
      // The route's documented shape is `{ workOrders: [...] }` (server.ts:554),
      // so full equality pins both the empty array and the absence of extras.
      const wos = await fetch(`${server.url}/api/work-orders`);
      expect(wos.status).toBe(200);
      expect(await wos.json()).toEqual({ workOrders: [] });
    } finally {
      server.stop();
    }
  });
});
