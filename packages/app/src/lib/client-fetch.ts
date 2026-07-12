/**
 * Always-installed `window.fetch` wrapper for the web app + desktop renderer.
 *
 * Three responsibilities, on the single seam every browser `/api/*` call passes
 * through:
 *
 * 1. **Version headers (always).** Every request to the local server's `/api/*`
 *    surface carries the client's version metadata (`x-ok-client-*`) so a
 *    future server can refuse an incompatible peer. This happens in **all**
 *    distributions — web, `ok ui`, and the desktop renderer — not just desktop.
 *
 * 2. **URL rewrite (desktop only).** In Electron the renderer is served from a
 *    different origin than the API (electron-vite's dev server, or `file://`
 *    when packaged), so relative `/api/*` requests must be retargeted to
 *    `window.okDesktop.config.apiOrigin = 'http://localhost:<utility-port>'`.
 *    Without this, every app fetch to `/api/*` hits the renderer host and gets
 *    the Vite HTML fallback — "Server error (HTTP 200)". Web / CLI distribution
 *    has no `apiOrigin`; relative fetches stay relative and hit the same-origin
 *    server as before.
 *
 * 3. **Hosted adapter (opt-in).** An embedding web host can prefix same-origin
 *    API paths and attach fixed routing headers. With no bootstrap config this
 *    branch is inert, preserving the standalone web and desktop contracts.
 *
 * The wrapper instruments by **resolved `/api/*` target**, not raw string
 * prefix: a relative `/api/*` path, a same-origin absolute `/api/*` URL, or an
 * absolute URL already pointing at `apiOrigin`'s `/api/*` all get headers. So a
 * caller that pre-prepends `apiOrigin` (e.g. the skill installer) is covered
 * too. Absolute external URLs (image CDNs, GitHub) and the HocuspocusProvider
 * WebSocket URL pass through untouched — they are not `fetch`, or not `/api/*`.
 *
 * CORS: the Hocuspocus API extension allows loopback Origins
 * (localhost/127.x.x.x/[::1]) and the opaque `"null"` origin (file:// packaged
 * Electron per Fetch spec §4.3); the allowed Origin is reflected verbatim in
 * ACAO, all others get 403.
 */
import { browserClientVersionHeaders } from '@/lib/client-version';

/** Minimal shape we read from the desktop bridge config. */
interface ClientFetchConfig {
  /** Electron utility-process API origin. Absent (web / CLI) → no URL rewrite. */
  apiOrigin?: string;
  /**
   * Optional same-origin prefix for hosted adapters. `/api/documents` becomes
   * `<apiPrefix>/documents`; absent keeps the standalone route unchanged.
   */
  apiPrefix?: string;
  /** Headers a trusted host adds to every local API request. */
  apiHeaders?: Record<string, string>;
}

const FETCH_WRAPPER_MARKER = Symbol.for('ok.client.fetchWrapper');

/**
 * Install the wrapper. Idempotent (a second call is a no-op via a marker
 * symbol — guards React StrictMode double-invoke and any future HMR path).
 * Safe to call before React renders, and safe to call with no config in web
 * mode (headers are still injected; nothing is rewritten).
 */
export function installClientFetchWrapper(config: ClientFetchConfig = {}): void {
  if (typeof window === 'undefined') return;
  const apiOrigin = config.apiOrigin && config.apiOrigin.length > 0 ? config.apiOrigin : undefined;
  const apiPrefix = normalizeApiPrefix(config.apiPrefix);

  const current = window.fetch as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };
  if (current[FETCH_WRAPPER_MARKER]) return;

  const origFetch = window.fetch.bind(window);
  // Version metadata is constant for the bundle's lifetime — resolve once.
  const apiHeaders = { ...config.apiHeaders, ...browserClientVersionHeaders() };

  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) => {
    const target = resolveApiTarget(input, apiOrigin, apiPrefix);
    if (!target.isApi) return origFetch(input, init);

    if (input instanceof Request) {
      const headers = mergeHeaders(input.headers, apiHeaders);
      return origFetch(new Request(target.url, input), { headers });
    }
    const headers = mergeHeaders(init?.headers, apiHeaders);
    return origFetch(target.url, { ...init, headers });
  }) as typeof window.fetch & { [FETCH_WRAPPER_MARKER]?: true };

  wrapped[FETCH_WRAPPER_MARKER] = true;
  window.fetch = wrapped;
}

