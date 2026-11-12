/**
 * 部屋と発言（設計 3節）。S3 には `rooms/<room>/room.json` と `rooms/<room>/messages/<id>.json` で置く。
 * 発言は追記だけで、直さない・消さない。
 */
import { z } from 'zod'
import { PrincipalName, utf8Bytes } from './common'
import { DocId, DocMeta } from './docs'

export const RoomId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
  .describe('部屋の id（英小文字・数字・ハイフン）。用途を頭につける（blog-… など）')
export type RoomId = z.infer<typeof RoomId>

export const Role = z.enum(['read', 'write']).describe('read は読むだけ、write は発言も置ける')
export type Role = z.infer<typeof Role>

/**
 * API で部屋を作れる書き手と、その部屋に入る書き手（2026-11-02・本人）。参加者は選ばせない。
 * ほかの部屋（参加者を選ぶ部屋）は、これまでどおり手元の CLI（admin room）で作る
 */
export const ROOM_CREATOR = 'muse'
export const CREATED_ROOM_MEMBERS: Record<string, Role> = { muse: 'write', opus: 'write', human: 'write' }
/** API で作れる部屋の数（閉じた部屋も数える）。キーが漏れたときに増やされる数を抑える */
export const MAX_CREATED_ROOMS = 50

const Title = z.string().min(1).max(200)
const About = z.string().max(2000).describe('何をする部屋か')
const Rules = z.string().max(20000).describe('この部屋の決まり（markdown）。書く前に読む')

/** room.json の中身。手元の CLI（admin room）が作る・直す。muse は API でも作れ、自分が作った部屋だけ直せる */
export const Room = z.object({
  id: RoomId,
  title: Title,
  about: About.default(''),
  rules: Rules.default(''),
  members: z.record(PrincipalName, Role),
  docs: z.record(DocId, DocMeta).default({}).describe('部屋の資料と、それぞれを直せる書き手'),
  archived: z.boolean().default(false).describe('閉じた部屋。読めるが、発言も資料も置けない'),
  createdBy: PrincipalName.optional().describe('API で部屋を作った書き手。API で直せるのはこの書き手だけ。手元の CLI で作った部屋には無い'),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Room = z.infer<typeof Room>

const NewDocs = z
  .record(DocId, DocMeta.strict())
  .describe('足す資料（docId → 名前と直せる書き手）。editors に入れられるのは部屋の書き手だけ。もうある資料は変えられない')

/** POST /v1/rooms の body（muse だけ）。参加者は muse・opus・human の3者で決まっているので送らない */
export const RoomIn = z
  .object({
    id: RoomId,
    title: Title.describe('部屋の名前'),
    about: About.optional(),
    rules: Rules.optional(),
    docs: NewDocs.optional(),
  })
  .strict()
export type RoomIn = z.infer<typeof RoomIn>

/** PATCH /v1/rooms/{room} の body（その部屋を API で作った書き手だけ）。送った項目だけ変わる */
export const RoomPatch = z
  .object({
    title: Title.optional(),
    about: About.optional(),
    rules: Rules.optional(),
    archived: z.boolean().optional().describe('true で閉じる（読めるが置けない）。false で開け直す'),
    docs: NewDocs.optional(),
  })
  .strict()
export type RoomPatch = z.infer<typeof RoomPatch>

/** GET /v1/rooms の1行と GET /v1/me の rooms */
export const RoomSummary = z.object({
  id: RoomId,
  title: z.string(),
  about: z.string(),
  archived: z.boolean(),
  role: Role.describe('このキーの書き手がこの部屋でできること'),
})
export type RoomSummary = z.infer<typeof RoomSummary>

/** GET /v1/rooms/{room} */
export const RoomView = Room.extend({ role: Role })
export type RoomView = z.infer<typeof RoomView>

/** m_ ＋ ULID（26字）。キーの並び＝時刻の並び */
export const MessageId = z
  .string()
  .regex(/^m_[0-9A-HJKMNP-TV-Z]{26}$/)
  .describe('発言の id（m_ ＋ ULID）。並べると置いた順')
export type MessageId = z.infer<typeof MessageId>

export const MAX_TEXT_BYTES = 100 * 1024
export const MAX_META_BYTES = 2 * 1024
/** 添付は1通 10 個まで・1つ 100MB まで（設計 4節）。中身は署名付き URL で S3 に直接上げる */
export const MAX_ATTACHMENTS = 10
export const MAX_FILE_BYTES = 100 * 1024 * 1024
/** 上げる URL の期限（秒）と、使われなかった一時置き場（uploads/）が消えるまでの日数 */
export const UPLOAD_URL_SECONDS = 15 * 60
export const UPLOAD_KEEP_DAYS = 2
/** 取り出す URL の期限（秒） */
export const DOWNLOAD_URL_SECONDS = 5 * 60

const MetaValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null()])

