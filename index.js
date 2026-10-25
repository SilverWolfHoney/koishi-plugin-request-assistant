const { Schema, h } = require('koishi')

const name = 'request-assistant'

const Config = Schema.object({
  autoApproveFriend: Schema.boolean()
    .default(true)
    .description('自动同意所有好友申请'),
  autoApproveInvite: Schema.boolean()
    .default(true)
    .description('自动同意所有把机器人拉进群的群邀请'),
  notifyJoinRequest: Schema.boolean()
    .default(true)
    .description('有入群申请时在群内通知群主/管理员处理'),
  adminOnly: Schema.boolean()
    .default(true)
    .description('只有群主或管理员可以处理入群申请'),
  allowSingleWithoutQuote: Schema.boolean()
    .default(true)
    .description('同一个群只有一个待处理申请时，允许不引用通知直接回复'),
  confirmInGroup: Schema.boolean()
    .default(true)
    .description('处理完成后在群里发送确认消息'),
  mentionOwner: Schema.boolean()
    .default(true)
    .description('发入群申请通知时 @ 群主'),
  pendingTimeoutMinutes: Schema.number()
    .default(1440)
    .min(1)
    .description('待处理申请的超时时间（分钟）'),
  decisionModel: Schema.string()
    .default('')
    .description('判断管理员回复用的模型，留空则使用 ChatLuna 默认模型'),
  aiTimeoutMs: Schema.number()
    .default(15000)
    .min(1000)
    .description('AI 判断的超时时间（毫秒）'),
  pollJoinRequests: Schema.boolean()
    .default(true)
    .description('定期轮询群系统消息，补救 NapCat 漏报的入群申请和群邀请'),
  joinPollInterval: Schema.number()
    .default(60)
    .min(10)
    .description('轮询群系统消息的间隔（秒）'),
})

const JUDGE_SYSTEM_PROMPT = [
  '你是 QQ 群入群申请的审批意图识别器。',
  '根据群主或管理员的一句话，判断其意图是同意还是拒绝这条入群申请，或者只是询问/讨论。',
  '只输出 JSON，不要输出 Markdown 代码块或其它文字：',
  '{"decision":"approve|reject|unknown","reason":"拒绝理由，没有就填空字符串"}',
  '判断规则：',
  '- 明确表示放行，如“同意”“通过”“可以”“行”“放进来”“让他进” → approve',
  '- 明确表示拒绝，如“拒绝”“不行”“不要”“不同意”“驳回” → reject',
  '- 疑问、追问、单纯讨论、无法确定 → unknown',
  '- 如果同时出现同意和拒绝，以最后表达的决定为准；仍无法判断则 unknown',
  '- reason 只提取管理员明确说出的拒绝理由，没有就留空',
].join('\n')

const REJECT_WORDS = ['拒绝', '驳回', '不同意', '不通过', 'no', 'n', 'reject']
const APPROVE_WORDS = ['同意', '通过', '批准', '允许', 'ok', 'yes', 'y', 'approve']

function normalize(text) {
  return String(text || '')
    .trim()
    .replace(/^[\s,，。.!！~～]+/, '')
}

function startsWithWord(text, word) {
  const lower = text.toLowerCase()
  if (!lower.startsWith(word)) return false
  if (!/^[a-z]+$/.test(word)) return true
  const next = lower.charAt(word.length)
  return !next || /[\s:：,，.!！。]/.test(next)
}

function parseDecision(text) {
  const value = normalize(text)
  if (!value) return null

  for (const word of REJECT_WORDS) {
    if (!startsWithWord(value, word)) continue
    const reason = value
      .slice(word.length)
      .replace(/^[\s:：,，-]+/, '')
      .trim()
      .slice(0, 100)
    return { approve: false, reason }
  }

  for (const word of APPROVE_WORDS) {
    if (startsWithWord(value, word)) return { approve: true, reason: '' }
  }

  return null
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
  }
  return ''
}

// NapCat 把好友验证有时当成普通私聊消息投递，来源可能是临时会话
// （sub_type=group，带 guildId），不能只看 sub_type。
const VERIFY_TEXT_PATTERNS = [
  /请求添加你?为好友/,
  /请求加你?为好友/,
  /申请添加你?为好友/,
  /申请加你?为好友/,
  /^添加你?为好友/,
  /^加你?为好友/,
  /好友验证/,
]

