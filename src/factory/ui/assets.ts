import { FactoryError } from '../domain/errors';

/**
 * E12.2 (#49) static asset serving for the web UI. The SPA is three plain files
 * under `src/factory/ui/` (no framework, no bundler, no build step). This
 * module is the only TypeScript in the subsystem: it maps a request path to an
 * asset, reads it once through `Bun.file`, and serves it as a `Response` — so
 * the existing pure request handler owns the transport boundary and the UI is
 * reachable without the API's bearer credential (reads stay public).
 */

/** One static asset as served: its response `content-type` and its bytes. */
export interface UiAsset {
  contentType: string;
  body: string;
}

/** The three assets the shell is composed of, in load order. */
export type UiAssetName = 'index.html' | 'app.js' | 'styles.css';

/** The registry: the single source of truth for what a UI path serves. */
const CONTENT_TYPES: Record<UiAssetName, string> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
};

/**
 * Bodies are immutable at runtime (they are static files, and the process is
 * restarted to ship a change), so read each one once. The cache is keyed by
 * asset name and holds the body only; the content type comes from the registry.
 */
const bodyCache = new Map<UiAssetName, string>();

/**
 * Map a request pathname to the asset it serves. `/` and `/index.html` are the
 * same document; the other two live under `/ui/`. Every other path — including
 * any `/api/*` path — is not a UI path and returns `undefined`, leaving the
 * existing API routing untouched.
 */
export function uiAssetName(pathname: string): UiAssetName | undefined {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  if (pathname === '/ui/app.js') return 'app.js';
  if (pathname === '/ui/styles.css') return 'styles.css';
  return undefined;
}

/**
 * Load one asset, relative to this module so it works regardless of the
 * process's working directory. A missing/unreadable file is a server fault
 * (the deployment is broken), not a client 404, so it surfaces as a typed
 * `FactoryError` the handler maps to a 500.
 */
export async function loadUiAsset(name: UiAssetName): Promise<UiAsset> {
  const cached = bodyCache.get(name);
  if (cached !== undefined) return { contentType: CONTENT_TYPES[name], body: cached };

  try {
    const body = await Bun.file(new URL(`./${name}`, import.meta.url)).text();
    bodyCache.set(name, body);
    return { contentType: CONTENT_TYPES[name], body };
  } catch (error) {
    throw new FactoryError(
      'UI_ASSET_UNAVAILABLE',
      `UI asset ${name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Serve a UI asset for `request`, or `undefined` when this request is not a UI
 * document/asset request. `GET`/`HEAD` only: a non-GET on a UI path falls
 * through to the API router, where the E10.4 auth boundary rejects it (the UI
 * has no mutating surface of its own — the server's `/api` routes remain the
 * sole mutation authority).
 */
export async function serveUi(request: Request): Promise<Response | undefined> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return undefined;

  const name = uiAssetName(new URL(request.url).pathname);
  if (name === undefined) return undefined;

  const asset = await loadUiAsset(name);
  return new Response(method === 'HEAD' ? null : asset.body, {
    status: 200,
    headers: {
      'content-type': asset.contentType,
      // The shell and its assets must not be cached across a redeploy.
      'cache-control': 'no-store',
    },
  });
}
