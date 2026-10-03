# dsh-qqmail-dock 📧

DSH 右侧栏的 **QQ 邮箱**：读最近邮件、看正文、发纯文本（发送要二次确认）。

> 这是给 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai/deepseek-harness) 右侧栏做的一排日常插件之一。
> 右侧栏本来就是 DSH 的「apps 入口」—— 官方的文件/终端/浏览器和第三方插件走的是**完全同一套机制**。

## 效果

![面板](https://cdn.jsdelivr.net/gh/lemonhall/dsh-qqmail-dock@main/docs/screenshot-panel.png)

（截图只裁了右侧栏面板。想换订阅源/分类/时长这些，改配置就行，不用碰代码。）

## 它能干什么

- IMAP over SSL（`imap.qq.com:993`）读，SMTP over SSL（`smtp.qq.com:465`）发
- **授权码只从 `$DSH_HOME/dsh-qqmail-dock/secret.json` 读**，绝不进 git、不进日志、**不回显**
- **发送门禁**：必须显式 `confirm=true`（面板上也要点两次）
- 正文提取：在 `bodyStructure` 里挑 `text/plain` → 退 `text/html` → 剥标签
- 输出默认是摘要；正文按 `previewChars` 截断，避免把长邮件灌进上下文

## 装

```
plugin_manager  install_bundle  target=link:E:\development\dsh-qqmail-dock
```

或从 npm：

```
dsh plugin --profile <你的 profile> add dsh-qqmail-dock
```

装好之后：右侧栏点「**+**」→ 选「**QQ 邮箱**」。

⚠️ **客户端半边改动要重启一次应用**；宿主半边热生效 —— 但**新增宿主路由要重启**（实测，别指望热重载）。

## 它是怎么work的

```
lib/index.js    宿主半：路由 + qqmail_panel 工具（Agent 侧读写同一份状态）
lib/state.js    本地状态（原子写：临时文件 + rename，读的人不会撞上写了一半的文件）
lib/client.js   右侧栏 tab（整个模块包在 IIFE 里 —— DSH 把所有客户端插件拼成一个脚本，
                顶层 const 会跨插件撞名，实测撞过一次直接把应用挡在启动之外）
```

**双向通道**：状态存在宿主，客户端 2 秒轮询。所以**你在面板里点一下，Agent 调工具就能读到**；
**Agent 写一次，面板自己会跟着变**。这不是"一个只读的看板"。

## 已知限制

- **只做「读 + 发」最小闭环**：不做 HTML 发送、附件、富文本、移动/删除/标已读
- 只支持 QQ 邮箱的服务器地址（改配置可换，但没为别的邮箱做过适配）
- 授权码不是 QQ 密码：要去 QQ 邮箱设置里单独生成

## License

MIT
