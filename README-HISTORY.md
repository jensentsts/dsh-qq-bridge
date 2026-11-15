# QQ bridge 0.0.1 · 独立派生版

**本项目派生自 https://github.com/Yuuyuko-uu/dsh-qq-link，原作者 Yuuyuko-uu。**
完整保留 **Yuuyuko-uu 插件许可 1.2**；本包不是原创 QQ 桥接实现，不改标 MIT。原作者与 source 注释继续保留。

**本次改动**：从本机**已安装 dsh-qq-link 1.5.4**（含独有 VOICE OUTBOUND PATCH）建立独立 fork；仅移植本地 1.5.2 的 running→steer / idle→followup 修补与回归测试；去自更新查询/安装及更新 UI；新命名、路由、存储、凭据；接 superAgentIo v1 与可选 resourcePicker v1；补原生 reply、有界引用上下文、file-only、真实多 assistant 原文输出，以及八组设置结构。后续增量已加入显式 HTTP 历史轮询、按聊天隔离的跨消息合并窗口、Qzone 读写工具，以及通过官方 schedule 服务的显式任务工具；连接页提供原生 configForms 的 Host networkAccess 表单。新代码也随派生作品沿用本许可。

## 当前交付边界

- **独立 QQ 桥接已在 DSH 桌面版加载，设置分为八组。旧 dsh-qq-link 已通过官方管理器卸载；现有配置的网络权限与收发开关均为关闭。**
- 已通过离线 adapter / fake IO / route lifecycle / Client factory 结构测试及真实 IoCore 端到端 mock；原本 1.5.2 steer 四场景也通过。
- **八分区设置已由主控在 DSH GUI 确认**；本轮未重新截图或做视觉回归。Client Slot 合同由主控 live Inspect 证实；本地 Client Inspect 曾超时。没有读取浏览器 token 或绕过认证。
- Host Config 的 `networkAccess` 默认 false；当前 profile 为 false，所有接收/发送配置默认 false。连接页可用原生 configForms 显式修改这一项；创建本包或载入 Client factory 不会请求上游仓库。原仓库地址仅作 provenance。

## 结构与依赖

| 部分 | 职责 |
|---|---|
| `lib/onebot.mjs` | 纯 OneBot 事件/引用/出站/TTS 计划，无 Agent 驱动、无发送副作用 |
| `lib/bridge.mjs` | 绑定、媒体协调、精确 delivery receipt，唯一依赖 `superAgentIo` v1 |
| `lib/history-tool.mjs` | exact-Agent 只读 `qq_history`，复用 OneBot history，当前 binding 固定目标，有界输出 |
| `lib/host.js` | Cordis 生命周期、独立 storageDomain、credentials 和 routes |
| `lib/client.js` | 原生 `settings.section` React 客户端；可选 `ctx.resourcePicker.open` |
| `lib/legacy-host.js`、`legacy/`、`tools/` | installed 1.5.4 派生基线与旧特性迁移资料，**不由 production entry 启动** |
| `PROVENANCE.json` | baseline/local patch 的来源、原件 SHA-256、保留项与修改范围 |
| `LICENSE` | 原作者许可完整逐字保留 |

- 必需 Host 服务：`superAgentIo`、`storageDomain`、`webServer`、`connection`、`credentials`；`attachments` 用于媒体能力，缺失时显式文字降级。
- 可选 Client 服务：`resourcePicker` v1。缺失不猜名字/不读 DOM，禁选择器按钮，仍支持完整 session ID。
- 精确运行版本依据本机 `app.asar/dsh` **0.2.2-rc.1**。未用旧 0.2.0-rc.2 源码覆盖运行版。
- `superAgentIo` 的模式、公平性、持久去重、canonical assistant source、history tools 和权限由 IO 包负责；本桥不再监听全局 session/event 或自己驱动全局 Agents；仅在绑定的 exact Agent context 观察模型取消与 quota turn/end，不添加真实输入。

### 独立身份

