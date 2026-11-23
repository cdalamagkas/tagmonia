/** Typed API client. DTO shapes come only from shared/types.ts. */
import {
  type ApiError,
  type AuthState,
  type Credentials,
  CSRF_HEADER,
  type HealthResponse,
  type LibrarySummary,
  type ReleaseDetail,
  type ReleaseList,
  type ScanJobDto,
} from "../../shared/types.ts";

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

let csrfToken: string | null = null;
let onUnauthorized: () => void = () => {};

/** Called when any request answers 401, so the app can return to the login page. */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function remember(state: AuthState): AuthState {
  csrfToken = state.csrfToken;
  return state;
}

async function request<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && csrfToken) headers[CSRF_HEADER] = csrfToken;
  const res = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok && !okStatuses.includes(res.status)) {
    if (res.status === 401 && !path.startsWith("/api/auth/")) onUnauthorized();
    throw new ApiRequestError(res.status, (data as ApiError).error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  health: () => request<HealthResponse>("GET", "/api/health", undefined, [503]),

  session: async () => remember(await request<AuthState>("GET", "/api/auth/session")),
  setup: async (c: Credentials) => remember(await request<AuthState>("POST", "/api/auth/setup", c)),
  login: async (c: Credentials) => remember(await request<AuthState>("POST", "/api/auth/login", c)),
  logout: async () => {
    await request<void>("POST", "/api/auth/logout");
    csrfToken = null;
  },

  summary: () => request<LibrarySummary>("GET", "/api/library/summary"),
  releases: (q: string, offset: number, limit = 50) =>
    request<ReleaseList>(
      "GET",
      `/api/library/releases?${new URLSearchParams({ q, offset: String(offset), limit: String(limit) })}`,
    ),
  release: (id: number) => request<ReleaseDetail>("GET", `/api/library/releases/${id}`),
  scan: () => request<ScanJobDto>("POST", "/api/library/scan"),
  cancelJob: (id: number) => request<ScanJobDto>("POST", `/api/jobs/${id}/cancel`),
};
