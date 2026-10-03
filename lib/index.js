/**
 * Host half of dsh-qqmail-dock —— QQ 邮箱的宿主半（读 IMAP / 发 SMTP）。
 *
 * 三条硬规矩（照 kotlinagentapp 的 PRD-0019）：
 *   1. 凭据**只从私有文件** `$DSH_HOME/dsh-qqmail-dock/secret.json` 读；不经 argv；
 *      授权码**绝不出现在返回文本、日志或错误信息里**（错误里统一打码）。
 *   2. 发送**必须显式 confirm**（requireConfirm）。
 *   3. 只做「读 + 发」最小闭环：不做 HTML、附件、富文本、移动/删除/标已读。
 *
 * 依赖 imapflow / nodemailer（已在 package.json 的 dependencies 里）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createStateStore } from './state.js'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const DEFAULTS = {
  imapHost: 'imap.qq.com',
  imapPort: 993,
  smtpHost: 'smtp.qq.com',
  smtpPort: 465,
  folder: 'INBOX',
  fetchCount: 20,
  previewChars: 1200,
  requireConfirm: true,
  timeoutMs: 20000,
}

const ROUTE_STATE = '/dsh-qqmail/state'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SECRET_FILE = join(DSH_HOME, 'dsh-qqmail-dock', 'secret.json')

const stateStore = createStateStore(join(DSH_HOME, 'dsh-qqmail-dock', 'state.json'), {
  lastFetchAt: null,
  lastFolder: null,
  selectedUid: null,
  cache: [], // 上次取到的摘要（只存摘要，不存正文）
  pendingQuestion: null,
})

/** 读私有凭据。拿不到就返回空对象，由调用方给出"未配置"的可解释提示。 */
function readSecret() {
  try {
    if (!existsSync(SECRET_FILE)) return {}
    const parsed = JSON.parse(readFileSync(SECRET_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** 把可能混进错误信息里的授权码打码（防御性，正常不会出现）。 */
function mask(text, secret) {
  let out = String(text == null ? '' : text)
  for (const value of [secret && secret.authCode, secret && secret.pass, secret && secret.password]) {
    if (value && String(value).length >= 4) out = out.split(String(value)).join('<MASKED>')
  }
  return out
}

function sendJson(res, status, payload) {
  try {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch {
    /* 连接已经断了 */
  }
}

/** 在 bodyStructure 树里找第一个匹配的叶子节点（叶子才有 part id）。 */
export function findPart(node, wantType) {
  if (!node) return null
  if (node.childNodes && node.childNodes.length) {
    for (const child of node.childNodes) {
      const hit = findPart(child, wantType)
      if (hit) return hit
    }
    return null
  }
  if (!wantType) return node
  return String(node.type || '').toLowerCase().includes(wantType) ? node : null
}

/** 从 imapflow 的 envelope 里抽出一行摘要。 */
export function summarizeEnvelope(envelope, uid) {
  const from = (envelope && envelope.from && envelope.from[0]) || {}
  const subject = (envelope && envelope.subject) || '(无主题)'
  const date = envelope && envelope.date ? new Date(envelope.date).getTime() : 0
  return {
    uid,
    from: from.address || '',
    fromName: from.name || '',
    subject: String(subject).slice(0, 160),
    date,
  }
}

/** 正文挑纯文本：优先 text/plain，退到把 HTML 标签剥掉。 */
export function pickBody(parts) {
  const plain = (parts || []).find((part) => typeof part === 'string' && !/<[a-z][\s\S]*>/i.test(part))
  if (plain) return { text: plain, fromHtml: false }
  const html = (parts || []).find((part) => typeof part === 'string' && part.length)
  if (!html) return { text: '', fromHtml: false }
  return {
    text: html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    fromHtml: true,
  }
}

/** Host plugin body. */
function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const opts = { ...DEFAULTS, ...cfg }
  const secret = readSecret()
  const configured = Boolean(secret.user && secret.authCode)

  let ImapFlow = null
  let nodemailer = null
  async function loadLibs() {
    if (ImapFlow && nodemailer) return { ImapFlow, nodemailer }
    const imap = await import('imapflow')
    const mail = await import('nodemailer')
    ImapFlow = imap.ImapFlow || (imap.default && imap.default.ImapFlow)
    nodemailer = mail.default || mail
    if (!ImapFlow || !nodemailer) throw new Error('imapflow / nodemailer 没正确加载')
    return { ImapFlow, nodemailer }
  }

  async function withImap(handler) {
    if (!configured) throw new Error(`未配置：请把 {"user":"…@qq.com","authCode":"…"} 写进 ${SECRET_FILE}（授权码不是 QQ 密码）`)
    const { ImapFlow: Flow } = await loadLibs()
    const client = new Flow({
      host: opts.imapHost,
      port: Number(opts.imapPort),
      secure: true,
      auth: { user: secret.user, pass: secret.authCode },
      logger: false,
      socketTimeout: Number(opts.timeoutMs),
    })
    await client.connect()
    try {
      return await handler(client)
    } finally {
      try {
        await client.logout()
      } catch {
        /* fine */
      }
    }
  }

  /** 取最近若干封的摘要（不拉正文，省流量也省上下文）。 */
  async function fetchList(count) {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(opts.folder)
      try {
        const total = client.mailbox && client.mailbox.exists ? client.mailbox.exists : 0
        if (!total) return []
        const limit = Math.min(60, Math.max(1, count || opts.fetchCount))
        const from = Math.max(1, total - limit + 1)
        const rows = []
        for await (const message of client.fetch(`${from}:*`, { uid: true, envelope: true, flags: true })) {
          const summary = summarizeEnvelope(message.envelope, message.uid)
          summary.seen = Boolean(message.flags && (message.flags.has ? message.flags.has('\\Seen') : false))
          rows.push(summary)
        }
        return rows.sort((a, b) => b.date - a.date)
      } finally {
        lock.release()
      }
    })
  }

  /** 读一封的正文。 */
  async function readMessage(uid) {
    return withImap(async (client) => {
      const lock = await client.getMailboxLock(opts.folder)
      try {
        // fetchOne 比手动 for-await fetch 更直接（要 uid 选项，否则按序号找）
        const found =
          (await client.fetchOne(String(uid), { uid: true, envelope: true, bodyStructure: true }, { uid: true })) || null
        if (!found) return null

        // 从 bodyStructure 里挑可读的那一段：
        //   优先 text/plain → 退到 text/html → 再退到第一个叶子节点
        const picked =
          findPart(found.bodyStructure, 'text/plain') ||
          findPart(found.bodyStructure, 'text/html') ||
          findPart(found.bodyStructure, null)

        // download() 必须先 await（返回 { meta, content }），而 content 是**流**：
        // 要 for-await 收集再拼。最早那版写成 `for await (const c of client.download(...))`
        // —— 拿到的其实是 Promise，于是报 "not a function or its return value is not async iterable"；
        // 改成同步读 content 又得到 "[object Object]"，因为它不是 Buffer 而是流。
        let text = ''
        let fromHtml = false
        const partId = picked && picked.part ? String(picked.part) : '1'
        try {
          const downloaded = await client.download(String(uid), partId, { uid: true })
          const stream = downloaded && downloaded.content ? downloaded.content : null
          if (stream) {
            const chunks = []
            for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
            text = Buffer.concat(chunks).toString('utf8')
            fromHtml = picked ? String(picked.type || '').toLowerCase().includes('html') : false
          }
        } catch (error) {
          // 取正文失败不该让整次读取崩掉：至少把主题/发件人给出来
          text = `（正文取不到：${mask((error && error.message) || error, secret)}）`
        }

        const body = fromHtml ? pickBody([text]) : { text, fromHtml: false }
        const limited = body.text.slice(0, Math.max(200, Number(opts.previewChars) || 1200))
        return {
          ...summarizeEnvelope(found.envelope, found.uid),
          text: limited,
          truncated: body.text.length > limited.length,
          fromHtml: Boolean(body.fromHtml),
        }
      } finally {
        lock.release()
      }
    })
  }

  /** 发纯文本。 */
  async function sendMail(to, subject, text) {
    if (!configured) throw new Error(`未配置：请把 {"user":"…@qq.com","authCode":"…"} 写进 ${SECRET_FILE}`)
    const { nodemailer: mailer } = await loadLibs()
    const transport = mailer.createTransport({
      host: opts.smtpHost,
      port: Number(opts.smtpPort),
      secure: true,
      auth: { user: secret.user, pass: secret.authCode },
      connectionTimeout: Number(opts.timeoutMs),
    })
    const info = await transport.sendMail({ from: secret.user, to, subject: subject || '(无主题)', text })
    try {
      transport.close()
    } catch {
      /* fine */
    }
    return { messageId: info && info.messageId, accepted: (info && info.accepted) || [] }
  }

  const status = () => ({
    configured,
    user: configured ? String(secret.user).replace(/^(.).*(@.*)$/, '$1***$2') : null,
    secretFile: SECRET_FILE,
    imap: `${opts.imapHost}:${opts.imapPort}`,
    smtp: `${opts.smtpHost}:${opts.smtpPort}`,
    folder: opts.folder,
    requireConfirm: Boolean(opts.requireConfirm),
  })

  ctx.inject(['tools'], (toolScoped) => {
    toolScoped.tools.register({
      name: 'qqmail_panel',
      description:
        'DSH 右侧栏「QQ 邮箱」面板：读最近邮件、看某封正文、发纯文本邮件。凭据存在本地私有文件里，授权码不会出现在任何返回文本里。' +
        'action=status 看是否已配置；action=list 取最近邮件摘要（可给 count）；action=read 看正文（需要 uid）；' +
        'action=send 发信（需要 to、subject、text，且必须显式 confirm=true）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'list', 'read', 'send'], description: '要做的动作。' },
          uid: { type: 'string', description: 'read：邮件 uid（从 list 拿）。' },
          count: { type: 'number', description: 'list：取几封，默认 20。' },
          to: { type: 'string', description: 'send：收件人。' },
          subject: { type: 'string', description: 'send：主题。' },
          text: { type: 'string', description: 'send：正文（纯文本）。' },
          confirm: { type: 'boolean', description: 'send：必须显式 true，否则拒绝发送。' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        render(_args, value) {
          return [{ type: 'text', text: String((value && value.text) || '') }]
        },
      },
      presentCall(args) {
        return { card: 'terminal', title: `qqmail_panel ${String((args && args.action) || 'list')}`.trim() }
      },
      async execute(args) {
        const action = String((args && args.action) || 'list').toLowerCase()
        const info = status()
        try {
          if (action === 'status') {
            return {
              text:
                `配置：${info.configured ? '已配置' : '未配置'}\n账号：${info.user || '（无）'}\n` +
                `IMAP ${info.imap} · SMTP ${info.smtp} · 文件夹 ${info.folder}\n` +
                `凭据文件：${info.secretFile}\n发送门禁：${info.requireConfirm ? '需要 confirm=true' : '关闭'}` +
                (info.configured ? '' : `\n\n要启用：把 {"user":"你的QQ号@qq.com","authCode":"授权码"} 写进上面那个文件（授权码不是 QQ 密码）`),
            }
          }
          if (action === 'list') {
            const rows = await fetchList(args.count)
            stateStore.patch({ lastFetchAt: Date.now(), lastFolder: opts.folder, cache: rows.slice(0, 40) })
            if (!rows.length) return { text: `${opts.folder} 里没有邮件` }
            return {
              text: rows
                .map((row) => `- ${new Date(row.date).toLocaleString('zh-CN', { hour12: false })}  ${row.seen ? ' ' : '●'} ${row.fromName || row.from}\n    主题：${row.subject}\n    uid=${row.uid}`)
                .join('\n'),
            }
          }
          if (action === 'read') {
            const uid = String(args.uid || '').trim()
            if (!uid) return { text: 'read 需要 uid' }
            const message = await readMessage(uid)
            if (!message) return { text: `没找到 uid=${uid}` }
            stateStore.patch({ selectedUid: uid })
            return {
              text:
                `发件人：${message.fromName ? `${message.fromName} <${message.from}>` : message.from}\n` +
                `主题：${message.subject}\n时间：${new Date(message.date).toLocaleString('zh-CN', { hour12: false })}\n\n` +
                message.text +
                (message.truncated ? '\n\n（正文已截断，完整内容请在面板里看）' : ''),
            }
          }
          if (action === 'send') {
            if (opts.requireConfirm && args.confirm !== true) {
              return { text: '拒绝发送：需要显式 confirm=true（发送门禁，照 PRD-0019 的 ConfirmRequired）' }
            }
            const to = String(args.to || '').trim()
            if (!to) return { text: 'send 需要 to' }
            const result = await sendMail(to, args.subject, String(args.text || ''))
            return { text: `已发送到 ${to}（messageId=${result.messageId || '未知'}）` }
          }
          return { text: `不认识的动作：${action}` }
        } catch (error) {
          return { text: `出错了：${mask((error && error.message) || error, secret)}` }
        }
      },
    })
  })

  ctx.inject(['webServer'], (scoped) => {
    const disposers = []
    disposers.push(
      scoped.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: (req, res) => {
          const method = String((req && req.method) || 'GET').toUpperCase()
          const headers = (req && req.headers) || {}
          if (String(headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
            res.statusCode = 403
            res.end()
            return
          }
          if (method === 'GET' || method === 'HEAD') {
            const s = stateStore.get()
            sendJson(res, 200, { ok: true, status: status(), cache: s.cache || [], lastFetchAt: s.lastFetchAt, selectedUid: s.selectedUid })
            return
          }
          if (method === 'POST') {
            let raw = ''
            req.on('data', (chunk) => {
              raw += chunk
              if (raw.length > 1024 * 1024) req.destroy()
            })
            req.on('end', async () => {
              let body = {}
              try {
                body = raw.trim() ? JSON.parse(raw) : {}
              } catch {
                sendJson(res, 400, { ok: false, error: '请求体不是 JSON' })
                return
              }
              const action = String(body.action || '').toLowerCase()
              try {
                if (action === 'fetch') {
                  const rows = await fetchList(body.count)
                  const s = stateStore.patch({ lastFetchAt: Date.now(), lastFolder: opts.folder, cache: rows.slice(0, 40) })
                  sendJson(res, 200, { ok: true, list: rows, cache: s.cache, status: status() })
                  return
                }
                if (action === 'read') {
                  const message = await readMessage(String(body.uid || ''))
                  if (message) stateStore.patch({ selectedUid: String(body.uid) })
                  sendJson(res, 200, { ok: true, message, status: status() })
                  return
                }
                if (action === 'send') {
                  if (opts.requireConfirm && body.confirm !== true) {
                    sendJson(res, 400, { ok: false, error: '发送被拒：需要显式确认' })
                    return
                  }
                  const result = await sendMail(String(body.to || '').trim(), body.subject, String(body.text || ''))
                  sendJson(res, 200, { ok: true, result })
                  return
                }
                sendJson(res, 400, { ok: false, error: `不认识的动作：${action}` })
              } catch (error) {
                sendJson(res, 502, { ok: false, error: mask((error && error.message) || error, secret) })
              }
            })
            return
          }
          res.statusCode = 405
          res.end()
        },
      }),
    )

    ctx.on('dispose', () => {
      for (const off of disposers) {
        try {
          off()
        } catch {
          /* already gone */
        }
      }
    })
  })
}

export { apply, ROUTE_STATE, DEFAULTS, mask }
