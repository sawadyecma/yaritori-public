/**
 * 読む画面の API（Lambda「Viewer」。2026-10-30）。画面（packages/web）は Cloudflare の Worker が配り、
 * /api と /auth だけがここへ中継されてくる。手元では viewer-local.ts が画面ごと 127.0.0.1 で配る。
 *
 * **読むだけ。** ルートは GET しか無く、関数の権限も S3 の GetObject と ListBucket、DynamoDB の GetItem・BatchGetItem・Query だけ（infra）。
 * 部屋も読む口（RoomReader）しか受け取らない。発言・資料・既読の印は書けないので、ログインの仕組みに穴があっても、届くのは読むところまで。
 *
 * 書き手の API（app.ts・/v1）とは別の関数で、キーではなく Google のログイン（google.ts）で入る。
 * 見えるのは**全部の部屋**（部屋の members とは関係ない。2026-10-30・本人）。
 */
import {
  DocId,
  FileId,
  MessageId,
  RoomId,
  WEB_PAGE,
  WEB_PEEK_TEXT_BYTES,
  WEB_PEEK_URL_SECONDS,
  peekKind,
  type WebDoc,
  type WebMe,
  type WebPeek,
  type WebRoom,
  type WebRoomList,
} from '@yaritori/schema'
import { Hono, type MiddlewareHandler } from 'hono'
import type { z } from 'zod'
import { docHistory, getDoc, listDocs } from './docs'
import type { WebEnv } from './google'
import { ApiError, fail } from './http'
import type { RoomReader } from './roomdb'
import { allRooms, fileKey, fileLink, getMessage, listMessages, readRoom } from './rooms'
import type { Store } from './store'

export type ViewerDeps = {
  store: Store
  rooms: RoomReader
  /** ログイン（google.ts）。手元（viewer-local.ts）では渡さない */
  auth?: { routes: (app: Hono<WebEnv>) => void; guard: MiddlewareHandler<WebEnv> }
}

/** 資料を読むときの「書き手」。読む画面は書き手ではないので、どの資料の editors にも当たらない名前にする（PrincipalName の形に合わない） */
const NOBODY = '-'

export function createViewer({ store, rooms, auth }: ViewerDeps) {
  const app = new Hono<WebEnv>()

  app.use('*', async (c, next) => {
    const started = Date.now()
    await next()
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store')
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('Referrer-Policy', 'no-referrer')
    // 本文はログに残さない（個人の話が乗る。設計 5節）。メールアドレスも残さない
    console.log(JSON.stringify({ method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started }))
  })
  if (auth) {
    auth.routes(app)
    app.use('*', auth.guard)
  }

  /** パスの id を形で確かめる（形違いは、無いものと同じ 404） */
  const valid = (schema: z.ZodType, v: string, what: string) => {
    if (!schema.safeParse(v).success) throw new ApiError(404, 'not_found', `${what} ${v} はありません`)
    return v
  }
  const room = async (v: string) => {
    const r = await readRoom(rooms, valid(RoomId, v, '部屋'))
    if (!r) throw new ApiError(404, 'room_not_found', `部屋 ${v} はありません`)
    return r
  }

  app.get('/api/me', (c) => c.json({ email: c.get('email') ?? 'local' } satisfies WebMe))

  app.get('/api/rooms', async (c) => {
    const list = (await allRooms(rooms)).map(({ id, title, about, archived, members, updatedAt }) => ({ id, title, about, archived, members, updatedAt }))
    return c.json({ rooms: list } satisfies WebRoomList)
  })

  app.get('/api/rooms/:room', async (c) => {
    const r = await room(c.req.param('room'))
    const docs = (await listDocs(store, r, NOBODY)).map(({ canEdit: _, ...d }) => d)
    return c.json({ ...r, docs } satisfies WebRoom)
  })

  // 置いた順に WEB_PAGE 通ずつ。続きは after=<next>
  app.get('/api/rooms/:room/messages', async (c) => {
    const r = await room(c.req.param('room'))
    const after = c.req.query('after')
    return c.json(await listMessages(store, r.id, { after: after === undefined ? undefined : valid(MessageId, after, '発言'), limit: WEB_PAGE }))
  })

  app.get('/api/rooms/:room/messages/:id', async (c) => {
    const r = await room(c.req.param('room'))
    return c.json(await getMessage(store, r.id, valid(MessageId, c.req.param('id'), '発言')))
  })

  app.get('/api/rooms/:room/docs/:docId', async (c) => {
    const r = await room(c.req.param('room'))
    const v = c.req.query('version')
    if (v !== undefined && !/^[1-9]\d{0,8}$/.test(v)) throw new ApiError(400, 'bad_version', `version は 1 以上の数で（${v}）`)
    const { canEdit: _, ...doc } = await getDoc(store, r, valid(DocId, c.req.param('docId'), '資料'), NOBODY, v === undefined ? undefined : Number(v))
    return c.json(doc satisfies WebDoc)
  })

  app.get('/api/rooms/:room/docs/:docId/versions', async (c) => {
    const r = await room(c.req.param('room'))
    return c.json(await docHistory(store, r, valid(DocId, c.req.param('docId'), '資料')))
  })

  // 添付は取り出す URL（5分）を返す。中身は関数を通らない
  app.get('/api/rooms/:room/files/:fileId', async (c) => {
    const r = await room(c.req.param('room'))
    return c.json(await fileLink(store, r.id, valid(FileId, c.req.param('fileId'), '添付')))
  })

  // その場で見る（サイドピーク）。md・テキストは中身をここで読んで返し（S3 に CORS を足さず、画面の connect-src も自分のドメインのまま）、
  // 画像・動画は埋め込む URL（inline）を返す。どれでも url（ダウンロード・5分）は付ける
  app.get('/api/rooms/:room/files/:fileId/peek', async (c) => {
    const r = await room(c.req.param('room'))
    const fileId = valid(FileId, c.req.param('fileId'), '添付')
    const link = await fileLink(store, r.id, fileId)
    const kind = peekKind(link.name, link.contentType)
    const other = (note: string) => c.json({ ...link, kind: 'other', note } satisfies WebPeek)
    if (kind === 'image' || kind === 'video') {
      const inlineUrl = await store.presignGet(fileKey(r.id, fileId), { name: link.name, inline: true }, WEB_PEEK_URL_SECONDS)
      return c.json({ ...link, kind, inlineUrl } satisfies WebPeek)
    }
    if (kind === 'markdown' || kind === 'text') {
      if (link.size > WEB_PEEK_TEXT_BYTES) return other(`${WEB_PEEK_TEXT_BYTES / 1024 / 1024}MB を超えるので、ここでは開きません。ダウンロードしてください`)
      const bytes = await store.getBytes(fileKey(r.id, fileId))
      if (!bytes) throw new ApiError(404, 'file_not_found', `部屋 ${r.id} に添付 ${fileId} はありません`)
      try {
        return c.json({ ...link, kind, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) } satisfies WebPeek)
      } catch {
        return other('UTF-8 のテキストではないので、ここでは開きません（Shift_JIS など）。ダウンロードしてください')
      }
    }
    return other('この種類のファイルは、ここでは開きません。ダウンロードしてください')
  })

  app.notFound((c) => fail(c, 404, 'not_found', `${c.req.method} ${c.req.path} はありません`))
  app.onError((e, c) => {
    if (e instanceof ApiError) return fail(c, e.status, e.code, e.message)
    console.error(JSON.stringify({ error: String(e).slice(0, 500), path: c.req.path }))
    return fail(c, 500, 'internal', 'サーバーの側で失敗しました。少し待ってから再読み込みしてください')
  })
  return app
}