```text
package / Client module: dsh-qq-bridge @ 0.0.1
Host entry / settings ID / transport: qq-bridge-001
storageDomain (official UNIT_NAME_RE): qq_bridge_001
routes: /dsh-qq-bridge-001/*
credentials key: dsh-qq-bridge/onebot-v1
legacy data: <DSH_HOME>/qq-bridge-001-legacy/ (mock-only)
```

旧 package、entry 和 `/dsh-qq-bridge` 路由不复用；本包 patch 不擅自启停旧插件。**绝不能同时运行两套接收/外发。**

## 可验证的新主线

### 主动发送、群聊点名和管理

- 在「QQ 桥接 → QQ 绑定 → 只发送的 QQ 聊天」添加 QQ 号或群号，可选填名称。保存后，在任意 DSH 会话中直接指定目标和消息。已开启外发的绑定也可直接使用。
- 消息路由用 `io_destinations` 发现 QQ 目标，用 `io_probe` 检查 OneBot 连接，用 `io_send` 发消息。只发送的目标无需创建或预载 DSH 会话。
- QQ 群里的原生 @ 会进入消息正文，点名大肥鱼也会匹配群聊点名规则。回复或主动外发时用 `@QQ号` 点名成员。含点名的回复用文字发送，QQ 会收到原生提及。
- `qq_recent` 可在 DSH 侧查已开启外发的聊天，返回发送者 QQ 号和原始消息 ID。`qq_moderate` 支持踢人、禁言、解禁、群公告、撤回群成员消息及撤回自己的私聊消息。发起管理操作时由 DSH 显示账号、目标和操作内容，实际权限和撤回时限由 QQ 决定。

### 连接和安全

- OneBot HTTP origin 默认 loopback，显式 remote opt-in 后才允许其他 origin；不接受 URL 用户名/密码、路径或查询。
- 管理接口必须通过官方 Connection 鉴权；服务缺失或抛错 fail-closed，不因“设置页能打开”而放行。
- 外部上报只接受 `POST /dsh-qq-bridge-001/onebot-events`。必须有非空 webhook secret 与 OneBot `X-Signature: sha1=<HMAC>`，按完整原始字节校验；不接受 URL token。
- 密钥只写 `ctx.credentials`，状态仅返回 configured。外部错误不回显 URL/headers/token。
- JSON、get_msg、媒体数/字节、超时和 origin 都有上限；HTTP 跳转拒绝。
- 「收发测试」按已保存的 QQ 聊天检查 OneBot。发送使用当前网络和 QQ 外发开关，接收检测码通过签名上报或历史轮询进入 DSH，结果显示在设置页。
- 不替换 approval/sandbox，不提权，skipped 绝不视作授权。

### QQ 网络访问

- 设置 → QQ 桥接 → 连接 → QQ 网络访问。Host 以可实时编辑的 `networkAccess` 字段提供该权限；连接页通过公开 `configForms` 读取，保存沿用原生 `form.set` 和修订队列。其余 Host 字段维持原配置方式。
- `networkAccess` 默认保持 false；页面加载、普通 `/save`、导入和只读预览都不会写入它。只有用户勾选并点击保存才提交一次原生 form write。
- 页面显示读取、只读、保存和失败状态。原生配置暂不可读时可重试，其余设置继续可用。
- 本包不新增 Host 设置存储、不新增写 endpoint，也不改 profile、凭据、权限或路由。

### 绑定与接入

- 一 QQ 聊天一 DSH 会话，保存时拒绝重复聊天/会话，不选最近活跃/最后发送者。sessionId/endpoint 使用后变更必须新 binding identity。
- 保存或启动主动调用 IO `preload`，冷会话由官方 resolveAgent，不要求用户先点开，不遇 resume 错误就生新会话。
- `queue` / `steer` / `auto` 完整交给 IO。auto 使用其连续 steer 预算与排队公平性；取消优先，不将长模型等待放入 HTTP 接收事务。
- Receipt 的 `accepted` 是原生 inbox 受理，**不等于模型完成、持久提交或外发完成**；应使用 IO receipt/history 查询真实后续状态。
- resourcePicker 选择/预览/新建分离；取消不保存/不授权。明确新建再取消的空会话仍保留，不静默删除。选择模型只是建议返回。

