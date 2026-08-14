import axios, { AxiosError } from 'axios';
import type {
  AuthResponse,
  EngineInfo,
  Execution,
  ExecutionSummary,
  LanguageInfo,
  Pagination,
} from './types';

/**
 * Browser-facing API base URL. Inlined at build time by Next, so it must be a
 * URL the user's browser can reach (not a Docker service name).
 */
export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const TOKEN_STORAGE_KEY = 'hrc.token';
export const USER_STORAGE_KEY = 'hrc.user';

export const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: { 'Content-Type': 'application/json' },
  // Execution is asynchronous now — every call here returns promptly, so a
  // short timeout is correct. Long runs are observed by polling.
  timeout: 30_000,
  // Datasets go up as base64 in the JSON body.
  maxBodyLength: 64 * 1024 * 1024,
  maxContentLength: 64 * 1024 * 1024,
});

api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/** Dispatched when the API rejects the stored token, so the UI can sign out. */
export const SESSION_EXPIRED_EVENT = 'hrc:session-expired';

export function clearStoredSession(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

/** True for the endpoints that mint a token, where a 401 means "wrong password". */
const isAuthEndpoint = (url: string | undefined) => (url ?? '').startsWith('/auth/');

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    // A stored token the API refuses will never start working: tokens are
    // signed with JWT_SECRET, and every checkout of this project generates its
    // own. Point the browser at a different checkout on the same localhost
    // origin and it keeps presenting the old token, so every request fails with
    // "Invalid token" until localStorage is cleared by hand. Drop it here and
    // let the UI ask for a fresh sign-in instead.
    if (
      error.response?.status === 401 &&
      !isAuthEndpoint(error.config?.url) &&
      typeof window !== 'undefined' &&
      window.localStorage.getItem(TOKEN_STORAGE_KEY)
    ) {
      clearStoredSession();
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    return Promise.reject(error);
  },
);

/** Unwraps the API's `{ error: { message, details } }` envelope into a message. */
export function apiErrorMessage(error: unknown): string {
  if (error instanceof AxiosError) {
    // "Invalid token" is accurate but tells the user nothing they can act on.
    // Say what actually happened and what fixes it.
    if (error.response?.status === 401 && !isAuthEndpoint(error.config?.url)) {
      return 'Your session is no longer valid — sign in again. (This happens when the API is restarted from a different checkout, which signs tokens with a different secret.)';
    }

    const payload = error.response?.data as
      | { error?: { message?: string; details?: Array<{ field?: string; message?: string }> } }
      | undefined;

    const detail = payload?.error?.details
      ?.map((item) => (item.field ? `${item.field}: ${item.message}` : item.message))
      .filter(Boolean)
      .join('; ');

    if (payload?.error?.message) {
      return detail ? `${payload.error.message} (${detail})` : payload.error.message;
    }
    if (error.code === 'ECONNABORTED') return 'Request timed out.';
    if (error.code === 'ERR_NETWORK') return `Cannot reach the API at ${API_URL}.`;
    return error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong';
}

// --- engine -------------------------------------------------------------------

export async function fetchLanguages(): Promise<LanguageInfo[]> {
  const { data } = await api.get<{ languages: LanguageInfo[] }>('/executions/languages');
  return data.languages;
}

export async function fetchEngine(): Promise<EngineInfo> {
  const { data } = await api.get<{ engine: EngineInfo }>('/executions/engine');
  return data.engine;
}

// --- executions ---------------------------------------------------------------

export interface CreateExecutionPayload {
  code: string;
  languageId: number;
  name?: string;
  stdin?: string;
  /** Base64 zip, unpacked into the working directory before the run. */
  additionalFiles?: string;
  timeLimit?: number;
  memoryLimit?: number;
}

/** Queues a run. Resolves as soon as the engine accepts it (HTTP 202). */
export async function createExecution(payload: CreateExecutionPayload): Promise<Execution> {
  const { data } = await api.post<{ execution: Execution }>('/executions', payload);
  return data.execution;
}

export async function fetchExecution(id: string): Promise<Execution> {
  const { data } = await api.get<{ execution: Execution }>(`/executions/${id}`);
  return data.execution;
}

export async function fetchExecutions(
  page = 1,
  pageSize = 20,
): Promise<{ executions: ExecutionSummary[]; pagination: Pagination }> {
  const { data } = await api.get(`/executions?page=${page}&pageSize=${pageSize}`);
  return data;
}

export async function deleteExecution(id: string): Promise<void> {
  await api.delete(`/executions/${id}`);
}

/**
 * Artifact download URL.
 *
 * The route requires a bearer token, so this is fetched as a blob rather than
 * being handed straight to an <a href> or <img src>.
 */
export function artifactUrl(executionId: string, artifactId: string): string {
  return `${API_URL}/api/v1/executions/${executionId}/artifacts/${artifactId}`;
}

export async function fetchArtifactBlob(executionId: string, artifactId: string): Promise<Blob> {
  const { data } = await api.get(`/executions/${executionId}/artifacts/${artifactId}`, {
    responseType: 'blob',
  });
  return data as Blob;
}

// --- auth ---------------------------------------------------------------------

export async function login(identifier: string, password: string): Promise<AuthResponse> {
  const { data } = await api.post<AuthResponse>('/auth/login', { identifier, password });
  return data;
}

export async function register(
  email: string,
  username: string,
  password: string,
): Promise<AuthResponse> {
  const { data } = await api.post<AuthResponse>('/auth/register', { email, username, password });
  return data;
}