/** Build a `Headers` from an existing init and overlay the version headers. */
function mergeHeaders(existing: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(existing);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

interface ApiTarget {
  /** Whether this request targets the local server's `/api/*` surface. */
  isApi: boolean;
  /** Final URL: rewritten to `apiOrigin` for relative requests in desktop mode. */
  url: string;
}

/**
 * Classify a fetch input as an `/api/*` request to the local server and
 * compute its final URL. A request counts as `/api/*` when it is a relative
 * `/api/*` path, a same-origin (or `file://`) absolute `/api/*` URL, or an
 * absolute URL already targeting `apiOrigin`'s `/api/*`.
 */
function resolveApiTarget(
  input: RequestInfo | URL,
  apiOrigin: string | undefined,
  apiPrefix: string | undefined,
): ApiTarget {
  if (typeof input === 'string') {
    if (input.startsWith('/api/')) {
      const path = prefixApiPath(input, apiPrefix);
      return { isApi: true, url: apiOrigin ? apiOrigin + path : path };
    }
    const parsed = tryParseUrl(input);
    if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
      return { isApi: true, url: prefixAbsoluteApiUrl(parsed, apiPrefix) };
    }
    return { isApi: false, url: input };
  }

  const parsed = input instanceof URL ? input : tryParseUrl(input.url, window.location.origin);
  if (parsed && isLocalApiUrl(parsed, apiOrigin)) {
    // Rewrite same-origin / file:// to apiOrigin in desktop mode; an absolute
    // URL already on apiOrigin stays as-is.
    const original = input instanceof URL ? input.href : input.url;
    if (apiOrigin && (parsed.origin === window.location.origin || parsed.protocol === 'file:')) {
      return {
        isApi: true,
        url: apiOrigin + prefixApiPath(parsed.pathname, apiPrefix) + parsed.search + parsed.hash,
      };
    }
    return {
      isApi: true,
      url: apiPrefix ? prefixAbsoluteApiUrl(parsed, apiPrefix) : original,
    };
  }
  return { isApi: false, url: input instanceof URL ? input.href : input.url };
}

function normalizeApiPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.endsWith('/') ? value.slice(0, -1) : value;
  return /^\/api(?:\/[A-Za-z0-9._~-]+)*$/.test(trimmed) ? trimmed : undefined;
}

function prefixApiPath(path: string, apiPrefix: string | undefined): string {
  if (!apiPrefix || path === apiPrefix || path.startsWith(`${apiPrefix}/`)) return path;
  return apiPrefix + path.slice('/api'.length);
}

function prefixAbsoluteApiUrl(url: URL, apiPrefix: string | undefined): string {
  if (!apiPrefix) return url.href;
  const next = new URL(url.href);
  next.pathname = prefixApiPath(next.pathname, apiPrefix);
  return next.href;
}

function tryParseUrl(url: string, base?: string): URL | null {
  try {
    return new URL(url, base);
  } catch {
    return null;
  }
}

/** True when `url` is an `/api/*` path on the page origin, `file://`, or apiOrigin. */
function isLocalApiUrl(url: URL, apiOrigin: string | undefined): boolean {
  if (!url.pathname.startsWith('/api/')) return false;
  if (url.origin === window.location.origin || url.protocol === 'file:') return true;
  if (apiOrigin) {
    const api = tryParseUrl(apiOrigin);
    if (api && url.origin === api.origin) return true;
  }
  return false;
}
