/** Typed API client. DTO shapes come only from shared/types.ts. */
import {
  type ApiError,
  type AuthState,
  type CoverDecisionRequest,
  type Credentials,
  type CredentialsRequest,
  CSRF_HEADER,
  type CurrentCoverDto,
  type DecisionRequest,
  type DestinationRequest,
  type EvidenceResponse,
  type FolderListDto,
  type FolderTreeDto,
  type HealthResponse,
  type HistoryResponse,
  type IdentificationDto,
  type IdentifyRequest,
  type JobDto,
  type LibrarySummary,
  type LockDto,
  type LockRequest,
  type PasswordChange,
  type ProposalResponse,
  type ProposeRequest,
  type ProvidersResponse,
  type ReleaseDetail,
  type ReleaseList,
  type ScanJobDto,
  type SearchTerms,
  type SettingsDto,
  type SettingsUpdateResponse,
  type SubmissionDto,
  type SubmissionOpenResponse,
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
  changePassword: (body: PasswordChange) => request<void>("POST", "/api/auth/password", body),
  logout: async () => {
    await request<void>("POST", "/api/auth/logout");
    csrfToken = null;
  },

  summary: () => request<LibrarySummary>("GET", "/api/library/summary"),
  /** A page of the library list (D75): a root and folder, a status, an order, a search. */
  releases: (
    v: { root: "library" | "inbox"; folder: string; status: string | null; sort: string; q: string },
    offset: number,
    limit = 50,
  ) =>
    request<ReleaseList>(
      "GET",
      `/api/library/releases?${new URLSearchParams({
        root: v.root,
        folder: v.folder,
        sort: v.sort,
        q: v.q,
        offset: String(offset),
        limit: String(limit),
        ...(v.status ? { status: v.status } : {}),
      })}`,
    ),
  /** One level of the folder tree (D75). */
  tree: (root: "library" | "inbox", path: string) =>
    request<FolderTreeDto>("GET", `/api/library/tree?${new URLSearchParams({ root, path })}`),
  release: (id: number) => request<ReleaseDetail>("GET", `/api/library/releases/${id}`),
  scan: () => request<ScanJobDto>("POST", "/api/library/scan"),
  identification: (id: number) => request<IdentificationDto>("GET", `/api/library/releases/${id}/identification`),
  proposal: (id: number) => request<ProposalResponse>("GET", `/api/library/releases/${id}/proposal`),
  propose: (id: number, body: ProposeRequest) => request<JobDto>("POST", `/api/library/releases/${id}/proposal`, body),
  // YouTube evidence (§9.5, D55)
  setEvidence: (releaseId: number, url: string) =>
    request<EvidenceResponse>("PUT", `/api/library/releases/${releaseId}/evidence`, { url }),
  removeEvidence: (releaseId: number) =>
    request<EvidenceResponse>("DELETE", `/api/library/releases/${releaseId}/evidence`),
  // MusicBrainz submission (§12)
  submission: (releaseId: number) =>
    request<{ submission: SubmissionDto | null }>("GET", `/api/library/releases/${releaseId}/submission`),
  prepareSubmission: (proposalId: number) => request<SubmissionDto>("POST", `/api/proposals/${proposalId}/submission`),
  openSubmission: (id: number) => request<SubmissionOpenResponse>("POST", `/api/submissions/${id}/open`),
  submissionCallback: (id: number, release: string) =>
    request<SubmissionDto>("POST", `/api/submissions/${id}/callback`, { release }),
  abandonSubmission: (id: number) => request<void>("POST", `/api/submissions/${id}/abandon`),
  recheckSubmission: (id: number) => request<SubmissionDto>("POST", `/api/submissions/${id}/recheck`),
  /** Whether MusicBrainz has the added release's cover art and ISRCs yet (D65). */
  checkFollowUps: (id: number) => request<SubmissionDto>("POST", `/api/submissions/${id}/follow-ups/check`),
  chooseSubmissionArtist: (id: number, name: string, artist: string | null) =>
    request<SubmissionDto>("POST", `/api/submissions/${id}/artists`, { name, artist }),
  decide: (proposalId: number, body: DecisionRequest) =>
    request<void>("POST", `/api/proposals/${proposalId}/decisions`, body),
  discard: (proposalId: number) => request<void>("POST", `/api/proposals/${proposalId}/discard`),
  /** The release's current cover image (D50); `v` changes the URL after a write. */
  coverUrl: (releaseId: number, size: "thumb" | "large", v = 0) =>
    `/api/library/releases/${releaseId}/cover?size=${size}${v ? `&v=${v}` : ""}`,
  coverInfo: (releaseId: number) =>
    request<{ cover: CurrentCoverDto | null }>("GET", `/api/library/releases/${releaseId}/cover/info`),
  /** Renaming on write (D57): include it in this proposal's write, or leave the names alone. */
  renameDecision: (proposalId: number, include: boolean) =>
    request<void>("POST", `/api/proposals/${proposalId}/rename`, { include }),
  /** Destinations (D59): the library's folders, and the folder chosen for a release (null: the template's). */
  folders: (path: string) => request<FolderListDto>("GET", `/api/library/folders?${new URLSearchParams({ path })}`),
  setDestination: (releaseId: number, folder: string | null) =>
    request<void>("PUT", `/api/library/releases/${releaseId}/destination`, { folder } satisfies DestinationRequest),
  coverDecision: (proposalId: number, body: CoverDecisionRequest) =>
    request<void>("POST", `/api/proposals/${proposalId}/cover/decision`, body),
  write: (proposalId: number) => request<JobDto>("POST", `/api/proposals/${proposalId}/write`),
  lock: (body: LockRequest) => request<LockDto>("POST", "/api/locks", body),
  unlock: (lockId: number) => request<void>("DELETE", `/api/locks/${lockId}`),
  history: (id: number) => request<HistoryResponse>("GET", `/api/library/releases/${id}/history`),
  undo: (batchId: number) => request<JobDto>("POST", `/api/batches/${batchId}/undo`),
  providers: () => request<ProvidersResponse>("GET", "/api/providers"),
  saveCredentials: (id: string, body: CredentialsRequest) =>
    request<{ restartRequired: boolean }>("PUT", `/api/providers/${id}/credentials`, body),
  testProvider: (id: string) => request<JobDto>("POST", `/api/providers/${id}/test`),
  settings: () => request<SettingsDto>("GET", "/api/settings"),
  updateSettings: (patch: unknown) => request<SettingsUpdateResponse>("PATCH", "/api/settings", patch),
  /** Search terms (D63): saved, then the release is identified again with them. */
  setSearchTerms: (id: number, terms: SearchTerms) =>
    request<JobDto>("PUT", `/api/library/releases/${id}/search-terms`, terms),
  clearSearchTerms: (id: number) => request<JobDto | undefined>("DELETE", `/api/library/releases/${id}/search-terms`),
  identify: (id: number, body: IdentifyRequest = {}) =>
    request<JobDto>("POST", `/api/library/releases/${id}/identify`, body),
  cancelJob: (id: number) => request<ScanJobDto>("POST", `/api/jobs/${id}/cancel`),
};
