# 第二增量计划 / optional contracts

只读 installed1.5.4 源码schema/default与fixture；**未读取旧配置文件或secret，因此旧实例“当前启用值”未知**，不能由默认值推断实际配置。所有迁移新feature默认off，导入disabled，仅显式owner操作能启用；Host networkAccess仍总网络闸。

| feature | installed schema/default行为 | 新主线安全执行路径 / 合同 |
|---|---|---|
| 分享card | json/xml自动抽标题/summary/url/BV，无独立开关 | 显式rich.cards；纯有界解析，不取网页/执行XML/entities；JSON外部资料包 |
| 合并forward | get_forward_msg缓存200/10min（含失败），节点12/行40/正文2500/有限深度 | 显式rich.forwards；call/node/depth/bytes/chars预算+endpoint隔离TTL负缓存；首层媒体需official准入 |
| ASR | false；用户shell模板{file}、modelDir、timeout60s；可能信任后端本地path/自装deps | 已实现显式asr.enabled；get_record只接受allowlistedHTTP或有界base64，official saveFile→exact native speechController.transcribe，明确ready/standby host-local provider；无CLI/prepare/configure/install/cloudfallback；durable transcribing/terminal回执防重复 |
| sender/filter/mention | 群默认只听点名，点名后5条/120s；群owner例外/关键词；probability100、点名必回true | 每binding admission.enabled=false；explicit allowlist、自ID @ / bounded verified quote/关键词、perchat尾预算、稳定message-id hash概率（无重复抽签） |
| rate | cooldown5s、4条/min，超出等待非丢弃；merge3s/最多20s/8条 | 已实现explicit rate.enabled=false；立即typed503 retryAfterMs queued:false，无payload长timer/隐藏队列，owner持久诊断；上游不重投则不会自动送达。merge窗口未迁移，不能宣称等价 |
| persona | false；actual1.1.1+仅exact Agent systemPrompt.section，挂失败不塞user消息 | optional agent.ctx systemPrompt.section/assemble/interpolate:false，exactAgent disposers，native提示快照仍由AgentLoop落日志 |
| threshold | row gate=false，只群；点名必过；false抑出站，真停false | scoped native tool，唯一QQ-turn+无混合local输入；durable gate receipt按turn，抑该真实delivery，不重写assistant；可native concludeTurn不取消无关输入 |
| polling | 总闸+绑定时2s拉history，启用从now watermark/10min补投窗 | 已实现显式 polling.enabled=false；owner配置可见；optional timer.interval，singleflight+abort+enable-time watermark；只走既有 bridge.receive/IO ingress，不回灌旧历史 |
| Qzone | 绑定会话挂4tool，read常可，post=false；exactAgent dedupe | 已实现 exact Agent scoped 只读 list/detail/feeds 与写 post/like/comment；网络总闸；写动作同时服从业务 send 与 binding send；图片仅 http(s)/base64:// |
| schedules | schedule[]；看圈false/30min，点赞评论false | 已实现 native `qq_schedule_create/list/view/edit` 与 owner 路由，只调用官方 `ctx.schedule`；仅用户/Agent 显式调用创建，不保存自动创建，不另起调度器 |

已Inspect并按exact0.2.2rc1验证的必要合同：

- `systemPrompt.section({name,order,text,interpolate:false})`、`assemble({scope:agent})`；不system-prompt/assemble waterfall。
- `tools.register({name,description,parameters:object,output:{schema,render},execute(args,exec)})` scoped；`exec.agent/signal/concludeTurn`；不替换executor/approval/sandbox。
- `timer.timeout/interval`回收disposer；仅收OneBot时显式启用polling，never自动额外model请求。
- `schedule.create({title,prompt,timing:{kind:'daily',daily:{time,time_zone}},target:{kind:'session',sessionId}})` / view/edit；不创建task直到owner按明确按钮，native service owns真正delivery。
- `sessionProjections.register`可提供source-exclusive turn事实，纯apply，bounded JSON状态；没有服务时features failclosed，不乱写Session新event。
- `agent/created` serial hook仅挂已绑定会话的scoped native能力，无自动Agent.create/followup。

当前完成 A/B 的 rich/ASR/filters/probability/tail/rate/persona/gate 与设置控件；第三增量补齐 C 的轮询、跨消息合并、Qzone 读写工具和官方 schedule 显式任务工具。此前用户要求停止新增查验的收尾边界继续有效：不继续 Loader signed-event 端到端或 DOM 验证扩展，不运行新增审计。已在要求前执行：pure/DOM旧回归与A/B合计58/58、legacy4/4；exact runtime7/7（含实际native speechController/WAV拒绝及Tools/SystemPrompt作用域），原Loader1/1。最后控件/收尾变更不为新增测试延长，只正常build。真实网络、ASR模型推理、profile安装与GUI视觉未执行；本次没有创建实际 schedule 任务，没有真实 Qzone/QQ 外发。
