# Sayland 独立 API

核对日期：2026-10-11。Node.js 运行，入口 `src/server.ts`，只监听 `127.0.0.1:4311`。从工程根目录启动，以根 `.env.local` 为只读配置来源；服务不查找或读取其他项目。

## 配置

- `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`DEEPSEEK_MODEL`（兼容 `DEEPSEEK_TEXT_MODEL`）；默认模型 `deepseek-flash`。
- `MIMO_API_KEY`、`MIMO_BASE_URL`、`MIMO_TTS_VOICE`；模型固定 `mimo-v2.5-asr` / `mimo-v2.5-tts`，默认音色 `mimo_default`。
- `SAYLAND_API_PORT` 默认 `4311`，`SAYLAND_WEB_ORIGINS` 默认 `http://127.0.0.1:4310,http://localhost:4310`，多个精确本机 origin 以逗号分隔。

供应商请求只使用官方 HTTPS 主机；不跟随重定向。API Key 不返回浏览器，不记录请求正文、录音、模型提示词或供应商响应 body。健康接口表示配置存在，不表示账号权限、额度或真实调用已经通过。

## 调用链

`POST /api/chat` → `chatRequestSchema` / `VoxelEngine.fromSnapshot` 验证输入 → `Providers.plan` 受限规划循环（DeepSeek → 可选 `inspect_scene` → `apply_scene` 隔离预演及新部件归属校验 → 必要时具体错误反馈后重写整批计划）→ App 再次内核及新部件归属校验 → SHA-256 预测快照 → SSE `plan` → 浏览器实际事务提交 → `POST /api/turns/:id/ack` 验证 revision/digest → 返回可显示、可朗读的回复。

只向浏览器交付一份通过预演的完整工具批次。工具 JSON/schema 错误、多个工具、越界、部件缺失、冲突会返回可修正的工具反馈；未通过前绝不发出 plan。供应商网络/权限失败、被截断的模型回复不会重复付费请求。快照的 `nextVoxelId` 必须由内核保留，否则删除最高 ID 后重建会产生与浏览器不同的 ID；兼容导入旧文件时由内核补齐。共享 `snapshotDigest` 对对象键、部件和体素排序，前后端使用同一规范。

`src/scene-context.ts` 从实际 occupancy 构建部件摘要，不根据树、船等关键词提供特殊落点。地形/水部件的 `surface.levels` 区分已占用 `occupiedY` 与上一格 `baseY`，并记录该格/更高处已有占用的列数。颜色或高度统计有上限时明示完整性；这些统计和包围盒都不是整件物体可放置的保证。

`inspect_scene` 查询原始快照的世界坐标闭区间 `{region:{min,max},partId:null|ID,offset}`，每轴至多 64 格、体积至多 64000 格。返回实际占位的 X 连续段，每页最多 256 段；`nextOffset` 非空时还需分页。连续段按部件合并，混色段明确 `color:null/mixedColor:true`，不因原场景多色花纹退化为逐格输出。`partId:null` 才能看到其他部件的阻挡；指定部件后的空白不能代表全场景空白。查询与预演都不改浏览器作品。

规划最多 6 次模型调用、4 次查询、3 次完整计划（首次失败后最多 2 次修正），整轮总截止时间 65 秒。`errors.ts::diagnoseBatchFailure` 用原始快照执行批次前缀，定位首个失败操作并保留累计预算规则；反馈包含内核 code、从 0 起的 operationIndex、精简操作、冲突世界坐标、原部件/目标部件局部坐标及最多 27 个附近占位。另附预演前缀中的目标/阻挡部件真实数量与世界/局部范围，阻挡部件占位复用 `inspectScene` 压缩为最多 256 条 X 连续段；大部件仅取冲突附近至多 40³ 区域并明确 `complete/truncated`。这些部件可能是本轮新生成的，原始快照查询中不存在；范围仍不是实心形状。诊断读取失败明确标记 unavailable，不覆盖原错误。切片行宽、重复层等具体内核错误也保留。每次修正仍从原始快照开始；不会自动挪坐标、跳过碰撞格子或删除复合请求中的目标。

模型提示明确逐步执行语义：同部件写入可以覆盖/改色，跨部件写入拒绝；挖空只影响本部件；不能先覆盖其他部件再通过后续挖空弥补；切片列/行/层分别沿 +X/+Z/+Y，`replace` 的点号只删除对应本部件格子。预设仅是快捷操作，自由造型不限种类。重试只修复模型步骤，不放宽内核保护。

### 物件组与部件

共享协议提供明确的两层归属：`Group{id,name}` 表示物件，`Part.groupId` 指向其所属物件；部件的 `role` 只表示用途。`snapshot.groups` 可选以兼容旧文件，缺失/空 `groupId` 视为未归组。组 ID 与部件 ID 是独立命名空间。`sceneSummary` 输出 `groups` 及其 `partIds/partCount/voxelCount/worldBounds`、`ungroupedPartIds` 和每个部件的显式 `groupId`；`inspect_scene` 也返回匹配部件的 `groupId`。组范围仍只是包围盒，不代表内部实心。

模型工具 JSON Schema 直接沿用共享协议，包含 `define_group`、`assign_part_group`、`rename_group`、`translate_group`、`paint_group`、`remove_group`。自由物件先定义组，再给成员指定 `groupId`；多个独立物件分别建组，不按同次请求、名称、ID 前缀、用途或坐标猜归属。`add_prefab` 由内核自动定义 `id=预设id/name=预设name` 的组并归入全部预设部件。整件修改用组操作，只改屋顶等局部仍用部件操作；删除组连同全部成员与方块删除。旧部件可明确归组/解除归组；修改旧部件时省略 `groupId` 保留原归属。

