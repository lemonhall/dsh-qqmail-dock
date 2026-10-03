/**
 * Client half of dsh-qqmail-dock —— 右侧栏的「QQ 邮箱」tab。
 *
 * 左：邮件列表；右：正文 + 写邮件。发送必须二次确认（面板上点两次），
 * 和 Agent 侧 `confirm=true` 是同一个门禁。凭据永远不经过这里 —— 全在宿主私有文件里。
 * ⚠️ 整个模块包在 IIFE 里（DSH 把客户端插件拼成一个脚本，顶层 const 会撞名）。
 */

;(() => {
const TAB_KIND = 'qqmail'
const TAB_ID = 'dsh-qqmail-dock:qqmail'
const ROUTE_STATE = '/dsh-qqmail/state'

window.__ModuleLoader__.load({
  id: 'dsh-qqmail-dock',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      border: 'var(--dsw-alias-border-l1)',
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      accent: 'var(--dsw-alias-brand-primary, #5a7cff)',
      warn: '#ffb020',
      err: '#ff5a4d',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    function fmtWhen(ms) {
      if (!ms) return ''
      const d = new Date(ms)
      const pad = (n) => String(n).padStart(2, '0')
      const sameDay = new Date().toDateString() === d.toDateString()
      return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}/${d.getDate()}`
    }

    function MailPanel() {
      const [status, setStatus] = React.useState(null)
      const [list, setList] = React.useState([])
      const [message, setMessage] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [tab, setTab] = React.useState('inbox') // inbox | compose
      const [to, setTo] = React.useState('')
      const [subject, setSubject] = React.useState('')
      const [text, setText] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [sent, setSent] = React.useState(null)

      const pull = React.useCallback(() => {
        return fetch(ROUTE_STATE)
          .then((response) => response.json())
          .then((payload) => {
            if (!payload || !payload.ok) return
            setStatus(payload.status)
            if (payload.cache && payload.cache.length && !list.length) setList(payload.cache)
          })
          .catch(() => {})
      }, [list.length])

      React.useEffect(() => {
        pull()
      }, [pull])

      const post = React.useCallback(
        (body) => {
          setBusy(true)
          setError(null)
          return fetch(ROUTE_STATE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
            .then((response) => response.json())
            .then((payload) => {
              if (!payload) return null
              if (!payload.ok) {
                setError(payload.error || '出错了')
                return null
              }
              if (payload.list) setList(payload.list)
              if (payload.message) setMessage(payload.message)
              if (payload.status) setStatus(payload.status)
              return payload
            })
            .catch((err) => {
              setError(String((err && err.message) || err))
              return null
            })
            .finally(() => setBusy(false))
        },
        [],
      )

      const send = () => {
        if (!confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        post({ action: 'send', to, subject, text, confirm: true }).then((payload) => {
          if (payload) {
            setSent(`已发送到 ${to}`)
            setTo('')
            setSubject('')
            setText('')
            setTab('inbox')
          }
        })
      }

      const configured = status && status.configured

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', height: '100%', background: C.bg, color: C.text } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12 } },
          h('span', { style: { fontWeight: 600 } }, '📧 QQ邮箱'),
          h('span', { style: { fontFamily: C.mono, fontSize: 10, color: C.dim } }, status ? status.user || '' : ''),
          h(
            'span',
            { style: { marginLeft: 'auto', display: 'inline-flex', gap: 3 } },
            [
              { key: 'inbox', text: '收件箱' },
              { key: 'compose', text: '写邮件' },
            ].map((item) =>
              h(
                'span',
                {
                  key: item.key,
                  onClick: () => {
                    setTab(item.key)
                    setConfirming(false)
                    setSent(null)
                  },
                  style: {
                    fontSize: 10.5,
                    padding: '1px 7px',
                    borderRadius: 5,
                    cursor: 'pointer',
                    border: `1px solid ${C.border}`,
                    color: tab === item.key ? C.text : C.dim,
                    background: tab === item.key ? `color-mix(in srgb, ${C.accent} 22%, transparent)` : 'transparent',
                  },
                },
                item.text,
              ),
            ),
          ),
          tab === 'inbox'
            ? h('button', { type: 'button', disabled: !configured || busy, onClick: () => post({ action: 'fetch' }), style: btn() }, busy ? '…' : '收取')
            : null,
        ),
        !configured
          ? h(
              'div',
              { style: { padding: '14px 16px', fontSize: 12, color: C.dim, lineHeight: 1.6 } },
              h('div', { style: { color: C.warn, marginBottom: 6 } }, '还没配置凭据'),
              h('div', null, '把下面这行写进宿主上的这个文件：'),
              h('div', { style: { fontFamily: C.mono, fontSize: 11, margin: '6px 0', wordBreak: 'break-all' } }, status ? status.secretFile : '$DSH_HOME/dsh-qqmail-dock/secret.json'),
              h('div', { style: { fontFamily: C.mono, fontSize: 11 } }, '{"user":"你的QQ号@qq.com","authCode":"授权码"}'),
              h('div', { style: { marginTop: 8 } }, '授权码不是 QQ 密码：QQ邮箱 → 设置 → 账户 → 开启 IMAP/SMTP → 生成授权码。'),
              h('div', { style: { marginTop: 6 } }, '这个文件不会进 git，插件也不会把授权码写进日志或返回文本。'),
            )
          : tab === 'compose'
            ? h(
                'div',
                { style: { flex: '1 1 auto', minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 12px', gap: 8 } },
                h('input', { value: to, onChange: (e) => setTo(e.target.value), placeholder: '收件人', style: { ...input() } }),
                h('input', { value: subject, onChange: (e) => setSubject(e.target.value), placeholder: '主题', style: { ...input() } }),
                h('textarea', {
                  value: text,
                  onChange: (e) => setText(e.target.value),
                  placeholder: '正文（纯文本）',
                  style: { ...input(), flex: '1 1 auto', minHeight: 120, resize: 'none', lineHeight: 1.5 },
                }),
                sent ? h('div', { style: { fontSize: 11.5, color: '#3ddc84' } }, sent) : null,
                confirming
                  ? h('div', { style: { fontSize: 11.5, color: C.warn } }, `确认发给 ${to}？再点一次「发送」`)
                  : h('div', { style: { fontSize: 11, color: C.dim } }, '发送需要二次确认（和 Agent 侧的 confirm 门禁是同一个）。'),
                h(
                  'div',
                  { style: { display: 'flex', gap: 8 } },
                  h('button', { type: 'button', disabled: busy || !to.trim() || !text.trim(), onClick: send, style: { ...btn(), borderColor: C.warn, color: C.warn, padding: '4px 14px' } }, confirming ? '确认发送' : '发送'),
                  confirming ? h('button', { type: 'button', onClick: () => setConfirming(false), style: btn() }, '取消') : null,
                ),
              )
            : h(
                'div',
                { style: { flex: '1 1 auto', minHeight: 0, display: 'flex' } },
                h(
                  'div',
                  { style: { width: 210, flex: 'none', borderRight: `1px solid ${C.border}`, overflow: 'auto', padding: '4px 4px' } },
                  list.length
                    ? list.map((row) =>
                        h(
                          'div',
                          {
                            key: row.uid,
                            onClick: () => post({ action: 'read', uid: row.uid }),
                            style: {
                              padding: '5px 7px',
                              borderRadius: 6,
                              cursor: 'pointer',
                              borderBottom: `1px solid color-mix(in srgb, ${C.border} 60%, transparent)`,
                              background: message && message.uid === row.uid ? `color-mix(in srgb, ${C.accent} 18%, transparent)` : 'transparent',
                            },
                          },
                          h(
                            'div',
                            { style: { display: 'flex', gap: 5, fontSize: 11.5, alignItems: 'baseline' } },
                            row.seen ? null : h('span', { style: { color: C.accent, fontSize: 8, flex: 'none' } }, '●'),
                            h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, row.fromName || row.from),
                            h('span', { style: { marginLeft: 'auto', fontFamily: C.mono, fontSize: 9.5, color: C.dim, flex: 'none' } }, fmtWhen(row.date)),
                          ),
                          h(
                            'div',
                            { style: { fontSize: 11, color: C.dim, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 } },
                            row.subject,
                          ),
                        ),
                      )
                    : h('div', { style: { padding: 12, fontSize: 11.5, color: C.dim } }, '点右上「收取」拉取'),
                ),
                h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0, overflow: 'auto', padding: '10px 12px' } },
                  message
                    ? h(
                        'div',
                        null,
                        h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 4 } }, message.subject),
                        h(
                          'div',
                          { style: { fontSize: 11, color: C.dim, fontFamily: C.mono, marginBottom: 10 } },
                          `${message.fromName ? `${message.fromName} <${message.from}>` : message.from} · ${new Date(message.date).toLocaleString('zh-CN', { hour12: false })}`,
                        ),
                        h('div', { style: { fontSize: 12.5, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, message.text || '（没有可显示的正文）'),
                        message.truncated ? h('div', { style: { marginTop: 10, fontSize: 11, color: C.warn } }, '正文已截断') : null,
                      )
                    : h('div', { style: { fontSize: 11.5, color: C.dim } }, '左边点一封看正文'),
                ),
              ),
        error ? h('div', { style: { flex: 'none', padding: '6px 12px', borderTop: `1px solid ${C.border}`, fontSize: 11, color: C.err } }, error) : null,
      )
    }

    function btn() {
      return {
        border: `1px solid ${C.border}`,
        background: 'transparent',
        color: C.text,
        borderRadius: 6,
        fontSize: 11.5,
        padding: '1px 8px',
        cursor: 'pointer',
      }
    }

    function input() {
      return {
        background: 'transparent',
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        color: C.text,
        fontSize: 12,
        padding: '5px 8px',
        outline: 'none',
      }
    }

    function MailBody() {
      return h(MailPanel)
    }

    function MailTitle() {
      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
        h('span', { 'aria-hidden': 'true' }, '📧'),
        h('span', null, 'QQ邮箱'),
      )
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.inject(['sidebarRightTabs'], (scoped) => {
        scoped.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          priority: 'extension',
          title: () => 'QQ邮箱',
          guide: [
            {
              id: TAB_KIND,
              kind: TAB_KIND,
              order: 140,
              title: () => 'QQ 邮箱',
              description: () => '收件箱 · 读正文 · 发纯文本',
              icon: () => h('span', { style: { fontSize: 16 } }, '📧'),
            },
          ],
        })
      })
      ctx.inject(['slots'], (scoped) => {
        scoped.slots.inject('sidebar.right.pane.tab', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, MailBody),
        )
        scoped.slots.inject('sidebar.right.pane.tab.title', () =>
          scoped.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, MailTitle),
        )
      })
    }

    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
})()
