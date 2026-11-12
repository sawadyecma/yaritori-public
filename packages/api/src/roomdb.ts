/**
 * 部屋・参加者・既読・部屋ごとの最新（DynamoDB の表 Rooms。設計 12節）。
 * 発言・添付・資料は S3（store.ts）のまま。API・読む画面・手元の CLI（admin room・admin migrate）がこの1か所を使う。
 *
 * 行は3つ（キーは pk・sk）:
 * - 部屋 `ROOM#<room>` / `META`：room.json と同じ項目と、取り合い用の ver。gsi1（`ROOMS` / `<room>`）で全部の部屋を引く
 * - 見出し `ROOM#<room>` / `HEAD`：title・about・archived と last（書き手 → その書き手の最新の発言 id）。受信箱が読む小さい行
 * - 席 `WRITER#<書き手>` / `ROOM#<room>`：role・readUpTo・readAt。受信箱と既読
 *
 * - **参加者の正本は部屋の行の members。** 見出しと席は写しで、部屋の行と同じトランザクションでしか書かない（作る・直す）
 * - 部屋の行は、ver が読んだときのままなら書く（S3 の If-Match の代わり）
 * - last と既読は後ろに戻さない（条件つきで書く）。既読は席が無ければ書かない（外された書き手の既読が席を作り直さない）
 * - 値の変換（marshall）は手で書く。Lambda のランタイムに必ずあるのは client-dynamodb なので、lib-dynamodb に頼らない
 */
import {
  BatchGetItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type AttributeValue,
  type BatchGetItemCommandOutput,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb'
import { Room, type ReadMark, type Role } from '@yaritori/schema'

export type VersionedRoom = { room: Room; ver: number }
/** 書き手が入っている部屋と、どこまで読んだか */
export type Seat = { room: string; role: Role; readUpTo: string | null; readAt: string | null }
/** 受信箱が読む見出し。last は書き手ごとの最新の発言 id */
export type RoomHead = { id: string; title: string; about: string; archived: boolean; last: Record<string, string> }

export interface RoomDb {
  /** 部屋（強い読み）。無ければ null */
  get(id: string): Promise<VersionedRoom | null>
  /** 全部の部屋（gsi1。並びは呼ぶ側で決める） */
  all(): Promise<Room[]>
  /** 書き手の席（強い読み） */
  seats(principal: string): Promise<Seat[]>
  /** 見出し（結果整合。1秒ほど古いことがある）。無い部屋は入らない */
  heads(ids: string[]): Promise<Map<string, RoomHead>>
  /** 部屋・見出し・席を一度に作る。もうあれば false */
  create(room: Room): Promise<boolean>
  /** 読んだ版（prev.ver）のままなら書き換える。見出しと席も members に合わせる。先を越されていれば false */
  replace(next: Room, prev: VersionedRoom): Promise<boolean>
  /** 書き手の最新の発言を進める（後ろには戻さない）。発言を S3 に置く前に呼ぶ */
  bumpLast(room: string, principal: string, messageId: string): Promise<void>
  /** 既読を進めて、いまの印を返す（後ろには戻さない）。席が無ければ null */
  markRead(room: string, principal: string, upTo: string, at: string): Promise<ReadMark | null>
  /** いまの既読の印。席が無ければ null */
  readMark(room: string, principal: string): Promise<ReadMark | null>
}

/** 読む画面に渡すのは読む口だけ */
export type RoomReader = Pick<RoomDb, 'get' | 'all'>

const headOf = (room: Room) => ({ title: room.title, about: room.about, archived: room.archived })

// ── DynamoDB ──

const metaKey = (id: string) => ({ pk: `ROOM#${id}`, sk: 'META' })
const headKey = (id: string) => ({ pk: `ROOM#${id}`, sk: 'HEAD' })
const seatKey = (id: string, principal: string) => ({ pk: `WRITER#${principal}`, sk: `ROOM#${id}` })
/** 全部の部屋の一覧（gsi1）で、部屋の行だけが持つ値 */
const ALL_ROOMS = 'ROOMS'

function toAV(v: unknown): AttributeValue {
  if (typeof v === 'string') return { S: v }
  if (typeof v === 'number') return { N: String(v) }
  if (typeof v === 'boolean') return { BOOL: v }
  if (v === null) return { NULL: true }
  if (Array.isArray(v)) return { L: v.map(toAV) }
  if (typeof v === 'object') return { M: toItem(v as Record<string, unknown>) }
  throw new Error(`DynamoDB に書けない値です（${typeof v}）`)
}
/** undefined の項目は書かない（createdBy の無い部屋など） */
const toItem = (o: Record<string, unknown>): Record<string, AttributeValue> =>
  Object.fromEntries(Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [[k, toAV(v)]])))