`src/grouping.ts::newPartGroupingIssue` 是 API 的单一附加规则：预演最终快照中，本轮新建部件必须指向有效组，既有未归组部件可保持。清空或明确删除后用相同 ID 重建，也作为新部件检查；检查跟随旧成员的显式归属变更，避免把先解除归属再删除空组误判成重建。缺失时返回有界 `GROUP_REQUIRED` 诊断（最多 16 个部件 ID，并注明总数/完整性），进入现有 3 次完整计划预算，不另加模型调用额度。`Providers.plan` 与 `app.ts` 最终校验都调用同一函数，注入或替换 provider 不能绕过该要求。

这条约束保证引用和归属结构完整，不把它宣称为任意自然语言物件划分都已正确；模型仍须按用户目标合理划分独立物件。物件归属随共享快照参与提交摘要，只有浏览器实际提交并 ACK 一致后才完成回复/朗读。

ASR 是短句录音结束后上传完整 WAV。SSE 仅传状态和完整计划，不假装实时 ASR。TTS 使用非流式 WAV，只朗读本 session 最近已确认的回复；尚未 ACK 的计划成功文案被服务端拒绝。

## HTTP 契约

除 health 外，所有业务接口需要 `X-Sayland-Session`，值为页面生成的随机 UUID（允许 16–80 字符字母数字、`_`、`-`）。允许同源 Vite `/api` 代理，或来自配置列表的直接请求。Host 必须为已配置本机地址；所有响应 `no-store`。

| 路由 | 输入 | 输出 |
| --- | --- | --- |
| `GET /api/health` | 无 | `{ok,model,aiConfigured,asrConfigured,ttsConfigured}` |
| `POST /api/chat` | 共享 `ChatRequest`：`{requestId,text,snapshot,messages}` | SSE，见下表 |
| `GET /api/turns/:id` | 无 | `{requestId,status,plan?,reply?,revision?,diagnostics?,error?}`；只对已确认/纯对话返回 reply |
| `POST /api/turns/:id/ack` | `{revision,digest}` | `{requestId,reply,revision,status:"committed"}` |
| `POST /api/turns/:id/cancel` | 无或 `{}` | 当前状态；已 committed 的交易保持 committed，不撤销场景 |
| `POST /api/speech/transcribe` | `Content-Type: audio/wav` 原始二进制 | `{text}` |
| `POST /api/speech/synthesize` | `{text}`，须为本 session 已确认回复 | `Content-Type: audio/wav` 二进制 |

| SSE event | data |
| --- | --- |
| `status` | `{requestId,phase:"thinking",message}`；后续规划显示“正在调整搭建方法…” |
| `plan` | `{requestId,batch,reply}`；reply 只可在 ACK 后呈现为完成文案 |
| `reply` | `{requestId,reply}`，纯对话或已确认请求的重复查询 |
| `done` | `{requestId,status}` |
| `error` | `{requestId,code,message}` |

普通 HTTP 错误为 `{error:{code,message}}`。SSE 已开始时使用 `error` event 后关闭。预演最终失败按实际类型返回如 `PLAN_COLLISION`、`PLAN_PART_NOT_FOUND`、`PLAN_BATCH_BUDGET`；不再把所有错误说成“放不下”。前端断开会取消供应商请求；主动取消还应调用 cancel，处理计划已经到达的情况。超时/断线后查询原 requestId，不能用新 ID 盲重发；同 ID、同内容重复提交会重放计划或已确认回复，不再次调用模型。同 ID、不同内容被拒绝。

`diagnostics` 仅供同 session 查询，包含 modelCalls/queryCalls/applyAttempts 计数与有界的结构化失败记录，不保存完整对话、原始供应商响应、音频或配置。与 turn 同样在短期内存中保留，TTL 10 分钟，不落盘。详细几何诊断不作为儿童界面的成功消息或朗读内容。

隐藏调试面板复用这个 turn 接口；物件树、部件数量与范围由浏览器当前已提交快照直接派生，不新增 `/api/debug/scene` 或第二份服务端场景。`awaiting_ack` 的 plan 是尚待确认的候选；`diagnostics` 中的碰撞占位可能来自临时预演前缀，不能当作浏览器作品状态。面板是否显示不是访问控制，仍以既有 loopback、Host/Origin 与同 session 隔离为边界；session 标识不等同用户账号或管理员身份。不要把隐藏面板数据、作品片段或完整对话自动写入日志/导出。

## 容量与资源

- 输入 JSON 上限 8 MiB，场景和批次容量另由共享协议限制；录音最多 30 秒、1 MiB、16 kHz 单声道 PCM16 WAV，校验真实 sample 数。
- 每个 session 最多 1 个进行中的供应商任务，全局最多 4 个；每分钟每 session 最多 24 次供应商调用。`begin` 预留首次调用，规划循环的后续每一次真实模型调用均再次计数。网络、权限和传输失败不自动重试；只有工具查询/几何反馈驱动的有界修正会产生下一次模型调用。
- 128 个 session、64 个 turn 有界内存；turn/session 闲置 10 分钟回收，待 ACK 2 分钟后失败。没有数据库，服务重启后不能恢复请求状态；作品留在浏览器本地。
- 录音和 TTS 仅在当前请求内存中处理。请求完成清除 timeout/abort 监听；服务关闭先取消所有供应商请求。
- DeepSeek 每次请求至多 60 秒、整轮规划至多 65 秒，ASR 30 秒、TTS 40 秒超时。取消/总截止时间会中止在途请求并阻止后续调用；计时器在退出时清理。错误正文不透传，额度/权限需通过真实供应商测试确认。

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
