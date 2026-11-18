// Derived package: Yuuyuko-uu/dsh-qq-link. LICENSE 1.2 retained; fork settings structure 0.0.1.
window.__ModuleLoader__.load({
  id: 'dsh-qq-bridge',
  factory: require => {
    const React = require('react'), h = React.createElement, NS = 'qq-bridge-001'
    const sections = ['connection', 'bindings', 'messages', 'tests', 'media', 'model', 'security', 'diagnostics']
    const en = {
      cards: 'Read share cards', forwards: 'Read merged forwards', forwardMedia: 'Read images in forwarded messages', richBudget: 'Complete rich-data character budget', asrEnabled: 'Transcribe incoming voice', asrProvider: 'Native host-local recognizer', asrLanguage: 'Recognition language', asrHint: 'Only an explicitly selected ready host-local speechController provider is used. No CLI, cloud fallback, preparation or downloads. Audio remains a durable attachment when transcription fails; duplicate or uncertain receipts never run ASR again.', filterEnabled: 'Enable sender / mention / probability filters', allowedSenders: 'Allowed sender IDs (one per line; empty = no sender filter)', mentionOnly: 'Groups: require a mention or verified quote', mentionAlways: 'Mentions bypass probability', mentionKeywords: 'Mention keywords (one per line)', probability: 'Reply probability (%)', tailCount: 'Messages accepted after mention', tailTime: 'Mention tail duration (ms)', rateEnabled: 'Enable rate backpressure', cooldown: 'Cooldown after reply (ms)', perMinute: 'Maximum admitted inputs per minute', rateHint: 'The interval applies to group replies. New incoming messages continue to enter the conversation.', personaEnabled: 'Enable scoped persona', personaText: 'Persona text (literal; no variable interpolation)', gateEnabled: 'Enable group reply threshold', gateConclude: 'Conclude this exclusive QQ turn when declined', featureHint: 'All features below are off by default. Persona applies only to this exact bound Agent. The native gate never affects local or mixed-source input and suppresses QQ output unless explicitly allowed or mentioned.', title: 'QQ bridge', subtitle: 'Independent fork · 0.0.1 · derived from Yuuyuko-uu/dsh-qq-link', connection: 'Connection', bindings: 'Bindings', input: 'Input', output: 'Output & quote', media: 'Media', model: 'Model & quota', security: 'Security', diagnostics: 'Diagnostics & history', loading: 'Loading QQ settings…', retry: 'Retry', error: 'Operation failed. Check authentication, configuration and IO availability.', save: 'Save settings', saving: 'Saving…', saved: 'Saved', unsaved: 'Unsaved changes', reload: 'Reload', baseUrl: 'OneBot HTTP origin', receive: 'Enable bindings & cold preload', networkOff: 'Host networkAccess is disabled. No real network requests can leave this package.', webhook: 'Receive signed OneBot HTTP reports', webhookHint: 'POST /dsh-qq-bridge-001/onebot-events. Requires an explicit nonempty secret and X-Signature; no query token.', token: 'OneBot access token', secret: 'HTTP report secret', saveSecrets: 'Store credentials', secretHint: 'Values are write-only; blank leaves the stored value unchanged.', configured: 'Configured', absent: 'Not configured', add: 'Add binding', empty: 'Add a QQ chat and select an existing session, or explicitly create one in the picker.', endpoint: 'Chat endpoint', session: 'Session ID', choose: 'Choose / create / preview', pickerMissing: 'Resource picker v1 is unavailable; full session IDs remain supported.', remove: 'Remove', enabled: 'Receive', send: 'Send', preload: 'Cold preload', mode: 'Admission mode', modeHint: 'queue = next turn; steer = next step. auto uses IO fairness and consecutive-steer limits. No approval or sandbox escalation.', auto: 'Auto', queue: 'Queue', steer: 'Steer', quote: 'Native reply segments', quoteHint: 'Inbound get_msg is bounded and chat-verified. Outbound adds a native reply segment, never a [QQ] protocol.', quoteChars: 'Quote character limit', quoteMedia: 'Quoted media limit', continuation: 'Extra real assistant replies', continuationHint: 'Optional IO continuation makes additional billed model requests. Global IO continuation must also be enabled. All reply-count / output-token / duration budgets are required; tools, media, local input, queueing or cancellation stop further continuation. Disabled by default.', replyBudget: 'Additional reply budget', tokenBudget: 'Output token budget', timeBudget: 'Duration budget (ms)', originals: 'Every real assistant message is sent once in original order, without punctuation splitting. Reasoning/tools/attempts are not exported.', maxMedia: 'Media count', imageMB: 'Image limit (MiB)', fileMB: 'File limit (MiB)', origins: 'Allowed media origins (one per line)', originHint: 'QQ bot card images also use qqbot.ugcimg.cn. Other downloads require a listed origin; redirects and local paths are rejected.', groupFiles: 'Allow group file uploads', voice: 'TTS outbound', keepText: 'Keep original text with voice', voiceHint: 'With voice enabled, plain replies use speech and stickers are sent separately. If synthesis fails, the original text is sent.', asrMissing: 'Qzone, schedules and active polling remain inactive. Importing legacy settings never creates background tasks.', modelHint: 'Default native-wins preserves a different native selection. An explicit picker model choice arms binding-once. Running sessions keep the captured step and apply pending choices only at turn-stopping before the next unprepared turn/step, or before the next idle receive. Native changes after arming win. Quota switching is opt-in and only before a next distinct idle QQ input; no same-step fallback or replay.', modelPolicy: 'Default model policy', 'native-wins': 'Native selection wins', 'binding-once': 'Apply binding once', off: 'Off', policyState: 'Policy state', quotaMode: 'Quota exhaustion strategy', 'next-input': 'Switch on next new QQ input', quotaOff: 'Do not switch', quotaCandidates: 'Fallback candidates (JSON array)', quotaBudget: 'Durable switch budget', quotaHint: 'Only explicit quota/rate-limit errors from an exclusive QQ turn without public partial output or tool effects can arm this policy. The failed request is never replayed. A different next QQ input must arrive while idle; catalog, native selection and cancellation are checked again. Diagnostics stay in Settings, not a fake assistant or gate-bypassing phone notice.', noModel: 'No binding default', sendMaster: 'Allow outbound sends', sendHint: 'Requires this switch, each binding send switch, IO global send switch and Host networkAccess. Keep old QQ disabled before activating this bridge.', permission: 'Permissions stay native and fail closed. Missing/broken authentication denies requests. Skipped/unanswered approval never grants authority. No real test-send endpoint.', migration: 'Explicit legacy JSON import', migrationHint: 'Paste old configuration JSON. Import disables all bindings/send gates, moves the legacy bearer token into credentials without echo, retains unsupported features read-only and never edits old files.', import: 'Import disabled bindings', history: 'Read bounded history', preview: 'Preview (cold read)', preloadNow: 'Preload now', cancel: 'Cancel / clear inbox', diagnosticsHint: 'No installation, authenticated visual check or real QQ send has been performed by this work.', operation: 'Result', cancelHint: 'Picker cancelled; existing binding unchanged. An explicitly created empty session remains in DSH.', pickFirst: 'Save/select a binding first.', provenance: 'Original author Yuuyuko-uu · full custom license 1.2 is retained.'
    }
    const zh = {
      cards: '读取分享卡片', forwards: '读取合并转发', forwardMedia: '读取转发消息中的图片', richBudget: '完整外部资料字符预算', asrEnabled: '入站语音转录', asrProvider: '本机原生识别器', asrLanguage: '转录语言', asrHint: '仅使用明确选择且已就绪的本机 speechController 服务，不执行 CLI、不转云端、不准备或下载模型。转录失败保留已准入音频；重复/未确认回执不重复转录。', filterEnabled: '启用发送者 / 点名 / 概率过滤', allowedSenders: '允许发送者 ID（每行一项；空为不限发送者）', mentionOnly: '群聊仅接点名或已验证的自身引用', mentionAlways: '点名消息不掷概率', mentionKeywords: '点名关键词（每行一项）', probability: '回复概率（%）', tailCount: '点名后接听条数', tailTime: '点名后接听时长（毫秒）', rateEnabled: '启用频率背压', cooldown: '回复后冷却（毫秒）', perMinute: '每分钟最多准入消息', rateHint: '冷却和频率限制用于群聊回复；新消息继续进入会话。', personaEnabled: '启用会话范围人设', personaText: '人设原文（不插值变量）', gateEnabled: '启用群回复门槛', gateConclude: '拒绝时结束当前唯一 QQ 轮次', featureHint: '以下功能默认全部关闭。人设只影响绑定的 exact Agent；原生门槛不影响本机/混合来源输入，未明确放行或点名时抑制 QQ 外发。', title: 'QQ 桥接', subtitle: '独立派生版 · 0.0.1 · 派生自 Yuuyuko-uu/dsh-qq-link', connection: '连接', bindings: '绑定 / 会话', input: '输入 / 排队', output: '输出 / 引用', media: '媒体', model: '模型 / 额度', security: '权限安全', diagnostics: '诊断 / 历史', loading: '正在读取 QQ 设置…', retry: '重试', error: '操作失败，请检查认证、设置和 IO 服务。', save: '保存设置', saving: '保存中…', saved: '已保存', unsaved: '有未保存改动', reload: '重新读取', baseUrl: 'OneBot HTTP 地址', receive: '启用绑定与冷预载', networkOff: 'Host networkAccess 尚未打开，本包不会发出真实网络请求。', webhook: '接收签名 OneBot HTTP 上报', webhookHint: 'POST /dsh-qq-bridge-001/onebot-events，必须配置非空 secret 和 X-Signature，不接受 URL 口令。', token: 'OneBot access token', secret: 'HTTP 上报 secret', saveSecrets: '存入凭据服务', secretHint: '只写不回显；留空保留已有值。', configured: '已配置', absent: '未配置', add: '添加绑定', empty: '先添加 QQ 聊天，再选择已有会话，或在选择器中明确新建会话。', endpoint: '聊天目标', session: '完整会话 ID', choose: '选择 / 新建 / 预览', pickerMissing: '资源选择器 v1 尚不可用，仍可填写完整会话 ID。', remove: '移除', enabled: '接收', send: '外发', preload: '冷预载', mode: '消息接入方式', modeHint: 'queue 排下一轮，steer 在下一步插话；auto 使用 IO 公平队列及连续插话预算，不提升审批或沙箱权限。', auto: '自动', queue: '排队', steer: '插话', quote: '原生 reply 引用', quoteHint: '入站有界 get_msg 并验证聊天归属，出站添加原生 reply 段，不使用 [QQ] 协议。', quoteChars: '引用正文上限', quoteMedia: '引用媒体上限', continuation: '额外真实 assistant 回复', continuationHint: '可选 IO continuation 会产生额外计费模型请求，且需 IO 总开关另行启用。回复次数 / 输出 token / 总时长预算必须同时填写；工具、媒体、人工输入、排队或取消会停止后续追加，默认关闭。', replyBudget: '额外回复次数预算', tokenBudget: '输出 token 预算', timeBudget: '时长预算（毫秒）', originals: '每条真实 assistant 消息按原顺序原样输出，不按标点切碎；思考、工具、attempt 不外发。', maxMedia: '每条媒体上限', imageMB: '图片上限（MiB）', fileMB: '文件上限（MiB）', origins: '允许下载媒体的 origin（每行一项）', originHint: 'QQ 机器人卡片图片支持 qqbot.ugcimg.cn；其他来源须列在此处，不跟随跳转，也不读取任意本地路径。', groupFiles: '允许上传群文件', voice: '出站 TTS 语音', keepText: '语音同时保留原文', voiceHint: '语音合成只读正文，表情包单独发图。合成失败时发送原文。', asrMissing: '空间、定时、主动轮询仍未在新 transport 启用；不会根据旧配置静默创建后台任务。', modelHint: '默认 native-wins 尊重已有不同原生选择；选择器明确选模型会装填 binding-once 一次应用。忙碌会话保留已捕获 step，在 turn-stopping 后的未准备下一轮/步或下次空闲接收前应用 pending，不声称当前 step 已换模；装填后用户原生改选优先。额度切换默认关闭，可选下一条不同且空闲的 QQ 输入前换模，不在原 step 重试、不重放。', modelPolicy: '默认模型策略', 'native-wins': '原生选择优先', 'binding-once': '绑定仅应用一次', off: '关闭', policyState: '策略状态', quotaMode: '额度耗尽策略', 'next-input': '下一条新 QQ 输入时换模', quotaOff: '不切换', quotaCandidates: '候选模型（JSON 数组）', quotaBudget: '持久换模次数预算', quotaHint: '仅唯一 QQ 触发、无公开部分回复/工具副作用且明确 quota/rate-limit 错误才装填。失败请求不重放；下一条不同 QQ 输入到达且空闲时，重新检查 catalog、原生选择和取消，再换模型处理新消息。诊断只在设置，不伪造 assistant 或绕发送闸通知手机。', noModel: '未设置绑定默认模型', sendMaster: '允许出站发送', sendHint: '需本开关 + 每绑定外发 + IO 总发送 + Host networkAccess 同时打开。启用前必须由 lead 停用旧 QQ，避免双收双发。', permission: '保持原生权限并 fail-closed；鉴权服务缺失/报错拒绝请求，skipped/未答审批不是授权；没有真实试发接口。', migration: '显式导入旧配置 JSON', migrationHint: '粘贴旧配置。导入会关闭接收/外发，旧 bearer token 仅迁入凭据服务不回显；旧通知口令不复用，未迁移特性只读保留，不改旧文件。', import: '导入为关闭的绑定', history: '读取有界历史', preview: '冷读预览', preloadNow: '立即预载', cancel: '取消并清空队列', diagnosticsHint: '本次未安装、未认证视觉测试、未真实发送 QQ 消息。', operation: '操作结果', cancelHint: '选择已取消，原绑定未变；明确新建后取消的空会话仍保留在 DSH。', pickFirst: '请先保存/选择一条绑定。', provenance: '原作者 Yuuyuko-uu · 完整保留自定义许可 1.2。'
    }
    Object.assign(en, {
      typingEnabled: 'Simulate typing before sending text', typingSpeed: 'Default typing speed', typingSlow: 'Slow', typingNormal: 'Natural', typingFast: 'Fast', typingCustom: 'Custom', typingLimit: 'Maximum wait per message (seconds)', typingHint: 'While typing, the agent keeps receiving messages. When the timer ends, it checks the latest chat and decides whether to send, revise, or discard the draft.', retargetNotice: 'The chat or conversation changed. Check and re-enable receiving and sending for this binding.',
      connectAndCheck: 'Save and check connection', connectionCard: 'OneBot connection', connectionCardHint: 'Sign in to the bot in your OneBot client, then save the address and token here.', connectionCurrent: 'Connection status', connectionUnchecked: 'Ready to check', connectionChangesSaved: 'Connection settings saved.', connectionReadyToSave: 'Save and check to apply the new connection.',
      selectedChat: 'Choose a QQ chat', noBindingsYet: 'Add a QQ chat to connect it to a DSH conversation.', conversationLinked: 'Conversation linked', personaSettings: 'Persona for this chat', personaOverrideHint: 'A custom persona applies only to this chat. Otherwise it uses the default persona.', defaultPersonaSettings: 'Default persona for QQ chats', chatRulesLink: 'Message rules', chatModelLink: 'Model settings', chatTestLink: 'Test this chat', chatReceiveOn: 'Receiving', chatReceiveOff: 'Receive off', chatSendOn: 'Sending', chatSendOff: 'Send off',
      chatModel: 'Conversation model', followSessionModel: 'Use the DSH conversation model', chatModelHint: 'Saving a selection applies it once to this conversation; later model changes in DSH remain in your control.', chatModelUnavailable: 'The saved model is not in the current catalog',
      voiceOutputTitle: 'Voice replies', voiceInputTitle: 'Incoming voice', fileMediaTitle: 'Images and files', advancedMedia: 'Advanced media settings', extraQqFeatures: 'QQ Space', legacyAdvanced: 'Import legacy configuration', detailedDiagnostics: 'Show technical details', goFixBindings: 'Review chat bindings', replyQuietSeconds: 'Wait for follow-up messages (seconds)', globalSendTitle: 'Sending QQ messages',
      permission: 'QQ sending also depends on the send switch for the target chat.',
      replyQuietMs: 'Wait for follow-up group messages (ms)', replyQuietHint: 'Group replies wait briefly for the complete message; incoming messages remain immediate.',
      voiceProvider: 'Voice provider', deepseekVoice: 'DeepSeek voice', deepseekVoiceHint: 'DeepSeek official speech uses the configured DeepSeek API key and is billed by character.',
      rateEnabled: 'Limit reply frequency', perMinute: 'Maximum replies per minute',
      hostPermissionTitle: 'Host access for each conversation', hostPermissionHint: 'These controls use the DSH conversation permission presets for file and command access.', hostPermissionSession: 'QQ conversation', hostPermissionPreset: 'Permission preset', hostPermissionApply: 'Apply to conversation', hostPermissionCurrent: 'Current preset', hostPermissionUnavailable: 'Conversation permissions are unavailable.', hostPermissionSaved: 'Conversation permissions updated.', hostPermissionReadOnly: 'Read only', hostPermissionWorkspace: 'Workspace write', hostPermissionFull: 'Full access',
      priceSchedule: 'Follow DeepSeek peak hours',
      peakProbability: 'Peak-hour response chance (%)',
      offPeakProbability: 'Off-peak response chance (%)',
      peakCooldown: 'Minimum peak response interval (seconds)',
      offPeakCooldown: 'Minimum off-peak response interval (seconds)',
      quotaReply: 'Message when model balance is exhausted',
      quotaReplyHint: 'Sent in private chats and group mentions when the active model has insufficient balance. Clear the message to disable it.',
      priceScheduleHint: 'For DeepSeek models, weekdays 09:00–12:00 and 14:00–18:00 Beijing time are peak hours. Weekends and Chinese public holidays are off-peak. Applies to ordinary group messages.',
      mergeEnabled: 'Merge consecutive messages per chat', mergeWindow: 'Quiet window (ms)', mergeMaxWait: 'Maximum hold (ms)', mergeMaxMessages: 'Maximum queued messages', mergeMaxChars: 'Maximum queued characters', mergeHint: 'QQ messages enter DSH promptly. The DSH steering merge plugin collects interruptions at the next step.',
      pollingEnabled: 'Poll OneBot HTTP history', pollingInterval: 'Polling interval (ms)', pollingCatchup: 'Catch-up window (ms)', pollingHint: 'Explicit opt-in. Enabling starts at the current time watermark; no old history is replayed. One flight at a time, abortable on save/unload. Messages still enter through the existing IO ingress and receive/send gates.',
      qzoneEnabled: 'Enable Qzone tools', qzonePost: 'Allow posting Qzone messages', qzoneLike: 'Allow liking Qzone posts', qzoneComment: 'Allow commenting on Qzone posts', qzoneHint: 'Read tools need only the Qzone switch. Post, like and comment additionally require the global business send switch and this binding send switch; they never read arbitrary local paths.',
      scheduleHint: 'Host tasks are created only by an explicit user or Agent call through the official schedule service. Loading, saving or importing settings never creates a task.',
      networkOff: 'Host networkAccess is disabled. Enable it below to allow OneBot HTTP access.',
      rateHint: 'The interval applies to group replies. New incoming messages continue to enter the conversation.',
      asrMissing: 'ASR needs a ready host-local recognizer from the native speech service. Without one, incoming audio stays as a durable attachment and a notice is added.',
      diagnosticsHint: 'Diagnostics shows the selected binding preview, bounded IO history, preload and cancel actions, admission decisions, polling watermarks and merge-window state.',
      provenance: 'Derived from Yuuyuko-uu/dsh-qq-link. The original author and Yuuyuko-uu plugin license 1.2 are retained.',
      hostAccessTitle: 'QQ network access',
      hostAccessHint: 'Allow the bridge to connect to the OneBot address on this page. Receiving and sending have separate switches.',
      hostAccessLoading: 'Reading network access settings…',
      hostAccessUnavailable: 'Network access settings are temporarily unavailable. Try reading them again.',
      hostAccessCurrent: 'Current value',
      hostAccessOn: 'On',
      hostAccessOff: 'Off',
      hostAccessToggle: 'Allow network access',
      hostAccessReadOnly: 'Network access settings are read-only.',
      hostAccessSave: 'Save network access',
      hostAccessRetry: 'Read again',
      hostAccessSaved: 'Network access saved.',
      hostAccessError: 'The change could not be saved. Read the current setting and retry.',
      botLoginHint: 'Sign in to QQ in your OneBot client. Save its HTTP address and, if configured, its access token. Check the connection to see which QQ account DSH reaches.',
      saveAuth: 'DSH rejected the save request. Reopen settings from an owner session.', saveInvalid: 'Review the settings. Check chat and session duplicates, addresses, and numeric limits.', saveApply: 'The bridge failed to write or apply settings. Reload to see what was saved.', saveTimeout: 'Saving timed out. Reload settings to check the result.', defaultPersona: 'Default persona', defaultPersonaEnabled: 'Use default persona', defaultPersonaHint: 'Used by QQ bindings without a custom persona.', customPersona: 'Use a custom persona', snowLumaTitle: 'Connect from a SnowLuma config',
      snowLumaHint: 'Sign in to QQ in SnowLuma and enable its OneBot HTTP server. Select the config/onebot_<QQ number>.json file on this computer.',
      snowLumaFile: 'SnowLuma JSON file',
      snowLumaReading: 'Reading the configuration…',
      snowLumaInvalid: 'Choose a valid SnowLuma OneBot JSON file (up to 128 KiB).',
      snowLumaNoHttp: 'No usable local HTTP server was found. Enable a SnowLuma OneBot HTTP server on this computer with path /, then select the updated file.',
      snowLumaServer: 'Local HTTP server',
      snowLumaAccount: 'QQ number from the filename',
      snowLumaHasToken: 'Access token included',
      snowLumaNoToken: 'Server has no access token',
      snowLumaUse: 'Use this connection',
      snowLumaSaveAddress: 'Save the HTTP address first using Save settings below.',
      snowLumaSaveToken: 'Save imported token',
      snowLumaClearToken: 'Clear saved OneBot token',
      goToBindings: 'Open QQ bindings',
      baseUrl: 'OneBot HTTP address',
      saveToken: 'Save token',
      saveWebhookSecret: 'Save signing secret',
      checkOneBot: 'Check connection',
      checkedAccount: 'Connected to QQ',
      saveBeforeCheck: 'Save the edited address or token before checking.',
      eventSettings: 'QQ message settings',
      'network-disabled': 'Allow network access to check the OneBot connection.',
      'authentication-failed': 'OneBot rejected authentication. Check the saved access token.',
      'account-unavailable': 'OneBot responded without a login account. Check whether QQ is signed in.',
      'account-offline': 'OneBot is reachable. The QQ account is offline.',
      'account-unhealthy': 'OneBot reports a service problem.',
      'connection-failed': 'OneBot could not be reached. Check its HTTP address and whether the client is running.',
      receive: 'Enable QQ bindings',
      bindingSteps: 'Add a private chat or group, enter its number, choose a DSH conversation, then save settings.',
      bindingReceiveHint: 'Enable Receive for the binding and allow network access. Configure signed webhooks in Connection or turn on polling in Message behavior.',
      chatType: 'QQ chat type',
      privateChat: 'Private chat',
      groupChat: 'Group chat',
      contactNumber: 'Contact’s QQ number',
      groupNumber: 'QQ group number',
      chooseConversation: 'Choose DSH conversation',
      chooseWithModel: 'Choose conversation and model',
      conversation: 'DSH conversation',
      noConversation: 'No conversation selected',
      bindingOptions: 'More binding options',
      outboundTargets: 'Send-only QQ chats',
      outboundHint: 'Add a contact or group that DSH can message directly. Select the chat by name in a DSH conversation.',
      outboundLabel: 'Chat name (optional)',
      outboundAdd: 'Add send-only chat',
      sendHint: 'Turn on outbound sends here and in Message Routing, enable network access, and allow sends for the target chat.',
      voiceHint: 'Plain replies can use speech. Replies with a group mention use text so the member gets the mention.',
      invalidChatNumber: 'Enter a valid QQ number or group number for each chat.',
      missingConversation: 'Choose a DSH conversation for each binding.',
      duplicateChat: 'Add each QQ chat once across bindings and send-only chats.',
      duplicateConversation: 'Each DSH conversation can only be bound once.',
      messages: 'Message behavior',
      messageReceive: 'Receiving messages',
      messageSend: 'Sending replies',
      sendBufferHint: 'Replies enter the outbox first. The agent can review and edit them before sending.',
      modeHint: 'Queue waits for the current turn. Steer adds the message at the next step.',
      receiveDetails: 'Receiving options',
      quoteDetails: 'Quote limits',
      perBindingRules: 'Rules for a QQ chat',
      quoteHint: 'Read incoming quotes. The agent chooses whether and which message to quote.',
      continuationHint: 'Extra replies use the limits below and require continuation in Super agent message IO.',
      modelHint: 'Choose a model policy and an ordered fallback list for each QQ chat.',
      quotaCandidates: 'Fallback models',
      quotaBudget: 'Maximum model switches',
      quotaHint: 'After quota exhaustion, the next QQ message can use a fallback when the session is idle.',
      addModel: 'Add candidate',
      chooseModel: 'Choose model',
      reasoningEffort: 'Reasoning effort',
      modelDefaultEffort: 'Model default',
      moveUp: 'Move up',
      moveDown: 'Move down',
      noCandidates: 'Add a model to use as a fallback.',
      modelsLoading: 'Loading DSH models…',
      modelsFailed: 'Could not read the DSH model catalog.',
      modelsEmpty: 'The DSH model catalog is empty.',
      reloadModels: 'Reload model list',
      modelDiagnostics: 'Model diagnostics',
      tests: 'Send / receive test',
      testTarget: 'QQ chat',
      testChooseTarget: 'Choose a saved QQ chat',
      testText: 'Test message',
      testDefaultText: 'DSH connection test',
      testSend: 'Send test message',
      testSent: 'OneBot confirmed the send.',
      testUnknown: 'Send outcome is uncertain. Check QQ before retrying.',
      testFailed: 'OneBot did not confirm the send.',
      testStart: 'Start receive test',
      testCode: 'Receive test code',
      testInstructions: 'Send this exact code from QQ in the selected chat within two minutes.',
      testWaiting: 'Waiting for the code from QQ…',
      testReceived: 'DSH received the code.',
      testExpired: 'Test expired. Start a new test.',
      testWebhook: 'Signed webhook',
      testPolling: 'History polling',
      testServiceError: 'Could not read the test result. Reload QQ bridge and try again.',
      NETWORK_ACCESS_DISABLED: 'Allow QQ network access in Connection.',
      QQ_SEND_DISABLED: 'Enable sending for the selected binding and in Security.',
      QQ_GROUP_MEMBER_MUTED: 'The QQ account is muted in this group.',
      QQ_GROUP_ALL_MUTED: 'This group has muted all members.',
      QQ_NOT_IN_GROUP: 'The QQ account is outside this group.',
      QQ_ACCOUNT_OFFLINE: 'The QQ account is offline.',
      QQ_ONEBOT_AUTH_FAILED: 'OneBot rejected authentication.',
      QQ_RECEIVE_DISABLED: 'Enable QQ bindings and Receive for the selected chat.',
      QQ_RECEIVE_SETUP: 'Set up signed webhooks in Connection or enable polling in Message behavior.',
      INVALID_TEST_MESSAGE: 'Enter a test message of 1–500 characters.',
      TEST_TARGET_CHANGED: 'The saved chat changed. Reload settings and choose it again.',
    })
    Object.assign(zh, {
      typingEnabled: '文字发送前模拟打字', typingSpeed: '默认打字速度', typingSlow: '慢', typingNormal: '自然', typingFast: '快', typingCustom: '自定义', typingLimit: '每条消息最多等待（秒）', typingHint: '等待期间继续接收消息；计时结束后唤醒大肥鱼，对照最新聊天决定发送、修改或放弃。大肥鱼也可以自行调整速度或立即发送。', retargetNotice: '聊天或会话已更换，请检查并重新开启这个绑定的接收和外发。',
      connectAndCheck: '保存并检测连接', connectionCard: '连接机器人', connectionCardHint: '先在 OneBot 客户端登录机器人，再在这里保存地址和令牌。', connectionCurrent: '连接状态', connectionUnchecked: '等待检测', connectionChangesSaved: '连接设置已保存。', connectionReadyToSave: '点击「保存并检测连接」应用新设置。',
      selectedChat: '选择 QQ 聊天', noBindingsYet: '添加 QQ 聊天后，将它连接到一个 DSH 会话。', conversationLinked: '已绑定会话', personaSettings: '这个聊天的人设', personaOverrideHint: '开启专属人设后仅用于这个聊天；其余聊天使用默认人设。', defaultPersonaSettings: 'QQ 聊天默认人设', chatRulesLink: '消息规则', chatModelLink: '模型设置', chatTestLink: '测试这个聊天', chatReceiveOn: '接收中', chatReceiveOff: '接收关闭', chatSendOn: '可发送', chatSendOff: '发送关闭',
      chatModel: '会话模型', followSessionModel: '跟随 DSH 会话', chatModelHint: '保存后将所选模型应用到这个会话一次；以后仍可在 DSH 中自行更换。', chatModelUnavailable: '已保存的模型暂未出现在列表中',
      voiceOutputTitle: '发送语音', voiceInputTitle: '接收语音', fileMediaTitle: '图片与文件', advancedMedia: '媒体高级设置', extraQqFeatures: 'QQ 空间', legacyAdvanced: '导入旧配置', detailedDiagnostics: '查看技术详情', goFixBindings: '检查 QQ 绑定', replyQuietSeconds: '等待后续消息（秒）', globalSendTitle: 'QQ 消息发送',
      permission: '向 QQ 发送消息时，还需要打开目标聊天的外发开关。',
      replyQuietMs: '群聊回复前等待后续消息（毫秒）', replyQuietHint: '群消息继续及时接收；回复前稍等完整消息，再一并处理。',
      voiceProvider: '语音服务', deepseekVoice: 'DeepSeek 音色', deepseekVoiceHint: 'DeepSeek 官方语音使用现有 DeepSeek API 凭据，按字符计费。',
      rateEnabled: '限制回复频率', perMinute: '每分钟最多回复次数',
      hostPermissionTitle: '各会话的主机权限', hostPermissionHint: '使用 DSH 会话原生权限档位，控制文件和命令访问。', hostPermissionSession: 'QQ 对应会话', hostPermissionPreset: '权限档位', hostPermissionApply: '应用到会话', hostPermissionCurrent: '当前档位', hostPermissionUnavailable: '暂时无法读取会话权限。', hostPermissionSaved: '会话权限已更新。', hostPermissionReadOnly: '只读', hostPermissionWorkspace: '工作区可写', hostPermissionFull: '完全权限',
      priceSchedule: '按 DeepSeek 峰谷时段回应',
      peakProbability: '高峰回应概率（%）',
      offPeakProbability: '闲时回应概率（%）',
      peakCooldown: '高峰回应间隔（秒）',
      offPeakCooldown: '闲时回应间隔（秒）',
      quotaReply: '模型欠费时的回复',
      quotaReplyHint: '模型余额不足时，私聊和群里被 @ 会自动发送这句话。清空可关闭。',
      priceScheduleHint: '使用 DeepSeek 模型时生效。北京时间工作日 09:00–12:00、14:00–18:00 为高峰，周末及法定节假日按闲时，用于普通群消息。',
      mergeEnabled: '按聊天合并连续消息', mergeWindow: '静默窗口（毫秒）', mergeMaxWait: '最长持有（毫秒）', mergeMaxMessages: '接收缓冲最多消息数', mergeMaxChars: '接收缓冲字符上限', mergeHint: 'QQ 消息收到后尽快送入 DSH；插话由 DSH 的「插话合并」插件在下一步统一处理。',
      pollingEnabled: '轮询 OneBot HTTP 历史', pollingInterval: '轮询间隔（毫秒）', pollingCatchup: '补投窗口（毫秒）', pollingHint: '显式开启。启用时从当前时间 watermark 开始，不回灌旧历史；同一时刻只跑一个轮询，保存/卸载时可终止。消息仍走既有 IO ingress 与收发闸。',
      qzoneEnabled: '启用 QQ 空间工具', qzonePost: '允许发说说', qzoneLike: '允许点赞说说', qzoneComment: '允许评论说说', qzoneHint: '读取工具只需空间总开关；发说说、点赞、评论还要求业务外发总开关和该绑定外发开关。不读取任意本地路径。',
      scheduleHint: 'Host 定时任务只由用户或 Agent 通过官方 schedule 服务显式创建。加载、保存或导入设置都不会创建任务。',
      networkOff: 'QQ 网络访问已关闭。配置连接地址后，可在本页开启。',
      rateHint: '冷却和频率限制用于群聊回复；新消息继续进入会话。',
      asrMissing: 'ASR 需要本机原生语音服务提供已就绪的识别器。没有可用识别器时，入站音频保留为持久附件并附加明确说明。',
      diagnosticsHint: '诊断展示所选绑定的预览、有界 IO 历史、预载与取消、准入决策、轮询 watermark 与合并窗口状态。',
      provenance: '派生自 Yuuyuko-uu/dsh-qq-link，保留原作者与 Yuuyuko-uu 插件许可 1.2。',
      hostAccessTitle: 'QQ 网络访问',
      hostAccessHint: '允许桥接连接本页设置的 OneBot 地址。接收和外发各有单独开关。',
      hostAccessLoading: '正在读取网络权限…',
      hostAccessUnavailable: '暂时读不到网络权限。可以重新读取。',
      hostAccessCurrent: '当前值',
      hostAccessOn: '开启',
      hostAccessOff: '关闭',
      hostAccessToggle: '允许网络访问',
      hostAccessReadOnly: '网络权限当前为只读。',
      hostAccessSave: '保存网络权限',
      hostAccessRetry: '重试读取',
      hostAccessSaved: '网络权限已保存。',
      hostAccessError: '保存失败。请重新读取后重试。',
      botLoginHint: '在 OneBot 客户端登录机器人 QQ。把客户端的 HTTP 地址填在这里并点「保存设置」。客户端设有访问令牌时，填入同一个令牌并点「保存令牌」。点「检测连接」可核对实际接入的 QQ 号。',
      saveAuth: 'DSH 拒绝了保存请求，请从所有者会话重新打开设置。', saveInvalid: '设置校验失败，请检查重复的 QQ 或 DSH 会话绑定、连接地址和数值范围。', saveApply: '桥接写入或应用设置时失败。请重新读取，核对已保存的值。', saveTimeout: '保存请求超时，请重新读取设置核对结果。', defaultPersona: '默认人设', defaultPersonaEnabled: '启用默认人设', defaultPersonaHint: '未开启专属人设的 QQ 绑定使用这段设定。', customPersona: '启用专属人设', snowLumaTitle: '从 SnowLuma 配置连接',
      snowLumaHint: '在 SnowLuma 登录 QQ 并启用 OneBot HTTP 服务，然后选择本机的 config/onebot_<QQ号>.json 文件。',
      snowLumaFile: 'SnowLuma JSON 文件',
      snowLumaReading: '正在读取配置…',
      snowLumaInvalid: '请选择有效的 SnowLuma OneBot JSON 文件，大小上限为 128 KiB。',
      snowLumaNoHttp: '未找到可用的本机 HTTP 服务。请在 SnowLuma 启用本机 OneBot HTTP 服务，将路径设为 /，再选择更新后的文件。',
      snowLumaServer: '本机 HTTP 服务',
      snowLumaAccount: '文件名中的 QQ 号',
      snowLumaHasToken: '配置含有访问令牌',
      snowLumaNoToken: '该服务未设置访问令牌',
      snowLumaUse: '使用此连接',
      snowLumaSaveAddress: '先点击下方「保存设置」保存 HTTP 地址。',
      snowLumaSaveToken: '保存导入的令牌',
      snowLumaClearToken: '清除已保存的 OneBot 令牌',
      goToBindings: '打开 QQ 绑定',
      bindings: 'QQ 绑定',
      receive: '启用 QQ 绑定',
      token: 'OneBot 访问令牌',
      secret: '上报签名密钥',
      saveToken: '保存令牌',
      saveWebhookSecret: '保存签名密钥',
      checkOneBot: '检测连接',
      checkedAccount: '已连接 QQ',
      saveBeforeCheck: '请先保存修改后的 HTTP 地址或令牌。',
      eventSettings: 'QQ 消息设置',
      'network-disabled': '开启并保存网络访问权限后即可检测连接。',
      'authentication-failed': 'OneBot 鉴权失败，请核对已保存的访问令牌。',
      'account-unavailable': 'OneBot 已响应，请检查客户端的 QQ 登录状态。',
      'account-offline': 'OneBot 已连接，当前 QQ 账号离线。',
      'account-unhealthy': 'OneBot 报告运行异常。',
      'connection-failed': '连接 OneBot 失败，请核对 HTTP 地址和客户端运行状态。',
      bindingSteps: '添加绑定后，选私聊或群聊，填写对方 QQ 号或群号，再选择 DSH 会话并保存设置。',
      bindingReceiveHint: '打开本条绑定的「接收」并允许网络访问。在「连接」配置签名上报，或在「收发行为」开启轮询接收。',
      chatType: 'QQ 聊天类型',
      privateChat: '私聊',
      groupChat: '群聊',
      contactNumber: '对方 QQ 号',
      groupNumber: 'QQ群号',
      chooseConversation: '选择 DSH 会话',
      chooseWithModel: '选择会话及模型',
      conversation: 'DSH 会话',
      noConversation: '还未选择会话',
      bindingOptions: '更多绑定设置',
      outboundTargets: '只发送的 QQ 聊天',
      outboundHint: '添加好友或群聊后，可在任意 DSH 会话里按名称发消息。这里填写 QQ 号或群号即可。',
      outboundLabel: '聊天名称（可选）',
      outboundAdd: '添加只发送聊天',
      sendHint: '请开启本页和消息路由的外发开关、连接中的网络访问，以及目标聊天的「外发」。',
      voiceHint: '普通回复可发成语音，含群成员 @ 的回复用文字送达点名。',
      invalidChatNumber: '请为每个聊天填写有效的 QQ 号或群号。',
      missingConversation: '请为每条绑定选择 DSH 会话。',
      duplicateChat: '每个 QQ 聊天在绑定和只发送列表中合计只能添加一次。',
      duplicateConversation: '同一个 DSH 会话只能绑定一次。',
      messages: '收发行为',
      messageReceive: '收到消息',
      messageSend: '发送回复',
      sendBufferHint: '回复先进入待发区，大肥鱼可以整理、修改后自主发送。',
      modeHint: '排队会等当前轮结束，插话会在下一步加入消息。',
      receiveDetails: '接收细节',
      quoteDetails: '引用上限',
      perBindingRules: '单个 QQ 聊天的规则',
      quoteHint: '读取收到的引用；是否引用以及引用哪条消息由大肥鱼自行决定。',
      continuationHint: '追加回复会按下方预算发起额外模型请求，同时需启用 Super agent 消息 IO 的追加回复。',
      modelHint: '为各个 QQ 聊天选择模型策略和候选模型的顺序。',
      quotaCandidates: '候选模型',
      quotaBudget: '最多切换次数',
      quotaHint: '额度耗尽后，会话空闲时，下一条 QQ 消息会按候选顺序尝试换模。',
      addModel: '添加候选',
      chooseModel: '选择模型',
      reasoningEffort: '推理强度',
      modelDefaultEffort: '模型默认',
      moveUp: '上移',
      moveDown: '下移',
      noCandidates: '先添加一个候选模型。',
      modelsLoading: '正在读取 DSH 模型…',
      modelsFailed: '暂时读不到 DSH 模型列表。',
      modelsEmpty: 'DSH 模型列表为空。',
      reloadModels: '重新读取模型列表',
      modelDiagnostics: '模型诊断',
      tests: '收发测试',
      testTarget: 'QQ 聊天',
      testChooseTarget: '选择已保存的 QQ 聊天',
      testText: '测试消息',
      testDefaultText: 'DSH 连接测试',
      testSend: '发送测试消息',
      testSent: 'OneBot 已确认发送。',
      testUnknown: '发送结果待确认，请先到 QQ 查看。',
      testFailed: 'OneBot 未确认发送。',
      testStart: '开始接收测试',
      testCode: '接收检测码',
      testInstructions: '请在两分钟内，从 QQ 把这段检测码原样发到所选聊天。',
      testWaiting: '等待 QQ 发来检测码…',
      testReceived: 'DSH 已收到检测码。',
      testExpired: '检测码已过期，可重新开始测试。',
      testWebhook: '签名上报',
      testPolling: '轮询接收',
      testServiceError: '暂时读不到测试结果，请重新加载 QQ 桥接后再试。',
      NETWORK_ACCESS_DISABLED: '请在「连接」允许 QQ 网络访问。',
      QQ_SEND_DISABLED: '请打开该绑定的接收、外发，以及「权限安全」中的外发总开关。',
      QQ_GROUP_MEMBER_MUTED: '当前 QQ 账号在该群被禁言。',
      QQ_GROUP_ALL_MUTED: '该群已开启全员禁言，当前账号的群内发言已暂停。',
      QQ_NOT_IN_GROUP: '当前 QQ 账号未加入该群。',
      QQ_ACCOUNT_OFFLINE: '当前 QQ 账号已离线。',
      QQ_ONEBOT_AUTH_FAILED: 'OneBot 鉴权失败。',
      QQ_RECEIVE_DISABLED: '请启用 QQ 绑定和所选聊天的接收。',
      QQ_RECEIVE_SETUP: '请在「连接」配置签名上报，或在「收发行为」开启轮询接收。',
      INVALID_TEST_MESSAGE: '请输入 1 到 500 字的测试消息。',
      TEST_TARGET_CHANGED: '已保存的聊天发生变化，请重新读取设置后再选。',
    })
    function bindingIssue(bindings, outboundTargets) {
      const chats = new Set(), sessions = new Set()
      for (const { endpoint, sessionId } of bindings) {
        if (!/^(private|group):[1-9]\d{0,23}$/.test(endpoint)) return 'invalidChatNumber'
        const session = sessionId?.trim()
        if (!session) return 'missingConversation'
        if (chats.has(endpoint)) return 'duplicateChat'
        if (sessions.has(session)) return 'duplicateConversation'
        chats.add(endpoint)
        sessions.add(session)
      }
      for (const { endpoint } of outboundTargets) {
        if (!/^(private|group):[1-9]\d{0,23}$/.test(endpoint)) return 'invalidChatNumber'
        if (chats.has(endpoint)) return 'duplicateChat'
        chats.add(endpoint)
      }
      return ''
    }
    const css = `.qqb001{max-width:960px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.65}.qqb001 h2{font-size:20px;font-weight:600;margin:0 0 4px;letter-spacing:-.02em}.qqb001 h3{font-size:15px;font-weight:600;margin:0 0 14px}.qqb001 p{max-width:68ch;margin:4px 0 14px;color:var(--dsw-alias-label-secondary)}.qqb001 nav{display:flex;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);margin:20px 0}.qqb001 button{font:inherit;cursor:pointer;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 10px;transition:background .2s,transform .15s}.qqb001 button:hover{background:var(--dsw-alias-bg-layer-2)}.qqb001 button:active{transform:translateY(1px)}.qqb001 button:disabled{opacity:.5;cursor:not-allowed}.qqb001 [role=tab]{border:0;border-radius:0;background:transparent;padding:8px 1px 10px;color:var(--dsw-alias-label-tertiary)}.qqb001 [aria-selected=true]{color:var(--dsw-alias-label-primary);box-shadow:inset 0 -2px var(--dsw-alias-label-primary)}.qqb001 :is(input,select,textarea,button):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}.qqb001 input:not([type=checkbox]),.qqb001 select,.qqb001 textarea{box-sizing:border-box;max-width:100%;width:100%;font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px}.qqb001 textarea{min-height:100px;resize:vertical}.qqb001 label.qqb001-field{display:grid;grid-template-columns:minmax(130px,28%) minmax(0,1fr);gap:14px;margin:12px 0;align-items:start}.qqb001 .qqb001-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}.qqb001 .qqb001-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.qqb001 .qqb001-binding{border-top:1px solid var(--dsw-alias-border-l2);padding:16px 0}.qqb001-layout{display:flex;flex-direction:column;block-size:100%;min-block-size:0;min-inline-size:0}
.qqb001-content{flex:1 1 auto;min-block-size:0;min-inline-size:0;overflow-y:auto;scrollbar-gutter:stable;margin-inline:-4px;padding:0 4px 16px}
.qqb001 .qqb001-actions{flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;border-top:1px solid var(--dsw-alias-border-l2);padding-block-start:12px}
.qqb001-actions button{white-space:nowrap}
.qqb001-actions small{min-inline-size:0;overflow-wrap:anywhere}.qqb001 pre{max-height:340px;overflow:auto;background:var(--dsw-alias-bg-layer-2);padding:12px;font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.qqb001 [role=alert]{border-left:3px solid var(--dsw-alias-state-business-primary);padding-left:12px}.qqb001 small{font-size:12px;color:var(--dsw-alias-label-tertiary)}@media(max-width:640px){.qqb001 label.qqb001-field{grid-template-columns:1fr;gap:4px}.qqb001 nav{gap:2px 12px}}.qqb001 .qqb001-destination{display:grid;grid-template-columns:minmax(130px,28%) minmax(0,1fr) auto;gap:14px;align-items:center;padding:10px 0 14px}
.qqb001 .qqb001-destination strong{font-weight:600;overflow-wrap:anywhere}
.qqb001 .qqb001-binding-options{margin-top:12px}
.qqb001 .qqb001-binding-options summary{color:var(--dsw-alias-label-secondary);cursor:pointer}
.qqb001 .qqb001-binding-options[open] summary{margin-bottom:12px}
.qqb001-message-options{display:grid;gap:8px}
.qqb001 .qqb001-message-options label.qqb001-field{margin-block:4px}
.qqb001-candidates{margin:10px 0;padding-inline-start:20px}
.qqb001-candidates li{padding:7px 0}
.qqb001-candidate{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;overflow-wrap:anywhere}
.qqb001-candidate button{padding:3px 7px}
.qqb001 .qqb001-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:16px;margin:12px 0;min-width:0}
.qqb001 .qqb001-card h4{font-size:14px;font-weight:650;margin:0 0 6px}.qqb001 .qqb001-card>p:last-child{margin-bottom:0}
.qqb001 .qqb001-chat-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.qqb001 .qqb001-chat-head strong{font-size:14px}.qqb001 .qqb001-badges{display:flex;gap:6px;flex-wrap:wrap}
.qqb001 .qqb001-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.qqb001 .qqb001-badge:before{content:'';width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}.qqb001 .qqb001-badge.is-on:before{background:#75b99a}
.qqb001 .qqb001-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.qqb001 .qqb001-links button{font-size:12px}
.qqb001 .qqb001-chat-tools{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}.qqb001 .qqb001-chat-tools button{white-space:nowrap}
.qqb001 .qqb001-section-title{margin:16px 0 6px}.qqb001 .qqb001-card .qqb001-binding-options{margin-top:10px}
.qqb001 .qqb001-summary-line{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.qqb001 .qqb001-actions{padding-inline:2px;padding-block:12px 2px}.qqb001 .qqb001-content{overflow-x:hidden;margin-inline:0;padding-inline:2px}
@media(max-width:640px){.qqb001 .qqb001-destination,.qqb001 .qqb001-chat-tools{grid-template-columns:1fr;gap:6px;justify-items:start}.qqb001 .qqb001-chat-tools>label{width:100%}}
@media(prefers-reduced-motion:reduce){.qqb001 button{transition:none}}`
    function apply(ctx) {
      const t = ctx.locale.bind(NS), listeners = new Set(); let picker, pickerAvailable = false
      const pickerSource = { getSnapshot: () => pickerAvailable, subscribe: callback => { listeners.add(callback); return () => listeners.delete(callback) } }
      const publishPicker = value => { picker = value; pickerAvailable = !!value; listeners.forEach(callback => callback()) }
      ctx.effect(() => ctx.locale.register(NS, { en, zh }))
      ctx.inject(['resourcePicker'], child => child.effect(() => { const service = child.resourcePicker; publishPicker(service?.version === 1 && service.capabilities().overlay ? service : undefined); return () => publishPicker(undefined) }))
      const CONFIG_ENTRY_IDS = Object.freeze(['dsh-qq-bridge', 'qq-bridge-001'])
      function createHostAccess(owner) {
        const accessListeners = new Set(), formOffs = []
        let service, entries
        let current = { status: 'unavailable', value: undefined, revision: undefined, writable: false, entryId: '', code: 'NO_SERVICE' }
        const choose = () => {
          const views = (entries ?? []).map(entry => {
            try { return { entry, view: entry.form && typeof entry.form.getSnapshot === 'function' ? entry.form.getSnapshot() : undefined } } catch { return { entry, view: undefined } }
          }).filter(item => item.view)
          const selected = views.find(item => item.view.status === 'ready') ?? views.find(item => item.view.status === 'loading')
          if (!selected) return { status: 'unavailable', value: undefined, revision: undefined, writable: false, entryId: '', code: 'NOT_SERVED' }
          return { status: selected.view.status, value: selected.view.value, revision: selected.view.revision, writable: selected.view.writable === true, entryId: selected.entry.id, code: selected.view.status === 'ready' ? 'READY' : 'LOADING' }
        }
        const publish = () => { current = choose(); for (const listener of [...accessListeners]) { try { listener() } catch { /* A slot listener failure must not break the form. */ } } }
        const ensure = () => {
          if (entries) { publish(); return true }
          let candidate
          try { candidate = typeof owner.get === 'function' ? owner.get('configForms') : undefined } catch { candidate = undefined }
          if (!candidate || typeof candidate.get !== 'function') { current = { ...current, status: 'unavailable', code: 'NO_SERVICE' }; return false }
          service = candidate
          entries = CONFIG_ENTRY_IDS.map(entryId => { try { return { id: entryId, form: service.get(entryId) } } catch { return { id: entryId, form: undefined } } })
          for (const entry of entries) if (entry.form && typeof entry.form.subscribe === 'function') {
            try { formOffs.push(entry.form.subscribe(() => publish())) } catch { /* Optional form subscription failure leaves the other entry usable. */ }
          }
          publish()
          return true
        }
        const refresh = () => {
          if (service && typeof service.describe === 'function') { try { const pending = service.describe().ensure?.(); if (pending && typeof pending.catch === 'function') pending.catch(() => {}) } catch { /* Missing describe face remains a retryable read. */ } }
          ensure(); publish()
        }
        const set = value => {
          ensure()
          const selected = (entries ?? []).find(entry => {
            try { const snapshot = entry.form && entry.form.getSnapshot(); return snapshot?.status === 'ready' && snapshot.writable === true && typeof entry.form.set === 'function' } catch { return false }
          })
          return selected ? selected.form.set('networkAccess', value === true) : Promise.resolve(false)
        }
        ensure()
        return {
          source: { getSnapshot: () => current, subscribe: listener => { accessListeners.add(listener); ensure(); return () => accessListeners.delete(listener) }, refresh, set },
          refresh, set,
          dispose: () => { for (const off of formOffs.splice(0)) { try { off() } catch { /* Service-owned form teardown. */ } } accessListeners.clear(); entries = undefined; service = undefined },
        }
      }
      const hostAccess = createHostAccess(ctx)
      ctx.effect(() => () => hostAccess.dispose())
      const unavailableHostAccess = Object.freeze({ status: 'unavailable', value: undefined, revision: undefined, writable: false, entryId: '', code: 'NO_SERVICE' })
      const useUnavailableHostAccess = selector => selector(unavailableHostAccess)
      async function request(path, body, signal) {
        const response = await fetch('/dsh-qq-bridge-001' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) })
        const value = await response.json().catch(() => null)
        if (!response.ok || !value?.ok) throw new Error(value?.code || 'HTTP_' + response.status)
        return value
      }
      function bindingCaption(row) {
        const [type, number] = row.endpoint.split(':')
        const peer = t(type === 'group' ? 'groupChat' : 'privateChat') + (number ? ' ' + number : '')
        return row.label && row.label !== row.endpoint ? row.label + ' · ' + peer : peer
      }
      const snowLumaFileLimit = 128 * 1024
      function snowLumaConnections(text, filename) {
        const config = JSON.parse(text.replace(/^\uFEFF/, ''))
        const servers = config?.networks?.httpServers
        if (!Array.isArray(servers)) return { error: 'snowLumaNoHttp' }
        const connections = new Map()
        for (const server of servers) {
          if (!server || server.enabled === false || !Number.isInteger(server.port) || server.port < 1 || server.port > 65535) continue
          if (server.path !== undefined && server.path !== '/') continue
          const host = typeof server.host === 'string' ? server.host.trim().toLowerCase() : server.host === undefined ? '0.0.0.0' : ''
          const loopback = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host === '::1' ? '[::1]' : host
          if (!['localhost', '127.0.0.1', '[::1]'].includes(loopback)) continue
          if (server.accessToken !== undefined && typeof server.accessToken !== 'string') continue
          const accessToken = server.accessToken?.trim() ?? ''
          if (accessToken.length > 4096 || /[\u0000-\u001f\u007f]/.test(accessToken)) continue
          const origin = 'http://' + loopback + (server.port === 80 ? '' : ':' + server.port)
          if (!connections.has(origin)) connections.set(origin, { origin, accessToken })
        }
        return connections.size
          ? { connections: [...connections.values()], qq: /^onebot_([1-9]\d{0,23})\.json$/i.exec(filename)?.[1] }
          : { error: 'snowLumaNoHttp' }
      }
      const modelKey = (provider, model) => JSON.stringify([provider, model])
      function modelCaption(catalog, selection) {
        if (!selection) return t('noModel')
        const group = catalog?.groups.find(group => group.id === selection.provider)
        const model = group?.models.find(model => model.id === selection.model)
        const effort = model?.reasoning?.efforts.find(effort => effort.id === selection.reasoningEffort)?.name ?? selection.reasoningEffort
        return [group?.name ?? selection.provider, model?.name ?? selection.model, effort].filter(Boolean).join(' · ')
      }
      function BindingModelFields({ row, update, catalog, field, disabled }) {
        const groups = catalog?.groups ?? [], selection = row.modelSelection
        const value = selection ? modelKey(selection.provider, selection.model) : ''
        const choices = groups.flatMap(group => group.models.map(model => ({ group, model })))
        const selected = choices.find(item => modelKey(item.group.id, item.model.id) === value)
        const efforts = selected?.model.reasoning?.efforts ?? []
        const apply = modelSelection => update({ modelSelection, modelPolicy: modelSelection ? 'binding-once' : 'native-wins', modelRevision: (row.modelRevision || 0) + 1 })
        return h(React.Fragment, null,
          field('chatModel', h('select', { value, disabled: disabled || !catalog, onChange: event => {
            if (!event.target.value) return apply(undefined)
            const choice = choices.find(item => modelKey(item.group.id, item.model.id) === event.target.value)
            if (choice) apply({ provider: choice.group.id, model: choice.model.id })
          } }, h('option', { value: '' }, t('followSessionModel')),
          selection && !selected && h('option', { value }, modelCaption(catalog, selection) + ' · ' + t('chatModelUnavailable')),
          groups.map(group => h('optgroup', { key: group.id, label: group.name ?? group.id },
            group.models.map(model => h('option', { key: model.id, value: modelKey(group.id, model.id) }, model.name ?? model.id))))), 'chatModelHint'),
          selection && (efforts.length > 0 || selection.reasoningEffort) && field('reasoningEffort', h('select', { value: selection.reasoningEffort ?? '', disabled: disabled || !selected, onChange: event => {
            const next = { provider: selection.provider, model: selection.model, ...(event.target.value ? { reasoningEffort: event.target.value } : {}) }; apply(next)
          } }, h('option', { value: '' }, t('modelDefaultEffort')),
          selection.reasoningEffort && !efforts.some(effort => effort.id === selection.reasoningEffort) && h('option', { value: selection.reasoningEffort }, selection.reasoningEffort),
          efforts.map(option => h('option', { key: option.id, value: option.id }, option.name ?? option.id)))))
      }
      function QuotaFields({ row, update, catalog, field, disabled }) {
        const policy = row.quotaPolicy ?? { mode: 'off', maxSwitches: 1, candidates: [] }
        const [selectedModel, setSelectedModel] = React.useState('')
        const [effort, setEffort] = React.useState('')
        const groups = catalog?.groups ?? []
        const choices = groups.flatMap(group => group.models.map(model => ({ group, model })))
        const choice = choices.find(({ group, model }) => modelKey(group.id, model.id) === selectedModel)
        const efforts = choice?.model.reasoning?.efforts ?? []
        const candidate = choice && {
          provider: choice.group.id, model: choice.model.id,
          ...(effort && efforts.some(option => option.id === effort) ? { reasoningEffort: effort } : {}),
        }
        const exists = candidate && policy.candidates.some(item =>
          item.provider === candidate.provider && item.model === candidate.model && item.reasoningEffort === candidate.reasoningEffort)
        const changePolicy = patch => update({ quotaPolicy: { ...policy, ...patch } })
        const move = (index, offset) => {
          const candidates = [...policy.candidates]
          const [item] = candidates.splice(index, 1)
          candidates.splice(index + offset, 0, item)
          changePolicy({ candidates })
        }
        return h('div', null,
          field('quotaMode', h('select', { value: policy.mode, disabled, onChange: event => changePolicy({ mode: event.target.value }) },
            h('option', { value: 'off' }, t('quotaOff')), h('option', { value: 'next-input' }, t('next-input')))),
          policy.mode === 'next-input' && h(React.Fragment, null,
            h('p', { className: 'qqb001-hint' }, t('quotaHint')),
            field('quotaBudget', h('select', { value: policy.maxSwitches, disabled, onChange: event => changePolicy({ maxSwitches: Number(event.target.value) }) },
              Array.from({ length: 8 }, (_, index) => h('option', { key: index + 1, value: index + 1 }, index + 1)))),
            policy.candidates.length > 0 && h('ol', { className: 'qqb001-candidates', 'aria-label': t('quotaCandidates') },
              policy.candidates.map((item, index) => h('li', { key: index },
                h('div', { className: 'qqb001-candidate' },
                  h('span', null, modelCaption(catalog, item)),
                  h('div', { className: 'qqb001-row' },
                    h('button', { type: 'button', disabled: disabled || index === 0, onClick: () => move(index, -1) }, t('moveUp')),
                    h('button', { type: 'button', disabled: disabled || index === policy.candidates.length - 1, onClick: () => move(index, 1) }, t('moveDown')),
                    h('button', { type: 'button', disabled, onClick: () => changePolicy({ candidates: policy.candidates.filter((_, n) => n !== index) }) }, t('remove'))))))),
            policy.candidates.length === 0 && h('p', { className: 'qqb001-hint' }, t('noCandidates')),
            field('chooseModel', h('select', { value: choice ? selectedModel : '', disabled: disabled || !choices.length,
              onChange: event => { setSelectedModel(event.target.value); setEffort('') } },
              h('option', { value: '' }, t('chooseModel')),
              groups.map(group => h('optgroup', { key: group.id, label: group.name ?? group.id },
                group.models.map(model => h('option', { key: model.id, value: modelKey(group.id, model.id) }, model.name ?? model.id)))))),
            efforts.length > 0 && field('reasoningEffort', h('select', { value: effort, disabled, onChange: event => setEffort(event.target.value) },
              h('option', { value: '' }, t('modelDefaultEffort')),
              efforts.map(option => h('option', { key: option.id, value: option.id }, option.name ?? option.id)))),
            h('button', { type: 'button', disabled: disabled || !candidate || !!exists || policy.candidates.length >= 8, onClick: () => {
              changePolicy({ candidates: [...policy.candidates, candidate] })
              setSelectedModel('')
              setEffort('')
            } }, t('addModel'))))
      }
      const testReasons = new Set([
        'NETWORK_ACCESS_DISABLED', 'QQ_SEND_DISABLED', 'QQ_RECEIVE_DISABLED', 'QQ_RECEIVE_SETUP', 'INVALID_TEST_MESSAGE', 'TEST_TARGET_CHANGED',
        'QQ_GROUP_MEMBER_MUTED', 'QQ_GROUP_ALL_MUTED', 'QQ_NOT_IN_GROUP', 'QQ_ACCOUNT_OFFLINE', 'QQ_ONEBOT_AUTH_FAILED',
      ])
      function TestPanel({ config, field, initialBindingId = '' }) {
        const [bindingId, setBindingId] = React.useState(initialBindingId)
        const [message, setMessage] = React.useState(t('testDefaultText'))
        const [pending, setPending] = React.useState(false)
        const [sendResult, setSendResult] = React.useState(null)
        const [probe, setProbe] = React.useState(null)
        const lifetime = React.useRef(null)
        const working = React.useRef(false)
        const binding = config.bindings.find(row => row.id === bindingId)
        const hasBinding = !!binding
        const waitingCode = probe?.state === 'waiting' ? probe.code : undefined
        React.useEffect(() => {
          const controller = new AbortController()
          lifetime.current = controller
          return () => controller.abort()
        }, [])
        React.useEffect(() => {
          if (!waitingCode || !hasBinding) return
          const controller = new AbortController()
          let timeout
          const poll = async () => {
            try {
              const { result } = await request('/tests/receive/status', { bindingId, code: waitingCode }, controller.signal)
              if (controller.signal.aborted) return
              if (result.state === 'waiting') timeout = setTimeout(poll, 1500)
              else setProbe(result)
            } catch {
              if (!controller.signal.aborted) setProbe({ state: 'error' })
            }
          }
          timeout = setTimeout(poll, 1500)
          return () => { clearTimeout(timeout); controller.abort() }
        }, [bindingId, waitingCode, hasBinding])
        async function execute(path, body, update, errorState) {
          const signal = lifetime.current?.signal
          if (working.current || signal?.aborted) return
          working.current = true
          setPending(true)
          try {
            const { result } = await request(path, body, signal)
            if (!signal?.aborted) update(result)
          } catch {
            if (!signal?.aborted) update({ state: errorState })
          } finally {
            working.current = false
            if (!signal?.aborted) setPending(false)
          }
        }
        const sendLabel = sendResult?.state === 'delivered' ? 'testSent'
          : sendResult?.state === 'unknown' ? 'testUnknown'
            : testReasons.has(sendResult?.reason) ? sendResult.reason : 'testFailed'
        const receiveLabel = probe?.state === 'received' ? 'testReceived' : probe?.state === 'waiting' ? 'testWaiting'
          : probe?.state === 'expired' ? 'testExpired' : testReasons.has(probe?.reason) ? probe.reason : 'testServiceError'
        return h(React.Fragment, null,
          field('testTarget', h('select', { value: binding ? bindingId : '', disabled: pending, onChange: event => {
            setBindingId(event.target.value)
            setSendResult(null)
            setProbe(null)
          } }, h('option', { value: '' }, t('testChooseTarget')),
          config.bindings.map(row => h('option', { key: row.id, value: row.id }, bindingCaption(row))))),
          h('section', { className: 'qqb001-binding' },
            field('testText', h('input', { value: message, maxLength: 500, disabled: pending, onChange: event => setMessage(event.target.value) })),
            h('button', { type: 'button', disabled: pending || !binding || !message.trim(), onClick: () => {
              setSendResult(null)
              void execute('/tests/send', { bindingId, endpoint: binding.endpoint, text: message, requestId: crypto.randomUUID() }, setSendResult, 'unknown')
            } }, t('testSend')),
            sendResult && h('p', { role: 'status' }, t(sendLabel), sendResult.externalMessageId && ' · ' + sendResult.externalMessageId)),
          h('section', { className: 'qqb001-binding' },
            h('button', { type: 'button', disabled: pending || !binding, onClick: () => {
              setProbe(null)
              void execute('/tests/receive/start', { bindingId, endpoint: binding.endpoint }, setProbe, 'error')
            } }, t('testStart')),
            waitingCode && h(React.Fragment, null,
              h('p', null, t('testInstructions')),
              field('testCode', h('input', { readOnly: true, value: waitingCode, onFocus: event => event.currentTarget.select() }))),
            probe && h('p', { role: 'status' }, t(receiveLabel),
              probe.via === 'webhook' ? ' · ' + t('testWebhook') : probe.via === 'polling' ? ' · ' + t('testPolling') : null)))
      }
      function Section(props) {
        const hasPicker = props.usePickerAvailable(value => value)
        const useNetworkAccess = props.useNetworkAccess ?? useUnavailableHostAccess
        const access = useNetworkAccess(value => value)
        const accessOn = access.status === 'ready' && access.value?.networkAccess === true
        const [networkDraft, setNetworkDraft] = React.useState(accessOn), [networkBusy, setNetworkBusy] = React.useState(false), [networkNotice, setNetworkNotice] = React.useState(''), [networkError, setNetworkError] = React.useState('')
        React.useEffect(() => { setNetworkDraft(accessOn) }, [access.status, access.revision, accessOn])
        const [state, setState] = React.useState(null), [draft, setDraft] = React.useState(null), [page, setPage] = React.useState(sections[0]), [busy, setBusy] = React.useState(false), [dirty, setDirty] = React.useState(false), [error, setError] = React.useState(false), [notice, setNotice] = React.useState(''), [result, setResult] = React.useState(null), [token, setToken] = React.useState(''), [secret, setSecret] = React.useState(''), [legacy, setLegacy] = React.useState(''), [selected, setSelected] = React.useState('')
        const controller = React.useRef(null), tabs = React.useRef([]), pickerPending = React.useRef(false)
        const [accountCheck, setAccountCheck] = React.useState(null)
        const [snowLuma, setSnowLuma] = React.useState(null)
        const [snowLumaOrigin, setSnowLumaOrigin] = React.useState('')
        const [importedCredential, setImportedCredential] = React.useState(null)
        const snowLumaRead = React.useRef(0)
        const [ruleIndex, setRuleIndex] = React.useState(0)
        const [rulesOpen, setRulesOpen] = React.useState(false), [outboundOpen, setOutboundOpen] = React.useState(false), [testBindingId, setTestBindingId] = React.useState('')
        const [catalog, setCatalog] = React.useState(null), [catalogRevision, setCatalogRevision] = React.useState(0)
        const [hostPermissions, setHostPermissions] = React.useState(null), [permissionBinding, setPermissionBinding] = React.useState(''), [permissionPreset, setPermissionPreset] = React.useState(''), [permissionNotice, setPermissionNotice] = React.useState('')
        React.useEffect(() => { setAccountCheck(null) }, [accessOn])
        React.useEffect(() => {
          if (page !== 'model') return
          const controller = new AbortController()
          setCatalog(null)
          request('/models', undefined, controller.signal).then(value => {
            if (!controller.signal.aborted) setCatalog(Array.isArray(value.catalog?.groups) ? value.catalog : false)
          }, () => {
            if (!controller.signal.aborted) setCatalog(false)
          })
          return () => controller.abort()
        }, [page, catalogRevision])
        React.useEffect(() => {
          if (page !== 'security') return
          const signal = new AbortController()
          request('/host-permissions', undefined, signal.signal).then(value => { if (!signal.signal.aborted) setHostPermissions(value.result) }, () => { if (!signal.signal.aborted) setHostPermissions({ available: false }) })
          return () => signal.abort()
        }, [page])
        React.useEffect(() => { controller.current = new AbortController(); load(); return () => controller.current.abort() }, [])
        async function load() { setError(false); setAccountCheck(null); snowLumaRead.current++; setSnowLuma(null); setSnowLumaOrigin(''); setImportedCredential(null); hostAccess.refresh(); try { const next = await request('/state', undefined, controller.current?.signal); setState(next); setDraft(next.config); setDirty(false) } catch { if (!controller.current?.signal.aborted) setError(true) } }
        async function run(fn) { setBusy(true); setError(false); try { await fn() } catch { if (!controller.current?.signal.aborted) setError(true) } finally { if (!controller.current?.signal.aborted) setBusy(false) } }
        async function saveHostAccess() { setNetworkBusy(true); setNetworkError(''); setNetworkNotice(''); try { const accepted = await hostAccess.set(networkDraft); if (!accepted) throw new Error('NOT_ACCEPTED'); setNetworkNotice('hostAccessSaved') } catch { setNetworkError('hostAccessError') } finally { setNetworkBusy(false) } }
        function retryHostAccess() { setNetworkError(''); setNetworkNotice(''); hostAccess.refresh() }
        const saveCredentials = (fields, clear) => run(async () => {
          const next = await request('/credentials', fields, controller.current?.signal)
          clear()
          setState(next)
          setNotice('saved')
          if ('onebotToken' in fields || fields.clearOnebot) setAccountCheck(null)
        })
        const saveAndCheckConnection = () => run(async () => {
          setAccountCheck(null); setNotice('')
          const origin = draft.baseUrl.trim(), addressEdited = origin !== state.config.baseUrl
          const imported = importedCredential?.origin === origin ? importedCredential : undefined
          let current = state
          if (addressEdited) {
            const input = { ...state.config, baseUrl: origin, snowLumaOrigin: origin }
            try { current = await request('/save', input, controller.current?.signal) }
            catch (failure) { setError(({ AUTHENTICATION_REQUIRED: 'saveAuth', HTTP_401: 'saveAuth', HTTP_403: 'saveAuth', INVALID_SETTINGS: 'saveInvalid', SETTINGS_APPLY_FAILED: 'saveApply' })[failure.message] || 'error'); return }
            setState(current)
            const remaining = { ...draft, baseUrl: current.config.baseUrl }
            setDraft(remaining); setDirty(JSON.stringify(remaining) !== JSON.stringify(current.config))
          }
          if (imported || token.trim()) {
            const fields = imported ? (imported.accessToken ? { onebotToken: imported.accessToken } : { clearOnebot: true }) : { onebotToken: token }
            current = await request('/credentials', { ...fields, onebotOrigin: current.config.baseUrl }, controller.current?.signal)
            setState(current); setToken(''); setImportedCredential(null)
          }
          setNotice('connectionChangesSaved')
          setAccountCheck(await request('/onebot/account', {}, controller.current?.signal))
        })
        const change = (key, value) => { setDraft(old => ({ ...old, [key]: value })); setDirty(true); setNotice('') }
        async function readSnowLuma(event) {
          const { currentTarget } = event
          const file = currentTarget.files?.[0]
          if (!file) return
          currentTarget.value = ''
          const revision = ++snowLumaRead.current
          const signal = controller.current?.signal
          setSnowLuma({ reading: true })
          setSnowLumaOrigin('')
          let preview
          try {
            if (file.size > snowLumaFileLimit) throw new Error('FILE_TOO_LARGE')
            preview = snowLumaConnections(await file.text(), file.name)
          } catch { preview = { error: 'snowLumaInvalid' } }
          if (signal?.aborted || revision !== snowLumaRead.current) return
          setSnowLuma(preview)
          setSnowLumaOrigin(preview.connections?.[0]?.origin ?? '')
        }
        function useSnowLuma(connection) {
          setAccountCheck(null)
          setToken('')
          const hasCredentialChange = !!connection.accessToken || state.credentials?.onebot === true
          setImportedCredential(hasCredentialChange ? connection : null)
          if (draft.baseUrl !== connection.origin) change('baseUrl', connection.origin)
        }
        const changeBinding = (index, patch) => change('bindings', draft.bindings.map((row, n) => n === index ? { ...row, ...patch } : row))
        function retargetBinding(index, patch) {
          const original = draft.bindings[index]
          const changed = original && (patch.endpoint !== undefined && patch.endpoint !== original.endpoint || patch.sessionId !== undefined && patch.sessionId.trim() !== original.sessionId?.trim())
          change('bindings', draft.bindings.map((row, n) => {
            if (n !== index) return row
            const endpointChanged = patch.endpoint !== undefined && patch.endpoint !== row.endpoint
            const sessionChanged = patch.sessionId !== undefined && patch.sessionId.trim() !== row.sessionId?.trim()
            if (!endpointChanged && !sessionChanged) return { ...row, ...patch }
            const { id, ...old } = row
            return { ...old, ...patch, enabled: false, sendEnabled: false }
          }))
          if (changed && (original.enabled || original.sendEnabled)) setNotice('retargetNotice')
        }
        const button = (key, fn, disabled = false) => h('button', { type: 'button', onClick: fn, disabled: busy || disabled }, t(key))
        const field = (key, control, hint) => h('label', { className: 'qqb001-field' }, h('span', null, t(key)), h('span', null, control, hint && h('div', { className: 'qqb001-hint' }, t(hint))))
        const text = (key, value, fn, options = {}) => field(key, h('input', { value: value ?? '', onChange: e => fn(e.target.value), ...options }))
        const toggle = (key, value, fn) => h('label', { className: 'qqb001-row' }, h('input', { type: 'checkbox', checked: !!value, onChange: e => fn(e.target.checked), disabled: busy }), t(key))
        const detail = (key, ...children) => h('details', { className: 'qqb001-binding-options' }, h('summary', null, t(key)), ...children)
        const numberField = (key, value, change, min, max) => text(key, value, input => change(Number(input)), { type: 'number', min, max, disabled: busy })
        const modeSelect = (value, fn) => h('select', { value, onChange: e => fn(e.target.value) }, ['auto', 'queue', 'steer'].map(m => h('option', { key: m, value: m }, t(m))))
        if (!draft) return h('section', { className: 'qqb001' }, h('style', null, css), h('h2', null, t('title')), h('p', { role: error ? 'alert' : 'status' }, t(error ? 'error' : 'loading')), error && button('retry', load))
        async function pick(index, selectModel = false) {
          const signal = controller.current?.signal
          if (!picker || pickerPending.current || signal?.aborted) return
          pickerPending.current = true
          setError(false)
          const row = draft.bindings[index]
          try {
            const response = await picker.open({
              allowedTypes: ['session'], multiple: false, allowMixed: false, allowParentChild: false, allowCreateSession: true, selectModel,
              ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
              ...(row.sessionId?.trim() ? { sessionId: row.sessionId.trim() } : {}),
              ...(selectModel && row.modelSelection ? { modelSelection: row.modelSelection } : {}),
            }, { signal })
            if (signal?.aborted) return
            if (response.status !== 'selected') { setNotice('cancelHint'); return }
            const item = response.items[0]
            if (response.items.length !== 1 || item?.type !== 'session') throw new Error('INVALID_PICKER_RESULT')
            retargetBinding(index, {
              sessionId: item.sessionId, workspaceId: item.workspaceId, label: item.title,
              ...(response.modelSelection ? { modelSelection: response.modelSelection, modelPolicy: 'binding-once', modelRevision: (row.modelRevision || 0) + 1 } : {}),
            })
          } catch {
            if (!signal?.aborted) setError(true)
          } finally {
            pickerPending.current = false
          }
        }
        const outboundTargets = draft.outboundTargets ?? []
        const issue = dirty ? bindingIssue(draft.bindings, outboundTargets) : ''
        function goFixBinding() {
          const chats = new Set(), sessions = new Set()
          const index = draft.bindings.findIndex(row => {
            const session = row.sessionId?.trim()
            const invalid = !/^(private|group):[1-9]\d{0,23}$/.test(row.endpoint) || !session || chats.has(row.endpoint) || sessions.has(session)
            chats.add(row.endpoint); sessions.add(session)
            return invalid
          })
          if (index >= 0) setRuleIndex(index)
          else setOutboundOpen(true)
          setPage('bindings')
        }
        const chatFields = (kind, number, setEndpoint) => h(React.Fragment, null,
          field('chatType', h('select', { value: kind, disabled: busy, onChange: event => setEndpoint(event.target.value, number) },
            h('option', { value: 'private' }, t('privateChat')), h('option', { value: 'group' }, t('groupChat')))),
          text(kind === 'group' ? 'groupNumber' : 'contactNumber', number,
            value => setEndpoint(kind, value.replace(/\D/g, '').slice(0, 24)), { disabled: busy, inputMode: 'numeric', autoComplete: 'off' }))
        let panel
        if (page === 'connection') {
          const networkOn = access.status === 'ready' ? accessOn : state.networkEnabled === true
          const addressEdited = draft.baseUrl.trim() !== state.config.baseUrl
          const connectionEdited = addressEdited || !!token.trim() || !!importedCredential
          const snowLumaConnection = snowLuma?.connections?.find(connection => connection.origin === snowLumaOrigin)
          panel = h(React.Fragment, null,
            h('section', { className: 'qqb001-card' },
            h('h4', null, t('connectionCard')), h('p', null, t('connectionCardHint')),
            detail('snowLumaTitle',
              h('p', null, t('snowLumaHint')),
              field('snowLumaFile', h('input', { type: 'file', accept: '.json,application/json', disabled: busy, onChange: readSnowLuma })),
              snowLuma?.reading && h('p', { role: 'status' }, t('snowLumaReading')),
              snowLuma?.error && h('p', { role: 'alert' }, t(snowLuma.error)),
              snowLumaConnection && h(React.Fragment, null,
                field('snowLumaServer', h('select', { value: snowLumaOrigin, disabled: busy, onChange: event => setSnowLumaOrigin(event.target.value) },
                  snowLuma.connections.map(connection => h('option', { key: connection.origin, value: connection.origin }, connection.origin)))),
                snowLuma.qq && h('p', null, t('snowLumaAccount') + ' · ' + snowLuma.qq),
                h('p', null, t(snowLumaConnection.accessToken ? 'snowLumaHasToken' : 'snowLumaNoToken')),
                button('snowLumaUse', () => useSnowLuma(snowLumaConnection)))),
            text('baseUrl', draft.baseUrl, value => { setAccountCheck(null); setImportedCredential(null); change('baseUrl', value) }, { disabled: busy }),
            text('token', token, value => { setAccountCheck(null); setImportedCredential(null); setToken(value) }, { type: 'password', autoComplete: 'new-password', disabled: busy }),
            h('div', { className: 'qqb001-row' },
              h('small', null, t('token') + ' · ' + t(state.credentials?.onebot ? 'configured' : 'absent')),
              button('connectAndCheck', saveAndCheckConnection, networkBusy || !draft.baseUrl.trim())),
            h('p', { role: 'status' },
              connectionEdited ? t('connectionReadyToSave')
                : !networkOn ? t('network-disabled')
                : accountCheck?.status === 'connected'
                  ? h(React.Fragment, null, t('checkedAccount'), ' ', h('strong', null, accountCheck.qq), accountCheck.nickname && ' · ' + accountCheck.nickname)
                  : accountCheck ? t(accountCheck.status) : t('connectionUnchecked'))),
            h('section', { className: 'qqb001-card' },
              h('h3', null, t('hostAccessTitle')), h('p', null, t('hostAccessHint')),
              access.status === 'loading' && h('p', { role: 'status' }, t('hostAccessLoading')),
              access.status === 'unavailable' && h('p', { role: 'status' }, t('hostAccessUnavailable')),
              access.status === 'ready' && h(React.Fragment, null,
                h('p', null, t('hostAccessCurrent') + ' · ' + t(accessOn ? 'hostAccessOn' : 'hostAccessOff')),
                h('label', { className: 'qqb001-row' }, h('input', { type: 'checkbox', checked: networkDraft,
                  disabled: busy || networkBusy || !access.writable,
                  onChange: event => { setNetworkDraft(event.target.checked); setNetworkNotice(''); setNetworkError('') } }), t('hostAccessToggle')),
                !access.writable && h('p', { className: 'qqb001-hint' }, t('hostAccessReadOnly'))),
              h('div', { className: 'qqb001-row' },
                button(networkBusy ? 'saving' : 'hostAccessSave', saveHostAccess, access.status !== 'ready' || !access.writable || networkBusy || networkDraft === accessOn),
                (access.status === 'unavailable' || networkError) && button('hostAccessRetry', retryHostAccess, networkBusy)),
              networkNotice && h('p', { role: 'status' }, t(networkNotice)),
              networkError && h('p', { role: 'alert' }, t(networkError))),
            h('div', { className: 'qqb001-links' },
              button('goToBindings', () => { setPage('bindings'); tabs.current[sections.indexOf('bindings')]?.focus() }),
              button('tests', () => { setTestBindingId(''); setPage('tests') })),
            h('details', { className: 'qqb001-binding-options' },
              h('summary', null, t('eventSettings')),
              toggle('webhook', draft.webhookEnabled, value => change('webhookEnabled', value)),
              h('p', null, t('webhookHint')),
              text('secret', secret, setSecret, { type: 'password', autoComplete: 'new-password', disabled: busy }),
              h('p', null, t('secretHint')),
              h('div', { className: 'qqb001-row' },
                h('small', null, t('secret') + ' · ' + t(state.credentials?.webhook ? 'configured' : 'absent')),
                button('saveWebhookSecret', () => saveCredentials({ webhookSecret: secret }, () => setSecret('')), !secret.trim()))))
        }
        if (page === 'bindings') {
          const activeIndex = draft.bindings[ruleIndex] ? ruleIndex : 0
          panel = h(React.Fragment, null,
          h('p', null, t('bindingSteps')),
          h('div', { className: 'qqb001-chat-tools' },
            draft.bindings.length > 0 ? field('selectedChat', h('select', { value: activeIndex, disabled: busy, onChange: event => setRuleIndex(Number(event.target.value)) },
              draft.bindings.map((item, index) => h('option', { key: item.id ?? index, value: index }, bindingCaption(item))))) : h('p', null, t('noBindingsYet')),
            button('add', () => { setRuleIndex(draft.bindings.length); change('bindings', [...draft.bindings, { endpoint: 'private:', sessionId: '', enabled: false, sendEnabled: false, preload: true, mode: draft.inputMode }]) }, draft.bindings.length >= 100)),
          detail('defaultPersonaSettings',
            toggle('defaultPersonaEnabled', draft.defaultPersona?.enabled, enabled => change('defaultPersona', { ...draft.defaultPersona, enabled })),
            field('defaultPersona', h('textarea', { value: draft.defaultPersona?.text ?? '', disabled: busy, maxLength: 6000,
              onChange: event => change('defaultPersona', { ...draft.defaultPersona, text: event.target.value }) }), 'defaultPersonaHint')),
          draft.bindings.map((row, index) => {
            if (index !== activeIndex) return null
            const [type, number = ''] = row.endpoint.split(':')
            const kind = type === 'group' ? 'group' : 'private'
            const session = row.sessionId?.trim()
            const label = row.label && row.label !== row.endpoint ? row.label : t('conversationLinked')
            const persona = row.persona ?? { enabled: false, text: '' }
            const saved = state.config.bindings.some(item => item.id === row.id && item.endpoint === row.endpoint && item.sessionId === row.sessionId)
            const setEndpoint = (nextKind, nextNumber) => retargetBinding(index, {
              endpoint: nextKind + ':' + nextNumber,
              label: row.label === row.endpoint ? undefined : row.label,
            })
            const sessionInput = text('session', row.sessionId, value => retargetBinding(index, {
              sessionId: value,
              ...(value.trim() !== session ? { workspaceId: undefined, label: undefined } : {}),
            }))
            return h('article', { key: row.id ?? index, className: 'qqb001-card' },
              h('div', { className: 'qqb001-chat-head' }, h('strong', null, bindingCaption(row)),
                h('div', { className: 'qqb001-badges' },
                  h('span', { className: 'qqb001-badge' + (row.enabled ? ' is-on' : '') }, t(row.enabled ? 'chatReceiveOn' : 'chatReceiveOff')),
                  h('span', { className: 'qqb001-badge' + (row.sendEnabled ? ' is-on' : '') }, t(row.sendEnabled ? 'chatSendOn' : 'chatSendOff')))),
              chatFields(kind, number, setEndpoint),
              h('div', { className: 'qqb001-destination' },
                h('span', null, t('conversation')),
                h('strong', { title: session }, session ? label : t('noConversation')),
                hasPicker && button('chooseConversation', () => void pick(index))),
              !hasPicker && h(React.Fragment, null, h('p', { className: 'qqb001-hint' }, t('pickerMissing')), sessionInput),
              h('div', { className: 'qqb001-row' },
                toggle('enabled', row.enabled, value => changeBinding(index, { enabled: value })),
                toggle('send', row.sendEnabled, value => changeBinding(index, { sendEnabled: value }))),
              h('div', { className: 'qqb001-links' },
                button('chatRulesLink', () => { setRuleIndex(index); setRulesOpen(true); setPage('messages') }),
                button('chatModelLink', () => { setRuleIndex(index); setPage('model') }),
                button('chatTestLink', () => { setTestBindingId(row.id); setPage('tests') }, !saved)),
              detail('personaSettings',
                h('p', { className: 'qqb001-hint' }, t('personaOverrideHint')),
                toggle('customPersona', persona.enabled, enabled => changeBinding(index, { persona: { ...persona, enabled } })),
                persona.enabled && field('personaText', h('textarea', { value: persona.text, disabled: busy, maxLength: 6000,
                  onChange: event => changeBinding(index, { persona: { ...persona, text: event.target.value } }) }))),
              h('details', { className: 'qqb001-binding-options' },
                h('summary', null, t('bindingOptions')),
                hasPicker && h(React.Fragment, null, sessionInput, button('chooseWithModel', () => void pick(index, true))),
                field('mode', modeSelect(row.mode || 'auto', value => changeBinding(index, { mode: value }))),
                toggle('preload', row.preload, value => changeBinding(index, { preload: value })),
                h('div', { className: 'qqb001-links' }, button('remove', () => { setRuleIndex(Math.max(0, index - 1)); change('bindings', draft.bindings.filter((_, i) => i !== index)) }))))
          }),
          h('p', { className: 'qqb001-hint' }, t('bindingReceiveHint')),
          h('details', { className: 'qqb001-binding-options', open: outboundOpen, onToggle: event => setOutboundOpen(event.currentTarget.open) }, h('summary', null, t('outboundTargets')),
            h('p', null, t('outboundHint')),
            outboundTargets.map((row, index) => {
              const [kind, number = ''] = row.endpoint.split(':')
              const patch = fields => change('outboundTargets', outboundTargets.map((target, position) => position === index ? { ...target, ...fields } : target))
              return h('article', { key: index, className: 'qqb001-binding' },
                chatFields(kind, number, (type, value) => patch({ endpoint: type + ':' + value, label: row.label === row.endpoint ? '' : row.label })),
                text('outboundLabel', row.label === row.endpoint ? '' : row.label, label => patch({ label }), { disabled: busy, maxLength: 160 }),
                h('div', { className: 'qqb001-row' },
                  toggle('send', row.enabled, enabled => patch({ enabled })),
                  button('remove', () => change('outboundTargets', outboundTargets.filter((_, position) => position !== index)))))
            }),
            button('outboundAdd', () => change('outboundTargets', [...outboundTargets, { endpoint: 'private:', label: '', enabled: true }]), outboundTargets.length >= 100)))
        }
        if (page === 'messages') {
          const { rich, merge, polling } = draft
          const setRich = patch => change('rich', { ...rich, ...patch })
          const setMerge = patch => change('merge', { ...merge, ...patch })
          const setPolling = patch => change('polling', { ...polling, ...patch })
          const index = draft.bindings[ruleIndex] ? ruleIndex : 0
          const row = draft.bindings[index]
          let rules
          if (row) {
            const admission = row.admission ?? { enabled: false, allowedSenders: [], mentionOnly: true, mentionAlways: true, keywords: [], probability: 100, tailMessages: 0, tailMs: 120000 }
            const rate = row.rate ?? { enabled: false, cooldownMs: 5000, perMinute: 4 }
            const pricing = row.endpoint.startsWith('group:') ? row.priceSchedule ?? { enabled: false, peakProbability: 20, offPeakProbability: 100 } : undefined
            const gate = row.replyGate ?? { enabled: false, conclude: false }
            const continuation = row.continuation ?? { enabled: false, maxAdditionalReplies: 1, maxOutputTokens: 1024, maxDurationMs: 30000 }
            const setAdmission = patch => changeBinding(index, { admission: { ...admission, ...patch } })
            const setRate = patch => changeBinding(index, { rate: { ...rate, ...patch } })
            const setPricing = patch => changeBinding(index, { priceSchedule: { ...pricing, ...patch } })
            const setGate = patch => changeBinding(index, { replyGate: { ...gate, ...patch } })
            const setContinuation = patch => changeBinding(index, { continuation: { ...continuation, ...patch } })
            rules = h('details', { className: 'qqb001-binding-options', open: rulesOpen, onToggle: event => setRulesOpen(event.currentTarget.open) },
              h('summary', null, t('perBindingRules')),
              field('testTarget', h('select', { value: index, disabled: busy, onChange: event => setRuleIndex(Number(event.target.value)) },
                draft.bindings.map((binding, position) => h('option', { key: position, value: position }, bindingCaption(binding))))),
              h('div', { className: 'qqb001-message-options' },
                toggle('filterEnabled', admission.enabled, enabled => setAdmission({ enabled })),
                admission.enabled && h('div', { className: 'qqb001-binding' },
                  field('allowedSenders', h('textarea', { value: admission.allowedSenders.join('\n'), disabled: busy,
                    onChange: event => setAdmission({ allowedSenders: event.target.value.split('\n').map(value => value.trim()).filter(Boolean) }) })),
                  toggle('mentionOnly', admission.mentionOnly, mentionOnly => setAdmission({ mentionOnly })),
                  toggle('mentionAlways', admission.mentionAlways, mentionAlways => setAdmission({ mentionAlways })),
                  field('mentionKeywords', h('textarea', { value: admission.keywords.join('\n'), disabled: busy,
                    onChange: event => setAdmission({ keywords: event.target.value.split('\n').filter(Boolean) }) })),
                  numberField('probability', admission.probability, probability => setAdmission({ probability }), 0, 100),
                  numberField('tailCount', admission.tailMessages, tailMessages => setAdmission({ tailMessages }), 0, 20),
                  numberField('tailTime', admission.tailMs, tailMs => setAdmission({ tailMs }), 0, 600000)),
                pricing && toggle('priceSchedule', pricing.enabled, enabled => setPricing({ enabled })),
                pricing?.enabled && h('div', { className: 'qqb001-binding' },
                  numberField('peakProbability', pricing.peakProbability, peakProbability => setPricing({ peakProbability }), 0, 100),
                  numberField('offPeakProbability', pricing.offPeakProbability, offPeakProbability => setPricing({ offPeakProbability }), 0, 100),
                  numberField('peakCooldown', (pricing.peakCooldownMs ?? 30000) / 1000, value => setPricing({ peakCooldownMs: value * 1000 }), 0, 3600),
                  numberField('offPeakCooldown', (pricing.offPeakCooldownMs ?? 5000) / 1000, value => setPricing({ offPeakCooldownMs: value * 1000 }), 0, 3600),
                  h('p', { className: 'qqb001-hint' }, t('priceScheduleHint'))),
                toggle('rateEnabled', rate.enabled, enabled => setRate({ enabled })),
                rate.enabled && h('div', { className: 'qqb001-binding' },
                  numberField('cooldown', rate.cooldownMs, cooldownMs => setRate({ cooldownMs }), 0, 60000),
                  numberField('perMinute', rate.perMinute, perMinute => setRate({ perMinute }), 1, 60),
                  h('p', { className: 'qqb001-hint' }, t('rateHint'))),
                toggle('gateEnabled', gate.enabled, enabled => setGate({ enabled })),
                gate.enabled && toggle('gateConclude', gate.conclude, conclude => setGate({ conclude })),
                toggle('continuation', continuation.enabled, enabled => setContinuation({ enabled })),
                continuation.enabled && h('div', { className: 'qqb001-binding' },
                  h('p', { className: 'qqb001-hint' }, t('continuationHint')),
                  numberField('replyBudget', continuation.maxAdditionalReplies, maxAdditionalReplies => setContinuation({ maxAdditionalReplies }), 1, 8),
                  numberField('tokenBudget', continuation.maxOutputTokens, maxOutputTokens => setContinuation({ maxOutputTokens }), 1, 32768),
                  numberField('timeBudget', continuation.maxDurationMs, maxDurationMs => setContinuation({ maxDurationMs }), 100, 120000))))
          }
          panel = h(React.Fragment, null,
            h('section', { className: 'qqb001-card' },
              h('h4', null, t('messageReceive')),
              toggle('receive', draft.enabled, value => change('enabled', value)),
              field('mode', modeSelect(draft.inputMode, value => change('inputMode', value)), 'modeHint'),
              h('div', { className: 'qqb001-message-options' },
                toggle('pollingEnabled', polling.enabled, enabled => setPolling({ enabled }))),
              h('p', { className: 'qqb001-hint' }, t('mergeHint')),
              detail('receiveDetails',
                h('div', { className: 'qqb001-message-options' },
                  toggle('cards', rich.cards, cards => setRich({ cards })),
                  toggle('forwards', rich.forwards, forwards => setRich({ forwards })),
                  rich.forwards && toggle('forwardMedia', rich.forwardMedia, forwardMedia => setRich({ forwardMedia })),
                  (rich.cards || rich.forwards) && numberField('richBudget', rich.maxChars, maxChars => setRich({ maxChars }), 256, 6000)),
                h('div', { className: 'qqb001-binding' },
                  numberField('mergeMaxMessages', merge.maxMessages, maxMessages => setMerge({ maxMessages }), 256, 1000),
                  numberField('mergeMaxChars', merge.maxChars, maxChars => setMerge({ maxChars }), 1048576, 4194304)),
                polling.enabled && h('div', { className: 'qqb001-binding' },
                  h('p', { className: 'qqb001-hint' }, t('pollingHint')),
                  numberField('pollingInterval', polling.intervalMs, intervalMs => setPolling({ intervalMs }), 800, 30000),
                  numberField('pollingCatchup', polling.catchupMs, catchupMs => setPolling({ catchupMs }), 60000, 3600000)))),
            h('section', { className: 'qqb001-card' },
              h('h4', null, t('messageSend')),
              h('p', { className: 'qqb001-hint' }, t('sendBufferHint')),
              toggle('typingEnabled', draft.typing?.enabled !== false, enabled => change('typing', { ...draft.typing, enabled })),
              draft.typing?.enabled !== false && h(React.Fragment, null,
                field('typingSpeed', h('select', { value: String(draft.typing?.rate ?? 1), disabled: busy, onChange: event => change('typing', { ...draft.typing, rate: Number(event.target.value) }) },
                  ![0.7, 1, 1.5].includes(draft.typing?.rate ?? 1) && h('option', { value: String(draft.typing.rate) }, t('typingCustom') + ' · ' + draft.typing.rate + '×'),
                  h('option', { value: '0.7' }, t('typingSlow')), h('option', { value: '1' }, t('typingNormal')), h('option', { value: '1.5' }, t('typingFast')))),
                text('typingLimit', (draft.typing?.maxWaitMs ?? 10000) / 1000, value => change('typing', { ...draft.typing, maxWaitMs: Math.min(600000, Math.max(0, Math.round(Number(value) * 1000))) }), { type: 'number', min: 0, max: 600, step: 0.5, disabled: busy })),
              h('p', { className: 'qqb001-hint' }, t('typingHint')),
              text('replyQuietSeconds', draft.replyQuietMs / 1000, value => change('replyQuietMs', Math.min(5000, Math.max(0, Math.round(Number(value) * 1000)))), { type: 'number', min: 0, max: 5, step: 0.1, disabled: busy }),
              h('p', { className: 'qqb001-hint' }, t('replyQuietHint')),
              toggle('quote', draft.nativeQuote, value => change('nativeQuote', value)),
              draft.nativeQuote && detail('quoteDetails',
                h('p', { className: 'qqb001-hint' }, t('quoteHint')),
                numberField('quoteChars', draft.quoteMaxChars, value => change('quoteMaxChars', value), 128, 6000),
                numberField('quoteMedia', draft.quoteMaxMedia, value => change('quoteMaxMedia', value), 0, 4))),
            rules)
        }
        if (page === 'tests') panel = h(TestPanel, { key: testBindingId || 'all', config: state.config, field, initialBindingId: testBindingId })
        if (page === 'media') panel = h(React.Fragment, null,
          h('section', { className: 'qqb001-card' }, h('h4', null, t('voiceOutputTitle')),
            toggle('voice', draft.voice.enabled, value => change('voice', { ...draft.voice, enabled: value })),
            draft.voice.enabled && h(React.Fragment, null,
              field('voiceProvider', h('select', { value: draft.voice.provider, disabled: busy, onChange: event => change('voice', { ...draft.voice, provider: event.target.value }) }, h('option', { value: 'deepseek' }, 'DeepSeek'), h('option', { value: 'minimax' }, 'MiniMax'))),
              draft.voice.provider === 'deepseek' && field('deepseekVoice', h('select', { value: draft.voice.deepseekVoice, disabled: busy, onChange: event => change('voice', { ...draft.voice, deepseekVoice: event.target.value }) }, h('option', { value: 'stella' }, 'Stella'), h('option', { value: 'tide' }, 'Tide')), 'deepseekVoiceHint'),
              toggle('keepText', draft.voice.keepText, value => change('voice', { ...draft.voice, keepText: value })), h('p', null, t('voiceHint')))),
          h('section', { className: 'qqb001-card' }, h('h4', null, t('voiceInputTitle')),
            toggle('asrEnabled', draft.asr.enabled, enabled => change('asr', { ...draft.asr, enabled })),
            draft.asr.enabled && h(React.Fragment, null,
              field('asrProvider', h('select', { value: draft.asr.providerId, onChange: event => change('asr', { ...draft.asr, providerId: event.target.value }) }, h('option', { value: '' }, '—'), (state.asr?.providers || []).map(provider => h('option', { key: provider.id, value: provider.id }, provider.name + ' · ' + provider.phase)))),
              text('asrLanguage', draft.asr.language, language => change('asr', { ...draft.asr, language })), h('p', null, t('asrHint')), h('p', null, t('asrMissing')))),
          h('section', { className: 'qqb001-card' }, h('h4', null, t('fileMediaTitle')),
            toggle('groupFiles', draft.allowGroupFiles, value => change('allowGroupFiles', value)),
            detail('advancedMedia',
              text('maxMedia', draft.maxMedia, value => change('maxMedia', Number(value)), { type: 'number', min: 0, max: 8 }),
              text('imageMB', draft.maxMediaBytes / 1048576, value => change('maxMediaBytes', Math.round(Number(value) * 1048576)), { type: 'number', min: 1, max: 20 }),
              text('fileMB', draft.maxFileBytes / 1048576, value => change('maxFileBytes', Math.round(Number(value) * 1048576)), { type: 'number', min: 1, max: 50 }),
              field('origins', h('textarea', { value: draft.mediaOrigins.join('\n'), onChange: event => change('mediaOrigins', event.target.value.split('\n').map(value => value.trim()).filter(Boolean)) }), 'originHint'))),
          detail('extraQqFeatures',
            toggle('qzoneEnabled', draft.qzone.enabled, value => change('qzone', { ...draft.qzone, enabled: value })),
            draft.qzone.enabled && h(React.Fragment, null,
              toggle('qzonePost', draft.qzone.post, value => change('qzone', { ...draft.qzone, post: value })),
              toggle('qzoneLike', draft.qzone.like, value => change('qzone', { ...draft.qzone, like: value })),
              toggle('qzoneComment', draft.qzone.comment, value => change('qzone', { ...draft.qzone, comment: value })), h('p', { className: 'qqb001-hint' }, t('qzoneHint'))),
            h('p', { className: 'qqb001-hint' }, t('scheduleHint'))))
        if (page === 'model') {
          const index = draft.bindings[ruleIndex] ? ruleIndex : 0, row = draft.bindings[index]
          panel = h(React.Fragment, null,
          h('p', null, t('modelHint')),
          field('quotaReply', h('textarea', { value: draft.quotaReply ?? '(T_T)白饭吃干净了……', maxLength: 500, disabled: busy, onChange: event => change('quotaReply', event.target.value) }), 'quotaReplyHint'),
          catalog === null && h('p', { role: 'status' }, t('modelsLoading')),
          catalog === false && h('div', { className: 'qqb001-row' },
            h('p', { role: 'status' }, t('modelsFailed')),
            button('reloadModels', () => setCatalogRevision(value => value + 1))),
          catalog && !catalog.groups.some(group => group.models.length) && h('p', { role: 'status' }, t('modelsEmpty')),
          row ? h(React.Fragment, null,
            field('selectedChat', h('select', { value: index, disabled: busy, onChange: event => setRuleIndex(Number(event.target.value)) },
              draft.bindings.map((item, position) => h('option', { key: item.id ?? position, value: position }, bindingCaption(item))))),
          h('article', { key: row.id ?? index, className: 'qqb001-card' },
            h('h4', null, bindingCaption(row)),
            h(BindingModelFields, { row, update: patch => changeBinding(index, patch), catalog, field, disabled: busy }),
            h(QuotaFields, { row, update: patch => changeBinding(index, patch), catalog, field, disabled: busy }),
            detail('modelDiagnostics',
              field('modelPolicy', h('select', { value: row.modelPolicy || 'native-wins', disabled: busy,
                onChange: event => changeBinding(index, { modelPolicy: event.target.value, modelRevision: (row.modelRevision || 0) + 1 }) },
                ['native-wins', 'binding-once', 'off'].map(value => h('option', { key: value, value }, t(value))))),
              h('pre', null, JSON.stringify({
                model: state.modelPolicies?.find(item => item.bindingId === row.id) ?? { state: 'off' },
                quota: state.quotaPolicies?.find(item => item.bindingId === row.id) ?? { state: 'off' },
              }, null, 2))))) : h('p', null, t('noBindingsYet')))
        }
        if (page === 'security') {
          const bindingId = permissionBinding || state.config.bindings[0]?.id || ''
          const binding = state.config.bindings.find(item => item.id === bindingId)
          const permission = hostPermissions?.bindings?.find(item => item.bindingId === bindingId)
          const selectedPreset = permissionPreset || permission?.current || ''
          const presetLabel = value => value === 'read-only' ? t('hostPermissionReadOnly') : value === 'workspace-write' ? t('hostPermissionWorkspace') : value === 'danger-full-access' ? t('hostPermissionFull') : value
          panel = h(React.Fragment, null,
            h('section', { className: 'qqb001-card' }, h('h4', null, t('globalSendTitle')),
              toggle('sendMaster', draft.sendEnabled, value => change('sendEnabled', value)), h('p', null, t('sendHint'))),
            h('section', { className: 'qqb001-card' },
              h('h4', null, t('hostPermissionTitle')), h('p', null, t('hostPermissionHint')),
              field('hostPermissionSession', h('select', { value: bindingId, disabled: busy, onChange: event => { setPermissionBinding(event.target.value); setPermissionPreset(''); setPermissionNotice('') } },
                !state.config.bindings.length && h('option', { value: '' }, '—'),
                state.config.bindings.map(item => h('option', { key: item.id, value: item.id }, item.label || item.endpoint || item.sessionId)))),
              !hostPermissions?.available ? h('p', null, t('hostPermissionUnavailable')) : h(React.Fragment, null,
                h('p', null, t('hostPermissionCurrent') + ': ' + (permission?.current ? presetLabel(permission.current) : '—')),
                permission?.workspaceRoot && h('p', null, permission.workspaceRoot),
                field('hostPermissionPreset', h('select', { value: selectedPreset, disabled: busy, onChange: event => { setPermissionPreset(event.target.value); setPermissionNotice('') } },
                  h('option', { value: '' }, '—'), (hostPermissions.options || []).map(item => h('option', { key: item.value, value: item.value }, presetLabel(item.value))))),
                button('hostPermissionApply', () => run(async () => {
                  const response = await request('/host-permissions', { bindingId, preset: selectedPreset }, controller.current?.signal)
                  setHostPermissions(response.result); setPermissionPreset(''); setPermissionNotice('hostPermissionSaved')
                }), !binding || !permission?.available || !selectedPreset),
                permissionNotice && h('p', { role: 'status' }, t(permissionNotice)))),
            detail('legacyAdvanced', h('p', null, t('migrationHint')), h('textarea', { 'aria-label': t('migration'), value: legacy, onChange: event => setLegacy(event.target.value), spellCheck: false }), button('import', () => run(async () => { const next = await request('/legacy-import', JSON.parse(legacy)); setState(next); setDraft(next.config); setLegacy(''); setDirty(false); setResult(next.warnings) }), !legacy.trim())))
        }
        if (page === 'diagnostics') panel = h(React.Fragment, null, h('p', null, t('diagnosticsHint')), field('bindings', h('select', { value: selected, onChange: e => setSelected(e.target.value) }, h('option', { value: '' }, '—'), state.config.bindings.map(row => h('option', { key: row.id, value: row.id }, row.label || row.endpoint)))), h('div', { className: 'qqb001-row' }, ...[['history', '/history'], ['preview', '/preview'], ['preloadNow', '/preload'], ['cancel', '/cancel']].map(([key, path]) => button(key, () => run(async () => setResult((await request(path, { bindingId: selected })).result)), !selected))), detail('detailedDiagnostics', h('pre', null, JSON.stringify({ preloads: state.preloads, capabilities: state.capabilities, polling: state.polling, merge: state.merge, admission: state.admission, nativeFeatures: state.nativeFeatures, asr: state.asr }, null, 2))))
        return h('section', { className: 'qqb001 qqb001-layout' },
          h('style', null, css),
          h('div', { className: 'qqb001-content' },
            h('header', null, h('h2', null, t('title')), h('small', null, t('subtitle'))),
            h('nav', { role: 'tablist', 'aria-label': t('title') }, sections.map((name, index) => h('button', {
              key: name, ref: el => { tabs.current[index] = el }, type: 'button', role: 'tab',
              id: NS + '-tab-' + name, 'aria-selected': page === name, 'aria-controls': NS + '-panel',
              tabIndex: page === name ? 0 : -1, onClick: () => setPage(name),
              onKeyDown: event => {
                const next = event.key === 'ArrowRight' ? (index + 1) % sections.length
                  : event.key === 'ArrowLeft' ? (index + sections.length - 1) % sections.length
                    : event.key === 'Home' ? 0 : event.key === 'End' ? sections.length - 1 : undefined
                if (next !== undefined) {
                  event.preventDefault()
                  setPage(sections[next])
                  tabs.current[next]?.focus()
                }
              },
            }, t(name)))),
            error && h('p', { role: 'alert' }, t(typeof error === 'string' ? error : 'error')),
            h('div', { role: 'tabpanel', id: NS + '-panel', 'aria-labelledby': NS + '-tab-' + page }, h('h3', null, t(page)), panel),
            notice && h('p', { role: 'status' }, t(notice)),
            result !== null && h('details', { open: true },
              h('summary', null, t('operation')), h('pre', null, JSON.stringify(result, null, 2).slice(0, 16000))),
            h('small', null, t('provenance'))),
          h('footer', { className: 'qqb001-actions' },
            button(busy ? 'saving' : 'save', () => run(async () => {
              const stagedConnection = importedCredential?.origin === draft.baseUrl
                ? { ...draft, snowLumaOrigin: importedCredential.origin } : draft
              let next
              try {
                next = await request('/save', stagedConnection, controller.current?.signal)
              } catch (failure) {
                if (controller.current?.signal.aborted) return
                const key = { AUTHENTICATION_REQUIRED: 'saveAuth', HTTP_401: 'saveAuth', HTTP_403: 'saveAuth', INVALID_SETTINGS: 'saveInvalid', SETTINGS_APPLY_FAILED: 'saveApply' }[failure.message]
                setError(key || (failure.name === 'TimeoutError' ? 'saveTimeout' : 'error'))
                return
              }
              setState(next)
              setDraft(next.config)
              setDirty(false)
              setNotice('saved')
            }), !dirty || !!issue),
            button('reload', () => run(load)),
            issue && button('goFixBindings', goFixBinding),
            h('small', { role: issue ? 'status' : undefined }, t(issue || (dirty ? 'unsaved' : 'saved')))))
      }
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'qq-bridge-001', order: 54, label: () => t('title'), locale: NS, inject: () => ({ hooks: { pickerAvailable: pickerSource, networkAccess: hostAccess.source } }) }, Section)))
    }
    return { apply, inject: ['slots', 'locale'] }
  },
})