function fromAV(a: AttributeValue): unknown {
  if (a.S !== undefined) return a.S
  if (a.N !== undefined) return Number(a.N)
  if (a.BOOL !== undefined) return a.BOOL
  if (a.NULL !== undefined) return null
  if (a.L !== undefined) return a.L.map(fromAV)
  if (a.M !== undefined) return fromItem(a.M)
  throw new Error('DynamoDB から読めない値です')
}
const fromItem = (i: Record<string, AttributeValue>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(i).map(([k, v]) => [k, fromAV(v)]))

const toSeat = (i: Record<string, unknown>): Seat => ({
  room: i.room as string,
  role: i.role as Role,
  readUpTo: (i.readUpTo as string | undefined) ?? null,
  readAt: (i.readAt as string | undefined) ?? null,
})
const toHead = (i: Record<string, unknown>): RoomHead => ({
  id: (i.pk as string).slice('ROOM#'.length),
  title: i.title as string,
  about: i.about as string,
  archived: i.archived as boolean,
  last: (i.last as Record<string, string> | undefined) ?? {},
})

/** トランザクションが条件か取り合いで断られた（どちらも「先を越された」） */
const lostRace = (e: unknown) =>
  e instanceof Error &&
  e.name === 'TransactionCanceledException' &&
  ((e as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed' || r.Code === 'TransactionConflict')
const conditionFailed = (e: unknown) => e instanceof Error && e.name === 'ConditionalCheckFailedException'

export function dynamoRoomDb(table: string, db = new DynamoDBClient({})): RoomDb {
  const metaItem = (room: Room, ver: number) => toItem({ ...metaKey(room.id), gsi1pk: ALL_ROOMS, gsi1sk: room.id, ver, ...room })

  /** 見出しの title・about・archived を部屋に合わせる（last には触らない。無ければ空で作る） */
  const headUpdate = (room: Room): TransactWriteItem => ({
    Update: {
      TableName: table,
      Key: toItem(headKey(room.id)),
      UpdateExpression: 'SET #title = :title, #about = :about, #archived = :archived, #last = if_not_exists(#last, :empty)',
      ExpressionAttributeNames: { '#title': 'title', '#about': 'about', '#archived': 'archived', '#last': 'last' },
      ExpressionAttributeValues: toItem({ ':title': room.title, ':about': room.about, ':archived': room.archived, ':empty': {} }),
    },
  })
  /** 席の役目を合わせる（既読はそのまま。無ければ作る） */
  const seatUpdate = (room: string, principal: string, role: Role): TransactWriteItem => ({
    Update: {
      TableName: table,
      Key: toItem(seatKey(room, principal)),
      UpdateExpression: 'SET #room = :room, #role = :role',
      ExpressionAttributeNames: { '#room': 'room', '#role': 'role' },
      ExpressionAttributeValues: toItem({ ':room': room, ':role': role }),
    },
  })

  async function query(input: ConstructorParameters<typeof QueryCommand>[0]) {
    const out: Record<string, unknown>[] = []
    let start: Record<string, AttributeValue> | undefined
    do {
      const res = await db.send(new QueryCommand({ ...input, ExclusiveStartKey: start }))
      for (const i of res.Items ?? []) out.push(fromItem(i))
      start = res.LastEvaluatedKey
    } while (start)
    return out
  }

  const self: RoomDb = {
    async get(id) {
      const res = await db.send(new GetItemCommand({ TableName: table, Key: toItem(metaKey(id)), ConsistentRead: true }))
      if (!res.Item) return null
      const item = fromItem(res.Item)
      return { room: Room.parse(item), ver: item.ver as number }
    },
    async all() {
      const items = await query({
        TableName: table,
        IndexName: 'gsi1',
        KeyConditionExpression: 'gsi1pk = :all',
        ExpressionAttributeValues: toItem({ ':all': ALL_ROOMS }),
      })
      return items.map((i) => Room.parse(i))
    },
    async seats(principal) {
      const items = await query({
        TableName: table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: toItem({ ':pk': `WRITER#${principal}` }),
        ConsistentRead: true,
      })
      return items.map(toSeat)
    },
    async heads(ids) {
      const out = new Map<string, RoomHead>()
      for (let i = 0; i < ids.length; i += 100) {
        let keys: Record<string, AttributeValue>[] | undefined = ids.slice(i, i + 100).map((id) => toItem(headKey(id)))
        // 一度に読み切れなかった分は、少し待って読み直す
        for (let attempt = 0; keys?.length; attempt++) {
          if (attempt === 5) throw new Error('部屋の見出しを読み切れませんでした（DynamoDB が混んでいます）')
          if (attempt) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt))
          const res: BatchGetItemCommandOutput = await db.send(new BatchGetItemCommand({ RequestItems: { [table]: { Keys: keys } } }))
          for (const item of res.Responses?.[table] ?? []) {
            const head = toHead(fromItem(item))
            out.set(head.id, head)
          }
          keys = res.UnprocessedKeys?.[table]?.Keys
        }
      }
      return out
    },
    async create(room) {
      try {
        await db.send(new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: table, Item: metaItem(room, 1), ConditionExpression: 'attribute_not_exists(pk)' } },
            { Put: { TableName: table, Item: toItem({ ...headKey(room.id), ...headOf(room), last: {} }) } },
            ...Object.entries(room.members).map(([p, role]) => seatUpdate(room.id, p, role)),
          ],
        }))
        return true
      } catch (e) {
        if (lostRace(e)) return false
        throw e
      }
    },
    async replace(next, prev) {
      const removed = Object.keys(prev.room.members).filter((p) => !(p in next.members))
      try {
        await db.send(new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: table,
                Item: metaItem(next, prev.ver + 1),
                ConditionExpression: '#ver = :ver',
                ExpressionAttributeNames: { '#ver': 'ver' },
                ExpressionAttributeValues: toItem({ ':ver': prev.ver }),
              },
            },
            headUpdate(next),
            ...Object.entries(next.members).map(([p, role]) => seatUpdate(next.id, p, role)),
            ...removed.map((p): TransactWriteItem => ({ Delete: { TableName: table, Key: toItem(seatKey(next.id, p)) } })),
          ],
        }))
        return true
      } catch (e) {
        if (lostRace(e)) return false
        throw e
      }
    },
    async bumpLast(room, principal, messageId) {
      try {
        // 見出しが無ければ（last が無いので）ValidationException で落ちる。黙って見落とすより、置くのを止める
        await db.send(new UpdateItemCommand({
          TableName: table,
          Key: toItem(headKey(room)),
          UpdateExpression: 'SET #last.#who = :id',
          ConditionExpression: 'attribute_not_exists(#last.#who) OR #last.#who < :id',
          ExpressionAttributeNames: { '#last': 'last', '#who': principal },
          ExpressionAttributeValues: toItem({ ':id': messageId }),
        }))
      } catch (e) {
        // もっと新しい id がもう入っている
        if (conditionFailed(e)) return
        throw e
      }
    },
    async markRead(room, principal, upTo, at) {
      try {
        await db.send(new UpdateItemCommand({
          TableName: table,
          Key: toItem(seatKey(room, principal)),
          UpdateExpression: 'SET #up = :up, #at = :at',
          ConditionExpression: 'attribute_exists(pk) AND (attribute_not_exists(#up) OR #up < :up)',
          ExpressionAttributeNames: { '#up': 'readUpTo', '#at': 'readAt' },
          ExpressionAttributeValues: toItem({ ':up': upTo, ':at': at }),
        }))
        return { upTo, updatedAt: at }
      } catch (e) {
        // 印のほうが先にある（後ろには戻さない）か、席が無い
        if (conditionFailed(e)) return self.readMark(room, principal)
        throw e
      }
    },
    async readMark(room, principal) {
      const res = await db.send(new GetItemCommand({ TableName: table, Key: toItem(seatKey(room, principal)), ConsistentRead: true }))
      if (!res.Item) return null
      const seat = toSeat(fromItem(res.Item))
      return { upTo: seat.readUpTo, updatedAt: seat.readAt }
    },
  }
  return self
}