### 原生引用和输出

- `reply` 段入站用有界 `get_msg` 补作者/正文/媒体，验证 exact chat 归属；跨群、无法证明归属、超时降级为缺失说明，不跟随 reply 链。
- SA 按会话提交顺序为每条完整的中间回复和最终回复生成独立投递，QQ 桥接将公开正文直接发给原聊天，清理旧回复里的包裹标记。正文标点和段落保留。
- DSH 图片、文件附件及正文中的工作区 Markdown 文件链接支持出站。图片转为 QQ 图片段，音频转为 QQ 语音，普通文件走 OneBot 上传。远程图片和音频使用媒体来源设置，纯文字可按现有语音设置合成。
- 出站 native reply 段关联该 binding 的原始 QQ 消息；upload notice 没有 native message id 时省略引用，不妨碍正文/文件输出。
- 语音合成只读取正文，失败时发送文字。启用图库中唯一匹配的表情由 QQ 桥接读取原图并单独发送。语音模式默认发送一份正文，可在媒体设置中同时保留文字。
- QQ 媒体接收使用配置中的图片来源。收到文件时，桥接可通过当前聊天的 OneBot 文件标识查找下载地址，再保存为 DSH 附件。
- 顶层 file-only、group_upload、持久 file-only assistant 不丢。文件走 OneBot 原生上传 API，图片从 durable attachment 读取验证；不读模型随手写的任意本地路径。
- 媒体失败保正文并追加明确缺失说明；GIF 的 durable image 路径保留格式。QQ 语音目前保留为 durable file，不能宣称新 ASR 已可用。
- 每 delivery 都写独立 sidecar intent/receipt；超时、部分发送、异常都是 unknown，**不盲重发**。不会为重试重复模型/工具副作用。

### 有界 QQ history tool

- `lib/history-tool.mjs` 在现有 exact-Agent 注册流程中新增只读 `qq_history`：目标固定为当前绑定的已有 session 和 endpoint，模型只可传 `count`（1–20，默认 10）和可选 OneBot `message_seq` 游标。工具不接受 QQ 号、群号或 URL。
- 复用既有 OneBot HTTP client 的 `get_group_msg_history` / `get_friend_msg_history`；读前和返回前复核网络权限、当前绑定和 Agent。群消息须匹配 `group_id`；私聊须含绑定对象，所有参与者字段须属于绑定对象或当前机器人账号。显式发送者许可名单同时生效。
- 输出只保留原始 message ID、sender ID/名称、时间、受限文本、媒体类型/净化后的文件名和 `json/xml/forward` 类型；不输出 URL、file ID、base64 或 raw 路径。单条文本 1200 字、总文本 8000 字、最多 20 条，`truncated` 显式标记。
- 该工具只读 OneBot history 并返回给 Agent；不调用 `bridge.receive`、不重复投递、不改 polling watermark、不发 QQ、不触发模型或 schedule。

### 设置八组

连接 / 绑定与会话 / 输入排队 / 输出引用 / 媒体 / 模型额度 / 权限安全 / 诊断历史。支持空态、错误、保存中、未保存、键盘页签、focus 与 reduced-motion；沿用 DSH theme tokens、全局 locale（中英，无独立语言开关）。视觉表现仍待认证原 GUI 验证。

本机 SnowLuma 登录 QQ 并启用 OneBot HTTP 服务后，在 QQ 桥接设置的「连接」页打开「从 SnowLuma 配置连接」。选择 `config/onebot_<QQ号>.json`，核对服务地址和文件名中的 QQ 号，点击「使用此连接」。先保存 HTTP 地址，再保存导入的令牌，最后点「检测连接」确认实际登录账号。导入的令牌仅随对应地址使用。其他 OneBot 客户端可在同一页手动填写地址和令牌。

## Legacy 与迁移

原 1.5.4 的全部 host、tools 和 Client/README/CHANGELOG 基线先复制再定点修改，保留来源注释和独有 VOICE、按 `sid + exact Agent` 的 Qzone 去重修复。已发现该 installed 基线鉴权异常路径原本 **fail-open**，fork 已改 fail-closed，不能把旧行为冒称安全修复。

