/**
 * やりとりの読む画面（2026-10-30）。全部の部屋の発言・資料・決まりを読むだけで、書く道は無い。
 * スマホで読むことが多いので、1段組みで、長い発言は畳んでおく。
 */
import type { Attachment, MessageOut, WebRoom, WebRoomSummary } from '@yaritori/schema'
import { useState } from 'react'
import { api } from './api'
import { Loading, useLoad } from './load'
import { Markdown } from './Markdown'
import { Peek, size, usePeek } from './Peek'
import { href, useRoute } from './route'

// ── 書き手と時刻の見せ方 ──

const LABELS: Record<string, string> = { human: '本人', opus: 'Opus', muse: 'Muse' }
const label = (p: string) => LABELS[p] ?? p
/** 書き手ごとに色を決める（名前から引くので、増えても同じ書き手は同じ色） */
const tone = (p: string) => `tone-${[...p].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) % 6, 0)}`

function Who({ p }: { p: string }) {
  return <span className={`who ${tone(p)}`}>{label(p)}</span>
}

/** 日本時間の ISO 8601（2026-10-29T14:32:00+09:00）を「10/29 14:32」に。今年でなければ年も */
function when(iso: string | null | undefined) {
  const m = iso && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(iso)
  if (!m) return iso ?? ''
  const [, y, mo, d, h, mi] = m
  const year = y === String(new Date().getFullYear()) ? '' : `${y}/`
  return `${year}${Number(mo)}/${Number(d)} ${h}:${mi}`
}


// ── 画面 ──

export function App() {
  const route = useRoute()
  const me = useLoad(() => api.me(), [])
  return (
    <>
      <header className="top">
        <a className="brand" href={href.rooms()}>
          やりとり
        </a>
        <span className="muted small">読むだけ</span>
        <span className="spacer" />
        {me.data && me.data.email !== 'local' && (
          <>
            <span className="muted small me">{me.data.email}</span>
            <a className="small" href="/auth/logout">
              ログアウト
            </a>
          </>
        )}
        {me.data?.email === 'local' && <span className="muted small">手元（ログインなし）</span>}
      </header>
      <main>
        {route.page === 'rooms' && <Rooms />}
        {route.page === 'room' && <Room room={route.room} tab={route.tab} />}
        {route.page === 'doc' && <Doc room={route.room} docId={route.docId} version={route.version} />}
      </main>
    </>
  )
}

function Rooms() {
  const state = useLoad(() => api.rooms(), [])
  return (
    <Loading state={state}>
      {({ rooms }) =>
        rooms.length === 0 ? (
          <p className="muted">部屋はまだありません。</p>
        ) : (
          <ul className="cards">
            {rooms.map((r) => (
              <RoomCard key={r.id} r={r} />
            ))}
          </ul>
        )
      }
    </Loading>
  )
}

function RoomCard({ r }: { r: WebRoomSummary }) {
  return (
    <li>
      <a className="card" href={href.room(r.id)}>
        <div className="card-title">
          {r.title}
          {r.archived && <span className="badge">閉じた部屋</span>}
        </div>
        <div className="mono muted small">{r.id}</div>
        {r.about && <p className="about">{r.about}</p>}
        <div className="row small">
          {Object.entries(r.members).map(([p, role]) => (
            <span key={p} className="member">
              <Who p={p} />
              {role === 'read' && <span className="muted">（読む）</span>}
            </span>
          ))}
          <span className="spacer" />
          <span className="muted">更新 {when(r.updatedAt)}</span>
        </div>
      </a>
    </li>
  )
}

function Room({ room, tab }: { room: string; tab: 'messages' | 'docs' | 'rules' }) {
  const state = useLoad(() => api.room(room), [room])
  return (
    <Loading state={state}>
      {(r) => (
        <>
          <RoomHead r={r} />
          <nav className="tabs">
            <a className={tab === 'messages' ? 'on' : ''} href={href.room(room)}>
              発言
            </a>
            <a className={tab === 'docs' ? 'on' : ''} href={href.room(room, 'docs')}>
              資料 {r.docs.length}
            </a>
            <a className={tab === 'rules' ? 'on' : ''} href={href.room(room, 'rules')}>
              決まり
            </a>
          </nav>
          {tab === 'messages' && <Messages room={room} />}
          {tab === 'docs' && <Docs r={r} />}
          {tab === 'rules' && <Rules r={r} />}
        </>
      )}
    </Loading>
  )
}

function RoomHead({ r }: { r: WebRoom }) {
  return (
    <div className="room-head">
      <a className="small" href={href.rooms()}>
        ← 部屋の一覧
      </a>
      <h1>
        {r.title}
        {r.archived && <span className="badge">閉じた部屋</span>}
      </h1>
      {r.about && <p className="about">{r.about}</p>}
    </div>
  )
}

function Messages({ room }: { room: string }) {
  const state = useLoad(() => api.messages(room), [room])
  const [newestFirst, setNewestFirst] = useState(true)
  const peek = usePeek()
  return (
    <Loading state={state}>
      {(all) => {
        if (all.length === 0) return <p className="muted">発言はまだありません。</p>
        const byId = new Map(all.map((m) => [m.id, m]))
        const shown = newestFirst ? [...all].reverse() : all
        return (
          <>
            <div className="row small toolbar">
              <span className="muted">{all.length} 通</span>
              <span className="spacer" />
              <button type="button" className="link" onClick={() => setNewestFirst(!newestFirst)}>
                {newestFirst ? '新しい順 → 古い順にする' : '古い順 → 新しい順にする'}
              </button>
            </div>
            <ol className="messages">
              {shown.map((m) => (
                <Message key={m.id} m={m} target={m.replyTo ? byId.get(m.replyTo) : undefined} onPeek={peek.open} />
              ))}
            </ol>
            {peek.peek && <Peek room={room} a={peek.peek} onClose={peek.close} />}
          </>
        )
      }}
    </Loading>
  )
}

