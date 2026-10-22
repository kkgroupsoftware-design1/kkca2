// Runtime configuration.
//
// Priority:
//   1. window.__MTC_CONFIG__ from /config.js (served with the static files;
//      on the VPS the Docker container generates it at startup from the
//      API_URL / LIVEKIT_URL environment variables — see entrypoint.sh).
//   2. Build-time Vite env (VITE_API_URL / VITE_LIVEKIT_URL) — local dev.
//   3. Same-origin default (apiUrl "") + a LiveKit URL derived from the
//      current page location (best effort for local development).

export interface RuntimeConfig {
  apiUrl: string;
  livekitUrl: string;
}

interface WindowWithConfig {
  __MTC_CONFIG__?: Partial<RuntimeConfig>;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function resolveConfig(): RuntimeConfig {
  const runtime = (window as unknown as WindowWithConfig).__MTC_CONFIG__;
  const env = import.meta.env as { VITE_API_URL?: string; VITE_LIVEKIT_URL?: string };

  const hasRuntime = runtime && (typeof runtime.apiUrl === 'string' || typeof runtime.livekitUrl === 'string');
  const apiUrl = stripTrailingSlash(
    hasRuntime && typeof runtime.apiUrl === 'string' ? runtime.apiUrl : env.VITE_API_URL ?? '',
  );
  let livekitUrl = stripTrailingSlash(
    hasRuntime && typeof runtime.livekitUrl === 'string' ? runtime.livekitUrl : env.VITE_LIVEKIT_URL ?? '',
  );
  if (!livekitUrl) {
    // Best-effort derivation (local dev where LiveKit is reached on the same
    // host). In production config.js always sets this explicitly.
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    livekitUrl = `${proto}//${window.location.hostname}:7880`;
  }
  return { apiUrl, livekitUrl };
}

export const runtimeConfig: RuntimeConfig = resolveConfig();

/** Join an API-relative path (e.g. "/api/files/x.png") onto the API base URL. */
export function apiFileUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${runtimeConfig.apiUrl}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}
