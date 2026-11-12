/**
 * 読む画面のログイン（Google）。2026-10-30。
 *
 * 流れ（OpenID Connect の認可コードフロー。やり取りは openid-client に任せて自作しない）:
 *
 *   /auth/login     PKCE・state・nonce を作って、10分だけの Cookie に署名して置き、Google へ送る
 *   /auth/callback  Google から戻ってきたら、コードをトークンに換えて ID トークンを確かめる
 *                   （発行元・宛先・期限・nonce は openid-client が見る。トークンは Google から TLS で直に受け取る）。
 *                   メールアドレスが確認済みで、許可リストにあるときだけセッションの Cookie を置く
 *   それ以外        セッションの Cookie を毎回確かめる。無ければ画面はログインへ、API は 401
 *
 * **Google のトークンは持たない。** 本人確認に使ったら捨て、こちらで署名したセッション（HttpOnly・Secure・
 * `__Host-` 付き・7日）だけを置く。全端末から締め出すときは署名鍵を作り直す（`admin web session-rotate`）。
 *
 * **守りは重ねてある。** Google の同意画面は「テスト中」でテストユーザーを絞り、ここでもメールアドレスを確かめ、
 * セッションを確かめるたびに許可リスト（SSM。`admin web allow / deny`）を見直す（外せば5分のうちに入れなくなる）。
 *
 * 読むだけの画面で、書き込みの口が無いので CSRF の対策は要らない。書き込みを足すときは Origin の確認を足す。
 */