- `lib/legacy-host.js` 仅用于离线兼容回归，不由生产 manifest/patch 激活；fetch 强制 mock 注入，顶层媒体 helpers 网络禁用。
- `legacy/client.js` 是旧设置迁移资料，不在新 Client graph；已去自动 GET update、更新页和 install 调用，改独立名字。
- 旧 `[QQ]` 源码仅保留回归；第二增量已把门槛、人设、点名/概率/过滤/频率、卡片、合并转发、native ASR 接入新 transport。第三增量接入 Qzone、官方 schedule、显式 HTTP 轮询与跨消息合并窗口；旧自更新和旧轮询/空间后台 timer 不进入 production。
- “权限安全”中的显式 JSON 导入只读用户提供的旧配置，不读取/写回旧配置路径。导入强制关闭总开关/绑定/外发，旧 bearer token 只经 Host `credentials.modifyRecord` 迁入凭据服务，不进 literal config/sidecar/状态回包；旧通知 URL 口令不复用为 HMAC secret。未支持设置只读保留以供继续迁移。
- 上游 tools 与旧文档保留原作者内容；其中历史安装命令不是本 fork 的启用指导。更新由操作者管理，不自动请求原 repo。

## 功能保留 / 新主线执行对照

| 功能 | 已保留与当前执行 | 验证 / 限制 |
|---|---|---|
| installed 1.5.4 原基线 | 全 host/tools 与许可作者注释保留，未拿本地 1.5.2 整包覆盖 | 原件 SHA-256 记录；legacy 不自动挂载 |
| VOICE OUTBOUND PATCH | 原补丁完整保留；production `voice.mjs` 迁出 mmx speech/text-file/voice/model 流程；`planVoice` 保 pure-text/TTS keepText 与 mixed-media 条件 | mock quote+text 可TTS，实际 image mixed不TTS，失败保原文；真实 mmx/音频未运行 |
| reply quote | 新入站有界 get_msg + author/body/media；出站原生 reply | wrong-chat/未知归属拒绝；reply metadata不关闭纯文本TTS；file upload notice无native ID省略quote |
| 多 assistant / 原文 | primary经IO投递每条真实committed assistant，原文不切分、不[QQ]协议 | 真正 IoCore/Session/Loader mock 多条通过；reasoning/tool过滤 |
| file-only / GIF /媒体 | top-level file/group_upload入站；official saveFile/saveImage；出站durable验证+file upload | mock通过；无任意path/ref伪造；真实OneBot上传/格式能力未测 |
| busy接入 / cold | IO queue/steer/auto / startup preload；保本地1.5.2 legacy4场景 | IO负责公平/持久去重；QQ不第二次驱动全局Agent |
| history / cancel | owner鉴权冷预览、有界IO history，取消清队列与pending模型应用 | caller scope由IO检查；不是无界拉全QQ历史 |
| model + effort | native-wins / binding-once / off；fresh-boundary catalog重校验、native durable selection | real AgentModel +持久确认失败不replay测试；busy显示pending |
| continuation / quota | 有界continuation只透传IO；quota next-input默认off | 额度失败仅下一条新QQ输入前fresh换模，不重放；诊断只留设置，费用显式告知 |
| owner / ingress安全 | Connection requestRejection+admit owner；webhook非空HMAC；credential只写 | missing/broken/guest failclosed；禁止提升sandbox/approval |
| selfupdate | 不复制selfupdate执行模块，host无import/register，新旧Client无自动GET/update/installUI | 新production没有update/install；原repo仅来源说明 |
| 空间去重安全 | installed sid+Agent-instance修补在legacy保持；新主线按 exact Agent 注册 Qzone 工具并在重挂前检查实例 | 新工具只在该 exact Agent 上可用，配置变更/解绑会卸载 |
| 空间 / 日程 / 轮询 / 跨消息合并窗口 | Qzone 读取/详情/动态流/发说说/点赞/评论工具；官方 `ctx.schedule` 的显式 create/list/view/edit；显式 HTTP history polling；按聊天合并窗口 | 均默认关闭或只读；写动作服从业务 send 闸；不后台建任务、不发真实消息 |
| QQ history tool | `qq_history` 只读当前 binding 的 OneBot history；count 1–20、可选 message_seq；输出有界文本/媒体名；不调用 bridge.receive、不改 watermark、不发 QQ | 目标由 binding 固定；校验 target/admission；网络、业务、binding、exact Agent 闸 |
| 入站 ASR | 默认 off；显式已就绪 host-local speechController 转录 canonical WAV，official saveFile准入音频，转录文本由 IO入模 | 无CLI/prepare/install/cloud fallback；转录失败保音频+明确未转录文本；durable intent/terminal回执不重复转录 |
| 卡片 / 合并转发 | 显式开关、纯json/xml数据抽取；get_forward_msg节点/深度/call/bytes/完整wrapper字符预算、负缓存 | 外部资料JSON，不执行HTML/XML实体表达式；首层图片按正常附件准入 |
| 发送者 / 点名 / 概率 | 每binding默认 off；sender allowlist、self @/verified self quote/关键词、chat隔离尾条数/时间、message-id稳定概率 | 过滤决策持久，过滤先于媒体/ASR；点名可直接放行 |
| rate / cooldown | 每binding默认 off；cooldown与perMinute预算，立即typed503/backpressure/queued:false；owner持久诊断 | 不后台延迟排队；OneBot若不重投该消息不会自动送达，真实重试行为未知 |
| 人设 / 回复门槛 | exactAgent native systemPrompt.section(interpolate:false)与scoped qq_reply_gate，projection限定唯一QQ-turn | gate receipt按turn持久；decline抑当前真实投递，可native conclude，不改approval/sandbox/executor、不驱动第二Agent |

