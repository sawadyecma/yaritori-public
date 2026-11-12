/**
 * 読む画面（packages/web）と Lambda「Viewer」のあいだの形（2026-10-30）。
 *
 * 書き手の API（/v1・Bearer キー）とは別の口。Google でログインした、許可したアカウントだけが
 * **全部の部屋**を読む（部屋の members とは関係なく見える。本人の判断）。書く道は持たない。
 * Viewer の権限も読むだけ（S3 の GetObject と ListBucket）にしてある。
 */
import { z } from 'zod'
import { DocSummary, DocView } from './docs'
import { FileLink, Room } from './rooms'

/** 入れる Google アカウント（メールアドレスの配列。SSM の SecureString）。出し入れは CLI の `admin web allow / deny` */
export const WEB_VIEWERS_PARAM = '/yaritori/web-viewers'
/** Google の OAuth クライアント（{"client_id","client_secret"}）。CLI の `admin web google` が置く */
export const WEB_GOOGLE_PARAM = '/yaritori/web-google'
/** セッションの署名鍵。作り直すと全端末が5分のうちに締め出される（`admin web session-rotate`） */
export const WEB_SESSION_KEY_PARAM = '/yaritori/web-session-key'

export const Viewers = z.array(z.email().transform((e) => e.toLowerCase()))
export type Viewers = z.infer<typeof Viewers>

/** GET /api/me */
export const WebMe = z.object({ email: z.string().describe('ログインしているアカウント（手元で開いたときは local）') })
export type WebMe = z.infer<typeof WebMe>

/** GET /api/rooms の1つ */
export const WebRoomSummary = Room.pick({ id: true, title: true, about: true, archived: true, members: true, updatedAt: true })
export type WebRoomSummary = z.infer<typeof WebRoomSummary>

export const WebRoomList = z.object({ rooms: z.array(WebRoomSummary) })
export type WebRoomList = z.infer<typeof WebRoomList>

/** 資料の一覧の1つ。読む画面は書き手ではないので「直せるか」は持たない */
export const WebDocSummary = DocSummary.omit({ canEdit: true })
export type WebDocSummary = z.infer<typeof WebDocSummary>

/** GET /api/rooms/{room} */
export const WebRoom = Room.omit({ docs: true }).extend({ docs: z.array(WebDocSummary) })
export type WebRoom = z.infer<typeof WebRoom>

/** GET /api/rooms/{room}/docs/{docId} */
export const WebDoc = DocView.omit({ canEdit: true })
export type WebDoc = z.infer<typeof WebDoc>

/** 読む画面の発言の1ページ（置いた順） */
export const WEB_PAGE = 50

/** 添付をその場で見る（サイドピーク。2026-10-30）。md とテキストは中身、画像と動画は埋め込む URL を返す */
export const PeekKind = z.enum(['markdown', 'text', 'image', 'video', 'other'])
export type PeekKind = z.infer<typeof PeekKind>

/** 中身を返すテキストの上限。これより大きいものはダウンロードで */
export const WEB_PEEK_TEXT_BYTES = 1024 * 1024
/** 画像・動画を埋め込む URL の期限（秒）。動画を見ているあいだにシークで取り直すので、ダウンロードの5分より長くする */
export const WEB_PEEK_URL_SECONDS = 60 * 60

const TEXT_EXT = new Set(['txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v'])

/** 何として見せるか。Content-Type は書き手の申告なので、拡張子でも引く */
export function peekKind(name: string, contentType: string): PeekKind {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase() ?? ''
  const type = contentType.toLowerCase()
  if (type === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown'
  if (/^image\/(png|jpeg|gif|webp|avif)$/.test(type) || IMAGE_EXT.has(ext)) return 'image'
  if (/^video\/(mp4|webm|quicktime|x-m4v)$/.test(type) || VIDEO_EXT.has(ext)) return 'video'
  if (type.startsWith('text/') || type === 'application/json' || TEXT_EXT.has(ext)) return 'text'
  return 'other'
}

/** GET /api/rooms/{room}/files/{fileId}/peek。url はダウンロード用（5分） */
export const WebPeek = FileLink.extend({
  kind: PeekKind,
  inlineUrl: z.string().optional().describe(`画像・動画を埋め込む URL（${WEB_PEEK_URL_SECONDS / 60} 分）`),
  text: z.string().optional().describe(`md・テキストの中身（UTF-8・${WEB_PEEK_TEXT_BYTES / 1024 / 1024}MB まで）`),
  note: z.string().optional().describe('その場で見せられない理由（大きすぎる・UTF-8 でない など）'),
})
export type WebPeek = z.infer<typeof WebPeek>
