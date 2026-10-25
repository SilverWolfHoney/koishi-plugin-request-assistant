const assert = require('node:assert')
const plugin = require('..')

const handlers = {}
const sent = []
const apiCalls = []
const warnings = []
const timers = { intervals: [], timeouts: [] }
let notifySeq = 0
let lastNotifyId = ''
let doubtList = []
let groupSystemMsg = { join_requests: [] }
const failingFriendFlags = new Set()
const friendIds = ['FRIEND1']

const logger = {
  info() {},
  warn(...args) {
    warnings.push(args.join(' '))
  },
  debug() {},
  error(...args) {
    console.log('[error]', ...args)
  },
}

const ctx = {
  logger: () => logger,
  bots: [],
  on(event, handler) {
    handlers[event] = handler
  },
  middleware(handler) {
    handlers.middleware = handler
  },
  setInterval(callback) {
    timers.intervals.push(callback)
    return () => {}
  },
  setTimeout(callback) {
    timers.timeouts.push(callback)
    return () => {}
  },
  chatluna: undefined,
}

function makeInternal() {
  return {
    async setFriendAddRequest(...args) {
      apiCalls.push(['setFriendAddRequest', ...args])
      if (failingFriendFlags.has(String(args[0]))) {
        throw new Error('No such request')
      }
    },
    async getFriendList() {
      return friendIds.map((user_id) => ({ user_id }))
    },
    async _get(action, params) {
      apiCalls.push(['_get', action, params])
      if (action === 'get_doubt_friends_add_request') return doubtList
      if (action === 'set_doubt_friends_add_request') return null
      if (action === 'get_group_system_msg') return groupSystemMsg
      throw new Error(`unknown action ${action}`)
    },
    async setGroupAddRequest(...args) {
      apiCalls.push(['setGroupAddRequest', ...args])
    },
    async getStrangerInfo(userId) {
      return { user_id: userId, nickname: '申请人' }
    },
    async getGroupMemberInfo() {
      return { role: 'member' }
    },
    async getGroupMemberList() {
      return [{ user_id: 'OWNER1', role: 'owner' }]
    },
    async sendGroupMsg(groupId, content) {
      apiCalls.push(['sendGroupMsg', groupId, content])
      lastNotifyId = String(++notifySeq)
      return lastNotifyId
    },
  }
}

function makeSession(overrides = {}) {
  return {
    platform: 'onebot',
    selfId: 'bot',
    guildId: 'G1',
    userId: 'U1',
    content: '',
    messageId: '',
    author: { roles: [] },
    quote: undefined,
    bot: {
      internal: makeInternal(),
      async sendMessage(channelId, content) {
        apiCalls.push(['sendMessage', channelId, content])
        lastNotifyId = String(++notifySeq)
        return [lastNotifyId]
      },
    },
    async send(content) {
      sent.push(content)
      return []
    },
    ...overrides,
  }
}

async function newJoinRequest(flag, userId = 'U1', comment = '我是小明') {
  await handlers['guild-member-request'](
    makeSession({ messageId: flag, guildId: 'G1', userId, content: comment })
  )
  const notify = apiCalls.pop()
  assert.strictEqual(notify[0], 'sendMessage')
  assert.strictEqual(notify[1], 'G1')
  const parts = notify[2]
  assert.ok(Array.isArray(parts))
  assert.ok(parts.some((part) => part?.type === 'at' && part?.attrs?.id === 'OWNER1'))
  const text = parts.filter((part) => typeof part === 'string').join('')
  assert.match(text, /【入群申请】/)
  return lastNotifyId
}

async function reply({ id, text, role = 'admin', userId = 'ADMIN1', onebot }) {
  let nextCalled = false
  await handlers.middleware(
    makeSession({
      guildId: 'G1',
      userId,
      content: text,
      quote: id ? { id } : undefined,
      onebot,
      author: { roles: [{ id: role }] },
    }),
    async () => {
      nextCalled = true
    }
  )
  return nextCalled
}

