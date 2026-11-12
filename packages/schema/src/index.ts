/**
 * やりとりの形の正本（docs/設計.md 3〜4節）。API・CLI・CDK が同じものを読む。
 * OpenAPI（docs/openapi.yaml）はここから生成するので、形を変えたら `npm run openapi` で書き出し直す。
 */
import { z } from 'zod'
import { PrincipalName } from './common'
import { RoomSummary } from './rooms'

export * from './common'
export * from './docs'
export * from './keys'
export * from './rooms'
export * from './web'

/** GET /v1/me */
export const Me = z.object({
  principal: PrincipalName,
  rooms: z.array(RoomSummary).describe('入っている部屋（閉じた部屋も含む）'),
})
export type Me = z.infer<typeof Me>