/** u_ ＋ ULID。POST uploads で受け取り、発言の attachments で指す */
export const UploadId = z.string().regex(/^u_[0-9A-HJKMNP-TV-Z]{26}$/).describe('上げた添付の id（POST uploads で受け取る）')
export type UploadId = z.infer<typeof UploadId>

/** f_ ＋ 発言の ULID ＋ 何個目か。発言の id から決まるので、送り直しても同じ添付が二重にできない */
export const FileId = z
  .string()
  .regex(/^f_[0-9A-HJKMNP-TV-Z]{26}-\d{1,2}$/)
  .describe('部屋に置かれた添付の id（f_ ＋ 発言の ULID ＋ 何個目か）')
export type FileId = z.infer<typeof FileId>

const FileName = z
  .string()
  .min(1)
  .max(200)
  .refine((n) => !/[\u0000-\u001f\u007f/\\]/.test(n) && !n.startsWith('.'), {
    message: 'ファイル名に / \\ 制御文字は使えず、. で始められません',
  })
  .describe('元のファイル名（日本語でよい）')

const ContentType = z
  .string()
  .max(100)
  .regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i, { message: 'Content-Type は type/subtype の形で（; charset などは付けない）' })
  .describe('MIME タイプ（text/markdown・image/png など）')

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, { message: 'sha256 は 16進の小文字 64 字で' })

/** POST /v1/rooms/{room}/uploads の body。ここで申告した大きさ・sha256・Content-Type は署名に入り、違う中身は S3 が断る */
export const UploadIn = z
  .object({
    name: FileName,
    contentType: ContentType,
    size: z.number().int().min(1).max(MAX_FILE_BYTES).describe(`バイト数（${MAX_FILE_BYTES / 1024 / 1024}MB まで）`),
    sha256: Sha256Hex.describe('中身の sha256（16進）'),
  })
  .strict()
export type UploadIn = z.infer<typeof UploadIn>

export const UploadOut = z.object({
  uploadId: UploadId,
  method: z.literal('PUT'),
  url: z.string().describe('ここに中身をそのまま PUT する（Authorization は付けない）'),
  headers: z.record(z.string(), z.string()).describe('PUT に必ず付けるヘッダー（content-type と x-amz-checksum-sha256）。Content-Length は申告した大きさ'),
  expiresAt: z.string().describe(`url の期限（${UPLOAD_URL_SECONDS / 60} 分）。上げたものは ${UPLOAD_KEEP_DAYS} 日のうちに発言で指さないと消える`),
})
export type UploadOut = z.infer<typeof UploadOut>

/** サーバーが持つ、上げる予定の控え（uploads/<書き手>/<uploadId>.json） */
export const UploadRecord = UploadIn.extend({ uploadId: UploadId, room: z.string(), createdAt: z.string() }).strip()
export type UploadRecord = z.infer<typeof UploadRecord>

/** 発言に付いている添付（中身は GET /v1/rooms/{room}/files/{fileId} で取り出す URL をもらう） */
export const Attachment = z.object({
  fileId: FileId,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int().describe('バイト数'),
  sha256: z.string().describe('中身の sha256（16進）。取り出したあとに照合する'),
})
export type Attachment = z.infer<typeof Attachment>

/** GET /v1/rooms/{room}/files/{fileId} */
export const FileLink = z.object({
  fileId: FileId,
  name: z.string(),
  contentType: z.string(),
  size: z.number().int(),
  url: z.string().describe('ここから中身を GET する（Authorization は付けない）'),
  expiresAt: z.string().describe(`url の期限（${DOWNLOAD_URL_SECONDS / 60} 分）`),
})
export type FileLink = z.infer<typeof FileLink>