## 已知未完成

1. 每绑定模型+effort 已通过 exact catalog 校验及 `agent.model.select` 在 cold/idle 或 scoped turn-stopping 后的未准备边界应用；native-wins 默认尊重不同现有模型，binding-once 仅显式应用一次。忙碌期间状态为 pending，不声称捕获中的 step 已换模；取消、native 改选、解绑、catalog 失效会阻止应用。额度策略默认 off，可显式启用 next-input：仅唯一 QQ、无部分输出/工具副作用、明确 quota/rate-limit 的失败才装填；持久换模次数预算防重启反复切换，下一条不同新 QQ 输入且空闲时 fresh catalog/native/cancel 校验后选候选模型，不重放失败请求、不在 same-step retry 改 selection。诊断只留设置，不绕 IO 总发送闸外发手机通知。
2. 可选额外真实回复仅透传 IO `continuation`，默认关闭，额外计费必须有回复次数/输出 token/时长三预算，且 IO 全局 continuationEnabled 同时开启。QQ 自身不重复实现模型驱动；相关真实多请求/usage 行为依赖 IO 包的离线验证，尚未实测 QQ 网络。
3. 第三增量已实现 ASR/卡片/合并转发/门槛/人设/发送者过滤/点名概率/频率冷却，以及显式 HTTP 轮询、按聊天合并窗口、Qzone 读写工具和官方 schedule 显式任务工具，均默认关闭或只读；旧实例实际启用值未读取，不以默认冒充现状。加载/保存/导入不会自动创建 schedule 任务，也不会自动发说说、点赞或评论。
4. 已在 test-only YAML 下用 exact official Loader/Include + Cordis + native Session + 真实 IO + storageDomain（mock 外部介质/transport）验证 composition 与卸载，但不是 profile 安装。真正 OneBot/语音/上传、Client 原 GUI 视觉与可访问性完整验证尚未执行。
5. read-only 历史有两条路径：IO 本地 binding/seq sidecar 和 canonical preview；以及本包 `qq_history` 直接读取当前 binding 的 OneBot history。前者不宣称能无条件拉完整 QQ 服务器历史；后者受网络、业务和 binding 闸限制，并只返回有界文本/媒体名称。HTTP polling 是显式开关的 OneBot history 读取，启用时从当前 watermark 开始，只通过既有 `bridge.receive` → IO ingress 进入，不另建会话或调度底座。
6. 新建会话、合法媒体来源、mmx 与旧桥停用必须由用户明确配置；本包不提供绕过权限的自动修复。Qzone 写工具只接受 http(s) 图片或 base64:// 数据；schedule 工具/owner 路由只在用户或 Agent 明确调用时创建/调整官方任务，本次没有创建任何实际任务。