// ── テスト用（DynamoDB の条件を真似る） ──

/** 部屋を並べて作る。room.json と同じ形で渡す（Room.parse を通す） */
export function memoryRoomDb(init: unknown[] = []) {
  const metas = new Map<string, VersionedRoom>()
  const heads = new Map<string, RoomHead>()
  const seats = new Map<string, Seat>()
  const seatId = (room: string, principal: string) => `${principal}\n${room}`
  const copy = <T>(v: T): T => structuredClone(v)
  const syncSeats = (room: Room, removed: string[] = []) => {
    for (const [p, role] of Object.entries(room.members)) {
      const cur = seats.get(seatId(room.id, p))
      seats.set(seatId(room.id, p), { room: room.id, role, readUpTo: cur?.readUpTo ?? null, readAt: cur?.readAt ?? null })
    }
    for (const p of removed) seats.delete(seatId(room.id, p))
  }

  const db = {
    /** テストが中を見るため */
    rows: { metas, heads, seats },
    async get(id: string) {
      const m = metas.get(id)
      return m ? copy(m) : null
    },
    async all() {
      return [...metas.values()].map((m) => copy(m.room))
    },
    async seats(principal: string) {
      return [...seats.entries()].filter(([k]) => k.startsWith(`${principal}\n`)).map(([, s]) => copy(s))
    },
    async heads(ids: string[]) {
      return new Map(ids.flatMap((id) => (heads.has(id) ? [[id, copy(heads.get(id)!)] as const] : [])))
    },
    async create(room: Room) {
      if (metas.has(room.id)) return false
      metas.set(room.id, { room: copy(room), ver: 1 })
      heads.set(room.id, { id: room.id, ...headOf(room), last: {} })
      syncSeats(room)
      return true
    },
    async replace(next: Room, prev: VersionedRoom) {
      const cur = metas.get(next.id)
      if (!cur || cur.ver !== prev.ver) return false
      metas.set(next.id, { room: copy(next), ver: prev.ver + 1 })
      heads.set(next.id, { id: next.id, ...headOf(next), last: heads.get(next.id)?.last ?? {} })
      syncSeats(next, Object.keys(prev.room.members).filter((p) => !(p in next.members)))
      return true
    },
    async bumpLast(room: string, principal: string, messageId: string) {
      const h = heads.get(room)
      if (!h) throw Object.assign(new Error('The document path provided in the update expression is invalid for update'), { name: 'ValidationException' })
      if (!h.last[principal] || h.last[principal] < messageId) h.last[principal] = messageId
    },
    async markRead(room: string, principal: string, upTo: string, at: string) {
      const s = seats.get(seatId(room, principal))
      if (!s) return null
      if (!s.readUpTo || s.readUpTo < upTo) Object.assign(s, { readUpTo: upTo, readAt: at })
      return { upTo: s.readUpTo, updatedAt: s.readAt }
    },
    async readMark(room: string, principal: string) {
      const s = seats.get(seatId(room, principal))
      return s ? { upTo: s.readUpTo, updatedAt: s.readAt } : null
    },
  } satisfies RoomDb & Record<string, unknown>
  for (const r of init) {
    const room = Room.parse(r)
    metas.set(room.id, { room, ver: 1 })
    heads.set(room.id, { id: room.id, ...headOf(room), last: {} })
    syncSeats(room)
  }
  return db
}
