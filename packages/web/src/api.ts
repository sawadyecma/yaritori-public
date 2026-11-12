/**
 * Lambda「Viewer」（packages/api/src/viewer.ts）を読む。形は @yaritori/schema の web.ts（型だけ使う）。
 * 401 はログインが切れたしるしなので、ログインへ移る（手元の 127.0.0.1 ではログインが無いので来ない）。
 */
import type { DocHistory, ErrorBody, FileLink, MessageList, MessageOut, WebDoc, WebMe, WebPeek, WebRoom, WebRoomList } from '@yaritori/schema'

export class LoadError extends Error {}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { accept: 'application/json' } })
  if (res.status === 401) {
    location.href = '/auth/login'
    throw new LoadError('ログインし直しています…')
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ErrorBody | null
    throw new LoadError(body?.error.message ?? `読めませんでした（${res.status}）`)
  }
  return (await res.json()) as T
}

const enc = encodeURIComponent

export const api = {
  me: () => get<WebMe>('/api/me'),
  rooms: () => get<WebRoomList>('/api/rooms'),
  room: (room: string) => get<WebRoom>(`/api/rooms/${enc(room)}`),
  /** 全部の発言を置いた順に（50 通ずつ続きを取る） */
  async messages(room: string): Promise<MessageOut[]> {
    const out: MessageOut[] = []
    let after: string | null = null
    do {
      const page: MessageList = await get<MessageList>(`/api/rooms/${enc(room)}/messages${after ? `?after=${enc(after)}` : ''}`)
      out.push(...page.messages)
      after = page.next
    } while (after)
    return out
  },
  doc: (room: string, docId: string, version?: number) =>
    get<WebDoc>(`/api/rooms/${enc(room)}/docs/${enc(docId)}${version ? `?version=${version}` : ''}`),
  versions: (room: string, docId: string) => get<DocHistory>(`/api/rooms/${enc(room)}/docs/${enc(docId)}/versions`),
  file: (room: string, fileId: string) => get<FileLink>(`/api/rooms/${enc(room)}/files/${enc(fileId)}`),
  peek: (room: string, fileId: string) => get<WebPeek>(`/api/rooms/${enc(room)}/files/${enc(fileId)}/peek`),
}
