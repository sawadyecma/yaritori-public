/**
 * 資料の読み書き（設計 3節・段3。形は packages/schema/src/docs.ts）。
 *
 * 版は `rooms/<room>/docs/<docId>/v000001.json` のように1つずつ別のオブジェクトで、putIfAbsent（無いときだけ書く）で足す。
 * 2人が同じ版から直しても、次の番号を先に取ったほうだけが書け、あとの人は 412 になる。上書きの道が無いのでロックが要らない。
 * いまの版は、その資料の接頭辞の下でいちばん後ろのキー（番号を 6 桁でそろえているので、キーの順＝版の順）。
 */
import { DocVersion, type DocHistory, type DocIn, type DocMeta, type DocSummary, type DocView, type Room } from '@yaritori/schema'
import { ApiError } from './http'
import { jst } from './rooms'
import type { Store } from './store'

const docPrefix = (room: string, docId: string) => `rooms/${room}/docs/${docId}/`
const versionKey = (room: string, docId: string, v: number) => `${docPrefix(room, docId)}v${String(v).padStart(6, '0')}.json`
const HISTORY_MAX = 50

function metaOf(room: Room, docId: string): DocMeta {
  const meta = room.docs[docId]
  if (!meta) throw new ApiError(404, 'doc_not_found', `部屋 ${room.id} に資料 ${docId} はありません。ある資料は GET /v1/rooms/${room.id}/docs で見られます`)
  return meta
}

/** 版のキーを古い順に全部 */
async function versionKeys(store: Store, room: string, docId: string): Promise<string[]> {
  const keys: string[] = []
  let startAfter: string | undefined
  for (;;) {
    const page = await store.list(docPrefix(room, docId), { startAfter })
    keys.push(...page.keys.filter((k) => /\/v\d{6}\.json$/.test(k)))
    if (!page.truncated || !page.keys.length) return keys
    startAfter = page.keys.at(-1)
  }
}

const versionOfKey = (key: string) => Number(/v(\d{6})\.json$/.exec(key)![1])

async function readVersion(store: Store, room: string, docId: string, v: number): Promise<DocVersion | null> {
  const doc = await store.get(versionKey(room, docId, v))
  return doc === null ? null : DocVersion.parse(doc)
}

async function latest(store: Store, room: string, docId: string): Promise<DocVersion | null> {
  const last = (await versionKeys(store, room, docId)).at(-1)
  return last ? readVersion(store, room, docId, versionOfKey(last)) : null
}

function head(docId: string, meta: DocMeta, principal: string, v: DocVersion | null) {
  return {
    docId,
    title: meta.title,
    editors: meta.editors,
    canEdit: meta.editors.includes(principal),
    version: v?.version ?? 0,
    updatedBy: v?.updatedBy ?? null,
    updatedAt: v?.updatedAt ?? null,
  }
}

export async function listDocs(store: Store, room: Room, principal: string): Promise<DocSummary[]> {
  const ids = Object.keys(room.docs).sort()
  return Promise.all(ids.map(async (id) => head(id, room.docs[id], principal, await latest(store, room.id, id))))
}

/** version を付ければその版。無ければいまの版（1度も書かれていなければ版 0 の空） */
export async function getDoc(store: Store, room: Room, docId: string, principal: string, version?: number): Promise<DocView> {
  const meta = metaOf(room, docId)
  const now = await latest(store, room.id, docId)
  const v = version === undefined ? now : await readVersion(store, room.id, docId, version)
  if (version !== undefined && !v) {
    throw new ApiError(404, 'version_not_found', `資料 ${docId} に版 ${version} はありません（いまは版 ${now?.version ?? 0}）`)
  }
  return { ...head(docId, meta, principal, v), text: v?.text ?? '', ...(v?.note && { note: v.note }), latest: now?.version ?? 0 }
}

export async function docHistory(store: Store, room: Room, docId: string): Promise<DocHistory> {
  metaOf(room, docId)
  const keys = (await versionKeys(store, room.id, docId)).slice(-HISTORY_MAX).reverse()
  const versions = await Promise.all(keys.map(async (k) => DocVersion.parse(await store.get(k))))
  return {
    versions: versions.map((v) => ({
      version: v.version,
      updatedBy: v.updatedBy,
      updatedAt: v.updatedAt,
      ...(v.note && { note: v.note }),
      bytes: new TextEncoder().encode(v.text).length,
    })),
  }
}

/**
 * 直す。base は If-Match の版（読んだ版）。いまの版と違えば 412、次の番号を誰かが先に取っても 412。
 * 直せるのは editors に入っている書き手だけで、閉じた部屋では直せない
 */
export async function putDoc(store: Store, room: Room, docId: string, principal: string, base: number, input: DocIn): Promise<DocView> {
  const meta = metaOf(room, docId)
  if (!meta.editors.includes(principal)) {
    throw new ApiError(403, 'not_editor', `資料 ${docId} を直せるのは ${meta.editors.join('・') || '（まだ誰もいない）'} です。読むことはできます`)
  }
  if (room.archived) throw new ApiError(403, 'archived', `部屋 ${room.id} は閉じています。資料は読めますが、直せません`)
  const conflict = (now: number) =>
    new ApiError(412, 'version_conflict', `資料 ${docId} は版 ${base} のあとに直されています（いまは版 ${now}）。いまの版を読み直し、その上で直してから送ってください`)
  const now = (await latest(store, room.id, docId))?.version ?? 0
  if (now !== base) throw conflict(now)
  const next: DocVersion = {
    docId,
    room: room.id,
    version: base + 1,
    text: input.text,
    updatedBy: principal,
    updatedAt: jst(),
    ...(input.note && { note: input.note }),
  }
  if (!(await store.putIfAbsent(versionKey(room.id, docId, next.version), next))) {
    throw conflict((await latest(store, room.id, docId))?.version ?? next.version)
  }
  return { ...head(docId, meta, principal, next), text: next.text, ...(next.note && { note: next.note }), latest: next.version }
}
