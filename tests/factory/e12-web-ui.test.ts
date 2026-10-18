import { describe, expect, it } from 'bun:test';

import { createApiHandler, type ApiHandler } from '../../src/factory/api/server';
import { createEmptyEvidenceReadPort } from '../../src/factory/observatory/observatory';
import { openEventLog } from '../../src/factory/events/log';
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

/** Build a pure API handler over an in-memory store, optionally with auth. */
function uiHandler(
  options: { auth?: { token: string; actor: string }; scheduler?: Scheduler } = {},
): ApiHandler {
  const store = openStateStore(':memory:');
  const events = openEventLog(store.db);
  return createApiHandler({
    store,
    events,
    evidence: createEmptyEvidenceReadPort(),
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.scheduler ? { scheduler: options.scheduler } : {}),
  });
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
