/**
 * 部屋と発言の読み書き（設計 3〜4節）。
 *
 * - 部屋に入っていない書き手には、部屋が「無い」と同じ 404 を返す（どんな部屋があるかを漏らさない）
 * - 発言は1通1オブジェクトで、id（m_ ＋ ULID）の順がそのまま時刻の順。一覧は S3 の StartAfter で続きを読む
 * - 再送は Idempotency-Key で弾く。先に idem/ に「この id で置く」を書いてから発言を書くので、
 *   途中で落ちても、同じキーで送り直せば同じ id の発言になる
 * - 添付の中身は関数を通らない。書き手は POST uploads で署名付き URL をもらって `uploads/<書き手>/<uploadId>` に直接上げ、
 *   発言を置くときに関数が S3 の中で `rooms/<room>/files/<fileId>` にコピーする。fileId は発言の id から決まるので、
 *   送り直しても二重にできない。使われなかった uploads/ はバケットの lifecycle で消える（部屋の中身は消さない）
 * - 部屋・参加者・既読・部屋ごとの最新は DynamoDB（roomdb.ts。設計 12節）。発言・添付・資料は S3（store.ts）
 * - 既読は書き手ごとに席の行が持つ。後ろには戻らない。自分の発言は未読に数えない
 * - **発言は、見出しの last（書き手ごとの最新）を先に進めてから S3 に置く。** 受信箱は、自分以外の last が既読より後の部屋だけ
 *   S3 を読む。逆の順だと、発言は置けたのに last を書けなかったとき、受信箱がその発言を見落とす（この順なら余分に読むだけ）
 * - 部屋を作れるのは muse だけ（2026-11-02・本人）。参加者は muse・opus・human で決まっていて選ばせない。
 *   直せるのは自分が作った部屋（createdBy）だけで、参加者は変えられず、資料は足すだけ（もうある資料の直せる人は変えられない）
 */
import {
  CREATED_ROOM_MEMBERS,
  DOWNLOAD_URL_SECONDS,
  INBOX_HEADS,
  INBOX_SCAN,
  MAX_CREATED_ROOMS,
  Message,
  MessageId,
  ROOM_CREATOR,
  Room,
  UPLOAD_URL_SECONDS,
  UploadRecord,
  type Attachment,
  type FileLink,
  type Inbox,
  type InboxRoom,
  type MessageIn,
  type MessageList,
  type MessageOut,
  type ReadMark,
  type Role,
  type RoomIn,
  type RoomPatch,
  type RoomSummary,
  type UploadIn,
  type UploadOut,
} from '@yaritori/schema'
import { createHash, randomBytes } from 'node:crypto'
import { ApiError } from './http'
import type { RoomDb, RoomHead, RoomReader, Seat } from './roomdb'
import type { Store } from './store'

const messagePrefix = (room: string) => `rooms/${room}/messages/`
const messageKey = (room: string, id: string) => `${messagePrefix(room)}${id}.json`
export const fileKey = (room: string, fileId: string) => `rooms/${room}/files/${fileId}`
const uploadKey = (principal: string, uploadId: string) => `uploads/${principal}/${uploadId}`
const uploadRecordKey = (principal: string, uploadId: string) => `${uploadKey(principal, uploadId)}.json`
const idemKey = (principal: string, room: string, key: string) =>
  `idem/${principal}/${createHash('sha256').update(`${room}\n${key}`).digest('hex')}.json`

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID（時刻 48 ビット＋ランダム 80 ビットを Crockford の base32 で 26 字） */
export function ulid(now = Date.now()): string {
  let time = ''
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time
  // 256 は 32 で割り切れるので、b % 32 は偏らない
  const rand = [...randomBytes(16)].map((b) => CROCKFORD[b % 32]).join('')
  return time + rand
}