async function main() {
  plugin.apply(ctx, plugin.Config({}))

  // 好友申请 -> 自动同意
  await handlers['friend-request'](makeSession({ messageId: 'F1', userId: 'U9' }))
  assert.deepStrictEqual(apiCalls.pop(), ['setFriendAddRequest', 'F1', true, ''])

  // 被邀请进群 -> 自动同意
  await handlers['guild-request'](
    makeSession({ messageId: 'I1', guildId: 'G9', userId: 'U8', subtype: 'invite' })
  )
  assert.deepStrictEqual(apiCalls.pop(), ['setGroupAddRequest', 'I1', 'invite', true, ''])

  // 入群申请 -> 群里发通知
  const notify1 = await newJoinRequest('J1', 'U1', '我是小明')
  const notify = apiCalls.length
  assert.strictEqual(notify, 0)
  assert.match(lastNotifyId, /^\d+$/)

  // 管理员引用通知回复“同意”（AI 未启用，走关键词兜底）
  const handledByMiddleware = await reply({ id: notify1, text: '同意' })
  assert.strictEqual(handledByMiddleware, false)
  assert.deepStrictEqual(apiCalls.pop(), ['setGroupAddRequest', 'J1', 'add', true, ''])
  assert.match(sent.pop(), /已同意/)

  // 新申请，群主回复“拒绝 满员了”
  const notify2 = await newJoinRequest('J2', 'U2', '拉我')
  await reply({ id: notify2, text: '拒绝 满员了', role: 'owner', userId: 'OWNER1' })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'J2',
    'add',
    false,
    '满员了',
  ])
  assert.match(sent.pop(), /已拒绝/)

  // 普通成员回复 -> 不处理
  const notify3 = await newJoinRequest('J3', 'U3', '申请')
  await reply({ id: notify3, text: '同意', role: 'member', userId: 'MEMBER1' })
  assert.strictEqual(apiCalls.length, 0)
  assert.match(sent.pop(), /只有群主或管理员/)

  // “不同意”按拒绝处理（单条待处理且不引用也生效）
  await reply({ text: '不同意 人满了' })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'J3',
    'add',
    false,
    '人满了',
  ])

  // 待处理清空后，普通回复不应触发任何操作，且应继续传给后续中间件
  apiCalls.length = 0
  sent.length = 0
  const passedThrough = await reply({ text: '同意' })
  assert.strictEqual(passedThrough, true)
  assert.strictEqual(apiCalls.length, 0)
  assert.strictEqual(sent.length, 0)

  // 机器人自己的消息不处理
  const notify4 = await newJoinRequest('J4', 'U4', '申请')
  let selfNextCalled = false
  await handlers.middleware(
    makeSession({
      selfId: 'bot',
      userId: 'bot',
      guildId: 'G1',
      content: '同意',
      quote: { id: notify4 },
      author: { roles: [{ id: 'admin' }] },
    }),
    async () => {
      selfNextCalled = true
    }
  )
  assert.strictEqual(selfNextCalled, true)
  assert.strictEqual(apiCalls.length, 0)

  // 私聊消息即使带 guildId，也不能用来审批群申请
  apiCalls.length = 0
  sent.length = 0
  let privateNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: 'G1',
      userId: 'ADMIN1',
      content: '同意',
      author: { roles: [{ id: 'admin' }] },
    }),
    async () => {
      privateNextCalled = true
    }
  )
  assert.strictEqual(privateNextCalled, true)
  assert.strictEqual(apiCalls.length, 0)
  assert.strictEqual(sent.length, 0)

  // 清掉 J4，避免影响后续用例
  await reply({ id: notify4, text: '同意' })
  apiCalls.pop()

  // 启用 AI 判断
  let aiResponse = '{"decision":"approve","reason":""}'
  let aiError = null
  ctx.chatluna = {
    config: { defaultModel: 'test/model' },
    async createChatModel() {
      if (aiError) throw aiError
      return {
        value: {
          async invoke() {
            return { content: aiResponse }
          },
        },
      }
    },
  }

  // 管理员说“行，放进来吧” -> AI 判断为同意
  const notify5 = await newJoinRequest('J5', 'U5', '朋友推荐')
  await reply({ id: notify5, text: '行，放进来吧' })
  assert.deepStrictEqual(apiCalls.pop(), ['setGroupAddRequest', 'J5', 'add', true, ''])

  // 管理员说“这人不行，别放” -> AI 判断为拒绝并提取理由
  aiResponse = '{"decision":"reject","reason":"看着像广告"}'
  const notify6 = await newJoinRequest('J6', 'U6', '进群看看')
  await reply({ id: notify6, text: '这人不行，别放' })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'J6',
    'add',
    false,
    '看着像广告',
  ])

  // AI 返回 Markdown 代码块时也能解析
  aiResponse = '```json\n{"decision":"reject","reason":"重复申请"}\n```'
  const notify6b = await newJoinRequest('J6b', 'U6B', '再试一次')
  await reply({ id: notify6b, text: '别批了' })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'J6b',
    'add',
    false,
    '重复申请',
  ])

  // AI 判断为 unknown -> 不处理，要求管理员说清楚
  aiResponse = '{"decision":"unknown","reason":""}'
  const notify7 = await newJoinRequest('J7', 'U7', '申请')
  await reply({ id: notify7, text: '他是谁？' })
  assert.strictEqual(apiCalls.length, 0)
  assert.match(sent.pop(), /没看懂你的决定/)

  // 管理员随后明确回复“同意” -> 处理同一个申请
  aiResponse = '{"decision":"approve","reason":""}'
  await reply({ id: notify7, text: '同意' })
  assert.deepStrictEqual(apiCalls.pop(), ['setGroupAddRequest', 'J7', 'add', true, ''])

  // AI 调用失败 -> 退回关键词判断
  aiError = new Error('AI unavailable')
  const notify8 = await newJoinRequest('J8', 'U8', '申请')
  await reply({ id: notify8, text: '同意' })
  assert.deepStrictEqual(apiCalls.pop(), ['setGroupAddRequest', 'J8', 'add', true, ''])

  // 引用通知但 adapter 没补全 quote 时，仍能从原始 reply 段取到消息 ID
  aiError = null
  aiResponse = '{"decision":"approve","reason":""}'
  const notifyQuote = await newJoinRequest('JQ', 'UQ', '引用兜底')
  apiCalls.length = 0
  await reply({
    text: '行，放进来吧',
    onebot: { message: [{ type: 'reply', data: { id: notifyQuote } }] },
  })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'JQ',
    'add',
    true,
    '',
  ])

  // NapCat 没有上报 friend-request：好友验证以私聊消息到达
  apiCalls.length = 0
  doubtList = [{ uin: 100001, flag: 'doubt-1', msg: '请求添加你为好友' }]
  let friendNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: undefined,
      userId: '100001',
      messageId: '677569584',
      content: '请求添加你为好友',
      onebot: { sub_type: 'friend', time: 1792951531 },
      author: { roles: [] },
    }),
    async () => {
      friendNextCalled = true
    }
  )
  assert.strictEqual(friendNextCalled, false)
  assert.deepStrictEqual(apiCalls.pop(), [
    '_get',
    'set_doubt_friends_add_request',
    { flag: 'doubt-1', approve: true },
  ])

  // 已经是好友的私聊 -> 放行，不尝试同意好友申请
  apiCalls.length = 0
  friendNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: undefined,
      userId: 'FRIEND1',
      content: '在吗',
      onebot: { sub_type: 'friend', time: 1792951531 },
      author: { roles: [] },
    }),
    async () => {
      friendNextCalled = true
    }
  )
  assert.strictEqual(friendNextCalled, true)
  assert.strictEqual(apiCalls.length, 0)

  // 可疑列表没有记录 -> 用消息时间作为 flag 兜底（秒失败，毫秒成功）
  apiCalls.length = 0
  doubtList = []
  failingFriendFlags.clear()
  failingFriendFlags.add('1792951531')
  friendNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: undefined,
      userId: '100002',
      content: '你好',
      onebot: { sub_type: 'friend', time: 1792951531 },
      author: { roles: [] },
    }),
    async () => {
      friendNextCalled = true
    }
  )
  assert.strictEqual(friendNextCalled, false)
  assert.deepStrictEqual(
    apiCalls.filter((call) => call[0] === 'setFriendAddRequest').map((call) => call[1]),
    ['1792951531', '1792951531000']
  )

  // 好友验证以临时会话消息到达（sub_type=group、带 guildId）也要兜底
  apiCalls.length = 0
  doubtList = [{ user_id: 100003, flag: 'doubt-2' }]
  let tempFriendNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: 'G1',
      userId: '100003',
      messageId: '677569585',
      content: '请求添加你为好友',
      onebot: { sub_type: 'group', time: 1792951532 },
      author: { roles: [] },
    }),
    async () => {
      tempFriendNextCalled = true
    }
  )
  assert.strictEqual(tempFriendNextCalled, false)
  assert.deepStrictEqual(apiCalls, [
    ['_get', 'get_doubt_friends_add_request', { count: 20 }],
    ['_get', 'set_doubt_friends_add_request', { flag: 'doubt-2', approve: true }],
  ])

  // 临时会话里的验证消息不在可疑列表时，用消息时间作为 flag 兜底
  apiCalls.length = 0
  doubtList = []
  tempFriendNextCalled = false
  await handlers.middleware(
    makeSession({
      isDirect: true,
      guildId: 'G1',
      userId: '100004',
      messageId: '677569586',
      content: '请求添加你为好友',
      onebot: { sub_type: 'group', time: 1792959999 },
      author: { roles: [] },
    }),
    async () => {
      tempFriendNextCalled = true
    }
  )
  assert.strictEqual(tempFriendNextCalled, false)
  assert.deepStrictEqual(
    apiCalls.filter((call) => call[0] === 'setFriendAddRequest'),
    [['setFriendAddRequest', '1792959999', true, '']]
  )

  // 轮询 get_group_system_msg 补捞入群申请
  groupSystemMsg = {
    join_requests: [
      {
        request_id: 'J-POLL',
        group_id: 'G1',
        invitor_uin: 100005,
        requester_nick: '轮询申请人',
        message: '轮询附言',
        checked: false,
      },
      {
        request_id: 'J-DONE',
        group_id: 'G1',
        invitor_uin: 100006,
        requester_nick: '已处理',
        message: '',
        checked: true,
      },
    ],
  }
  apiCalls.length = 0
  sent.length = 0
  ctx.bots = [
    {
      platform: 'onebot',
      selfId: 'bot',
      status: 1,
      internal: makeInternal(),
      async sendMessage(groupId, content) {
        apiCalls.push(['sendMessage', groupId, content])
        lastNotifyId = String(++notifySeq)
        return [lastNotifyId]
      },
    },
  ]

  // 定时器注册顺序：清理任务 -> 群系统消息轮询
  assert.strictEqual(timers.intervals.length, 2)
  const pollCallback = timers.intervals[1]
  await pollCallback()

  const pollNotify = apiCalls.find((call) => call[0] === 'sendMessage')
  assert.ok(pollNotify)
  assert.strictEqual(pollNotify[1], 'G1')
  assert.match(
    pollNotify[2].filter((part) => typeof part === 'string').join(''),
    /轮询申请人/
  )
  const pollNotifyId = lastNotifyId

  // 同一条申请再次轮询时不重复通知
  apiCalls.length = 0
  await pollCallback()
  assert.strictEqual(
    apiCalls.filter((call) => call[0] === 'sendMessage').length,
    0
  )

  // 管理员引用轮询通知回复「同意」
  await reply({ id: pollNotifyId, text: '同意' })
  assert.deepStrictEqual(apiCalls.pop(), [
    'setGroupAddRequest',
    'J-POLL',
    'add',
    true,
    '',
  ])

  // 轮询 get_group_system_msg 补捞群邀请（invited_requests）并自动同意
  apiCalls.length = 0
  groupSystemMsg = {
    invited_requests: [
      {
        request_id: 9001,
        group_id: 88888,
        invitor_uin: 100007,
        checked: false,
      },
      {
        request_id: 9002,
        group_id: 88889,
        invitor_uin: 100008,
        checked: true,
      },
    ],
    join_requests: [],
  }
  await pollCallback()
  assert.deepStrictEqual(
    apiCalls.filter(
      (call) => call[0] === 'setGroupAddRequest' && call[2] === 'invite'
    ),
    [['setGroupAddRequest', '9001', 'invite', true, '']]
  )

  // 同一条群邀请不会在下一轮重复同意
  apiCalls.length = 0
  await pollCallback()
  assert.strictEqual(
    apiCalls.filter((call) => call[0] === 'setGroupAddRequest').length,
    0
  )

  console.log('all request-assistant tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
