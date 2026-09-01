export interface ApiError {
  type?: string
  title?: string
  status: number
  detail?: string
}

export class HttpError extends Error {
  status: number
  detail?: string
  constructor(status: number, detail?: string) {
    super(detail || `HTTP ${status}`)
    this.status = status
    this.detail = detail
  }
}

const BASE = ''

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return undefined as T
  let data: unknown = null
  try { data = await res.json() } catch { /* empty */ }
  if (!res.ok) {
    const err = data as Partial<ApiError> | null
    throw new HttpError(res.status, err?.detail ?? `HTTP ${res.status}`)
  }
  return data as T
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
}

export function download(path: string): void {
  window.open(BASE + path, '_blank')
}

/** Pull an error's human-readable detail out of an unknown thrown value. */
export function errText(e: unknown): string {
  if (e instanceof HttpError) return e.detail ?? e.message
  if (e instanceof Error) return e.message
  return String(e)
}
