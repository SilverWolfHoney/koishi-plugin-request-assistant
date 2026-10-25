# koishi-plugin-request-assistant

一个面向 NapCat / OneBot 11 的 Koishi 申请处理插件：自动同意好友申请和群邀请，并把入群申请发到群里，由群主或管理员引用通知回复「同意」或「拒绝」来处理。

## 功能

- 自动同意好友申请
- 自动同意把机器人拉进群的群邀请
- 收到入群申请时，在群内发通知并 @ 群主
- 群主/管理员引用通知回复「同意」「拒绝 理由」即可审批
- 可选接入 ChatLuna：用模型理解管理员的一句话（例如「行，放进来吧」），失败时回退到关键词判断
- 群系统消息轮询：补救 NapCat 漏报的入群申请和群邀请
- 好友验证私聊兜底：NapCat 有时不发送 `friend-request` 事件，而是把验证消息当普通私聊投递

## 环境

- Koishi 4.18+
- `koishi-plugin-adapter-onebot` + NapCat（或其他 OneBot 11 实现）
- 可选：ChatLuna（用于 AI 判断管理员回复的意图）
- 可选：`@langchain/core`（仅在启用 AI 判断时需要，缺失时会自动回退到关键词）

> 插件调用了 NapCat 的部分扩展接口（`get_doubt_friends_add_request`、`set_doubt_friends_add_request`、`get_group_system_msg`），在其他 OneBot 实现上可能不可用。

## 安装

### 从源码安装

```bash
cd /path/to/koishi-app
mkdir -p local-plugins
git clone https://github.com/SilverWolfHoney/koishi-plugin-request-assistant.git \
  local-plugins/koishi-plugin-request-assistant
```

在 `package.json` 的 `dependencies` 中加入：

```json
"koishi-plugin-request-assistant": "file:local-plugins/koishi-plugin-request-assistant"
```

然后安装并启动：

```bash
npm install
npm start
```

在 Koishi 控制台的插件市场/插件配置里启用 `request-assistant`，或直接写进 `koishi.yml`：

```yaml
plugins:
  request-assistant:abc123:
    autoApproveFriend: true
    autoApproveInvite: true
    notifyJoinRequest: true
    pollJoinRequests: true
```

## 配置

| 配置项 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `autoApproveFriend` | boolean | `true` | 自动同意所有好友申请 |
| `autoApproveInvite` | boolean | `true` | 自动同意所有把机器人拉进群的群邀请 |
| `notifyJoinRequest` | boolean | `true` | 有入群申请时在群内通知群主/管理员 |
| `adminOnly` | boolean | `true` | 只有群主或管理员可以处理入群申请 |
| `allowSingleWithoutQuote` | boolean | `true` | 同一个群只有一个待处理申请时，允许不引用通知直接回复 |
| `confirmInGroup` | boolean | `true` | 处理完成后在群里发送确认消息 |
| `mentionOwner` | boolean | `true` | 发入群申请通知时 @ 群主 |
| `pendingTimeoutMinutes` | number | `1440` | 待处理申请的超时时间（分钟） |
| `decisionModel` | string | 空 | AI 判断使用的模型；留空则使用 ChatLuna 默认模型 |
| `aiTimeoutMs` | number | `15000` | AI 判断超时时间（毫秒） |
| `pollJoinRequests` | boolean | `true` | 定期轮询群系统消息，补救漏报的入群申请和群邀请 |
| `joinPollInterval` | number | `60` | 群系统消息轮询间隔（秒） |

## 使用

当有人申请加群时，机器人会在群里发送类似下面的通知：

```
【入群申请】
申请人：小明（10001）
附言：我是群友
请群主或管理员引用本条消息回复「同意」或「拒绝 理由」。
```

群主或管理员**引用这条通知**回复：

- `同意` / `通过` / `放进来吧` → 同意
- `拒绝 人满了` / `不同意` → 拒绝，并带上理由

启用 ChatLuna 和 `decisionModel` 后，模型会尝试理解更自然的表达；模型不可用或超时会自动退回关键词判断。

## 已知限制

- **普通好友申请无法轮询。** NapCat 只暴露了 `get_doubt_friends_add_request`（已过滤/可疑申请队列），普通待处理申请在核心的 `getBuddyReq().buddyReqs` 里，没有对应的 OneBot action。因此插件依靠 `friend-request` 事件和好友验证私聊来处理，不做好友申请轮询。
- 群入群申请和群邀请事件依赖 NapCat 的通知更新，离线期间可能漏报；插件用 `get_group_system_msg` 每 60 秒补捞一次。
- 群审批通知保存在内存里，机器人重启后之前发出的通知不能再按引用匹配。
- 插件会调用 NapCat 扩展接口，换用其他 OneBot 实现时请先验证兼容性。

## 测试

```bash
npm test
```

测试不依赖真实 QQ / NapCat，使用 mock 的 `ctx` 和 `bot.internal`。在独立目录运行前需要能解析到 `koishi`（可在 Koishi 应用目录内运行，或自行安装依赖）。

## License

MIT
