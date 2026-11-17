// 服务端渲染的登录页和错误页（主网站以后是 web/ 下的单页应用）

import { html, raw } from 'hono/html'

const style = raw(`
:root{--bg:#FAFAF8;--fg:#1F1F1E;--fg2:#383836;--line:#DADAD5;--card:#FFFFFF;--btn:#1F1F1E;--btnfg:#FFFFFF}
@media (prefers-color-scheme: dark){:root{--bg:#1C1C1E;--fg:#F2F2F0;--fg2:#CFCFCB;--line:#3C3C3F;--card:#252527;--btn:#F2F2F0;--btnfg:#1C1C1E}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;
  background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif}
main{width:100%;max-width:360px;display:flex;flex-direction:column;gap:20px}
h1{margin:0;font-size:26px;font-weight:700}
p{margin:0;font-size:15px;line-height:1.6;color:var(--fg2)}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;height:48px;border-radius:10px;
  background:var(--btn);color:var(--btnfg);font-size:16px;font-weight:600;text-decoration:none}
.btn svg{width:20px;height:20px;fill:currentColor}
.note{font-size:13px}
a{color:#1F64D6}
`)

function layout(title: string, body: unknown) {
  return html`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${style}</style>
</head>
<body><main>${body}</main></body>
</html>`
}

const githubIcon = raw(`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`)

/** search：/login 上的原始查询串（含 client/state/code_challenge），原样传给 /auth/github/start */
export function loginPage(search: string) {
  return layout('登录 Quotabar', html`
<h1>登录 Quotabar</h1>
<p>登录后，可以在网站和手机上查看 Claude 额度、会话和执行状态。</p>
<a class="btn" href="/auth/github/start${search}">${githubIcon}使用 GitHub 登录</a>
<p class="note">Apple 和 Google 登录稍后提供。</p>`)
}

export function errorPage(message: string) {
  return layout('登录出错', html`
<h1>出了点问题</h1>
<p>${message}</p>
<a class="btn" href="/login">重新登录</a>`)
}

/** Mac / iOS 登录成功后：跳回 App。链接放在 data 属性里由脚本读取，避免拼进脚本。 */
export function returnToAppPage(appUrl: string, client: string) {
  const app = client === 'mac' ? 'Quotabar' : 'Quotabar App'
  return layout('正在返回 ' + app, html`
<h1>登录成功</h1>
<p>正在返回 ${app}。如果浏览器询问是否打开，请选择“打开”。</p>
<a class="btn" id="open" href="${appUrl}" data-url="${appUrl}">打开 ${app}</a>
<p class="note">回到 ${app} 后，这个页面可以关掉。</p>
<script>
  setTimeout(function () { location.href = document.getElementById('open').dataset.url }, 300)
</script>`)
}
