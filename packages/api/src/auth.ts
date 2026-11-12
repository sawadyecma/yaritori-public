/**
 * Bearer のキーから書き手を決める（設計 5節）。書き手は本文の側で名乗らせず、どのキーで来たかで決める。
 *
 * SSM（KEYS_PARAM）には sha256 のハッシュだけを置く。作り直しは CLI の `admin key rotate <書き手>`。
 * Lambda は5分だけ控えるので、作り直したキーはその時間のうちに全コンテナで効く。
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { KeyHashes, hashKey, parseKey } from '@yaritori/schema'
import type { MiddlewareHandler } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { fail, type Env } from './http'

/** 書き手 → キーの sha256（32バイト） */
export type KeyLoader = () => Promise<Map<string, Buffer>>

/** SSM の秘密を控えておく時間 */
const CACHE_MS = 5 * 60e3
/** 書き手が見つからないときに比べる相手。有無を時間で漏らさないため */
const DUMMY = Buffer.alloc(32)

export function toBuffers(doc: unknown): Map<string, Buffer> {
  return new Map(Object.entries(KeyHashes.parse(doc)).map(([name, hex]) => [name, Buffer.from(hex, 'hex')]))
}

export function ssmKeyLoader(name: string, ssm = new SSMClient({})): KeyLoader {
  let cached: { at: number; value: Promise<Map<string, Buffer>> } | null = null
  return () => {
    if (!cached || Date.now() - cached.at > CACHE_MS) {
      const value = ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true })).then(
        (res) => toBuffers(JSON.parse(res.Parameter?.Value ?? '{}')),
        (e: unknown) => {
          // まだ1本もキーを作っていないときは、誰も通さないだけにする
          if (e instanceof Error && e.name === 'ParameterNotFound') return new Map<string, Buffer>()
          throw e
        },
      )
      value.catch(() => (cached = null))
      cached = { at: Date.now(), value }
    }
    return cached.value
  }
}

export function bearer(load: KeyLoader): MiddlewareHandler<Env> {
  return async (c, next) => {
    const m = /^Bearer\s+(\S+)$/.exec(c.req.header('authorization') ?? '')
    if (!m) return fail(c, 401, 'no_key', 'キーがありません。Authorization: Bearer <キー> を付けて送ってください')
    const parsed = parseKey(m[1])
    const want = parsed ? (await load()).get(parsed.principal) : undefined
    const same = timingSafeEqual(want ?? DUMMY, Buffer.from(hashKey(m[1]), 'hex'))
    if (!parsed || !want || !same) {
      return fail(c, 401, 'bad_key', 'キーが違うか、失効しています。いま渡されているキーをそのまま送ってください（作り直したなら新しいほう）')
    }
    c.set('principal', parsed.principal)
    await next()
  }
}