import type { Context, Hono, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import * as oidc from 'openid-client'

export interface AuthSecrets {
  clientId: string
  clientSecret: string
  /** セッションの署名鍵 */
  sessionKey: string
}

export type WebEnv = { Variables: { email: string } }

export interface AuthOptions {
  secrets: () => Promise<AuthSecrets>
  /** 入れる Google アカウントのメールアドレス（小文字） */
  viewers: () => Promise<Set<string>>
  /**
   * 画面を開くドメイン（https://yaritori.example.com など）。戻り先はここから組む。
   * Cloudflare の Worker が中継すると、Lambda に届く Host は Lambda 自身の URL になるので、Host からは組めない
   * （組むとログインのあと Cookie が Lambda の URL のほうに置かれ、画面のドメインでは入れない）
   */
  publicOrigin: string
  sessionDays?: number
}

const GOOGLE = new URL('https://accounts.google.com')
const SESSION = '__Host-yt_session'
const PENDING = '__Host-yt_login'
const PENDING_SEC = 600
const COOKIE = { path: '/', secure: true, httpOnly: true, sameSite: 'Lax' } as const

function page(c: Context, status: 200 | 400 | 403 | 503, body: string) {
  return c.html(
    '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width">' +
      `<title>やりとり</title><div style="font-family:system-ui;padding:24px;line-height:1.7">${body}</div>`,
    status,
  )
}

export function googleAuth({ secrets, viewers, publicOrigin, sessionDays = 7 }: AuthOptions) {
  // クライアントの秘密を作り直したら、組み直す（同じコンテナが古い秘密を使い続けないように）
  let config: { for: string; value: Promise<oidc.Configuration> } | null = null
  const getConfig = async () => {
    const s = await secrets()
    const id = `${s.clientId}\n${s.clientSecret}`
    if (config?.for !== id) {
      const value = oidc.discovery(GOOGLE, s.clientId, s.clientSecret).then(
        (found) =>
          // **Google は戻りの URL に iss を付けない**（2026-10-21 に本番で確認。公開設定では
          // authorization_response_iss_parameter_supported を true と言っているので、openid-client が
          // iss を求めて「iss missing」で止まった）。iss は複数の発行元を使い分けるときの取り違えを防ぐもので、
          // ここは Google だけなので要らない。ID トークンの中の iss（発行元）はこれまでどおり確かめられる
          new oidc.Configuration(
            { ...(found.serverMetadata() as oidc.ServerMetadata), authorization_response_iss_parameter_supported: false },
            s.clientId,
            s.clientSecret,
          ),
      )
      value.catch(() => (config = null)) // 次の要求でやり直す
      config = { for: id, value }
    }
    return config.value
  }
  const key = async () => new TextEncoder().encode((await secrets()).sessionKey)

  async function sign(payload: JWTPayload, seconds: number, audience: string) {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime(`${seconds}s`)
      .setAudience(audience)
      .sign(await key())
  }
  async function verify(token: string | undefined, audience: string) {
    if (!token) return null
    try {
      return (await jwtVerify(token, await key(), { audience, algorithms: ['HS256'] })).payload
    } catch {
      return null
    }
  }

  // 戻り先は Google に登録した URL と1文字も違ってはいけない
  const callbackUrl = `${publicOrigin}/auth/callback`

  const routes = (app: Hono<WebEnv>) => {
    app.get('/auth/login', async (c) => {
      let cfg: oidc.Configuration
      try {
        cfg = await getConfig()
      } catch (e) {
        console.error('Google の設定を読めませんでした', e)
        return page(c, 503, 'Google のログインがまだ設定されていません（手元で <code>npm run yaritori -- admin web google</code>）。')
      }
      const verifier = oidc.randomPKCECodeVerifier()
      const state = oidc.randomState()
      const nonce = oidc.randomNonce()
      setCookie(c, PENDING, await sign({ verifier, state, nonce }, PENDING_SEC, 'login'), { ...COOKIE, maxAge: PENDING_SEC })
      const allow = await viewers()
      const url = oidc.buildAuthorizationUrl(cfg, {
        redirect_uri: callbackUrl,
        scope: 'openid email',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
        // 1人だけなら、Google のアカウント選択でその人を先に出す
        ...(allow.size === 1 ? { login_hint: [...allow][0] } : {}),
      })
      return c.redirect(url.href, 302)
    })

    app.get('/auth/callback', async (c) => {
      const pending = await verify(getCookie(c, PENDING), 'login')
      deleteCookie(c, PENDING, { path: '/', secure: true })
      if (!pending) return page(c, 400, 'ログインをやり直してください（10分以上たったか、別の画面から戻ってきました）。<p><a href="/auth/login">ログイン</a></p>')
      const current = new URL(callbackUrl)
      current.search = new URL(c.req.url).search
      let claims: oidc.IDToken | undefined
      try {
        const tokens = await oidc.authorizationCodeGrant(await getConfig(), current, {
          pkceCodeVerifier: String(pending.verifier),
          expectedState: String(pending.state),
          expectedNonce: String(pending.nonce),
        })
        claims = tokens.claims()
      } catch (e) {
        // 戻りの URL に何が付いていたかは、値を出さずに名前だけ残す（コードや state を残さない）
        console.error('ログインに失敗しました（戻りのパラメータ: %s）', [...current.searchParams.keys()].join(','), e)
        return page(c, 400, 'ログインに失敗しました。<p><a href="/auth/login">もう一度</a></p>')
      }
      const email = String(claims?.email ?? '').toLowerCase()
      if (!claims || claims.email_verified !== true || !(await viewers()).has(email)) {
        // 他人のメールアドレスはログに残さない
        console.warn('許可していないアカウントでログインしようとしました（sub=%s）', claims?.sub)
        return page(c, 403, 'このアカウントでは入れません。')
      }
      setCookie(c, SESSION, await sign({ sub: claims.sub, email }, sessionDays * 86400, 'session'), {
        ...COOKIE,
        maxAge: sessionDays * 86400,
      })
      return c.redirect('/', 302)
    })

    app.get('/auth/logout', (c) => {
      deleteCookie(c, SESSION, { path: '/', secure: true })
      return page(c, 200, 'ログアウトしました。<p><a href="/auth/login">もう一度ログイン</a></p>')
    })
  }

  const guard: MiddlewareHandler<WebEnv> = async (c, next) => {
    if (c.req.path.startsWith('/auth/')) return next()
    const session = await verify(getCookie(c, SESSION), 'session')
    const email = String(session?.email ?? '')
    // 署名が有効でも、許可リストから外したアカウントは通さない
    if (session && (await viewers()).has(email)) {
      c.set('email', email)
      return next()
    }
    if (c.req.path.startsWith('/api/')) return c.json({ error: { code: 'login', message: 'ログインが切れました' } }, 401)
    return c.redirect('/auth/login', 302)
  }

  return { routes, guard }
}
