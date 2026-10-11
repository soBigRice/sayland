# Sayland 独立 API

核对日期：2026-10-11。Node.js 运行，入口 `src/server.ts`，只监听 `127.0.0.1:4311`。从工程根目录启动，以根 `.env.local` 为只读配置来源；服务不查找或读取其他项目。

## 当前多场景入口

当前 UI 使用 SQLite 后台工作区，完整路由、场景权威、队列和恢复说明见 [WORKSPACE.md](WORKSPACE.md)。后台批次以数据库事务提交为确认，关闭页面继续；每场景独立历史和任务。下文 `/api/chat`、浏览器 ACK、session 一任务和短期内存 turn 是保留的旧兼容协议，并非新界面的后台队列。建模工具、几何和供应商章节仍适用，文中的 ACK 在新链路对应实际数据库提交。

## 配置

- `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（兼容 `DEEPSEEK_TEXT_MODEL`）；默认模型 `deepseek-flash`。
- `MIMO_API_KEY`、`MIMO_BASE_URL`、`MIMO_TTS_VOICE`；模型固定 `mimo-v2.5-asr` / `mimo-v2.5-tts`，默认音色 `mimo_default`。
- `SAYLAND_API_PORT` 默认 `4311`，`SAYLAND_WEB_ORIGINS` 默认 `http://127.0.0.1:4310,http://localhost:4310`，多个精确本机 origin 以逗号分隔。

供应商请求只使用官方 HTTPS 主机；不跟随重定向。API Key 不返回浏览器，不记录请求正文、录音、模型提示词或供应商响应 body。健康接口表示配置存在，不表示账号权限、额度或真实调用已经通过。

## 调用链

`POST /api/chat` → 输入与快照校验 → `Providers.plan` 流式思考/工具循环 → 查询最新快照或编译并预演一批 → App再次内核及归组校验 → SSE `plan` → 浏览器执行 → `ACK(batchId,revision,digest)` → 已提交摘要反馈模型 → 下一批，直至最终 `reply + done`。

模型的普通互动与执行状态分开：完整模型响应同时包含工具和普通`content`时，`PlannerOptions.onCommentary`发出SSE `commentary:{requestId,messageId,text}`。只接受完整普通文字，原始`reasoning_content`永不外发；超过600字符的中途文字整条略过，工具仍按原规则执行，不截断句子或另耗修正预算。`plan.reply`不是提前完成证明，浏览器收到实际ACK的`receipt.reply`后才将它保留为一条搭建回复。最终`reply + done`完成整轮并批准TTS，中途对话不提前朗读。取消/失败仍保留已经确认的对话与批次，迟到回调不能跨回合。

纯聊天/澄清保留主模型已验证的普通回答；非推理意图分类器只决定是否必须继续调用编辑工具，其`reply`不替换主模型回答。`GET /api/health`提供`thinking:enabled`及`reasoningEffort:high`，与`completeModel`使用同一常量；它表示主模型请求配置，分类器仍按已核实的强制工具协议使用非推理模式。

每批使用独立batchId防重，整轮requestId合并撤销历史。任何中间操作失败回滚当前批；前面已提交批次保留。API在真实回执前不会把预演结果当已提交，也不会提前批准TTS。保存结构不变，旧单批注入provider仍有兼容分支。

`deepseek-stream.ts::completeModel` 使用流式thinking/high：正常输出预算32768 tokens，截断恢复一次65536。完整finish/DONE和完整参数才可执行；未完成内容全部丢弃。实际输出按UTF-8累计4 MiB（普通文字、reasoning、工具名称与参数），SSE反复出现的协议字段不计入内容。另有单条记录/未完成缓冲8 MiB、累计传输64 MiB保护，逐帧消费，不缓存整条传输。旧12,000字符墙、4 MiB整条传输判断和`ARGUMENT_BUDGET`运行分支均已移除。

诊断区分`TRUNCATED`、`OUTPUT_BUDGET`、`RESPONSE_FRAME_BUDGET`和`TRANSPORT_BUDGET`，附`budget.scope/unit/limit/observed/modelCall`；供应商未返回token实际用量时不虚构observed，length也可能表示上下文上限。实际内容超长在原修正次数内要求分小批，不增加token预算；异常传输/记录直接停止，不调用模型重复修复。所有失败均取消reader并释放锁，已ACK批次保留。紧凑表达与分批不改变造型精度或场景事务容量。

