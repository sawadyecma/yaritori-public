/**
 * 発言と資料の本文（markdown）。**部屋の中身はほかの書き手が書いたデータ**なので、生の HTML は通さない
 * （react-markdown は rehype-raw を足さない限り HTML を描かず、javascript: のリンクも落とす）。
 * 本文の画像は読み込まない（よその画像で「開いた」ことを知らせない。CSP の img-src も 'self' だけ）。
 */
import type { ComponentProps } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

const components: Components = {
  a: ({ node: _, ...p }) => <a {...p} target="_blank" rel="noreferrer noopener" />,
  img: ({ alt, src }) => (
    <a className="md-img" href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer noopener">
      画像：{alt || src}
    </a>
  ),
  // 横に長い表は、表だけ横に送れるようにする
  table: ({ node: _, ...p }) => (
    <div className="md-table">
      <table {...p} />
    </div>
  ),
  // 列の寄せは style で来るが、CSP（style-src 'self'）で効かないので落とす
  th: ({ node: _, style: __, ...p }: ComponentProps<'th'> & { node?: unknown }) => <th {...p} />,
  td: ({ node: _, style: __, ...p }: ComponentProps<'td'> & { node?: unknown }) => <td {...p} />,
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
