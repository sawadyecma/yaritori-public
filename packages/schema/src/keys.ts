/**
 * 書き手のキー（設計 5節）。形は `yt_<書き手>_<ランダム32バイトの base64url>`。
 *
 * **SSM（KEYS_PARAM）に置くのは sha256 のハッシュだけ。** キーそのものは作ったときに1度だけ表示する（CLI の admin key rotate）。
 * 頭から書き手を引けるので、API は1つのハッシュとだけ比べればよい。
 * SSM の標準パラメータは 4KB までで、1人ぶんが 80 バイト前後なので 50 人ほど入る。
 */
import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

/** キーのハッシュを置く SSM のパラメータ（SecureString）。CDK では作らない（値がテンプレートに載るため）。CLI が作る */
export const KEYS_PARAM = '/yaritori/keys'

const KEY_RE = /^yt_([a-z][a-z0-9-]{0,31})_([A-Za-z0-9_-]{43})$/

/** SSM に置く中身。書き手 → キーの sha256（16進） */
export const KeyHashes = z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.string().regex(/^[0-9a-f]{64}$/))
export type KeyHashes = z.infer<typeof KeyHashes>

export function newKey(principal: string): string {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(principal)) {
    throw new Error(`書き手の名前は英小文字で始まり、英小文字・数字・ハイフンだけで32字まで: ${principal}`)
  }
  return `yt_${principal}_${randomBytes(32).toString('base64url')}`
}

/** キーの頭から書き手を引く。形が違えば null（ハッシュの照合はしない） */
export function parseKey(key: string): { principal: string } | null {
  const m = KEY_RE.exec(key)
  return m ? { principal: m[1] } : null
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}