/** 日本時間の ISO 8601（秒まで） */
export function jst(ms = Date.now()): string {
  return new Date(ms + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00'
}

/** 本文の1行目（空行を飛ばし、120字まで） */
export function headLine(text: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return [...line].length > 120 ? [...line].slice(0, 119).join('') + '…' : line
}

const view = (m: Message, headOnly = false): MessageOut => {
  const out: MessageOut = { ...m, head: headLine(m.text) }
  if (headOnly) delete out.text
  return out
}

export async function readRoom(rooms: RoomReader, id: string): Promise<Room | null> {
  return (await rooms.get(id))?.room ?? null
}

const notFound = (id: string) => new ApiError(404, 'room_not_found', `部屋 ${id} が無いか、入っていません。入れる部屋は GET /v1/rooms で見られます`)

/** 部屋と、その書き手の役目。入っていなければ 404（参加者は部屋の行の members を強い読みで見る） */
export async function roomFor(rooms: RoomDb, id: string, principal: string): Promise<{ room: Room; role: Role }> {
  const room = await readRoom(rooms, id)
  const role = room?.members[principal]
  if (!room || !role) throw notFound(id)
  return { room, role }
}

/** 全部の部屋（id の順）。読む画面（Viewer）と、muse が作った部屋の数 */
export async function allRooms(rooms: RoomReader): Promise<Room[]> {
  return (await rooms.all()).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * 書き手の席と、その部屋の見出し（id の順）。見出しが無い部屋（あるはずだが）は部屋の行から作り、last を持たない
 * （受信箱はその部屋を S3 で数える）。部屋の行も無い席は飛ばす
 */
async function seatsWithHeads(rooms: RoomDb, principal: string): Promise<{ seat: Seat; head: Omit<RoomHead, 'last'> & { last?: RoomHead['last'] } }[]> {
  const seats = await rooms.seats(principal)
  const heads = await rooms.heads(seats.map((s) => s.room))
  const out = await Promise.all(seats.map(async (seat) => {
    const head = heads.get(seat.room)
    if (head) return { seat, head }
    const room = await readRoom(rooms, seat.room)
    return room ? { seat, head: { id: room.id, title: room.title, about: room.about, archived: room.archived } } : null
  }))
  return out.filter((x) => x !== null).sort((a, b) => a.seat.room.localeCompare(b.seat.room))
}

export async function listRooms(rooms: RoomDb, principal: string): Promise<RoomSummary[]> {
  return (await seatsWithHeads(rooms, principal)).map(({ seat, head }) => ({
    id: head.id,
    title: head.title,
    about: head.about,
    archived: head.archived,
    role: seat.role,
  }))
}

/** 足す資料の editors が部屋の書き手か、もうある資料と重ならないか */
function checkNewDocs(room: Room, docs: RoomIn['docs']) {
  for (const [docId, meta] of Object.entries(docs ?? {})) {
    if (room.docs[docId]) {
      throw new ApiError(409, 'doc_exists', `部屋 ${room.id} に資料 ${docId} はもうあります。名前や直せる人を変えるのは本人（手元の CLI）に頼んでください。新しい資料なら別の docId で`)
    }
    const outside = meta.editors.filter((e) => !room.members[e])
    if (outside.length) {
      throw new ApiError(400, 'bad_editor', `資料 ${docId} の editors にいる ${outside.join('・')} は部屋に入っていません。入れられるのは ${Object.keys(room.members).join('・')} だけです`)
    }
  }
}

/** 部屋を作る（muse だけ）。もうある id には作れない（上書きしない） */
export async function createRoom(rooms: RoomDb, principal: string, input: RoomIn): Promise<Room> {
  if (principal !== ROOM_CREATOR) {
    throw new ApiError(403, 'cannot_create_room', `部屋を作れるのは ${ROOM_CREATOR} だけです。部屋が要るときは本人に頼んでください`)
  }
  const made = (await rooms.all()).filter((r) => r.createdBy === principal).length
  if (made >= MAX_CREATED_ROOMS) {
    throw new ApiError(403, 'too_many_rooms', `API で作れる部屋は ${MAX_CREATED_ROOMS} までです（閉じた部屋も数えます）。もっと要るときは本人に頼んでください`)
  }
  const now = jst()
  const empty = Room.parse({
    id: input.id,
    title: input.title,
    about: input.about ?? '',
    rules: input.rules ?? '',
    members: CREATED_ROOM_MEMBERS,
    createdBy: principal,
    createdAt: now,
    updatedAt: now,
  })
  checkNewDocs(empty, input.docs)
  const room: Room = { ...empty, docs: input.docs ?? {} }
  if (!(await rooms.create(room))) {
    throw new ApiError(409, 'room_exists', `部屋 ${room.id} はもうあります。別の id にしてください`)
  }
  return room
}

/** 自分が作った部屋を直す。送った項目だけ変わる。資料は足すだけ。CLI と同時に直しても上書きしない（読み直して当て直す） */
export async function patchRoom(rooms: RoomDb, id: string, principal: string, patch: RoomPatch): Promise<{ room: Room; role: Role }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await rooms.get(id)
    const before = cur?.room
    const role = before?.members[principal]
    if (!cur || !before || !role) throw notFound(id)
    if (before.createdBy !== principal) {
      throw new ApiError(403, 'not_room_owner', `部屋 ${id} は API で直せません。直せるのは自分が API で作った部屋だけです。直したいところは発言で本人に伝えてください`)
    }
    checkNewDocs(before, patch.docs)
    const room = Room.parse({
      ...before,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.about !== undefined && { about: patch.about }),
      ...(patch.rules !== undefined && { rules: patch.rules }),
      ...(patch.archived !== undefined && { archived: patch.archived }),
      docs: { ...before.docs, ...patch.docs },
      updatedAt: jst(),
    })
    if (await rooms.replace(room, cur)) return { room, role }
  }
  throw new ApiError(409, 'room_conflict', `部屋 ${id} がちょうど直されているところでした。少し待ってからもう一度送ってください`)
}

