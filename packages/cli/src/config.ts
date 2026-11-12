/**
 * CLI の宛先とキー。環境変数があればそちらを使う。
 *
 * - 宛先：YARITORI_URL、無ければ infra/cdk-outputs.json の ApiUrl
 * - キー：YARITORI_KEY、無ければリポジトリ直下の .env の YARITORI_KEY（admin key rotate --write-env で書いたもの）。
 *   `--as <書き手>` を付けたときは YARITORI_KEY_<書き手>（大文字、- は _）。human のキーはこちら（使うのは本人に頼まれたときだけ）
 * - バケットと表（admin の操作）：infra/cdk-outputs.json の StoreBucket と RoomsTable
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

function outputs(): { ApiUrl?: string; StoreBucket?: string; RoomsTable?: string } {
  const p = resolve(ROOT, 'infra/cdk-outputs.json')
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')).Yaritori ?? {}) : {}
}

export function apiUrl(): string {
  const url = process.env.YARITORI_URL ?? outputs().ApiUrl
  if (!url) throw new Error('宛先がありません。YARITORI_URL を入れるか、デプロイして infra/cdk-outputs.json を作ってください')
  return url.replace(/\/$/, '')
}

/** --as で書き手を替えたときのキーの名前 */
export const keyVar = (actor?: string) => (actor ? `YARITORI_KEY_${actor.toUpperCase().replace(/-/g, '_')}` : 'YARITORI_KEY')

export function apiKey(): string {
  const name = keyVar(process.env.YARITORI_ACTOR)
  if (process.env[name]) return process.env[name]
  const env = resolve(ROOT, '.env')
  const line = existsSync(env) ? readFileSync(env, 'utf8').split('\n').find((l) => l.startsWith(`${name}=`)) : undefined
  if (!line) throw new Error(`キーがありません。${name} を入れるか、admin key rotate <書き手> --write-env .env${name === 'YARITORI_KEY' ? '' : ` --env-name ${name}`} で作ってください`)
  return line.slice(name.length + 1).trim()
}

export function storeBucket(): string {
  const b = outputs().StoreBucket
  if (!b) throw new Error('バケットが分かりません。デプロイして infra/cdk-outputs.json を作ってください')
  return b
}

/** 部屋・参加者・既読の表（DynamoDB。設計 12節） */
export function roomsTable(): string {
  const t = outputs().RoomsTable
  if (!t) throw new Error('部屋の表が分かりません。デプロイして infra/cdk-outputs.json を作ってください')
  return t
}

/** `npm run yaritori -- …` は cwd をリポジトリ直下にするので、相対パスは呼んだ場所（INIT_CWD）から解く */
export function userPath(p: string): string {
  return isAbsolute(p) ? p : resolve(process.env.INIT_CWD ?? process.cwd(), p)
}