reasoning_content按供应商工具协议只留服务器内存并回传，不进入SSE、诊断或作品。主思考请求使用auto工具选择；非思考意图分类才使用强制工具。网络/权限错误不自动重试。官方核查2026-10-11：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。预算回归见`deepseek-stream.test.ts`及`progressive-planner.test.ts`，均为本地fixtures，不代表新增真实模型验收。

最多24次模型、64次工具、6分钟；连续失败后最多2次修正，只在实际ACK且revision推进时清零。空操作、读查询不能重置。每次调用计入现有限流。修正只针对当前未提交批次，不重新执行前批；模型可调整自行选择的布局参数，不将第一次猜测锁成用户要求。用户明确坐标仍应遵守；保留真实几何校验。

`errors.ts::diagnoseBatchFailure` 用当前快照重放批次前缀定位首个错误；反馈operationIndex、世界/局部坐标和阻挡部件真实占位。预演前缀可能含当前新部件，不能当浏览器已提交内容。大部件只反馈有界局部并标记complete/truncated；包围盒从不表示实心。快照nextVoxelId和规范化SHA-256保证服务端预测与浏览器实际一致。

### 给模型的场景数据

`scene-context.ts::sceneSummary` 按Group→Part输出稳定ID、用途、原点、实际数量/范围和颜色；terrain/water表面区分已占用occupiedY与上一格baseY，不把范围或高度当成可放置保证。

- `inspect_scene`：当前快照世界坐标闭区间，占位X连续段，每页256段、按nextOffset翻页；混色段明确mixedColor，适合碰撞判断。指定partId会隐藏其他部件，判断空位用partId:null。
- `read_region`：必须匹配revision，单part局部坐标，保留每格颜色；palette cells和layers择短。最多4096实际格，超限报错要求缩小区域，绝不截断冒充完整。world=part.origin+local，孔洞不是邻居为空的证明。
- `get_views`：`geometry-views.ts::modelViews` 从完整已提交体素生成960×352 PNG三联图，正面+Z看向−Z、右侧+X看向−X、俯视+Y看向−Y，共用包围盒比例；支持group/part及单part局部特写。图例截断显式标记，几何不截断。与显示相机/动画无关，图片不能证明背面或内部。

