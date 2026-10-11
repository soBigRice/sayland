# 场景模型导出

核对日期：2026-10-11。入口：小岛设置 → 导出 3D 模型。原 `.sayland.json` 作品备份、导入、历史与自动保存不变。

## 范围与调用链

`App → ModelExportDialog → Worker → createExportArchive → ZIP 下载`。窗口用显式 `groupId/partId` 提供全部、物件组和单部件复选；没有方块的部件不列出。组支持全选/半选，不根据名字猜成员。参数变更只计算尺寸和颜色，连通性检查与网格/压缩都在后台线程。取消、关闭窗口或卸载终止 Worker；完成也终止。下载 URL 30 秒后或卸载时释放，临时 Three 几何/材质/贴图在 finally 释放。

`packages/scene/src/export.ts` 从已提交快照筛选体素，保留所选物件的相对位置，整体平移到最小角。每格默认 2 mm，可选 0.1～100 mm，界面显示长×宽×高；不会猜测打印机平台大小或 AMS 数量。极大绝对坐标先归零再生成角点，跨度超过 100 万格拒绝，避免浮点精度丢失。表面超过 200 万方块面时明确要求分批导出，不简化或截断几何。

按 `partId + color` 提取实体边界，同一分区内部面删除；不同颜色/部件之间保留实体接口，使各耗材分区独立闭合。面边邻接焊接角点；边/点接触不会把四张面错误焊成一条非流形边。每面两三角形、朝外绕序，保留孔洞。只做忠实导出，不自动填孔、加底座/支撑、粘连或改变水面/地形。面连通域、未触底域和朝下暴露面写入包内说明，仅为几何提示，不能替代切片、机械强度或真机验证。

## 文件与材质

| 文件 | 内容 |
| --- | --- |
| `model.3mf` | OPC ZIP、毫米单位，`X=x-minX, Y=maxZ+1-z, Z=y-minY`，保持右手系。单个装配体引用所有颜色部件，避免各部件自动单独落床；基础材质与 `m:colorgroup`/三角形属性双写颜色 |
| `model.fbx` | 二进制 FBX 7.4，原 Y 向上、毫米坐标、UnitScaleFactor=0.1；物件组/部件/颜色网格层级与稳定 ID；逐面 UV、法线、颜色与内嵌 PNG |
| `textures/voxel-edge.png` / `textures/Sayland-*.png` | 后者为各色烘焙副本；前者与渲染层 `voxelMaterial.makeEdgeTexture` 同源的 64×64 细边缘贴图 |
| `materials.json` | 原颜色、Lambert 来源/不透明度、部件/组、尺寸/坐标转换、结构检查；物理耗材为 null，不能把显示色说成 PLA/PETG |
| `scene.snapshot.json` | 仅所选内容的世界坐标快照；不含无关对象、对话、撤销历史或凭据。它不是作品备份，不能在设置中当 `.sayland.json` 导入 |
| `打印说明.txt` | Bambu Studio 导入、选择机型和耗材、颜色映射、支撑与逐层预览，以及本次结构检查 |

当前视口是 `MeshLambertMaterial` 加方块边缘贴图，没有每部件的物理材质属性。FBX 用无高光 Phong 表达漫反射并保留贴图；材质清单记录原始语义。Blender 4.3.2 实测将 FBX 贴图直接接到 Base Color，忽略底色。因此导出将颜色与细边缘在线性光下合成并编码为 sRGB PNG，FBX 使用白色漫反射，避免在其他软件二次染色；每色 PNG 内嵌且附独立副本，原色仍在材质名/清单/体素中。场景灯光、阴影和 GTAO 是屏幕效果，不伪装成打印材质或几何。3MF 保留实体颜色，细边缘贴图不转成耗材分区。

## 选型与兼容边界

- Three r186 无自带 3MF/FBX 导出器。FBX 采用 `@comfyorg/fbx-exporter-three@1.0.2`（MIT，支持当前 Three peer，新增约 427 KB 源包，导出 Worker 单独加载）；不自研 FBX 二进制协议。ZIP 用已有间接依赖 `fflate@0.8.3`（MIT）显式锁定。无安装脚本、外部转换服务或模型上传。[FBX 维护者](https://github.com/Comfy-Org/fbx-exporter-three)、[fflate](https://github.com/101arrowz/fflate)。
- 3MF 只需体素实体、材质、装配引用，按官方规范编写少量 XML；复用 fflate 压缩，不引入整个 lib3mf WASM 运行时。STL 不承载本需求的标准颜色/材质，故不作为主格式。[Core](https://github.com/3MFConsortium/spec_core/blob/master/3MF%20Core%20Specification.md)、[Materials](https://github.com/3MFConsortium/spec_materials)。
- 已核对 Bambu Studio 官方 `bbs_3mf.cpp` 的标准导入分支：`m:colorgroup`、三角形 `pid/p1/p2/p3`，不能只输出 `basematerials` 就声称拓竹识别颜色。[导入器](https://github.com/bambulab/BambuStudio/blob/master/src/libslic3r/Format/bbs_3mf.cpp)。没有写机器配置、AMS槽位或G-code；支持颜色解析的版本仍需用户映射实际耗材，旧版可以按部件名中的颜色手动分配。

## 验证入口

`packages/scene/src/export.test.ts`：255 种局部占位含边/点接触的闭合、绕序、体积；内部面与颜色接口、选择范围、坐标和当前完整初始岛。
`serialize.test.ts`：ZIP 内容、XML/颜色扩展、FBX 签名和内嵌 PNG、材质与所选快照、不修改原作品。

最终导出相关 8 项测试通过，其中完整初始岛 246146 格、25部件、90色、2947472三角形的闭合/绕序/总体积检查通过。隔离预览 `127.0.0.1:4314`、独立 Chrome 上下文在1440×1000和390×844验证全部/组/子部件、半选、空选择和非法尺寸禁用、后台下载/取消、Esc关闭；无横向溢出或页面异常。完整ZIP约31MiB，快照/材质清单格数一致；房屋ZIP由浏览器实际下载后回读。

ThreeMFLoader独立回读房屋3MF：22个网格、22色、6472三角形、39×33×54mm，与清单一致。Blender 4.3.2后台独立回读同份浏览器下载的FBX：几何数量、毫米尺寸、物件/部件ID、UV、内嵌sRGB贴图及每种颜色的实际像素通过；没有打开或改动用户Blender工程。曾查出灰白边缘贴图覆盖底色的问题，已改为烘焙颜色纹理，中心像素与原色对应已纳入自动测试。

导出模块单独类型检查、最终前端Vite构建与Worker打包通过（保留原有大包提示）。本轮验证期间其他任务正在修改useWorkshop/工作区架构并产生`__surface-check.tsx`临时夹具，导致最新项目级类型检查出现范围外错误；没有修改或删除它们，也不把先前构建结果当作并行改动最终通过。主预览4310/4311保持，临时4314、测试浏览器/Blender进程和临时构建/下载/截图在验证后清理。

尚未进行真实拓竹切片或打印验收，用户体验未确认，未提交。
