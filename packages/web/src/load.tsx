/** 読み込みの状態（読んでいる・読めた・失敗した）と、その出し分け */
import { useEffect, useState, type ReactNode } from 'react'

export type LoadState<T> = { data?: T; error?: string }

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]): LoadState<T> {
  const [state, setState] = useState<LoadState<T>>({})
  useEffect(() => {
    let live = true
    setState({})
    load().then(
      (data) => live && setState({ data }),
      (e: unknown) => live && setState({ error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      live = false
    }
  }, deps)
  return state
}

export function Loading<T>({ state, children }: { state: LoadState<T>; children: (data: T) => ReactNode }) {
  if (state.error) return <p className="error">{state.error}</p>
  if (state.data === undefined) return <p className="muted">読んでいます…</p>
  return <>{children(state.data)}</>
}