export async function listMessages(
  store: Store,
  room: string,
  q: { after?: string; limit: number; from?: string; head?: boolean },
): Promise<MessageList> {
  const out: MessageOut[] = []
  let startAfter = q.after ? messageKey(room, q.after) : undefined
  let more = true
  while (out.length < q.limit && more) {
    // 書き手で絞るときは読んでみないと分からないので、多めに読む
    const page = await store.list(messagePrefix(room), { startAfter, max: q.from ? 100 : q.limit - out.length })
    more = page.truncated
    if (!page.keys.length) break
    const docs = await Promise.all(page.keys.map((k) => store.get(k)))
    for (const [i, doc] of docs.entries()) {
      startAfter = page.keys[i]
      const m = Message.parse(doc)
      if (q.from && m.from !== q.from) continue
      out.push(view(m, q.head))
      if (out.length === q.limit) {
        more ||= i < page.keys.length - 1
        break
      }
    }
  }
  return { messages: out, next: out.length === q.limit && more ? out.at(-1)!.id : null }
}

export async function getMessage(store: Store, room: string, id: string): Promise<MessageOut> {
  const doc = await store.get(messageKey(room, id))
  if (doc === null) throw new ApiError(404, 'message_not_found', `部屋 ${room} に発言 ${id} はありません`)
  return view(Message.parse(doc))
}

