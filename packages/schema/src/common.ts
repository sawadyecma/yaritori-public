import { z } from 'zod'

/** 書き手の名前。キー（yt_<名前>_<秘密>）の真ん中に入るので `_` を含めない */
export const PrincipalName = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/)
  .describe('書き手の名前（human・opus・muse・routine-<名前> など）。キーで決まり、本文の側では名乗らない')
export type PrincipalName = z.infer<typeof PrincipalName>

/** 誤りの返し方。message だけで直し方が分かるように書く（設計 4節） */
export const ErrorBody = z.object({
  error: z.object({
    code: z.string().describe('機械向けの短い名前（no_key・bad_key・not_found など）'),
    message: z.string().describe('人と書き手向けの説明。直し方まで書く'),
  }),
})
export type ErrorBody = z.infer<typeof ErrorBody>

/** 1リクエストの上限。添付の中身は関数を通らない（署名付き URL で S3 に直接）ので、本文（100KB）が入れば足りる */
export const MAX_REQUEST_BYTES = 512 * 1024

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).length
