/**
 * 読む画面の Cloudflare Worker。2026-10-30。
 *
 * 画面（dist/ の静的ファイル）は Cloudflare が配り、/api と /auth だけ Lambda「Viewer」
 * （packages/api/src/viewer-lambda.ts）へ中継する。**ログインの確認とデータは全部 Lambda がやり、ここは何も判断しない。**
 * 判断を2か所に分けると、片方だけ直して穴が開く。
 *
 * 静的ファイルはログインしていなくても取れる。中身はデータの無い画面の枠だけで、データは
 * ログイン必須の /api から取る（未ログインなら 401 → 画面がログインへ移る）。
 *
 * Lambda の Function URL は独自ドメインを持てないので、この中継が要る（DNS の CNAME だけでは
 * 証明書と Host が合わずに断られる）。
 */

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> }
  /** Lambda「Viewer」の Function URL。デプロイのときに infra/cdk-outputs.json の ViewerFunctionUrl を --var で渡す */
  LAMBDA_ORIGIN: string
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      const target = new URL(url.pathname + url.search, env.LAMBDA_ORIGIN)
      const headers = new Headers(req.headers)
      headers.delete('host') // 宛先（Lambda の URL）の Host で送る
      const res = await fetch(target, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req.body,
        // Google へのリダイレクトと Set-Cookie は、ブラウザにそのまま返す
        redirect: 'manual',
      })
      return new Response(res.body, res)
    }
    return env.ASSETS.fetch(req)
  },
}
