/**
 * QQ 邮箱插件的纯函数测试（不用连网、不用凭据）：
 *   node test/qqmail.test.mjs
 * 重点测两件事：**授权码打码**（安全）与**从一堆 MIME 段里挑正文**。
 */
import { mask, summarizeEnvelope, pickBody } from '../lib/index.js'

let failed = 0
function check(name, actual, expected) {
  const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v))
  const ok = show(actual) === show(expected)
  if (!ok) failed += 1
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    期望 ${show(expected)}\n    实际 ${show(actual)}`}`)
}

// --- 打码：授权码绝不能原样出现在任何输出里 ---
const secret = { user: 'a@qq.com', authCode: 'abcdef123456' }
check('错误信息里的授权码被打码', mask('login failed for abcdef123456', secret), 'login failed for <MASKED>')
check('多处出现全打掉', mask('abcdef123456 then abcdef123456', secret), '<MASKED> then <MASKED>')
check('别的密码字段也打码', mask('p@ssw0rd!', { pass: 'p@ssw0rd!' }), '<MASKED>')
check('没命中就原样', mask('IMAP 连接超时', secret), 'IMAP 连接超时')
check('太短的字段不打（避免把正常文字打烂）', mask('abc ok', { authCode: 'abc' }), 'abc ok')
check('null 不炸', mask(null, secret), '')

// --- 摘要：从 imapflow 的 envelope 结构里抽一行 ---
const summary = summarizeEnvelope(
  { from: [{ name: '某人', address: 'x@example.com' }], subject: '关于下周的事', date: '2026-10-03T01:00:00.000Z' },
  '42',
)
check('发件人地址', summary.from, 'x@example.com')
check('发件人名字', summary.fromName, '某人')
check('主题', summary.subject, '关于下周的事')
check('uid', summary.uid, '42')
check('时间转毫秒', summary.date, Date.parse('2026-10-03T01:00:00.000Z'))
check('缺 envelope 不炸', summarizeEnvelope(null, '1').subject, '(无主题)')
check('超长主题截断', summarizeEnvelope({ subject: 'x'.repeat(300) }, '2').subject.length, 160)

// --- 正文挑选 ---
check(
  '有纯文本就优先纯文本',
  pickBody(['<html><body><p>HTML 版</p></body></html>', '这是纯文本版']).text,
  '这是纯文本版',
)
const htmlOnly = pickBody(['<html><body><p>你好</p><br><p>世界</p></body></html>'])
check('只有 HTML 时剥标签', htmlOnly.text.includes('你好') && htmlOnly.text.includes('世界'), true)
check('剥 HTML 时标记来源', htmlOnly.fromHtml, true)
check('HTML 里的 style/script 丢掉', /color|function/.test(pickBody(['<style>p{color:red}</style><script>function x(){}</script><p>正文</p>']).text), false)
check('空输入给空串', pickBody([]).text, '')
check('实体还原', pickBody(['<p>a &amp; b &lt;c&gt;</p>']).text.includes('a & b <c>'), true)

console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
process.exit(failed ? 1 : 0)
