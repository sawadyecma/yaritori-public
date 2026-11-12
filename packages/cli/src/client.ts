/** API を叩く。誤りは API の message をそのまま投げる（直し方まで書いてある） */
import type { ErrorBody } from '@yaritori/schema'
import { apiKey, apiUrl } from './config'

export async function call<T>(method: 'GET' | 'POST' | 'PUT', path: string, opts: { body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const res = await fetch(apiUrl() + path, {
    method,
    headers: {
      authorization: `Bearer ${apiKey()}`,
      ...(opts.body !== undefined && { 'content-type': 'application/json' }),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text.slice(0, 500)
    try {
      const e = (JSON.parse(text) as ErrorBody).error
      msg = `${e.message}（${e.code}）`
    } catch {}
    throw Object.assign(new Error(`${method} ${path} → ${res.status}: ${msg}`), { status: res.status })
  }
  return JSON.parse(text) as T
}

/**
 * 署名付き URL との受け渡し（S3 と直接）。**Authorization を付けない**（付けると S3 が「認証が2つ」で断る）。
 * S3 の誤りは XML で返るので、Code だけ拾って見せる
 */
async function s3Error(method: string, res: Response): Promise<Error> {
  const code = /<Code>(.*?)<\/Code>/.exec(await res.text())?.[1] ?? ''
  const hint = code === 'BadDigest' ? '（中身が申告した sha256 と違う）' : code === 'SignatureDoesNotMatch' ? '（大きさ・Content-Type・ヘッダーが申告と違う）' : code === 'AccessDenied' ? '（URL の期限切れか、違う URL）' : ''
  return Object.assign(new Error(`S3 への ${method} → ${res.status} ${code}${hint}`), { status: res.status })
}

export async function s3Put(url: string, bytes: Uint8Array, headers: Record<string, string>) {
  const res = await fetch(url, { method: 'PUT', headers, body: new Uint8Array(bytes) })
  if (!res.ok) throw await s3Error('PUT', res)
}

export async function s3Get(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok) throw await s3Error('GET', res)
  return new Uint8Array(await res.arrayBuffer())
}