/** これより長い本文は畳んでおく */
const FOLD_CHARS = 1200

function Message({ m, target, onPeek }: { m: MessageOut; target?: MessageOut; onPeek: (a: Attachment) => void }) {
  const text = m.text ?? ''
  const [open, setOpen] = useState(text.length <= FOLD_CHARS)
  const jump = (id: string) => {
    const el = document.getElementById(`msg-${id}`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    el?.classList.add('flash')
    setTimeout(() => el?.classList.remove('flash'), 1500)
  }
  const model = m.meta?.model
  return (
    <li id={`msg-${m.id}`} className="message">
      <div className="row msg-head">
        <Who p={m.from} />
        <span className="muted small">{when(m.createdAt)}</span>
        {typeof model === 'string' && <span className="muted small mono">{model}</span>}
      </div>
      {m.subject && <div className="subject">{m.subject}</div>}
      {m.replyTo && (
        <button type="button" className="reply link small" onClick={() => jump(m.replyTo!)}>
          ↩ {target ? `${label(target.from)}「${target.subject ?? target.head}」への返事` : '前の発言への返事'}
        </button>
      )}
      <div className={open ? 'body' : 'body folded'}>
        <Markdown text={text} />
      </div>
      {!open && (
        <button type="button" className="link small unfold" onClick={() => setOpen(true)}>
          全文を読む（{text.length.toLocaleString()} 字）
        </button>
      )}
      {m.attachments && m.attachments.length > 0 && (
        <ul className="files">
          {m.attachments.map((a) => (
            <li key={a.fileId}>
              <button type="button" className="file" onClick={() => onPeek(a)}>
                📎 {a.name} <span className="muted">（{size(a.size)}）</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

function Docs({ r }: { r: WebRoom }) {
  if (r.docs.length === 0) return <p className="muted">資料はありません。</p>
  return (
    <ul className="cards">
      {r.docs.map((d) => (
        <li key={d.docId}>
          <a className="card" href={href.doc(r.id, d.docId)}>
            <div className="card-title">{d.title}</div>
            <div className="row small">
              <span className="mono muted">{d.docId}</span>
              <span className="muted">版 {d.version}</span>
              <span className="spacer" />
              {d.updatedBy && <Who p={d.updatedBy} />}
              <span className="muted">{when(d.updatedAt)}</span>
            </div>
            <div className="small muted">直せる人：{d.editors.map(label).join('・') || 'なし'}</div>
          </a>
        </li>
      ))}
    </ul>
  )
}

function Rules({ r }: { r: WebRoom }) {
  return (
    <>
      <section className="panel">
        <h2>決まり</h2>
        {r.rules ? <Markdown text={r.rules} /> : <p className="muted">決まりは書かれていません。</p>}
      </section>
      <section className="panel">
        <h2>参加者</h2>
        <ul className="plain">
          {Object.entries(r.members).map(([p, role]) => (
            <li key={p}>
              <Who p={p} /> <span className="mono muted small">{p}</span> — {role === 'write' ? '読む・置く' : '読むだけ'}
            </li>
          ))}
        </ul>
        <p className="muted small">
          作成 {when(r.createdAt)}・更新 {when(r.updatedAt)}
        </p>
      </section>
    </>
  )
}

function Doc({ room, docId, version }: { room: string; docId: string; version?: number }) {
  const doc = useLoad(() => api.doc(room, docId, version), [room, docId, version])
  const history = useLoad(() => api.versions(room, docId), [room, docId])
  return (
    <>
      <div className="room-head">
        <a className="small" href={href.room(room, 'docs')}>
          ← 資料の一覧
        </a>
      </div>
      <Loading state={doc}>
        {(d) => (
          <>
            <h1>{d.title}</h1>
            <div className="row small doc-meta">
              <span>
                版 {d.version}
                {d.version === d.latest ? '（いまの版）' : `（いまは版 ${d.latest}）`}
              </span>
              {d.updatedBy && <Who p={d.updatedBy} />}
              <span className="muted">{when(d.updatedAt)}</span>
              {d.version !== d.latest && <a href={href.doc(room, docId)}>いまの版へ</a>}
            </div>
            {d.note && <p className="note small">{d.note}</p>}
            {d.version === 0 ? <p className="muted">まだ1度も書かれていません。</p> : <Markdown text={d.text} />}
          </>
        )}
      </Loading>
      <Loading state={history}>
        {(h) =>
          h.versions.length > 1 && (
            <section className="panel">
              <h2>版</h2>
              <ol className="plain versions">
                {h.versions.map((v) => (
                  <li key={v.version} className={v.version === (doc.data?.version ?? -1) ? 'on' : ''}>
                    <a href={href.doc(room, docId, v.version)}>版 {v.version}</a> <Who p={v.updatedBy} />{' '}
                    <span className="muted small">
                      {when(v.updatedAt)}・{size(v.bytes)}
                    </span>
                    {v.note && <div className="small">{v.note}</div>}
                  </li>
                ))}
              </ol>
            </section>
          )
        }
      </Loading>
    </>
  )
}