## 第三增量：轮询、合并、Qzone、schedule

合并窗口中的输入在请求取消、停用桥接、停用或更换绑定时清理；已经提交给 IO 的输入按原回执处理。模型侧定时任务工具仅访问当前 QQ 绑定的会话；管理界面可选择已有绑定。

- **HTTP history polling**：`lib/polling.mjs` 用既有 OneBot HTTP origin 调用 `get_group_msg_history` / `get_friend_msg_history`，把历史行构造成 OneBot message 事件后调用同一个 `bridge.receive`。显式 `polling.enabled`；首次启用写入当前时间 watermark，重启按已存 watermark 续跑；单 flight、可 abort、按 `polling.catchupMs` 限制补投。只有 `enabled` binding 才轮询，network 总闸仍由 Host `networkAccess` 执行。
- **跨消息合并**：`lib/merge.mjs` 按 binding 隔离持有窗口，受 `windowMs`、`maxWaitMs`、`maxMessages`、`maxChars` 限制。点名/引用立即 flush，普通消息等静默间隔；flush 后一次调用 IO ingress，正文带来源边界，超过块/字符预算显式省略。webhook 和 polling 都走同一路径。
- **Qzone**：`lib/qzone.mjs` 迁入 `qq_space_list`、`qq_space_detail`、`qq_space_feeds`、`qq_space_post`、`qq_space_like`、`qq_space_comment`，走同一 OneBot HTTP origin。读取需 `qzone.enabled`；写动作还要求全局 `sendEnabled`、binding `sendEnabled` 和对应 `post/like/comment` 开关。图片只接受 http(s) 或 base64://，不读任意本地路径。工具按 exact Agent 注册并在实例/配置变化时卸载。
- **schedule**：`lib/schedule-tools.mjs` 只调用官方 `ctx.schedule` 的 `create/list/view/edit`，任务 target 固定到当前/指定 binding 的现有 session。`qq_schedule_create` 只在用户或 Agent 明确调用时创建，不在 load/save/import 时建任务；`/schedules/create`、`/schedules/edit` 等 owner 路由也只在显式请求时代理官方服务。没有第二套调度器或后台静默 timer。

本次不真实连接 QQ、不发送消息、不导入凭据、不创建实际 schedule 任务、不启停桌面插件；`dist` 由普通 `node build.mjs` 复制生成。

## 构建

本包是直接运行的 plain ESM，`node build.mjs` 将主线、locale/图标/许可/迁移资料复制为可安装 package artifact 到 `dist`，不安装、不修改profile；legacy不从main/exports自动激活。ASR使用optionalnative服务，不打包识别模型或下载依赖。

本轮只做 Host networkAccess 入口、用户文案与文档收尾；未运行全量测试、审计、真实网络或插件启停。

## 离线测试

在本包目录执行（本机经用户批准的命令级 Node，不改 PATH；源码根仅只读测试依赖）：

```powershell
$env:DSH_SOURCE_ROOT='<DSH_SOURCE_ROOT>'
& 'node' tests/run.mjs
& 'node' --import ./tests/runtime-loader.mjs --test tests/runtime.integration.mjs tests/loader.integration.mjs
```

第一条含 pure/compiled React semantic DOM 与原1.5.2 steer脚本；第二条为真实 exact Cordis/storageDomain/AgentModel/Loader composition。jsdom 不是视觉截图或原GUI验证。

依赖相邻工作区 `dsh-super-agent-io/core.mjs` 的纯实现用于集成测试，不安装 peer 包，不运行网络。`tests/inbound-steer.mjs` 是 1.5.2 测试移植，仅改独立 fixture 路径与 mock 注入。报告需分别列离线结构/行为、真实 runtime、视觉、真实外发四种验证等级，不能混为“已可用”。
