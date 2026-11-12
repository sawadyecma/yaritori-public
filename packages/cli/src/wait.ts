/**
 * yaritori wait（2026-11-02）。ほかの書き手の発言が来るまで待つ。
 *
 * Claude Code が発言を置いたあとに裏で走らせておくと、返事が来たところで終わり、Claude Code が自分で起きて pull できる
 * （本人が「返事来たよ」と言わなくて済む）。**API に通知の口は足さない。** 受信箱（GET /v1/inbox）を間を空けて見に行くだけ。
 *
 * - 既読の印より後に、ほかの書き手の発言があれば終わる。まだ pull していない発言があれば、待たずにすぐ終わる
 * - 通信の失敗・5xx・429 は待ち続ける（返事を待つあいだに一度落ちても止まらない）。キー違い・入っていない部屋はすぐ止める
 * - 部屋を言わなければ、入っている部屋（閉じた部屋を除く）のどれかに来たら終わる
 */
import type { Inbox, InboxRoom } from '@yaritori/schema'
import { call } from './client'
import { inboxLines } from './messages'

/** 見に行く間（秒）の既定と下限。Lambda の予約同時実行は 2 なので、ほかの書き手の邪魔をしない間を空ける */
export const EVERY_DEFAULT = 60
export const EVERY_MIN = 10
/** 待つ長さ（分）の既定と上限。忘れた wait がいつまでも残らないように */
export const TIMEOUT_DEFAULT = 360
export const TIMEOUT_MAX = 24 * 60

export type WaitDeps = {
  inbox: () => Promise<Inbox>
  sleep: (ms: number) => Promise<void>
  now: () => number
  warn: (msg: string) => void
}

const defaultDeps: WaitDeps = {
  inbox: () => call<Inbox>('GET', '/v1/inbox'),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  warn: (msg) => console.error(msg),
}

/** 待っている部屋。言われた部屋に入っていない・閉じていれば投げる（待っても来ない） */
export function watched(box: Inbox, rooms: string[]): InboxRoom[] {
  if (!rooms.length) return box.rooms.filter((r) => !r.archived)
  return rooms.map((id) => {
    const r = box.rooms.find((x) => x.id === id)
    if (!r) throw new Error(`部屋 ${id} に入っていません。入っている部屋は yaritori me で見られます`)
    if (r.archived) throw new Error(`部屋 ${id} は閉じています（だれも置けないので、待っても来ません）`)
    return r
  })
}

/** 送り直せば通るかもしれない誤り（通信の失敗は status を持たない） */
const transient = (e: unknown) => {
  const status = (e as { status?: number }).status
  return status === undefined || status === 429 || status >= 500
}

/** 未読のある部屋を返す。timeout 分のうちに来なければ null */
export async function waitFor(rooms: string[], opts: { every: number; timeout: number }, deps: WaitDeps = defaultDeps): Promise<InboxRoom[] | null> {
  const until = deps.now() + opts.timeout * 60e3
  let first = true
  for (;;) {
    let box: Inbox | null = null
    try {
      box = await deps.inbox()
    } catch (e) {
      // 最初の1回は、つながらない・キー違いをすぐ知らせる
      if (first || !transient(e)) throw e
      deps.warn(`受信箱を見られませんでした（${e instanceof Error ? e.message : e}）。続けて待ちます`)
    }
    if (box) {
      const hit = watched(box, rooms).filter((r) => r.unread > 0)
      if (hit.length) return hit
    }
    first = false
    const left = until - deps.now()
    if (left <= 0) return null
    await deps.sleep(Math.min(opts.every * 1000, left))
  }
}

export async function wait(rooms: string[], o: { every?: number; timeout?: number } = {}) {
  const every = o.every ?? EVERY_DEFAULT
  const timeout = o.timeout ?? TIMEOUT_DEFAULT
  if (every < EVERY_MIN) throw new Error(`--every は ${EVERY_MIN} 秒より短くできません`)
  if (timeout < 1 || timeout > TIMEOUT_MAX) throw new Error(`--timeout は 1〜${TIMEOUT_MAX} 分で`)
  console.error(`${rooms.length ? `部屋 ${rooms.join('・')} ` : '入っている部屋'}に、ほかの書き手の発言が来るまで待ちます（${every} 秒ごと・最長 ${timeout} 分）`)
  const hit = await waitFor(rooms, { every, timeout })
  if (!hit) {
    console.error(`${timeout} 分待ちましたが、来ませんでした`)
    process.exitCode = 3
    return
  }
  for (const r of hit) for (const line of inboxLines(r)) console.log(line)
  console.error(`来ました。yaritori pull ${hit.length === 1 ? hit[0].id : '<部屋>'} --into <フォルダ> で落としてください`)
}
