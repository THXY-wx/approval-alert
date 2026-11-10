# 授权弹窗提醒（Approval alert）

AI **申请访问权限**、**等你回答**、或**答完一轮**时，在屏幕右下角弹出一张**置顶的系统提示卡**
（可响铃），所以把 Harness 放在后台挂机时也不会漏掉。提示卡不抢焦点，理由消失后自动收起。

## 三个触发点

| 场景 | 挂在哪里 | 卡片行为 |
| --- | --- | --- |
| 申请权限 | `approval/request`（waterfall） | 留在屏幕上直到申请结束（允许 / 拒绝 / 超时） |
| 等你回答 | `user-questions/request`（`notifyQuestions: true` 时） | 回答后自动收起 |
| 答完一轮 | `session/event` 的 `turn/end`，仅 `completed` | 切回 Harness 后自动收起，同一会话只保留一张 |

权限与提问都必须**排在现有答复方之前**才能看到：Cordis 的 waterfall 由第一个返回结果的监听器
拍板，而界面里的授权对话框注册得更早、返回后就不再往下走。

```js
ctx.on('approval/request', async (request, next) => {
  const card = openCard(...)   // 弹出置顶提示卡
  try { return await next() }  // 原样交给后面的答复方（界面对话框）决定
  finally { card?.close() }    // 申请一结束就关掉提示卡
}, { prepend: true, global: true })
```

它只**观察**，不参与决策，所以“允许 / 拒绝 / 超时”的行为、已有弹窗都不变；即使提示卡启动失败，
权限申请仍然照常进行。

“答完一轮”走的是会话日志里的 `turn/end` 记录：只有 `completed` 才提醒，用户手动停止或出错的一轮
保持安静；子代理会话（`parentSession` / `origin: 'subagent'`）不提醒，否则父任务还没结束就会被刷屏。

## 卡片内容

- 标题（授权「需要授权确认」/ 回答「AI 已回答完成」，可配置）
- 主行：`AI 请求使用工具：pwsh`、`AI 正在等待你的回答`、或 `回答已完成，可以查看`
- 详情：申请原因 / 问题内容 / **回答开头的 110 字预览**
- 底行：`会话 27424d7c · 处理完成后自动关闭`
- 「打开 Harness」按钮：把 Harness 窗口切到前台并收起提示卡（用任务栏同款
  `SwitchToThisWindow`，避免被 Windows 前台锁拦下）

实现方式是每张卡一个独立 `powershell.exe` 进程，运行同目录的 `popup.ps1`，用 WinForms 画一张
`TopMost` 卡片（暗色/亮色跟随 Windows 应用主题，多屏时出现在鼠标所在屏幕，多张卡向上堆叠）。
Host 会直接结束对应进程，所以不会留下过期提醒；Host 进程意外退出时卡片会在 3 秒内自行关闭。
回答卡片在用户切回 Harness 约 2 秒后自动收起，因此挂机回来看到一次就不会再碍事；此时如果
Harness 本来就是前台窗口，卡片不响铃，避免聊天时每轮都响。

## 配置

在 profile 的 `cordis.patch.yml` 里加这段覆盖（改完即时生效，不需要重启）：

```yaml
- id: approval-alert
  config:
    enabled: true            # 总开关
    sound: true              # 弹出时播放系统提示音
    title: 需要授权确认        # 授权卡片标题
    questionTitle: 需要你的回答 # ask_user_question 时的标题
    finishedTitle: AI 已回答完成 # 回答完成时的标题
    notifyQuestions: false   # 是否提醒 ask_user_question（等待回答）
    notifyFinished: true     # 是否提醒“答完一轮”
    autoCloseSeconds: 0      # 授权/提问卡片自动关闭秒数；0 表示留到申请结束
    maxPopups: 4             # 同时最多几张卡；满了会先挤掉已完成（finished）的卡
```

## 限制

- 仅 Windows：卡片依赖 `powershell.exe` + WinForms。
- 不使用 Windows 通知中心，因为通知会在几秒后自动收起，挂机时会错过；置顶卡片会一直留到
  申请结束或用户回到 Harness。
- 卡片是独立进程，不跟随 Harness 的界面主题 token，只跟随 Windows 的明暗主题。
- 修改 `index.js` 后需要重新安装本 bundle 才会加载新代码（HMR 只在 profile 重新合成时替换模块）；
  改配置或 `popup.ps1` 不需要。

## 文件

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 插件：挂 `approval/request`、`user-questions/request`、`session/event`，起停卡片进程 |
| `popup.ps1` | 卡片本体：WinForms 置顶窗口、配色、响铃、按钮、焦点/看门狗定时器 |
| `cordis.patch.yml` | 插入行与默认配置 |
| `locale/*.json` | 插件列表里的标题和说明 |
