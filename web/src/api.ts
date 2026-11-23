/** Typed API client. DTO shapes come only from shared/types.ts. */
import type { ApiError, HealthResponse } from "../../shared/types.ts";

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({ error: res.statusText }));
  if (!res.ok && res.status !== 503) throw new ApiRequestError(res.status, (body as ApiError).error);
  return body as T;
}

export const api = {
  health: () => getJson<HealthResponse>("/api/health"),
};
