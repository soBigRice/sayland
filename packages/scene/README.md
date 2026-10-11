# 体素场景内核

核对日期：2026-10-11。纯 TypeScript，不依赖 React、Three.js、DOM 或提供商。协议与容量常量以 `../protocol/src/index.ts` 为唯一来源。

`src/index.ts` 导出 `VoxelEngine`、`createInitialScene`、坐标工具与相关类型。

```text
SceneBatch + requestId + 可选 historyGroup
  → protocol.batchSchema
  → 检查请求幂等、baseRevision
  → VoxelStore 写时复制草稿
  → 模板展开 / 几何采样 / 任意切片及补丁
  → 整数范围、部件占位、工作量及容量检查
  → 原子提交 + 真实差量 + revision
  → 可撤销结果快照 → Three.js 实例显示
```

- 方块储存整数最小角，显示中心各轴加 0.5；+Y 向上、+Z 向前。任何部件操作的 region/offset/cell 均相对部件 origin；手动 `put`、按 ID 变换为世界坐标。
- 物件分组为两层 `Group → Part → voxel`：`Group` 只含稳定 `id/name`，`Part.groupId` 表示唯一所属物件，体素仍只引用 `partId`。组和部件使用独立 ID 命名空间，不增加父子变换矩阵，不改变世界坐标。组最多512个；缺失或为null的groupId均为未分组，不通过名称、ID前缀或包围盒猜归属。
- 单位置只允许一个所属部件。失败整批回滚，包括 ID 分配；同部件可改色，不会重算旧几何覆盖手工修改。
- `executeBatch(input, requestId, historyGroup?)` 返回 `{ snapshot, changes, canUndo, canRedo, replayed }`。同一对话使用相同 historyGroup；重复请求返回当前场景，不恢复旧快照。
- `undo/redo` 使用差量，不再次调用模型。`rename(name)` 独立进入历史并提升版本。取消由外层停止后续调用，已完成的批次保留，可整轮撤销。
- `serialize()` / `VoxelEngine.restore(input)` 使用 version=1 持久化场景、差量历史与幂等记录。最多50步、100000条差量、64个请求指纹。恢复时核对历史两条分支、部件与占位一致性；损坏时抛错，不静默丢弃历史。组及成员归属同时进入每条历史的before/after元数据；仅改分组或组名也能撤销，一轮对话的`historyGroup`仍仅控制撤销合并，与场景物件组无关。
- `snapshot.nextVoxelId` 明确携带分配器状态；服务端 `fromSnapshot()` 才能在删除最高 ID 后产生与浏览器相同的新 ID 和提交摘要。旧快照缺失此字段时从现存最大 ID 推导；序列化历史另保留并核对分配器。
- 首版世界坐标 -128…128，场景40000方块、单批触及16000 ID、几何候选64000格。任何超限都明确报错；这些是资源限制，不是已经测得的设备帧率保证。
- `add_prefab` 产生一个`id/name`与输入相同的物件组，全部普通部件明确引用该组。house生成 `id-floor/walls/roof/door/windows/chimney`；tree生成 `id-trunk/leaves`；duck生成 `id` 和 `id-beak`；flowers生成 `id-stems/petals`；river生成 `id`。模板后续不会重放，局部编辑保留；现存同名组或部件导致整批失败。

初始岛 `createInitialScene()` 为9211个真实可编辑方块、25部件、13物件组，屋顶编号 `home-roof`、所属组`home`；泥土/草地/沙滩属于`island-terrain`，两棵树各有自己的组。不执行网络请求，也不重新分组已保存的旧作品。

## 分组编辑与旧数据

`define_group`定义或更新组，`define_part`可带groupId；组须先存在。更新现有部件时省略groupId会保留原归属，显式null才解除。`assign_part_group`只改所属关系、不移动体素，传null解除归属；`rename_group`只改显示名称。组可暂时无成员，便于同批先定义组再添加部件。所有关系在导入和历史恢复时校验，拒绝重复组ID和不存在的组引用。

`translate_group`先收集全部成员的体素ID，再一次性校验并移动；不能展开成依次`translate_part`，否则紧邻成员会把彼此误判为障碍。平移保留体素/部件ID，所有成员origin同步加delta，部件局部偏移不变。`paint_group`只改全组颜色；`remove_group`删除组、成员部件与其体素，其他组和未分组部件保持不变。碰撞、坐标范围或单批预算超限均整批回滚，不留下部分移动。

快照schemaVersion仍为2，内核持久化version仍为1：新快照始终输出groups，旧快照及历史元数据缺少groups时按空组恢复，旧Part不强行补字段，保留既有撤销/重做和请求指纹。分组历史同样持久化。`canonicalSnapshotJson`按组/部件/体素ID排序，并在摘要中统一缺失groups为空数组、缺失groupId为null；组名和归属参与ACK摘要，数组顺序不影响结果。旧应用不认识新增操作/字段，前后端需要使用同一版本协议。

`src/engine.test.ts`覆盖初始数据、原子回滚、幂等、revision、局部编辑、模板、整轮历史、容量、恢复损坏、分配器镜像一致性。`src/groups.test.ts`覆盖邻接成员整组平移、origin和ID保留、碰撞/越界/预算回滚、整组涂色/删除、元数据撤销、旧备份恢复与新旧历史混用、预设归组和服务端/浏览器摘要一致性。

内核选择性取自同机「创想生成器」的坐标、几何、稀疏存储与事务实现；未带入原工作台、世界分页、三视图、空腔分析或服务调度。Sayland 的有限范围、模板、初始岛和公开持久化接口在本项目维护。