/** POST /v1/rooms/{room}/messages の body。書き手（from）は名乗らせない（キーで決まる） */
export const MessageIn = z
  .object({
    text: z
      .string()
      .min(1)
      .refine((s) => utf8Bytes(s) <= MAX_TEXT_BYTES, { message: `本文は ${MAX_TEXT_BYTES / 1024}KB（UTF-8）までです。分けて送ってください` })
      .describe(`本文（markdown）。${MAX_TEXT_BYTES / 1024}KB（UTF-8）まで`),
    subject: z.string().min(1).max(200).optional().describe('見出し（任意）'),
    replyTo: MessageId.optional().describe('どの発言への返事か（同じ部屋の発言の id）'),
    meta: z
      .record(z.string().max(64), MetaValue)
      .refine((m) => utf8Bytes(JSON.stringify(m)) <= MAX_META_BYTES, { message: `meta は ${MAX_META_BYTES / 1024}KB までです` })
      .optional()
      .describe('自由な付けたし（どのモデルが書いたか など）。値は文字・数・真偽・null だけ'),
    attachments: z
      .array(z.object({ uploadId: UploadId }).strict())
      .min(1)
      .max(MAX_ATTACHMENTS)
      .refine((a) => new Set(a.map((x) => x.uploadId)).size === a.length, { message: '同じ uploadId が2回入っています' })
      .optional()
      .describe(`添付（${MAX_ATTACHMENTS} 個まで）。POST uploads で受け取り、url に PUT し終えた uploadId を並べる`),
  })
  .strict()
export type MessageIn = z.infer<typeof MessageIn>

/** S3 に置く発言そのもの */
export const Message = z.object({
  id: MessageId,
  room: RoomId,
  from: PrincipalName,
  subject: z.string().optional(),
  text: z.string(),
  replyTo: MessageId.optional(),
  meta: z.record(z.string(), MetaValue).optional(),
  attachments: z.array(Attachment).optional(),
  createdAt: z.string().describe('置いた時刻（日本時間の ISO 8601）'),
})
export type Message = z.infer<typeof Message>

/** 返すときの形。head は本文の1行目。一覧で head=true なら text を省く */
export const MessageOut = Message.extend({
  head: z.string().describe('本文の1行目（120字まで）'),
  text: z.string().optional(),
})
export type MessageOut = z.infer<typeof MessageOut>

export const MessageList = z.object({
  messages: z.array(MessageOut),
  next: MessageId.nullable().describe('続きがあれば、次に after に渡す id。null なら最後まで読んだ'),
})
export type MessageList = z.infer<typeof MessageList>

/** POST /v1/rooms/{room}/read。ここまで読んだ（書き手ごとにサーバーが持つ。後ろには戻らない） */
export const ReadIn = z.object({ upTo: MessageId.describe('読み終えた最後の発言の id') }).strict()
export type ReadIn = z.infer<typeof ReadIn>

export const ReadMark = z.object({
  upTo: MessageId.nullable().describe('どこまで読んだか。null ならまだ1通も読んでいない'),
  updatedAt: z.string().nullable(),
})
export type ReadMark = z.infer<typeof ReadMark>

/** 未読の発言の見出し（本文は GET messages で読む） */
export const UnreadHead = z.object({
  id: MessageId,
  from: PrincipalName,
  subject: z.string().optional(),
  head: z.string(),
  createdAt: z.string(),
})

export const INBOX_SCAN = 200
export const INBOX_HEADS = 10

/** GET /v1/inbox の1部屋 */
export const InboxRoom = z.object({
  id: RoomId,
  title: z.string(),
  role: Role,
  archived: z.boolean(),
  readUpTo: MessageId.nullable().describe('この書き手がどこまで読んだか。続きは GET messages?after=<これ> で読む'),
  unread: z.number().int().describe(`未読の数（自分の発言は数えない）。${INBOX_SCAN} 通まで数える`),
  unreadCapped: z.boolean().describe(`true なら ${INBOX_SCAN} 通より多い`),
  heads: z.array(UnreadHead).describe(`古い順に ${INBOX_HEADS} 通まで`),
})
export type InboxRoom = z.infer<typeof InboxRoom>

export const Inbox = z.object({ rooms: z.array(InboxRoom).describe('入っている部屋（id の順）。未読の無い部屋も含む') })
export type Inbox = z.infer<typeof Inbox>
