/** Thin client of the backend HTTP API (backend/docs/protocol.md). */
let connection = { url: "", token: "" };

export function setConnection(url: string, token: string) {
  connection = { url, token };
}

export const connectionInfo = () => connection;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const PREFIX = "/api/v1";

export async function request<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(connection.url + PREFIX + path, {
      method,
      headers: {
        Authorization: `Bearer ${connection.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ApiError(0, "network", "Нет связи с бэкендом");
  }
  let data: unknown = null;
  try {
    data = await response.json();
  } catch {
    /* an empty body */
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? "http_error", error?.message ?? `Ошибка ${response.status}`);
  }
  return data as T;
}

export const get = <T>(path: string, signal?: AbortSignal) => request<T>("GET", path, undefined, signal);
export const post = <T>(path: string, body: unknown = {}) => request<T>("POST", path, body);
export const put = <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body);
export const patch = <T>(path: string, body: unknown = {}) => request<T>("PATCH", path, body);
export const del = <T>(path: string) => request<T>("DELETE", path);

export const sessionPath = (id: string, tail = "") => `/sessions/${encodeURIComponent(id)}${tail}`;

export function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