export async function postMessage(
  store: Store,
  rooms: RoomDb,
  room: Room,
  principal: string,
  input: MessageIn,
  idempotencyKey?: string,
  now = Date.now,
): Promise<{ message: MessageOut; replayed: boolean }> {
  if (input.replyTo && (await store.get(messageKey(room.id, input.replyTo))) === null) {
    throw new ApiError(400, 'bad_reply_to', `replyTo の ${input.replyTo} はこの部屋にありません。同じ部屋の発言の id を入れてください`)
  }
  const key = idempotencyKey ? idemKey(principal, room.id, idempotencyKey) : null
  const bodyHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  let id = `m_${ulid(now())}`

  /** 前の回がある。同じ本文で発言まで書けていればそれを返し、書けていなければ同じ id を引き継ぐ */
  const resume = async (prev: { id: string; bodyHash: string }) => {
    if (prev.bodyHash !== bodyHash) {
      throw new ApiError(409, 'idempotency_conflict', '同じ Idempotency-Key で違う本文が送られました。新しい本文なら新しいキーで送ってください')
    }
    const existing = await store.get(messageKey(room.id, prev.id))
    if (existing !== null) return { message: view(Message.parse(existing)), replayed: true }
    id = MessageId.parse(prev.id)
    return null
  }
  // 送り直しなら、上げたもの（uploads/）が消えたあとでも前の発言を返せるように、確かめる前に見る
  const prev = key ? ((await store.get(key)) as { id: string; bodyHash: string } | null) : null
  if (prev) {
    const done = await resume(prev)
    if (done) return done
  }
  const uploads = await checkUploads(store, room.id, principal, input)
  // 確かめ終えてから idem/ に「この id で置く」を書く（弾いた本文で id を取らない）
  if (key && !prev && !(await store.putIfAbsent(key, { room: room.id, id, bodyHash }))) {
    const done = await resume((await store.get(key)) as { id: string; bodyHash: string })
    if (done) return done
  }

  // 添付を先にコピーする（発言が指す先を先に用意する）。もうあれば、前の回がコピーした同じ中身
  const attachments: Attachment[] = []
  for (const [i, u] of uploads.entries()) {
    const fileId = `f_${id.slice(2)}-${i}`
    if (!(await store.head(fileKey(room.id, fileId)))) {
      await store.copy(uploadKey(principal, u.uploadId), fileKey(room.id, fileId), { contentType: u.contentType, name: u.name })
    }
    attachments.push({ fileId, name: u.name, contentType: u.contentType, size: u.size, sha256: u.sha256 })
  }
  const message: Message = {
    id,
    room: room.id,
    from: principal,
    ...(input.subject && { subject: input.subject }),
    text: input.text,
    ...(input.replyTo && { replyTo: input.replyTo }),
    ...(input.meta && { meta: input.meta }),
    ...(attachments.length && { attachments }),
    createdAt: jst(now()),
  }
  // 受信箱が見落とさないよう、last を先に進める（送り直しで同じ id なら、もう進んでいる）
  await rooms.bumpLast(room.id, principal, id)
  if (!(await store.putIfAbsent(messageKey(room.id, id), message))) {
    // 同じキーの送り直しが同時に書いた
    return { message: view(Message.parse(await store.get(messageKey(room.id, id)))), replayed: true }
  }
  return { message: view(message), replayed: false }
}

/** 上げる場所を用意する。申告（大きさ・sha256・Content-Type）は署名に入るので、違う中身は S3 が断る */
export async function createUpload(store: Store, room: Room, principal: string, input: UploadIn, now = Date.now): Promise<UploadOut> {
  const uploadId = `u_${ulid(now())}`
  const record: UploadRecord = { ...input, uploadId, room: room.id, createdAt: jst(now()) }
  await store.putIfAbsent(uploadRecordKey(principal, uploadId), record)
  const slot = await store.presignPut(uploadKey(principal, uploadId), input, UPLOAD_URL_SECONDS)
  return { uploadId, method: 'PUT', url: slot.url, headers: slot.headers, expiresAt: jst(now() + UPLOAD_URL_SECONDS * 1000) }
}

