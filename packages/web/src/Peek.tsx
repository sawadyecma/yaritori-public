/**
 * 添付をその場で見る（サイドピーク。2026-10-30）。広い画面では右から開くパネル、狭い画面では全面に開く。
 *
 * - md・テキスト：中身は Viewer が読んで返す（UTF-8・1MB まで）。md は本文と同じ描き方（生の HTML は通さない）
 * - 画像・動画：埋め込む URL（1時間）。CSP の img-src・media-src に足してあるのは yaritori のバケットだけ
 * - ほか：種類と大きさとダウンロードだけ
 *
 * 閉じるのは ×・Esc・外側を押す・ブラウザの「戻る」（開くときに履歴を1つ積む。ハッシュは変えないので画面は切り替わらない）。
 */
import type { Attachment, WebPeek } from '@yaritori/schema'
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import { Loading, useLoad } from './load'
import { Markdown } from './Markdown'

export const size = (n: number) => (n < 1024 ? `${n}B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)}KB` : `${(n / 1024 ** 2).toFixed(1)}MB`)

export function usePeek() {
  const [peek, setPeek] = useState<Attachment | null>(null)
  useEffect(() => {
    if (!peek) return
    const onPop = () => setPeek(null)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [peek])
  const open = useCallback((a: Attachment) => {
    if (!history.state?.peek) history.pushState({ peek: true }, '')
    setPeek(a)
  }, [])
  // 積んだ履歴を戻す（popstate で閉じる）。積んでいなければそのまま閉じる
  const close = useCallback(() => (history.state?.peek ? history.back() : setPeek(null)), [])
  return { peek, open, close }
}

export function Peek({ room, a, onClose }: { room: string; a: Attachment; onClose: () => void }) {
  const state = useLoad(() => api.peek(room, a.fileId), [room, a.fileId])
  const [error, setError] = useState<string>()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    document.body.classList.add('peeking')
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.classList.remove('peeking')
    }
  }, [onClose])
  const download = async () => {
    setError(undefined)
    try {
      // ダウンロードの URL は5分で切れるので、押したときに取りに行く
      location.href = (await api.file(room, a.fileId)).url
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="peek-backdrop" onClick={onClose}>
      <aside className="peek" role="dialog" aria-modal="true" aria-label={a.name} onClick={(e) => e.stopPropagation()}>
        <header className="peek-head">
          <div className="peek-title">
            <div className="peek-name">{a.name}</div>
            <div className="muted small">
              {a.contentType}・{size(a.size)}
            </div>
          </div>
          <button type="button" className="button small" onClick={download}>
            ダウンロード
          </button>
          <button type="button" className="peek-close" onClick={onClose} aria-label="閉じる" autoFocus>
            ×
          </button>
        </header>
        {error && <p className="error small peek-error">{error}</p>}
        <div className="peek-body">
          <Loading state={state}>{(p) => <PeekBody p={p} />}</Loading>
        </div>
      </aside>
    </div>
  )
}

function PeekBody({ p }: { p: WebPeek }) {
  const [broken, setBroken] = useState(false)
  if (p.kind === 'markdown') return <Markdown text={p.text ?? ''} />
  if (p.kind === 'text') return <pre className="peek-text">{p.text}</pre>
  if (p.kind === 'image' && !broken) return <img className="peek-image" src={p.inlineUrl} alt={p.name} onError={() => setBroken(true)} />
  if (p.kind === 'video' && !broken) {
    return <video className="peek-video" src={p.inlineUrl} controls playsInline preload="metadata" onError={() => setBroken(true)} />
  }
  return <p className="muted">{broken ? 'このブラウザでは表示できませんでした。ダウンロードしてください' : p.note}</p>
}