function looksLikeFriendVerification(text) {
  const value = String(text || '').trim()
  if (!value) return false
  return VERIFY_TEXT_PATTERNS.some((pattern) => pattern.test(value))
}

function parseAiDecision(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  const candidates = [raw]
  const match = raw.match(/\{[\s\S]*?\}/)
  if (match && match[0] !== raw) candidates.push(match[0])

  for (const candidate of candidates) {
    let data
    try {
      data = JSON.parse(candidate)
    } catch {
      continue
    }
    const decision = String(data.decision || '').toLowerCase()
    if (
      decision !== 'approve' &&
      decision !== 'reject' &&
      decision !== 'unknown'
    ) {
      continue
    }
    return {
      decision,
      reason: String(data.reason || '').trim().slice(0, 100),
    }
  }
  return null
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

function buildJudgePrompt(record, replyText) {
  return [
    '申请信息：',
    `申请人：${record.nickname}（${record.userId}）`,
    `附言：${record.comment || '（无）'}`,
    '',
    '管理员回复：',
    replyText,
  ].join('\n')
}

function apply(ctx, config) {
  const logger = ctx.logger('request-assistant')
  const pendingByMessage = new Map()
  const pendingByGroup = new Map()
  const ownerCache = new Map()
  const friendCache = { ids: null, at: 0 }
  // flag -> 通知时间。事件和轮询可能同时看到同一条申请，用它去重。
  const notifiedFlags = new Map()
  const notifyingFlags = new Set()
  const attemptedFlags = new Map()
  // flag -> 最近一次轮询处理时间。服务端列表删除有延迟，避免每分钟重复同意。
  const invitedAttempted = new Map()

  function isOneBot(session) {
    return session?.platform === 'onebot' && !!session.bot?.internal
  }

  function remember(messageId, record) {
    pendingByMessage.set(messageId, record)
    let ids = pendingByGroup.get(record.groupId)
    if (!ids) pendingByGroup.set(record.groupId, (ids = new Set()))
    ids.add(messageId)
  }

  function forget(messageId) {
    const record = pendingByMessage.get(messageId)
    if (!record) return
    pendingByMessage.delete(messageId)
    const ids = pendingByGroup.get(record.groupId)
    if (!ids) return
    ids.delete(messageId)
    if (!ids.size) pendingByGroup.delete(record.groupId)
  }

  // 引用通知时 adapter 会调用 get_msg 补全 quote；部分 NapCat 版本
  // 会因消息 ID 形式不一致而失败，这里再从原始消息段里取一次 reply id。
  function getQuoteId(session) {
    if (session.quote?.id != null) return String(session.quote.id)
    const message = rawEvent(session)?.message
    if (Array.isArray(message)) {
      const reply = message.find((segment) => segment?.type === 'reply')
      if (reply?.data?.id != null) return String(reply.data.id)
    } else if (typeof message === 'string') {
      const match = message.match(/\[CQ:reply,[^\]]*id=([^,\]]+)/)
      if (match) return match[1]
    }
    return null
  }

  function findPending(session) {
    const quoteId = getQuoteId(session)
    if (quoteId != null && pendingByMessage.has(quoteId)) {
      return {
        messageId: quoteId,
        record: pendingByMessage.get(quoteId),
        quoted: true,
      }
    }
    if (!config.allowSingleWithoutQuote) return null
    const ids = pendingByGroup.get(String(session.guildId || ''))
    if (ids?.size !== 1) return null
    const messageId = ids.values().next().value
    return {
      messageId,
      record: pendingByMessage.get(messageId),
      quoted: false,
    }
  }

  async function getNickname(bot, userId) {
    try {
      const info = await bot.internal.getStrangerInfo(userId, true)
      return info?.nickname || userId
    } catch (error) {
      logger.debug(`获取用户 ${userId} 昵称失败：${error.message}`)
      return userId
    }
  }

  async function getOwnerId(bot, groupId) {
    const cached = ownerCache.get(groupId)
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.ownerId

    try {
      const members = await bot.internal.getGroupMemberList(groupId)
      const owner = (members || []).find((member) => member?.role === 'owner')
      const ownerId = owner?.user_id != null ? String(owner.user_id) : ''
      ownerCache.set(groupId, { ownerId, at: Date.now() })
      return ownerId
    } catch (error) {
      logger.debug(`获取群 ${groupId} 群主失败：${error.message}`)
      return ''
    }
  }

  function rawEvent(session) {
    return session.onebot || session.event?._data || {}
  }

  async function loadFriendIds(session) {
    if (friendCache.ids && Date.now() - friendCache.at < 60_000) {
      return friendCache.ids
    }
    const list = await session.bot.internal.getFriendList()
    friendCache.ids = new Set((list || []).map((item) => String(item.user_id)))
    friendCache.at = Date.now()
    return friendCache.ids
  }

  // 部分 NapCat 版本不会上报 friend-request 事件，好友验证会以
  // “临时好友验证”私聊消息（sub_type=friend）的形式出现。
  // 这里先用可疑好友申请列表取 flag，拿不到再尝试用消息时间作为 flag。
  async function approveFriendRequestFromMessage(
    session,
    { allowTimeFlag = false } = {}
  ) {
    const userId = String(session.userId || '')
    if (!userId) return false
    const internal = session.bot.internal

    if (typeof internal._get === 'function') {
      try {
        const doubts = await internal._get('get_doubt_friends_add_request', {
          count: 20,
        })
        const entry = (Array.isArray(doubts) ? doubts : []).find(
          (item) =>
            String(item?.uin ?? '') === userId ||
            String(item?.user_id ?? '') === userId
        )
        if (entry?.flag != null) {
          await internal._get('set_doubt_friends_add_request', {
            flag: String(entry.flag),
            approve: true,
          })
          return true
        }
      } catch (error) {
        logger.debug(`查询可疑好友申请失败：${error.message}`)
      }
    }

    if (!allowTimeFlag) return false

    const raw = rawEvent(session)
    const seconds = Number(raw.time) || Math.floor(Date.now() / 1000)
    const flags = [...new Set([String(seconds), String(seconds * 1000)])]
    for (const flag of flags) {
      try {
        await internal.setFriendAddRequest(flag, true, '')
        return true
      } catch (error) {
        logger.debug(`用 flag ${flag} 同意好友申请失败：${error.message}`)
      }
    }
    return false
  }

  function hasPendingFlag(flag) {
    for (const record of pendingByMessage.values()) {
      if (record.flag === flag) return true
    }
    return false
  }

  async function sendJoinNotice(bot, request) {
    const flag = String(request.flag || '')
    const groupId = String(request.groupId || '')
    const userId = String(request.userId || '')
    if (!flag || !groupId || !userId) return false
    if (notifiedFlags.has(flag) || notifyingFlags.has(flag)) return false
    if (hasPendingFlag(flag)) return false
    // 通知发送失败时不要每分钟重试刷日志
    if (Date.now() - (attemptedFlags.get(flag) || 0) < 5 * 60_000) return false
    attemptedFlags.set(flag, Date.now())

    notifyingFlags.add(flag)
    try {
      const nickname = request.nickname || (await getNickname(bot, userId))
      const ownerId = config.mentionOwner ? await getOwnerId(bot, groupId) : ''
      const parts = []
      if (ownerId && ownerId !== String(bot.selfId)) {
        parts.push(h('at', { id: ownerId }))
      }
      parts.push(
        [
          '【入群申请】',
          `申请人：${nickname}（${userId}）`,
          `附言：${request.comment || '（无）'}`,
          '请群主或管理员引用本条消息回复「同意」或「拒绝 理由」。',
        ].join('\n')
      )

      const ids = await bot.sendMessage(groupId, parts)
      const messageId = ids?.[0]
      if (messageId == null || messageId === '') {
        logger.warn('入群申请通知已发送，但没有拿到消息 ID，无法匹配回复')
        return false
      }
      remember(String(messageId), {
        flag,
        groupId,
        userId,
        nickname,
        comment: request.comment || '',
        createdAt: Date.now(),
        processing: false,
      })
      notifiedFlags.set(flag, Date.now())
      logger.info(`群 ${groupId} 收到入群申请：${nickname}（${userId}）`)
      return true
    } catch (error) {
      logger.warn(`发送入群申请通知失败：${error.message}`)
      return false
    } finally {
      notifyingFlags.delete(flag)
    }
  }

  // NapCat 只在 onGroupNotifiesUpdated 触发的瞬间上报入群申请/群邀请，
  // 机器人离线期间或事件漏报时需要靠 get_group_system_msg 补捞。
  async function pollGroupSystem(bot) {
    let data
    try {
      data = await bot.internal._get('get_group_system_msg', { count: 50 })
    } catch (error) {
      logger.debug(`查询群系统消息失败：${error.message}`)
      return 0
    }

    let count = 0
    if (config.autoApproveInvite) {
      count += await approveInvitedRequests(bot, data)
    }
    if (config.notifyJoinRequest) {
      count += await notifyJoinRequests(bot, data)
    }
    return count
  }

  // 机器人被拉群的邀请：事件漏报时同样能从群系统消息里补捞并自动同意。
  async function approveInvitedRequests(bot, data) {
    const list = Array.isArray(data?.invited_requests)
      ? data.invited_requests
      : Array.isArray(data?.InvitedRequest)
        ? data.InvitedRequest
        : []
    let count = 0
    for (const item of list) {
      if (!item || item.checked) continue
      const flag = item.request_id != null ? String(item.request_id) : ''
      if (!flag) continue
      if (Date.now() - (invitedAttempted.get(flag) || 0) < 5 * 60_000) continue
      invitedAttempted.set(flag, Date.now())
      try {
        await bot.internal.setGroupAddRequest(flag, 'invite', true, '')
        count += 1
        logger.info(
          `已自动同意群邀请（轮询）：群 ${item.group_id ?? ''}，邀请人 ${
            item.invitor_uin ?? ''
          }`
        )
      } catch (error) {
        logger.debug(`自动同意群邀请失败（flag: ${flag}）：${error.message}`)
      }
    }
    return count
  }

  async function notifyJoinRequests(bot, data) {
    const list = Array.isArray(data?.join_requests) ? data.join_requests : []
    let count = 0
    for (const item of list) {
      if (!item || item.checked) continue
      const sent = await sendJoinNotice(bot, {
        flag: item.request_id,
        groupId: item.group_id,
        userId: item.invitor_uin,
        nickname: item.requester_nick || item.invitor_nick || '',
        comment: String(item.message || '').trim(),
      })
      if (sent) count += 1
    }
    if (count) logger.info(`轮询到 ${count} 条新的入群申请`)
    return count
  }

  async function pollAllBotsGroup() {
    for (const bot of ctx.bots || []) {
      if (bot.platform !== 'onebot' || !bot.internal) continue
      if (typeof bot.status === 'number' && bot.status !== 1) continue
      await pollGroupSystem(bot)
    }
  }

  async function isAdminOrOwner(session, groupId) {
    if (!config.adminOnly) return true

    const role = session.author?.roles?.[0]?.id
    if (role === 'owner' || role === 'admin') return true
    if (role) return false

    try {
      const info = await session.bot.internal.getGroupMemberInfo(
        String(groupId),
        String(session.userId),
        true
      )
      return info?.role === 'owner' || info?.role === 'admin'
    } catch (error) {
      logger.warn(`查询群成员身份失败：${error.message}`)
      return false
    }
  }

  async function classifyByAI(record, replyText) {
    const chatluna = ctx.chatluna
    if (!chatluna) return null

    let SystemMessage
    let HumanMessage
    try {
      ;({ SystemMessage, HumanMessage } = require('@langchain/core/messages'))
    } catch (error) {
      logger.warn(`加载 @langchain/core 失败：${error.message}`)
      return null
    }

    const modelName =
      (config.decisionModel || '').trim() || chatluna.config?.defaultModel
    if (!modelName) return null

    const ref = await chatluna.createChatModel(modelName)
    const model = ref?.value
    if (!model) return null

    const signal =
      typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(config.aiTimeoutMs)
        : undefined
    const response = await model.invoke(
      [
        new SystemMessage(JUDGE_SYSTEM_PROMPT),
        new HumanMessage(buildJudgePrompt(record, replyText)),
      ],
      { temperature: 0, ...(signal ? { signal } : {}) }
    )
    const decision = parseAiDecision(contentToText(response?.content))
    if (!decision) throw new Error('模型没有返回可解析的 JSON')
    return decision
  }

  async function handleReply(session) {
    const found = findPending(session)
    if (!found) {
      const ids = pendingByGroup.get(String(session.guildId || ''))
      if (ids?.size > 1 && parseDecision(session.content)) {
        await session
          .send('这条回复没有匹配到申请通知，请引用要处理的那条通知再回复。')
          .catch(() => {})
        return true
      }
      return false
    }

    const { messageId, record, quoted } = found
    if (record.processing) return true

    const replyText = String(session.content || '').trim()

    // 没有引用通知时，只认明确的「同意 / 拒绝」关键词，
    // 避免把群里的普通聊天都当成审批操作。
    const keyword = quoted ? null : parseDecision(replyText)
    if (!quoted && !keyword) return false

    if (!(await isAdminOrOwner(session, record.groupId))) {
      await session.send('只有群主或管理员可以处理入群申请。').catch(() => {})
      return true
    }

    record.processing = true
    try {
      let decision = null

      if (quoted) {
        try {
          decision = await withTimeout(
            classifyByAI(record, replyText),
            config.aiTimeoutMs + 1000,
            'AI 判断超时'
          )
        } catch (error) {
          logger.warn(`AI 判断回复意图失败，改用关键词判断：${error.message}`)
        }
      }

      if (decision) {
        if (decision.decision === 'unknown') {
          await session
            .send('没看懂你的决定。请明确回复「同意」或「拒绝 理由」。')
            .catch(() => {})
          return true
        }
      } else {
        const fallback = keyword || parseDecision(replyText)
        if (!fallback) {
          await session
            .send('没看懂你的决定。请明确回复「同意」或「拒绝 理由」。')
            .catch(() => {})
          return true
        }
        decision = {
          decision: fallback.approve ? 'approve' : 'reject',
          reason: fallback.reason,
        }
      }

      const approve = decision.decision === 'approve'
      try {
        await session.bot.internal.setGroupAddRequest(
          record.flag,
          'add',
          approve,
          decision.reason || ''
        )
      } catch (error) {
        logger.warn(`处理群 ${record.groupId} 的入群申请失败：${error.message}`)
        await session.send(`处理失败：${error.message}`).catch(() => {})
        return true
      }

      forget(messageId)

      const operator =
        session.author?.nick ||
        session.author?.name ||
        session.username ||
        session.userId
      logger.info(
        `${operator} 在群 ${record.groupId} ${
          approve ? '同意' : '拒绝'
        }了 ${record.userId} 的入群申请`
      )

      if (config.confirmInGroup) {
        const text = approve
          ? `已同意 ${record.nickname}（${record.userId}）的入群申请。`
          : `已拒绝 ${record.nickname}（${record.userId}）的入群申请。${
              decision.reason ? `理由：${decision.reason}` : ''
            }`
        await session.send(text).catch(() => {})
      }
      return true
    } finally {
      record.processing = false
    }
  }

  ctx.on('friend-request', async (session) => {
    if (!isOneBot(session)) return
    logger.debug(`收到好友申请事件：${session.userId}（flag: ${session.messageId}）`)
    if (!config.autoApproveFriend) return
    const flag = String(session.messageId || '')
    if (!flag) {
      logger.warn('好友申请事件缺少 flag，已跳过')
      return
    }
    try {
      await session.bot.internal.setFriendAddRequest(flag, true, '')
      friendCache.ids?.add(String(session.userId || ''))
      logger.info(`已自动同意好友申请：${session.userId}`)
    } catch (error) {
      // flag 对不上时（不同 NapCat 版本字段不同），退回可疑申请列表再试
      const approved = await approveFriendRequestFromMessage(session, {
        allowTimeFlag: true,
      })
      if (approved) {
        friendCache.ids?.add(String(session.userId || ''))
        logger.info(`已自动同意好友申请（兜底）：${session.userId}`)
      } else {
        logger.warn(`自动同意好友申请失败：${error.message}`)
      }
    }
  })

  ctx.on('guild-request', async (session) => {
    if (!isOneBot(session)) return
    logger.debug(`收到群邀请事件：群 ${session.guildId}，邀请人 ${session.userId}`)
    if (!config.autoApproveInvite) return
    const flag = String(session.messageId || '')
    if (!flag) {
      logger.warn('群邀请事件缺少 flag，已跳过')
      return
    }
    try {
      await session.bot.internal.setGroupAddRequest(flag, 'invite', true, '')
      logger.info(`已自动同意群邀请：群 ${session.guildId}，邀请人 ${session.userId}`)
    } catch (error) {
      logger.warn(`自动同意群邀请失败：${error.message}`)
    }
  })

  ctx.on('guild-member-request', async (session) => {
    if (!isOneBot(session)) return
    logger.debug(
      `收到入群申请事件：群 ${session.guildId}，申请人 ${session.userId}（flag: ${session.messageId}）`
    )
    if (!config.notifyJoinRequest) return

    const flag = String(session.messageId || '')
    const groupId = String(session.guildId || '')
    const userId = String(session.userId || '')
    if (!flag || !groupId || !userId) {
      logger.warn('入群申请事件缺少 flag、群号或申请人，已跳过')
      return
    }

    await sendJoinNotice(session.bot, {
      flag,
      groupId,
      userId,
      comment: String(session.content || '').trim(),
    })
  })

  // 放在 ChatLuna 之前，审批回复被这里消费后不再传给角色，
  // 避免引用通知时角色也抢着回一句。
  ctx.middleware(async (session, next) => {
    if (!isOneBot(session)) return next()
    if (session.userId === session.selfId) return next()

    // NapCat 有时不上报 friend-request：好友验证会以普通私聊消息到达。
    // 来源可能是临时会话（sub_type=group，带 guildId），也可能 sub_type=friend，
    // 所以不能只凭 sub_type 判断，也要看验证文案。
    if (config.autoApproveFriend && session.isDirect) {
      const userId = String(session.userId || '')
      const raw = rawEvent(session)
      const verifyMessage =
        raw.sub_type === 'friend' ||
        looksLikeFriendVerification(contentToText(session.content))

      if (userId && userId !== String(session.selfId || '') && verifyMessage) {
        let isFriend = null
        try {
          isFriend = (await loadFriendIds(session)).has(userId)
        } catch (error) {
          logger.debug(`获取好友列表失败：${error.message}`)
        }

        if (isFriend !== true) {
          const approved = await approveFriendRequestFromMessage(session, {
            allowTimeFlag: true,
          })
          if (approved) {
            friendCache.ids?.add(userId)
            logger.info(
              `已自动同意好友申请（临时验证消息）：${userId}`
            )
          } else {
            logger.warn(
              `收到好友验证消息，但自动同意失败，请手动处理：${userId}`
            )
          }
          // 系统验证消息不应交给角色，避免角色把它当成普通私聊回复
          return
        }
      }
    }

    if (session.isDirect || !session.guildId) return next()
    const handled = await handleReply(session)
    if (handled) return
    return next()
  }, true)

  ctx.setInterval(() => {
    const deadline = Date.now() - config.pendingTimeoutMinutes * 60_000
    for (const [messageId, record] of pendingByMessage) {
      if (record.createdAt < deadline) forget(messageId)
    }
    for (const [flag, at] of notifiedFlags) {
      if (at < deadline) notifiedFlags.delete(flag)
    }
    for (const [flag, at] of attemptedFlags) {
      if (at < deadline) attemptedFlags.delete(flag)
    }
    for (const [flag, at] of invitedAttempted) {
      if (at < deadline) invitedAttempted.delete(flag)
    }
  }, 60_000)

  // 事件漏报或机器人离线期间产生的申请，靠轮询补上。
  const pollGroup =
    config.pollJoinRequests &&
    (config.notifyJoinRequest || config.autoApproveInvite)

  if (pollGroup) {
    ctx.on('bot-status-updated', (bot) => {
      if (bot?.platform !== 'onebot' || bot.status !== 1) return
      ctx.setTimeout(() => {
        pollGroupSystem(bot).catch((error) => {
          logger.debug(`轮询群系统消息失败：${error.message}`)
        })
      }, 3000)
    })

    ctx.setInterval(
      () =>
        pollAllBotsGroup().catch((error) => {
          logger.debug(`轮询群系统消息失败：${error.message}`)
        }),
      config.joinPollInterval * 1000
    )
  }
}

module.exports = { name, Config, apply }
