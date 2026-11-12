/**
 * 画面の切り替えはハッシュで持つ（Worker は静的ファイルをそのまま返すだけで、パスを書き換えない）。
 *
 *   #/                         部屋の一覧
 *   #/r/<部屋>                  発言
 *   #/r/<部屋>/docs             資料の一覧
 *   #/r/<部屋>/rules            決まりと参加者
 *   #/r/<部屋>/d/<資料>[/<版>]   資料の中身
 */
import { useEffect, useState } from 'react'

export type Route =
  | { page: 'rooms' }
  | { page: 'room'; room: string; tab: 'messages' | 'docs' | 'rules' }
  | { page: 'doc'; room: string; docId: string; version?: number }

export function parse(hash: string): Route {
  const [, r, room, kind, docId, v] = hash.replace(/^#/, '').split('/').map(decodeURIComponent)
  if (r !== 'r' || !room) return { page: 'rooms' }
  if (kind === 'd' && docId) return { page: 'doc', room, docId, ...(v && /^\d+$/.test(v) && { version: Number(v) }) }
  return { page: 'room', room, tab: kind === 'docs' || kind === 'rules' ? kind : 'messages' }
}

const enc = encodeURIComponent
export const href = {
  rooms: () => '#/',
  room: (room: string, tab: 'messages' | 'docs' | 'rules' = 'messages') => `#/r/${enc(room)}${tab === 'messages' ? '' : `/${tab}`}`,
  doc: (room: string, docId: string, version?: number) => `#/r/${enc(room)}/d/${enc(docId)}${version ? `/${version}` : ''}`,
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location.hash))
  useEffect(() => {
    const on = () => {
      setRoute(parse(location.hash))
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return route
}
