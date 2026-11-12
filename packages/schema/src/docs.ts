/**
 * 資料（設計 3節・段3）。部屋の中の、直し続ける文書（「01-本人のメモ.md」のようなもの）。
 *
 * - どの資料があり、誰が直せるか（editors）は room.json の docs に持つ。作る・直せる人を変えるのは手元の CLI（admin room doc）だけ
 * - 版は1つずつ別のオブジェクト（rooms/<room>/docs/<docId>/v000001.json …）で、追記だけ。前の版は消えない
 * - 直すときは If-Match に読んだ版の番号を入れる。いまの版と違えば 412（誰かが先に直した）
 */
import { z } from 'zod'
import { PrincipalName, utf8Bytes } from './common'

export const DocId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .describe('資料の id（英小文字・数字・ハイフン。01-memo など）')
export type DocId = z.infer<typeof DocId>

/** room.json の docs の1つ */
export const DocMeta = z.object({
  title: z.string().min(1).max(200).describe('表示の名前（01-本人のメモ.md など）'),
  editors: z.array(PrincipalName).default([]).describe('直せる書き手。部屋の read／write とは別'),
})
export type DocMeta = z.infer<typeof DocMeta>

export const MAX_DOC_BYTES = 200 * 1024

/** PUT /v1/rooms/{room}/docs/{docId} の body */
export const DocIn = z
  .object({
    text: z
      .string()
      .refine((s) => utf8Bytes(s) <= MAX_DOC_BYTES, { message: `資料は ${MAX_DOC_BYTES / 1024}KB（UTF-8）までです` })
      .describe(`中身（markdown）。${MAX_DOC_BYTES / 1024}KB（UTF-8）まで`),
    note: z.string().min(1).max(500).optional().describe('何を直したか（任意。版の一覧に出る）'),
  })
  .strict()
export type DocIn = z.infer<typeof DocIn>

/** S3 に置く版そのもの */
export const DocVersion = z.object({
  docId: DocId,
  room: z.string(),
  version: z.number().int().min(1),
  text: z.string(),
  updatedBy: PrincipalName,
  updatedAt: z.string(),
  note: z.string().optional(),
})
export type DocVersion = z.infer<typeof DocVersion>

const DocHead = z.object({
  docId: DocId,
  title: z.string(),
  editors: z.array(PrincipalName),
  canEdit: z.boolean().describe('このキーの書き手が直せるか'),
  version: z.number().int().describe('いまの版。まだ1度も書かれていなければ 0'),
  updatedBy: PrincipalName.nullable(),
  updatedAt: z.string().nullable(),
})

/** GET /v1/rooms/{room}/docs の1つ */
export const DocSummary = DocHead
export type DocSummary = z.infer<typeof DocSummary>

/** GET・PUT /v1/rooms/{room}/docs/{docId}。ETag ヘッダーにも版の番号が入る */
export const DocView = DocHead.extend({
  text: z.string(),
  note: z.string().optional(),
  latest: z.number().int().describe('いちばん新しい版（version= で前の版を見ているときは version と違う）'),
})
export type DocView = z.infer<typeof DocView>

/** GET /v1/rooms/{room}/docs/{docId}/versions */
export const DocHistory = z.object({
  versions: z
    .array(z.object({ version: z.number().int(), updatedBy: PrincipalName, updatedAt: z.string(), note: z.string().optional(), bytes: z.number().int() }))
    .describe('新しい順（50 版まで）'),
})
export type DocHistory = z.infer<typeof DocHistory>

/** ETag と If-Match の形。"3" のように版の番号を引用符でくくる */
export const etagOf = (version: number) => `"${version}"`

/** If-Match から版の番号を読む。W/ と引用符は外す。形が違えば null */
export function parseIfMatch(header: string | undefined): number | null {
  if (header === undefined) return null
  const m = /^\s*(?:W\/)?"?(\d{1,9})"?\s*$/.exec(header)
  return m ? Number(m[1]) : null
}
