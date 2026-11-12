/**
 * 部屋の出し入れ（admin room。設計 1節・5節・12節）。AWS の認証で DynamoDB の表（Rooms）を直接書く。
 * 書き方は API と同じ（packages/api/src/roomdb.ts）。作るときは「無ければ」、直すときは「読んだ版（ver）のままなら」で書くので、
 * 取り違えて上書きしない。参加者を変えると、受信箱が引く席の行も同じトランザクションで足す・消す（外した書き手の既読も消える）。
 * API でも muse だけは部屋を作れ、自分が作った部屋（createdBy）を直せる。ここからはどの部屋も直せ、createdBy はそのまま残る。
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm'
import { dynamoRoomDb, type RoomDb, type VersionedRoom } from '@yaritori/api/roomdb'
import { DocMeta, KEYS_PARAM, Role, Room } from '@yaritori/schema'
import { readFileSync } from 'node:fs'
import { roomsTable, userPath } from './config'

const region = process.env.AWS_REGION ?? 'ap-northeast-1'
let db: RoomDb | undefined
export const roomDb = () => (db ??= dynamoRoomDb(roomsTable(), new DynamoDBClient({ region })))
export const jst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + '+09:00'

export type RoomEdit = {
  title?: string
  about?: string
  rulesFile?: string
  members?: string[] // name=role
  removeMembers?: string[]
  archived?: boolean
}

function parseMembers(list: string[] = []): Record<string, Role> {
  return Object.fromEntries(list.map((s) => {
    const [name, role] = s.split('=')
    return [name, Role.parse(role)]
  }))
}

const read = (id: string): Promise<VersionedRoom | null> => roomDb().get(id)

/** 読んだ版のままなら書く。先を越されていれば止める */
async function replace(room: Room, cur: VersionedRoom) {
  if (!(await roomDb().replace(room, cur))) throw new Error(`部屋 ${room.id} は読んだあとに誰かが直しました。もう一度やり直してください`)
}

/** キーの無い書き手を部屋に入れたら知らせる（入れること自体は止めない。キーは後から作れる） */
async function warnKeyless(room: Room) {
  try {
    const res = await new SSMClient({ region }).send(new GetParameterCommand({ Name: KEYS_PARAM, WithDecryption: true }))
    const have = new Set(Object.keys(JSON.parse(res.Parameter?.Value ?? '{}')))
    const missing = Object.keys(room.members).filter((m) => !have.has(m))
    if (missing.length) console.error(`（キーがまだ無い書き手: ${missing.join('・')}。admin key rotate で作る）`)
  } catch {}
}

function show(room: Room) {
  console.log(JSON.stringify(room, null, 2))
}

export async function roomCreate(id: string, title: string, edit: RoomEdit) {
  const now = jst()
  const room = Room.parse({
    id,
    title,
    about: edit.about ?? '',
    rules: edit.rulesFile ? readFileSync(userPath(edit.rulesFile), 'utf8') : '',
    members: parseMembers(edit.members),
    createdAt: now,
    updatedAt: now,
  })
  if (!(await roomDb().create(room))) throw new Error(`部屋 ${id} はもうあります。直すなら admin room edit`)
  show(room)
  console.error(`部屋 ${id} を作りました。`)
  await warnKeyless(room)
}

export async function roomEdit(id: string, edit: RoomEdit) {
  const cur = await read(id)
  if (!cur) throw new Error(`部屋 ${id} はありません`)
  const members = { ...cur.room.members, ...parseMembers(edit.members) }
  for (const m of edit.removeMembers ?? []) delete members[m]
  const room = Room.parse({
    ...cur.room,
    ...(edit.title !== undefined && { title: edit.title }),
    ...(edit.about !== undefined && { about: edit.about }),
    ...(edit.rulesFile !== undefined && { rules: readFileSync(userPath(edit.rulesFile), 'utf8') }),
    ...(edit.archived !== undefined && { archived: edit.archived }),
    members,
    updatedAt: jst(),
  })
  await replace(room, cur)
  show(room)
  console.error(`部屋 ${id} を直しました。`)
  await warnKeyless(room)
}

export async function roomShow(id: string) {
  const cur = await read(id)
  if (!cur) throw new Error(`部屋 ${id} はありません`)
  show(cur.room)
}

export async function roomList() {
  const rooms = (await roomDb().all()).sort((a, b) => a.id.localeCompare(b.id))
  if (!rooms.length) return console.log('（まだ部屋はありません）')
  for (const r of rooms) {
    console.log(`${r.id}\t${r.archived ? '閉じた\t' : ''}${r.createdBy ? `${r.createdBy} が作った\t` : ''}${r.title}\t${Object.entries(r.members).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  }
}

/** 資料を部屋に足す・直せる人を替える・外す（外しても版は S3 に残る。API からは見えなくなる） */
export async function roomDoc(id: string, docId: string, o: { title?: string; editors?: string[]; remove?: boolean }) {
  const cur = await read(id)
  if (!cur) throw new Error(`部屋 ${id} はありません`)
  const docs = { ...cur.room.docs }
  if (o.remove) {
    if (!docs[docId]) throw new Error(`部屋 ${id} に資料 ${docId} はありません`)
    delete docs[docId]
  } else {
    const title = o.title ?? docs[docId]?.title
    if (!title) throw new Error(`資料 ${docId} を新しく足すときは --title が要ります`)
    docs[docId] = DocMeta.parse({ title, editors: o.editors ?? docs[docId]?.editors ?? [] })
    const outside = docs[docId].editors.filter((e) => !(e in cur.room.members))
    if (outside.length) console.error(`（部屋に入っていない書き手が editors にいます: ${outside.join('・')}。直せるのは部屋に入ってから）`)
  }
  const room = Room.parse({ ...cur.room, docs, updatedAt: jst() })
  await replace(room, cur)
  console.log(JSON.stringify(room.docs, null, 2))
  console.error(o.remove ? `資料 ${docId} を部屋 ${id} から外しました（版は残っています）。` : `資料 ${docId} を部屋 ${id} に置きました。`)
}