Flash通过原生user image_url读取图片，不加视觉供应商、不上传外部文件。读取图片后，模型须在后续回复看到图片才能据此编辑；不会强制每次操作都先看图。提交后旧图片/局部读取归档，同版本新图替换旧图。保留工具调用配对和思考协议连续性，不把几何压缩当作已测得token节省。官方能力：[DeepSeek Vision](https://api-docs.deepseek.com/guides/vision/)（2026-10-11复核）。

### 精细造型与提交后的自动外观反馈（2026-10-11）

对照同机创想生成器的 `server/tools.ts`：自由轮廓/切片/补丁、Flash high推理与分批预算已有对应能力，差异主要在精细造型尺度要求。当前新建复杂角色/动物/汽车参考主轴40–56格、约5000–12000个有效体素；空心船只参考24–40格主轴并保留船舱。它们是生成指引，非计数门槛；明确尺寸、相对比例与简单小物件优先，禁止实心填充或复制放大旧粗块凑数。对照时小船仅88格、全场17834格，没有触发当时40000场景上限，不能把该案例归因为容量不足；本任务没有调整容量或作品格式，实时容量以共享协议为准。

`Providers.plan → commitBatch/真实ACK → visual-feedback.ts::changedObjectViews → modelViews → 下一次原有模型调用`：按前后实际体素ID、位置、颜色和归属差异定位本次受影响的物件；每件单独取完整组的三视图，避免大地形把小物件缩成几个像素。局部删除也查看剩余整件；完整删除、纯元数据变化没有虚构图片，旧未归组部件按part取图。同一模型回复含多批时，全部工具回执之后统一使用最后ACK版本，不发送中间版本。仍可主动get_views检查物件间关系或局部特写。

模型看到真实轮廓后对照原要求检查比例、可识别特征、开口和部件贴附，再决定继续或局部修正。没有单独增加必经的模型轮次、独立评分器或创建前门禁；图片会增加输入token，修正会消耗原有24次调用/6分钟预算。停止、已有批次保留和整轮撤销保持。诊断 `automaticViewPasses/automaticViewImages` 记录自动图像生成次数/数量，与主动 `viewCalls` 区分；它们不证明外观已经达标。回归入口 `test/automatic-views.test.ts`、`test/progressive-planner.test.ts`。

已有结构改造（2026-10-11）：`providers.ts::SYSTEM_PROMPT` 按目标区分独立改色/拆除与结构改造；后者允许局部处理实际相接的多个部件，保护其余区域。部件包围盒最高点不能当作整个连接面高度，摘要不足时读取真实局部或整件视图。平顶案例中的山墙、阁楼窗、烟囱分属不同part，必须按真实连接处理；明确要求保留山墙、悬浮或指定高度时以用户要求为准。提交后的图像说明同步要求检查非预期空隙、依附关系和保留区域。这是模型规划指引，不新增强制落地、自动删墙、固定屋顶高度或确定性语义验收器。`test/structural-edit.live.ts` 提供手动真实模型回归：`node --import tsx apps/api/test/structural-edit.live.ts --run <输出目录>`；只用固定坐标的房屋、草地、树和失败几何，不依赖欢迎岛布局、不读写用户工作库，使用配置凭据并产生模型调用费用。`--replay` 使用已保存的批次离线复核目标几何、无关数据保留及整轮撤销/重做，不产生模型调用。

### 确定性编辑编译

`apply_scene` 的模型参数新增 `creations:[{operations,placement}]` 和 `surfaceEdits`；每批 `SceneBatch` 与作品格式保持不变。`operations` 是自由创建/编辑主入口，允许直接定义任意位置的新组/新部件及悬浮造型；creations只是可选放置辅助；旧保存批次不受该模型入口限制。编译顺序为 operations、surfaceEdits、creations，后面的造型可以引用前面新建的组/部件，每一步都从原快照重放累计批次，最终一并提交或一并拒绝。

`layout.ts::compileCreation` 要求一个明确归组的局部新物件或单个预设。placement 支持：on_surface 按真实底部足迹放置在目标表面；near 放在目标附近真实地面；in_surface 在限定地形足迹内挖除后嵌入，保留河床并拒绝本次造型把水面盖住的错误；absolute 使用实际包围盒最小角精确放置，可用于自由悬浮创作。目标 group/part 二选一，包围盒不当实心，非目标物不覆盖。候选4096、工作量有界；同高地形、河床和实际挖掘/写入范围检查不通过则不提交；高处既有屋檐不在改动体积内时保持不变。空世界无目标 on_surface 从实际造型最小角(0,0,0)起建。

`surface-edit.ts::compileSurfaceExpansion` 接收 partId、amount(1–4)、axes(x/z/xz) 及可选地形目标。按原表面行/列外端扩展，不填孔洞；地形 group/part 二选一，多层岛使用完整 terrainGroupId，不能同时指定草地层。指定地形时要求紧邻河床、实际挖掘/写入体积无其他部件，并只删除新增足迹上的目标地形。无地形目标时只允许向空位扩展。保留旧水与未选中格，碰撞/越界/不支持的多水位整次失败。

模型首次只回复文字时，`intent.ts` 用当前句、近4条历史和对象索引检查 edit/chat/clarify；明确 edit 会继续要求工具，不把流利的追问算作完成。这个调用计入24次/6分钟总限制，取消后不继续请求。不再将模型第一次自选的位置、方向或扩面参数锁定；通过最新实际结果修正。新契约使用共享 JSON Schema refs 避免复制操作定义；模型仍可能产生造型语义错误，几何预演通过不能替代实际效果验收。

测试入口 `scene-edit.test.ts`、`layout.test.ts`、`surface-edit.test.ts`、`intent.test.ts`；真实样例状态统一记录在 PROJECT_MAP 和 DEVELOPMENT_NOTES。

### 物件组与部件

共享协议提供明确的两层归属：`Group{id,name}` 表示物件，`Part.groupId` 指向其所属物件；部件的 `role` 只表示用途。`snapshot.groups` 可选以兼容旧文件，缺失/空 `groupId` 视为未归组。组 ID 与部件 ID 是独立命名空间。`sceneSummary` 输出 `groups` 及其 `partIds/partCount/voxelCount/worldBounds`、`ungroupedPartIds` 和每个部件的显式 `groupId`；`inspect_scene` 也返回匹配部件的 `groupId`。组范围仍只是包围盒，不代表内部实心。

模型工具 JSON Schema 直接沿用共享协议，包含 `define_group`、`assign_part_group`、`rename_group`、`translate_group`、`paint_group`、`remove_group`。自由物件先定义组，再给成员指定 `groupId`；多个独立物件分别建组，不按同次请求、名称、ID 前缀、用途或坐标猜归属。`add_prefab` 由内核自动定义 `id=预设id/name=预设name` 的组并归入全部预设部件。整件修改用组操作，只改屋顶等局部仍用部件操作；删除组连同全部成员与方块删除。旧部件可明确归组/解除归组；修改旧部件时省略 `groupId` 保留原归属。

2026-10-11新增`rotate_group / rotate_part`，通过同一`apply_scene.operations`开放给模型：显式目标、世界轴、整数世界pivot和带符号的quarterTurns（90度倍数）。例如“小船转一下”可以选整船组绕y轴转90度并说明结果；明确角度/方向不擅自替换，45度和持续动画当前不支持。提示词要求按真实对象边界选择旋转中心、保留成员与颜色，失败返回原操作及阻挡物供修正。`providers.plan → VoxelEngine预演 → SSE plan → 浏览器执行 → digest ACK → 最终回复`不变；`test/rotation.test.ts`使用合成模型响应验证接口公开、整组/部件旋转、碰撞反馈及真实API/ACK流程，不能代替真实模型的意图理解验收。

`src/grouping.ts::newPartGroupingIssue` 是 API 的单一附加规则：预演最终快照中，本轮新建部件必须指向有效组，既有未归组部件可保持。清空或明确删除后用相同 ID 重建，也作为新部件检查；检查跟随旧成员的显式归属变更，避免把先解除归属再删除空组误判成重建。缺失时返回有界 `GROUP_REQUIRED` 诊断（最多 16 个部件 ID，并注明总数/完整性），进入当前连续失败修正预算，不另加模型调用额度。`Providers.plan` 与 `app.ts` 最终校验都调用同一函数，注入或替换 provider 不能绕过该要求。

这条约束保证引用和归属结构完整，不把它宣称为任意自然语言物件划分都已正确；模型仍须按用户目标合理划分独立物件。物件归属随共享快照参与提交摘要，只有浏览器实际提交并 ACK 一致后才完成回复/朗读。

ASR 是短句录音结束后上传完整 WAV。SSE 仅传状态和完整计划，不假装实时 ASR。TTS 使用非流式 WAV，只朗读本 session 最近已确认的回复；尚未 ACK 的计划成功文案被服务端拒绝。

## HTTP 契约

除 health 外，所有业务接口需要 `X-Sayland-Session`，值为页面生成的随机 UUID（允许 16–80 字符字母数字、`_`、`-`）。允许同源 Vite `/api` 代理，或来自配置列表的直接请求。Host 必须为已配置本机地址；所有响应 `no-store`。

| 路由 | 输入 | 输出 |
| --- | --- | --- |
| `GET /api/health` | 无 | `{ok,model,aiConfigured,asrConfigured,ttsConfigured}` |
| `POST /api/chat` | 共享 `ChatRequest`：`{requestId,text,snapshot,messages}` | SSE，见下表 |
| `GET /api/turns/:id` | 无 | `{requestId,status,plan?,reply?,revision?,receipts,diagnostics?,error?}`；只对已确认/纯对话返回 reply |
| `POST /api/turns/:id/ack` | `{batchId?,revision,digest}` | `{requestId,batchId?,reply,revision,digest,status:"committed"}`（单批回执） |
| `POST /api/turns/:id/cancel` | 无或 `{}` | 当前状态；停止后仍可确认已经本地提交的匹配批次，不撤销场景 |
| `POST /api/speech/transcribe` | `Content-Type: audio/wav` 原始二进制 | `{text}` |
| `POST /api/speech/synthesize` | `{text}`，须为本 session 已确认回复 | `Content-Type: audio/wav` 二进制 |

| SSE event | data |
| --- | --- |
| `status` | `{requestId,phase:"thinking",message}`；后续规划显示“正在调整搭建方法…” |
| `plan` | `{requestId,batchId,batch,reply}`；reply是本批进度，不表示整轮完成 |
| `reply` | `{requestId,reply}`，最终回复或纯对话 |
| `done` | `{requestId,status}` |
| `error` | `{requestId,code,message,committedBatches}` |

普通 HTTP 错误为 `{error:{code,message}}`。SSE 已开始时使用 `error` event 后关闭。预演最终失败按实际类型返回如 `PLAN_COLLISION`、`PLAN_PART_NOT_FOUND`、`PLAN_BATCH_BUDGET`；不再把所有错误说成“放不下”。前端断开会取消供应商请求；主动取消还应调用 cancel，处理计划已经到达的情况。超时/断线后查询原 requestId，不能用新 ID 盲重发；同 ID、同内容重复提交会重放计划或已确认回复，不再次调用模型。同 ID、不同内容被拒绝。

`diagnostics` 仅供同 session 查询，包含 modelCalls/queryCalls/applyAttempts 计数与有界的结构化失败记录，不保存完整对话、原始供应商响应、音频或配置。与 turn 同样在短期内存中保留，TTL 10 分钟，不落盘。详细几何诊断不作为儿童界面的成功消息或朗读内容。

隐藏调试面板复用这个 turn 接口；物件树、部件数量与范围由浏览器当前已提交快照直接派生，不新增 `/api/debug/scene` 或第二份服务端场景。`awaiting_ack` 的 plan 是尚待确认的候选；`diagnostics` 中的碰撞占位可能来自临时预演前缀，不能当作浏览器作品状态。面板是否显示不是访问控制，仍以既有 loopback、Host/Origin 与同 session 隔离为边界；session 标识不等同用户账号或管理员身份。不要把隐藏面板数据、作品片段或完整对话自动写入日志/导出。

## 容量与资源

- 输入 JSON 上限 8 MiB，场景和批次容量另由共享协议限制；按住录音最多 120 秒、3,840,044 bytes、16 kHz 单声道 PCM16 WAV，校验真实 sample 数。上限与前端共用 `packages/protocol/src/voice.ts`；前端超限取消，不自动发送截断音频。
- 每个 session 最多 1 个进行中的供应商任务，全局最多 4 个；每分钟每 session 最多 24 次供应商调用。`begin` 预留首次调用，规划循环的后续每一次真实模型调用均再次计数。网络、权限和传输失败不自动重试；只有工具查询/几何反馈驱动的有界修正会产生下一次模型调用。
- 128 个 session、64 个 turn 有界内存；turn/session 闲置 10 分钟回收，待 ACK 2 分钟后失败。没有数据库，服务重启后不能恢复请求状态；作品留在浏览器本地。
- 录音和 TTS 仅在当前请求内存中处理。请求完成清除 timeout/abort 监听；服务关闭先取消所有供应商请求。
- DeepSeek整轮含ACK至多6分钟，HTTP传输至多390秒，ASR30秒、TTS40秒超时。取消/总截止时间会中止在途请求并阻止后续调用；计时器在退出时清理。错误正文不透传，额度/权限需通过真实供应商测试确认。

## 验证边界

`test/api.test.ts` 使用明确标记的内存模型/音频 fixtures 与 `fastify.inject`；不读取 `.env.local`，不启动长驻服务，不连接真实供应商。覆盖真实 ACK/hash 门禁、无效操作、取消、并发、重复请求、跨 session、过期、音频校验、官方请求结构及错误脱敏。

2026-10-11 使用用户授权的测试凭据执行了一次真实供应商闭环：`mimo-v2.5-tts` 合成固定非隐私句子“帮我把小房子的屋顶变成蓝色。”，返回 24 kHz / 单声道 / 16-bit WAV，音频 3.52 秒；原始 WAV 直接交给 `mimo-v2.5-asr`，识别逐字一致。该次 TTS 1787 ms、ASR 1648 ms、合计 3434 ms，仅为单样例记录，不能代表稳定延迟。音频只在内存中流转，临时脚本随后删除，无新增软件或长驻进程。

该闭环没有经过浏览器的 16 kHz 录音转换、HTTP 原始 WAV 路由或真实麦克风/扬声器，相关体验与前后端提交仍需主代理联调和用户验收。上面的 fixtures 不代替真实调用；这次供应商闭环也不代替设备验收。

同日另用真实 `deepseek-flash` 对两份隔离内存场景执行完整规划及内核校验：初始小岛“在小房子旁边种一棵大树”以 1 个 `add_prefab` 新增 220 个方块、2 个部件，未删除或修改原有方块，耗时 3221 ms；空场景“帮我搭一只长脖子的长颈鹿”以 21 个 `define_part` / `fill_shape` 操作新增 310 个方块、6 个部件，耗时 6391 ms。两例首次通过，无碰撞修复或提示词调整。此证据证明预设和自由体素操作均可由真实模型生成并执行，不代表造型视觉效果已经验收，也未改动浏览器中的作品；测试脚本已删除。

### 地表高度与种树失败（2026-10-11）

上述种树单例通过不能代表连续对话稳定。实际浏览器先把屋顶改蓝，再请求房子旁种树时出现 `INVALID_PLAN`，场景保持。使用该 revision 1 / 9211 体素导出快照与同一历史直接复现，模型提出树基点 `(-14,5,-8)`，内核报 `COLLISION`：该格已被 `island-grass` 占据。证据表明模型把地表占用高度 5 当成了树干起点；旧提示“地面通常 y=0”和只有部件 bounds 的摘要未明确地面上下关系。

第 1 轮修复删除默认地面高度假设，并加入上面的真实地表与已验证落点摘要，没有自动重试或调整用户坐标。`test/scene-context.test.ts` 固定覆盖原错误坐标、非零地表、保留蓝色屋顶及全部原方块、树干可放但树冠被新手工方块挡住、空场景无虚构落点；与 API 测试合计 11 项通过，TypeScript 检查通过。原导出快照及历史的两次真实复测分别选择 `(-13,6,-5)` 和 `(3,6,3)`，各成功新增 220 块，耗时 1660 / 1489 ms；有限样例不构成零失败保证。后续浏览器结果和主观视觉由主代理另行验收。导出文件保留在用户原位置，测试脚本已清理。

该树专用落点方案现已由下面的通用占位查询/受限预演修正替代；上述测试数量和结果仅对应当时实现，不能直接充当新规划循环的验收。

### 通用占位查询与预演修正（2026-10-11）

“扩河并加小船”真实隔离复现表明：模型先定义新水部件，再填充覆盖旧 `lagoon` 的大方体，计划之后才挖中央孔洞。第二个操作就发生跨部件 `COLLISION`，后续挖空无法执行；原 API 又把具体错误丢弃为“放不下”。包围盒摘要缺少孔洞/占位事实，一次性生成计划也没有修正反馈，因此追加树或船特例不能解决通用创作。

本次保留模型原始 assistant `tool_calls` 和 `tool.id`，按官方 Chat Completions 流程追加对应 `role:tool/tool_call_id` 结果；不制造模型未发出的历史工具调用，不启用 beta strict，所有操作仍经本地 Zod 与内核验证。官方流程已于本次核对：[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)。

`test/planner.test.ts` 使用明确的模型 fixtures 固定历史失败第 2 操作、准确占用/局部坐标反馈、真实查询分页、完整保留扩河与小船两项目标、保留所有旧方块与紫色屋顶、ACK 前拒绝朗读；并验证 JSON/schema 可修正、3 次计划/6 次调用/4 次查询上限、错误切片行宽反馈、桅杆/帆跨层冲突前缀占位、诊断裁剪的显式不完整标记、累计修改预算定位、取消及供应商失败不重试。与 `api.test.ts` / `scene-context.test.ts` 合计 30 项通过，TypeScript 通过。没有因此宣称真实模型已稳定、任意造型已验收或麦克风闭环已通过；本次真实模型与浏览器验证由主任务另行记录。

### 两层分组接入验证（2026-10-11）

`test/grouping.test.ts` 覆盖模型缺组后的反馈修正、相同前缀的独立物件分别归组、连续缺组在原有次数上限停止、旧未归组编辑与显式整理、清空/删除/组删除后同 ID 重建、先解除归属再删组、预设自动归组。`api.test.ts` 固定验证注入 provider 的无组新部件也无法进入 plan/ACK/朗读；`scene-context.test.ts` 核对显式成员、未归组、空组与计数/范围。原有规划碰撞 fixtures 加入必要的有效组信息，仍断言碰撞位置、完整目标、原体素不变与提交门禁，没有放宽断言。

本次 API 范围合计 38 项通过。随后根据共享内核最终契约补充旧部件重定义省略 `groupId` 的继承场景，受影响的 16 项 API/grouping 测试再次通过。全局 TypeScript 检查当时仅因并行开发的前端 DebugPanel 尚未落地报错，API 范围无错误；最终全量构建及真实模型物件分组/整组移动/局部改色由主任务验证。此处测试全部为本地 fixtures，没有新增真实供应商调用。

官方协议：[DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls/)、[MiMo ASR](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition)、[MiMo TTS](https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5)。
