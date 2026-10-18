import { describe, expect, it } from 'bun:test';

import { createApiHandler, type ApiHandler } from '../../src/factory/api/server';
import { createEmptyEvidenceReadPort } from '../../src/factory/observatory/observatory';
import { openEventLog } from '../../src/factory/events/log';
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
function uiHandler(options: { auth?: { token: string; actor: string } } = {}): ApiHandler {
  const store = openStateStore(':memory:');
  const events = openEventLog(store.db);
  return createApiHandler({
    store,
    events,
    evidence: createEmptyEvidenceReadPort(),
    ...(options.auth ? { auth: options.auth } : {}),
  });
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
