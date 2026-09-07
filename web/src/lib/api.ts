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

/**
 * Fetch a path as raw text.
 *
 * Archive files are served as octet-stream regardless of content, so a JSON
 * file parsed through `request` returns an object. Rendering that object as a
 * React child throws, and a .jsonl file fails JSON.parse and silently reads
 * back as null. Both cases want the bytes, not a parse.
 */
async function requestText(path: string): Promise<string> {
  const res = await fetch(BASE + path)
  const body = await res.text()
  if (!res.ok) {
    let detail = `HTTP ${res.status}`
    try { detail = (JSON.parse(body) as Partial<ApiError>).detail ?? detail } catch { /* not a problem+json body */ }
    throw new HttpError(res.status, detail)
  }
  return body
}

/** POST a file's raw bytes (archive import routes read the body directly). */
async function requestUpload<T>(path: string, file: Blob): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  })
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
  upload: <T>(path: string, file: Blob) => requestUpload<T>(path, file),
  text: (path: string) => requestText(path),
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
