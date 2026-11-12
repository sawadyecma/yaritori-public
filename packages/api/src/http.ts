import type { ErrorBody } from '@yaritori/schema'
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type Env = { Variables: { principal: string } }

/** 誤りは { error: { code, message } }。message だけで直し方が分かるように書く */
export function fail(c: Context, status: ContentfulStatusCode, code: string, message: string) {
  return c.json({ error: { code, message } } satisfies ErrorBody, status)
}

/** 処理の途中で投げると、app の onError がそのまま { error } で返す */
export class ApiError extends Error {
  constructor(readonly status: ContentfulStatusCode, readonly code: string, message: string) {
    super(message)
  }
}
