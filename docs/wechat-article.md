# 把 QQ 邮箱接进 DSH 右侧栏：两个 409 和一个流

📧 **QQ 邮箱** —— DSH 右侧栏的一个新 tab。

## 为什么做这个

收件箱里的东西经常需要被我处理 —— 那它就该出现在我干活的地方，而不是另一个窗口。

## 长什么样

![QQ 邮箱](https://cdn.jsdelivr.net/gh/lemonhall/dsh-qqmail-dock@main/docs/screenshot-panel.png)

（图只截了右侧栏面板。我这台机器桌面左下角有真名，所以截图从来不整屏。）

## 它能干什么

- IMAP over SSL（`imap.qq.com:993`）读，SMTP over SSL（`smtp.qq.com:465`）发
- **授权码只从 `$DSH_HOME/dsh-qqmail-dock/secret.json` 读**，绝不进 git、不进日志、**不回显**
- **发送门禁**：必须显式 `confirm=true`（面板上也要点两次）
- 正文提取：在 `bodyStructure` 里挑 `text/plain` → 退 `text/html` → 剥标签
- 输出默认是摘要；正文按 `previewChars` 截断，避免把长邮件灌进上下文

## 一个值得说的设计决定

**授权码只从私有文件读，且任何输出都先过一遍打码。** 凭据存在 `$DSH_HOME/dsh-qqmail-dock/secret.json`，不进 git、不进日志。真正难的不是 IMAP，是 imapflow 的 `download()`：它返回 Promise，而解出来的 `content` 是**流** —— 我第一版直接拿返回去 `for await`，面板上报 `not a function or its return value is not async iterable`；改成同步读又得到 `[object Object]`。正解是 `await` 之后再 `for await` 收集。另外**发送必须显式 confirm**（面板上也要点两次）。

## 双向的，不只看

这是这批插件的共同点：**状态在宿主、界面 2 秒轮询**。所以我在面板里点一下，Agent 调工具就能读到；Agent 写一次（比如「帮我记一笔午饭 12.5」），面板自己就变了。

装：

```
# 先装 DSH（桌面版从 https://harness.deepseek.com 下载安装包；只要 CLI 的话）：
npm i -g @deepseek-ai/dsh

# 再装这个插件（桌面版也可以走 GUI：右侧栏「插件 → 添加插件」）
dsh plugin --profile desktop add dsh-qqmail-dock

# 如果你是开发者、想用本地目录直接挂：
plugin_manager install_bundle target=link:E:\development\dsh-qqmail-dock
```

代码在 <https://github.com/lemonhall/dsh-qqmail-dock>，npm 上是 `dsh-qqmail-dock`。右侧栏点「**+**」→ 选「QQ 邮箱」就能看到它。

## 已知限制

- **只做「读 + 发」最小闭环**：不做 HTML 发送、附件、富文本、移动/删除/标已读
- 只支持 QQ 邮箱的服务器地址（改配置可换，但没为别的邮箱做过适配）
- 授权码不是 QQ 密码：要去 QQ 邮箱设置里单独生成