/** 発言の attachments の uploadId を、控えと S3 の様子で確かめる（自分が上げたもの・同じ部屋・上がっている・申告どおり） */
async function checkUploads(store: Store, room: string, principal: string, input: MessageIn): Promise<UploadRecord[]> {
  return Promise.all((input.attachments ?? []).map(async ({ uploadId }, i) => {
    const doc = await store.get(uploadRecordKey(principal, uploadId))
    if (doc === null) {
      throw new ApiError(400, 'bad_upload', `attachments[${i}] の ${uploadId} はありません。POST uploads で受け取った id を入れてください（使わずに 2 日たつと消えます）`)
    }
    const u = UploadRecord.parse(doc)
    if (u.room !== room) throw new ApiError(400, 'bad_upload', `attachments[${i}] の ${uploadId} は部屋 ${u.room} 用です。この部屋で POST uploads からやり直してください`)
    const obj = await store.head(uploadKey(principal, uploadId))
    if (!obj) throw new ApiError(400, 'upload_missing', `attachments[${i}]（${u.name}）はまだ上がっていません。受け取った url に、headers を付けて PUT してから置いてください`)
    if (obj.size !== u.size || obj.sha256 !== u.sha256) {
      throw new ApiError(400, 'upload_mismatch', `attachments[${i}]（${u.name}）の中身が申告と合いません。POST uploads からやり直してください`)
    }
    return u
  }))
}

/** 取り出す URL を渡す（中身は関数を通らない） */
export async function fileLink(store: Store, room: string, fileId: string, now = Date.now): Promise<FileLink> {
  const info = await store.head(fileKey(room, fileId))
  if (!info) throw new ApiError(404, 'file_not_found', `部屋 ${room} に添付 ${fileId} はありません`)
  const name = info.name ?? fileId
  return {
    fileId,
    name,
    contentType: info.contentType,
    size: info.size,
    url: await store.presignGet(fileKey(room, fileId), { name }, DOWNLOAD_URL_SECONDS),
    expiresAt: jst(now() + DOWNLOAD_URL_SECONDS * 1000),
  }
}

/** ここまで読んだ。いまの印より前なら動かさない（後ろには戻らない） */
export async function markRead(store: Store, rooms: RoomDb, room: string, principal: string, upTo: string): Promise<ReadMark> {
  if ((await store.get(messageKey(room, upTo))) === null) {
    throw new ApiError(400, 'bad_up_to', `upTo の ${upTo} はこの部屋にありません。読んだ発言の id を入れてください`)
  }
  const mark = await rooms.markRead(room, principal, upTo, jst())
  // 部屋の members にいるのに席が無い。黙って既読を捨てない
  if (!mark) throw new Error(`部屋 ${room} に ${principal} の席がありません`)
  return mark
}

/**
 * 入っている部屋ごとの未読。自分以外の書き手の last が既読の印より後の部屋だけ、印より後の発言を INBOX_SCAN 通まで S3 で読み、
 * 自分の発言を除いて数える。新しい発言が無い部屋は S3 を読まない（Muse が1分おきに見に来る。設計 12節）
 */
export async function inbox(store: Store, rooms: RoomDb, principal: string): Promise<Inbox> {
  const seats = await seatsWithHeads(rooms, principal)
  return {
    rooms: await Promise.all(seats.map(async ({ seat, head }): Promise<InboxRoom> => {
      const room = { id: head.id, title: head.title, role: seat.role, archived: head.archived, readUpTo: seat.readUpTo }
      const fresh = !head.last || Object.entries(head.last).some(([who, id]) => who !== principal && (!seat.readUpTo || id > seat.readUpTo))
      if (!fresh) return { ...room, unread: 0, unreadCapped: false, heads: [] }
      const page = await store.list(messagePrefix(head.id), {
        startAfter: seat.readUpTo ? messageKey(head.id, seat.readUpTo) : undefined,
        max: INBOX_SCAN,
      })
      const unread = (await Promise.all(page.keys.map((k) => store.get(k))))
        .map((d) => Message.parse(d))
        .filter((m) => m.from !== principal)
      return {
        ...room,
        unread: unread.length,
        unreadCapped: page.truncated,
        heads: unread.slice(0, INBOX_HEADS).map((m) => ({
          id: m.id,
          from: m.from,
          ...(m.subject && { subject: m.subject }),
          head: headLine(m.text),
          createdAt: m.createdAt,
        })),
      }
    })),
  }
}
