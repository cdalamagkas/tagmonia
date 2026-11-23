/**
 * API DTOs shared by the server and the web client (CLAUDE.md: never duplicate
 * DTO shapes). Keep this file free of runtime imports so both sides can use it.
 */

export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  checks: {
    /** The music root exists and is a readable directory. */
    musicRoot: boolean;
    /** The config directory is writable (database and snapshots live there). */
    configDir: boolean;
  };
}

export interface ApiError {
  error: string;
}
