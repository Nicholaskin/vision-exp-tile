# 更新日志（Release Changelog）

> 全部版本记录（v0.1.0 → v0.5.0-rc.3），最新在上；本文件 = GitHub Release 的 changelog 栏（由 .github/workflows/release.yml 自动读取）。
> 注：README 只展示最新一期更新内容（使用者视角）；本文件保留每期完整记录（含历史）。

## v0.5.0-rc.3（双形态 · 跟随 DSH 0.2.0 装载机制）

**触发**：DSH 升级到 **0.2.0-rc.2**（本机注册表实测，2026-09-29 安装；runtime node 24.18.1 / pnpm 11.7.0）。要求插件跟随该版本的装载机制可用。

**实测结论（决定形态取舍的依据）**

1. **0.2.0 的插件机制仍是 Cordis bundle**：宿主程序（app.asar）内自述装载流程为「按 `dsh.profile.bundles` 顺序，读取每个 bundle 包 manifest 的 `dsh.bundle.patch` 指向的 patch 文件，叠加成组合树」——与 0.1.x 同款。
2. **宿主未内置 dsh-std 生态装载器**：对 asar 全量扫描，`tools.dsh` / `dsh-plugin.json` / `dshPlugin` / `@dsh-std` **均为 0 命中**（`facets` 命中处是 DSH 自身存储后端的术语，与本插件协议无关）。
3. **新插件管理器（0.2.0 新增）的识别条件**：asar 内文本为「a runtime dependency of the installation that **declares `dsh.bundle.patch`**」→ 只有带该声明的依赖才会被插件管理器接管。
4. 由此确认 rc.2 及之前删除 `dsh` 字段、只留 `dsh-plugin.json` 的纯标准形态，在当前宿主上**不会被识别、更不会装载**。
5. 0.2.0 另新增「插件-宿主版本兼容性校验」与官方豁免通道（`dsh plugin allow-version` / 插件管理器内的 exact-version exemption）。

**本版变更（双形态并存）**

- **恢复 Cordis bundle 形态**（当前宿主可用）：新增 `cordis.patch.yml`（`insert` 顶层插入 `id/name = vision-exp-tile`）；`package.json` 加回 `dsh.bundle.patch`，`main` 与 `exports["."]` 指回 `src/index.js`（导出 `apply` / `name`，即宿主装载入口）；`files` 补 `cordis.patch.yml`。
- **保留 dsh-std 标准形态**：`dsh-plugin.json` 与 `std-facet.js` 原样保留，后者改为子导出 `exports["./std-facet"]`——等宿主内置生态装载器后可直接启用，无需再改代码。
- **不声明任何 `@deepseek-ai/*` 运行时依赖**：入口仍只 import `node:` 内置与相对模块 → 不触发 0.2.0 的版本兼容性校验冲突（这是双形态方案能「干净装载」的关键）。
- **新增 Cordis 入口冒烟** `scripts/cordis-entry-smoke.mjs`（18 项断言：`apply` 注册 3 个工具且名字正确、清理函数可执行、`main`/`exports`/`dsh.bundle.patch`/`files` 声明齐备、`cordis.patch.yml` 结构有效、`dsh-plugin.json` 与 `std-facet.js` 并存）；`npm run smoke` 现同时跑两套入口冒烟（`smoke:std` / `smoke:cordis` 可单独跑）。该脚本隔离 `DSH_HOME` 到临时目录，不触碰真实配置。

**验证**：`npm test` **166/166** 全绿；`npm run smoke` = 标准入口 15/15 + Cordis 入口 18/18 全过。

**待办（需宿主侧实测）**：在 DSH 0.2.0 的插件管理器中装入本插件（link 依赖已在 profile），确认 `vision_tile_split` / `vision_tile_recognize` / `vision_region_crop` 出现在工具目录——装配结果回填本节。

## v0.5.0-rc.2（取消 picturereader 适配 · 阶段二首项）

**背景**：v0.4.2 曾为「与上游 picturereader 常同实例挂载」做了一套适应性优化（共存探测 + 工具分工引导 + 其配置/venv 复用）。用户决定**取消该适配**，本插件回归完全独立运行——不再关心同实例装了哪些其它图像插件。

**移除内容**（三块，全删）

1. **共存探测 + 工具分工引导（原 A 块）**：删除 `src/picturereader-detector.js`（`isPicturereaderPresent` 双通道探测 / `collabGuideText` / `withCollabIfPresent`）；`src/index.js` 不再按探测结果拼装工具 description，注册回归朴素 `ctx.tools.register(...)`，同时移除原先「首个 apply 探测 + 500/1500ms 复查 + 结果变化后重注册」的竞态处理；`std-facet.js` 里仅服务旧探测的 `tools.get()` 垫片一并删除。→ **三个工具 description 恒为基线文本**。
2. **配置复用（原 B 块）**：删除 `src/peer-config.js`（`readPeerSettings` 读 settings.yaml 的 `picturereader:` 分区 / `applyPeerDefaults`）；`src/index.js` 不再调用，`src/settings-file.js` 的 `initFileSettings({ peer })` 参数移除（sourceGetter 简化为 `normalizeFromSettings(readSnapshot())`），迁移键表删除 `peer_mode` / `collab_mode`。→ **视觉端点一律取本插件自身配置**（`~/.dsh/vision-exp-tile.json` 的 `base_url`/`model` 或环境变量），不再从 picturereader 分区继承。
3. **venv 复用（原 C 块）**：删除 `src/ocr-local.js` 的 `peerVenvPython` 与 `resolveVenvPython` 的 peer 分支（优先级简化为「显式 env > 默认 venv > 默认兜底」）。→ **行为零变化**：实证该分支恒为死逻辑（own 与 peer 路径完全相同，均为 `$HOME/paddle_venv`、`$HOME/rapid_venv`）。

**保留**：`src/ocr-local.js` / `src/pixelgrid.js` / `client.js` 中「写法参考自开源项目 picturereader（MIT）」的**代码来源与许可声明**——属署名与合规信息，非运行时适配。

**影响**：① 工具描述不再出现「【与 picturereader 分工】」段；② 若此前依赖 picturereader 分区提供 `vlm_base`/`vlm_model`，升级后需在本插件自己的设置文件/环境变量中显式配置（本机已自配，无影响）；③ 其它功能与 v0.5.0-rc.1 一致。

**验证**：`npm test` **166/166** 全绿（删除 `tests/peer.test.js` 与 settings-file 的 peer 用例，共 -17 项）；`npm run smoke` 标准 facet 冒烟全过（15/15）；活代码残留引用检查 **0 条**（`picturereader-detector` / `peer-config` / `isPicturereaderPresent` / `withCollabIfPresent` / `applyPeerDefaults` / `readPeerSettings` / `peerVenvPython`）。

## v0.5.0-rc.1（生态化改造 · 阶段一）

**背景与目标**

插件在 DSH 0.1.7-rc.2 上失效的根因：宿主只装载 `profile.package.json` 的 `dsh.bundle.bundles[]` 白名单成员，而 vision-exp-tile 不在其中（旧装载形态 = Cordis bundle + `cordis.patch.yml`，已随宿主换代失效）。本次不修单点兼容，而是按用户选定的路线**加入 dsh-std 协议生态**（github.com/T-Auto/dsh-ecosystem-spec）：把插件改造成 dsh-std 标准组件，由宿主侧 `@dsh-std/adapter-dsh` 发现、校验、装载——标准插件不再需要 `dsh.bundle` / `dsh.client` / `cordis.patch.yml`，也不 import 任何 `@deepseek-ai/*` 宿主包。

### 新功能与改动

1. **标准组件化**：新增 `dsh-plugin.json`（manifest v0.15：`facets.host{entry, apiVersion}` + `contributes["x-tools"]` 声明 3 个 `tools.dsh/v1alpha1` Tool 资源）与 `std-facet.js`（`defineFacet` 标准 Host Facet 入口：激活时经 `context.extensions.publish` 发布工具的 ToolHandler，adapter 自动映射进 DSH 原生工具目录）。
2. **设置文件化**：新增 `src/settings-file.js` —— 设置持久化到 `<DSH_HOME 或 ~/.dsh>/vision-exp-tile.json`，脱离宿主 dsh-settings 服务；**首次自动迁移**旧 settings.yaml 的 `vision-exp-tile:` 分区（纯文本行解析，不引 YAML 依赖）；mtime 热生效 + 原子写回（tmp+rename）；`device_profile` 设备画像回写改走配置文件。
3. **文件访问抽象**：新增 `src/host-io.js` —— 替代旧 `ctx.fs`：绝对路径 node:fs 直读；相对路径优先委托标准执行环境的 `readWorkspaceFile`（宿主按会话 cwd 解析 + fs/observed 观察），无宿主环境时 process.cwd() 兜底。
4. **out_dir 相对语义变更**：显式相对 `out_dir` 的基准从「会话 cwd」改为「**源图所在目录**」（标准协议不提供 cwd；源图目录跨宿主稳定、更符合直觉）。
5. **依赖与元数据**：`package.json` 移除 `dsh.bundle` / `dsh.client` / `@deepseek-ai/*` peerDependencies / `cordis.patch.yml`；新增 `@dsh-std/sdk`、`@dsh-std/tool` 运行时依赖、`@dsh-std/manifest` devDep；`main`/`exports` 指向 `std-facet.js`。
6. **运行时链路洁净**：`SETTINGS_FIELDS` 从 `settings-schema.js` 拆出到 `src/settings-fields.js`（纯数据、零依赖），`runtime.js` 改从其导入——标准装载链（std-facet → src/*）不再连带加载 `@deepseek-ai/schemastery`。
7. **测试**：新增 `tests/host-io.test.js`（9 项：绝对直读/相对委托/cwd 兜底/超限/不存在/错误透传/空路径/已取消）、`tests/settings-file.test.js`（11 项：YAML 分区解析/读写回/原子落盘/损坏容错/迁移/幂等/peer 优先级）、`scripts/std-facet-smoke.mjs`（15 项冒烟：FacetModule 激活→发布 3 工具→定义形状→真实小图执行 →manifest 经 `@dsh-std/manifest parseManifest` 正式校验→scope 清理→运行时链路零宿主 import）。`npm test` **183/183** 全绿。

### 行为变化（使用者视角）

- **设置入口**：DSH Web 设置页不再提供本插件配置分区（client.js 设置页于阶段二以标准 SettingsSection 回归）→ 改为直接编辑 `~/.dsh/vision-exp-tile.json`（枚举/数值/布尔直接写 JSON；OCR 引擎/池等的 env 覆盖机制保留不变）。
- **相对 `out_dir`**：基准改为源图目录（见上）。
- **picturereader 分工引导**：标准环境下 `ctx.tools` 无目录客户端，共存探测降级为「不在场」（工具描述保持基线）；阶段二经协议目录查询恢复。
- **宿主要求**：需宿主安装并装载 `@dsh-std/adapter-dsh`（bundles 白名单 + adapter 自身 patch），vision-exp-tile 作为普通依赖——**装配实测（2026-10-07）受阻**：registry 上 adapter 全部版本（0.1.0-rc1~0.1.1-rc.3）peer 均为 `@deepseek-ai/* <0.1.6`，与宿主 0.1.7-rc.2 不匹配，且宿主插件管理热装严格校验 peer、无忽略入口（安装失败）。按红线不魔改第三方 → **待上游 adapter 适配 0.1.7 后回填实测**。

### 验证

- `npm test`：**183/183** 全绿（原 168 + host-io 9 + settings-file 11 - 5 项重组合并）；
- `npm run smoke`：**15/15** 全过（含 parseManifest 校验与工具名-发布名一致性）；
- 本版为「生态化改造首阶段」：**未 push、未打 tag、未发布**——宿主装配**受阻**（adapter peer `<0.1.6` vs 宿主 0.1.7-rc.2，热装被拒；等上游适配），阶段二（功能与架构升级）不影响、待续。

## v0.4.3（2026-08-30）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 背景与目标

v0.4.2 发布后进入「仅本地同步、暂不发布」收尾：把工作区已新增/修正的代码与文档同步到 v0.4.3 版本号，完成 README/CHANGELOG 更新块对齐，并本地构建双 zip 留存。内容包括：修正 `package.json` 仓库元数据占位符、统一计费表述（避免「不统计」等易误读措辞）、补充「隐私与数据说明」、为 pipeline/region_crop 增加过期临时产物清理。

### 新功能与改动

1. **仓库元数据修复**：`package.json` 的 `repository` / `homepage` / `bugs` 由占位作者/仓库地址改为实际仓库地址。原账号（`Nicholas023`）已被停用，仓库迁移至 `Nicholaskin/vision-exp-tile`；v0.4.3 打包时元数据已指向新地址，包内链接开箱可用。
2. **计费表述诚实化**：README、工具描述、脚本注释统一为「不代为统计/不显示 token 与费用，实际以 DeepSeek 官方 API 平台账单为准」，替换旧的「不统计 token / 不计算费用」表述。
3. **新增「隐私与数据说明」**：图片以 base64 直连 DeepSeek 官方视觉 API、按官方账单计费；pipeline/smart 过程明细落盘系统临时目录（可用 `out_dir` 指定）；插件默认清理超过 24 小时的旧临时目录/区域图（仅插件自身前缀，不触碰用户指定 `out_dir`）。
4. **过期清理模块**：新增 `src/temp-cleanup.js`（`cleanupOldTempArtifacts`：扫描系统临时目录，按 mtime 清理 >24h 的 `vision-tile-pipeline-*` 目录与 `region-*.png` / `vision-tile-ocr-*.png` 文件；支持注入 `now`/`ttlMs`/`tmpRoot`/`excludePaths`；异常静默容错），并在 `src/pipeline.js` / `src/index.js`（region_crop 路径）结束时调用。
5. **测试**：新增 `tests/temp-cleanup.test.js`（5 项：默认不删新鲜文件、过期前缀清理且非前缀保留、注入 now/ttlMs 可控、excludePaths 保护、异常路径不抛），并加入 `package.json` 的 `test` 显式列表。

### 验证

- `npm test`：**168/168** 全绿（原 163 + temp-cleanup.test.js 5 项）；
- `npm run release-pack`：生成 `dist/vision-exp-tile-v0.4.3.zip` 与 `dist/vision-exp-tile-v0.4.3-nopython.zip`；
- 本版为「仅本地同步、暂不发布」：**未 push、未打 tag、未创建 GitHub Release、未 git commit**，全部保留在工作区。

## v0.4.2（2026-08-24）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 背景与目标

vision-exp-tile 与上游 picturereader（github.com/jing-hy/picturereader）常同挂载于同一 DSH 实例。二者都做图像识别，若不分工会让模型被两套近似工具搞晕、多空转轮数。本版做"picturereader 适应性优化"：两插件共存/协作的工具调度适配，并复用其已配视觉端点与已建 OCR venv，顺带省模型空转。

### 新功能

1. **共存探测 + 工具分工引导（A）**：新增 `src/picturereader-detector.js`——`isPicturereaderPresent`（双通道：dsh-tools 注册表 `ctx.tools.get('image_scan')` / 插件目录 `<DSH_HOME>/plugins/picturereader` 存在性；全部 try/catch，异常=不在场）、`collabGuideText`（在场返回 ≤220 字中文分工引导）、`withCollabIfPresent`。`src/index.js` 注册三个工具时按探测结果在 description 末尾追加分工段（大图切块/批量/区域→本插件；小图/像素级/整页文档→picturereader 的 `image_scan`/`image_ocr`/`image_batch`/`document_to_image`）；首个 apply 探测 + setTimeout 500/1500ms 复查（防插件注册顺序竞态，结果变化才 dispose+重注册一次）。**picturereader 不在场时工具描述与 v0.4.1 逐字节一致（零回归）；不在工具结果尾部加任何文本。**
2. **peer 配置复用（B）**：新增 `src/peer-config.js`——`readPeerSettings` 读 settings.yaml 的 `picturereader:` 分区（文本行匹配，去引号/去注释；文件/分区缺失=null）；`applyPeerDefaults` 在本插件 baseURL/model 等于默认（未显式）时以 `vlm_base`/`vlm_model` 覆盖（用户显式 > peer > 默认）；apiKeyEnv 仍用本插件自身 `DEEPSEEK_API_KEY` 链（不读 vlm_key 密钥）。
3. **peer venv 复用（C）**：`src/ocr-local.js` 的 `rapidPython`/`paddlePython` 增加 peer venv 候选——优先级：本插件显式 env（`DSH_RAPID_PYTHON`/`DSH_PADDLE_PYTHON`）> 本插件默认 venv（存在）> picturereader 已建 venv（`$HOME/<venv>/Scripts/python.exe`）> 本插件默认（兜底失败安全回退）；`resolveVenvPython` 为纯函数（可注入 exists 便于单测）。venv 路径常量经实证：picturereader/src/core.js 用 `join(homedir(),'<venv>','Scripts','python.exe')`。
4. **测试**：新增 `tests/peer.test.js`（16 项）：探测双通道/异常、分工引导在场/不在场、三个真实工具描述回归（不在场不含分工段）、peer 配置读取（临时 YAML：正常/缺键/畸形/无分区）、applyPeerDefaults 优先级、resolveVenvPython 优先级、rapid/paddle venv 集成（临时目录 mock 路径存在性）。
5. **无新增依赖、不改动 picturereader**：全部用 Node 内置 + 现有依赖；不写 picturereader 任何文件。

### 验证

- `npm test`：**163/163** 全绿（原 147 + peer.test.js 16 项）；
- `VISION_TEST_TIMEOUT_FACTOR=8 npm test`：163/163 仍全绿；
- `VISION_TEST_SKIP_TIMING=1 npm test`：162 通过 + 1 跳过（超时/时序敏感用例），0 失败；
- `node scripts/probe-device.mjs`：输出合法 JSON（不受本版影响）。

### 致谢与兼容性说明

本版与 [picturereader](https://github.com/jing-hy/picturereader)（MIT，作者 @jing-hy）做了共存协作适配——感谢上游作者与社区。两个插件都装时，模型会自动按分工选工具（大图/批量走 vision-exp-tile，小图/像素级/整页文档走 picturereader）；视觉端点与 OCR 环境可共享复用。**不安装 picturereader 也完全不影响使用：本插件保持完全独立，所有协作探测失败自动回退，双方互不修改。**

---
## v0.4.1（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 背景与目标

解决"较差机型全量测试时 OCR 池超时导致测试不通过"：慢机（核少/内存小）跑 OCR 池单测时，因时序抖动偶发超时失败。按用户三条建议实现——① 设置项可调超时判定；② 测试前先问用户是否测试；③ 安装时自动识别设备、较差机型特别处理。

### 新功能

1. **设备档案模块**（新增 `src/device.js`）：`probeDevice`（CPU 核数/内存/GPU 名，GPU 用 nvidia-smi 1.5s 超时、失败返回 null，可 mock）、`classifyTier`（slow/normal/fast）、`applyTierRecommendations`（slow 放宽池超时到 240s、池并发降到 2、关 GPU、测试倍率×4；性能较好机器 ×2 不足以体现慢机差异，×4 给慢机留足余量，可手动到最保守的 ×8；normal/fast 保持默认）、`deviceProfileText`。
2. **设置项新增 4 字段 + 1 只读**：
   - `ocr_pool_timeout_ms`（20000..1200000，默认 120000，env `DSH_OCR_POOL_TIMEOUT`）——OCR 池单请求超时，可调；
   - `performance_tier`（auto/fast/normal/slow，默认 auto，env `DSH_OCR_PERF_TIER`）——auto=自动探测，非 auto=用户强制；
   - `test_timeout_factor`（1..8，默认 1，推荐 4=slow 档默认，手动最保守 8，env `VISION_TEST_TIMEOUT_FACTOR`）——测试超时判定倍率；
   - `test_skip_timing`（boolean，默认 false，env `VISION_TEST_SKIP_TIMING`）——跳过时序敏感断言；
   - `device_profile`（text，只读）——运行时设备画像摘要，自动填充。
   - 设置/运行时 4 层全链同步（settings-schema / config / runtime / client.js 双语 label），并保持"用户显式值 > 档位推荐 > 默认"。
3. **慢机测试自适应**：
   - 新增 `tests/helpers/suite-env.mjs`（`poolTimeoutMs` / `timingFactor` / `skipTiming`）；
   - `tests/ocr-pool.test.js` 默认超时与超时用例改按倍率放大，时序敏感用例用 `{ skip: skipTiming() }` 声明跳过（跳过时打印原因与建议）；
   - 新增 `tests/device.test.js`（档位/推荐/注入/auto 应用）与 `tests/suite-env.test.js`（边界：非法回退/clamp/布尔解析），并加入 `package.json` 的 `test` 显式列表。
4. **交互式自检入口**（新增 `scripts/self-check.mjs`，`npm run selfcheck`）：调 `probeDevice`+档位打印设备画像与推荐；交互询问"是否运行全量测试？（Y/T/N）"（仅 TTY；参数 `--yes`/`--skip-timing`/`--no` 无人值守）；以子进程跑 `node --test`（读 package.json 显式列表），注入 `DSH_OCR_POOL_TIMEOUT`/`VISION_TEST_TIMEOUT_FACTOR`/`VISION_TEST_SKIP_TIMING`，汇总退出码并给出慢机改善建议。
5. **安装即优化**（`scripts/install-to-web-profile.ps1`）：安装/更新流程末尾自动探测设备（调用 `node scripts/probe-device.mjs`，输出 JSON），slow 档把调优键（`ocr_pool_timeout_ms`/`ocr_pool`/`gpu_provider`/`test_timeout_factor`）写入 `~/.dsh/settings.yaml` 的 `vision-exp-tile` 分区——仅未显式设置的键（幂等）、写入前备份到同目录 `.bak-时间戳`、参数 `-NoDeviceTune` 跳过；无论与否都打印设备画像与推荐。找不到分区则提示不创建（不越权改其他文件）。
6. **超时收敛**：`ocr-local.js` 的 `gpuPoolTimeoutMs` 改读 `DSH_OCR_POOL_TIMEOUT`（并导出 `ocrPoolTimeoutMs`，兼容旧 `DSH_OCR_GPU_POOL_TIMEOUT`）；`pipeline.js` 两处写死 `120000` 改由 `ocrPoolTimeoutMs()` 提供；`index.js` 注册设置后异步设备探测，完成后重应用 env（auto+slow 无感简化）并回写只读画像。
7. **设备微基准算力评级（A）**：`src/device.js` 新增 `cpuWorkload`/`runCpuBenchmark`（纯 JS 轻量基准，预算 ~0.4s，归一化 0..2、1.0=参考机）；`probe` 增加 `benchScore`/`benchOpsPerSec`；`classifyTier` 用基准修正档位（<0.5 不判 fast、<0.3 且无 GPU 判 slow、基准不可用不影响原规则）。设置项 `device_benchmark`（默认 true）可关。校准依据：本机 16 核 normal 基准约 3e8 ops/s（参考分 ~1.0），弱阈值 0.5/0.3 按经验分档。
8. **电池/低功耗探测（B）**：新增 `detectPowerState`（win32 CIM 一次性查询 `BatteryStatus` / linux sysfs / mac pmset，1s 超时）；`probe` 增加 `onBattery`；放电中且档位 fast/normal 自动应用省电推荐（池并发 2、测试倍率×2、gpuProvider off；slow 推荐不变），经 `computeRecommendations` 合并。设置项 `device_power_probe`（默认 true）可关。
9. **ARM/WSL/容器降级（C）**：新增 `detectPlatformInfo`（os.arch + /proc/version 判 WSL + /.dockerenv|cgroup 判容器）与 `isPlatformDegraded`；受限环境自动应用保守默认（块格式 jpeg、池并发 2、gpuProvider off），经 `normalizeFromSettings` 落地 `cfg.format`。设置项 `platform_fallback`（auto/on/off，默认 auto）。
10. **慢网适配（D）**：slow 档自动把兴趣点并发降到 1（`DSH_INTEREST_CONCURRENCY`）、视觉 API 单请求超时放大到 600s（`normalizeFromSettings` 落地 `cfg.timeoutMs`，默认 300s×2）；仅未显式设置时生效（用户显式 > 推荐 > 默认）。设置项 `slow_net_adapt`（默认 true）可关。
11. **新设置字段汇总**：`device_benchmark`（bool）、`device_power_probe`（bool）、`platform_fallback`（enum auto/on/off）、`slow_net_adapt`（bool），设置/运行时/设置页双语全链同步；`probe-device.mjs` 输出新增 `onBattery`/`platformInfo`/`benchScore`/`detectMs` 字段，`self-check.mjs` 设备画像行新增 电池/平台/基准 三段。

### 验证

- `npm test`：**147/147** 全绿（原 111 + device.test.js 32 项（本轮从 13 扩展，含档位/推荐/基准/省电/平台/慢网等）+ suite-env.test.js 4 项 + client-bundle 清单补 performance_tier/platform_fallback）；
- `VISION_TEST_TIMEOUT_FACTOR=2 npm test`：147/147 仍全绿（倍率放宽窗口）；
- `VISION_TEST_TIMEOUT_FACTOR=8 npm test`：147/147 仍全绿（模拟最保守慢机 ×8，性能较好的本机也无超时误报）；
- `VISION_TEST_SKIP_TIMING=1 npm test`：146 通过 + 1 跳过（超时/时序敏感用例），0 失败；
- `node scripts/self-check.mjs --yes`：设备画像（本机 16 核/15.6GB/RTX 3050 Ti → normal，电池 交流 / 平台 x64 / 基准 0.96）→ 注入 120000/×1 → 147/147 通过；
- `node scripts/probe-device.mjs`：输出合法 JSON（含 onBattery/platformInfo/benchScore/detectMs）；本机 tier=normal、onBattery=false、platformInfo={x64,WSL否,容器否}、benchScore≈0.96，detectMs 总耗时 **440ms（≤2s）**、微基准 402ms、GPU 439ms、电源 416ms、平台 0ms；
- `install-to-web-profile.ps1` 的 slow 合并逻辑经临时 settings.yaml 验证：首次写入 4 调优键、已有键不覆盖、二次幂等、备份生成。

## v0.4.0（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能

1. **GPU 多设备加速（可选能力）**：
   - 新增 `DSH_OCR_ENGINE=gpu/auto` 引擎模式；新增设置项 `gpu_provider`（auto/cuda/dml/openvino/off）、`gpu_python`、`gpu_device`、`gpu_fallback`（设置页「图像识别」分区同步 4 新字段 + ocr_engine 枚举加 Gpu）；
   - **DirectML 一个引擎覆盖 NVIDIA/AMD/Intel 全厂商**（Windows）；CUDA（NVIDIA 极致）/OpenVINO（Intel）可选；`auto` 自动探测 → 不可用自动回退 CPU（`gpu_fallback` 可关）；
   - 独立 GPU venv（rapid_gpu_venv，onnxruntime-directml 1.24.4 + rapidocr 1.4.4），**不污染原 rapid_venv**；
   - **性能口径（务必如实）**：单进程实测 DML ~208ms vs CPU ~329ms（约 1.5×）；但在插件 4 并发进程池模式下 DML 反慢于 CPU（端到端 DML 2604ms vs CPU 1307ms/张）→ **定位为"可选加速能力（默认不启用）"**，文档表述为"按需开启；多厂商显卡兼容；自动回退保底"，**禁止宣称"GPU 总体提速 X 倍"**；
2. **引擎选择增强**：resolveEngine 支持 gpu/auto（默认 rapid 行为不变，向后兼容；设置页引擎下拉新增 Gpu/Auto）。
3. 其余：ocr-pool 支持按引擎区分超时（GPU 冷启动放宽）；runtime env 映射 4 个 DSH_OCR_GPU_* 键；worker 响应带 provider/gpu_device 调试信息。

### 验证

单测 **111/111** 全绿（原 96 + 新增 gpu.test.js 15 项）；E2E：离线真实 OCR（DSH_OCR_CACHE=0）4/4；真机 4 轮（含 pipeline/region_crop/preview 真 API，API 14/20）4/4；GPU 冒烟四路径（dml/自动回退/off/auto）全过。

---

## v0.3.1（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。** 补丁：修复 DSH 0.1.1-rc.2 兼容。

### 修复

1. **设置分区内容空白（DSH 0.1.1-rc.2 兼容）**：升级 DSH 到 0.1.1-rc.2 后，客户端 settingsScope 不再提供 load() 方法；client.js 原无条件调用导致分区渲染异常。修复：if (typeof scope.load === "function") scope.load()（与 picturereader 3.0.6 同款防御），rc.7/rc.2 双兼容。
2. **发布资产修正**：release workflow 打包清单补上 client.js（v0.3.0 的 zip 曾漏打包设置界面文件）；v0.3.0 资产补正（zip 已含 client.js）。
## v0.3.0（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能

1. **DSH Web 设置页「图像识别」分区**（client.js，浏览器半侧手写 ModuleLoader bundle）：可编辑插件全部配置，按「基础 + 高级折叠」分组展示；枚举用 select、布尔用 checkbox、数值用 number、文本用 text；保存=全部写入设置命名空间（数值转 number、布尔保留、空串 unset 走默认），重置=全部 unset 恢复默认。
2. **设置命名空间 + schemastery schema**（`src/settings-schema.js`）：`SETTINGS_NS='vision-exp-tile'`，`SettingsSchema` 用 z.object 描述全部 25 个字段（枚举、布尔、数值带 min/max/default、中文 description）；`SETTINGS_FIELDS` 为 client 与测试复用的扁平字段清单（key/type/labelKey/advanced/options/configKey/envKey）。
3. **运行时快照 + 热生效**（`src/runtime.js`）：`setRuntimeSource` / `getRuntimeConfig`（惰性重读实现改设置即生效）；`normalizeFromSettings` 把 snake_case 映射为 camelCase（base_url→baseURL 等）并经 `normalizeConfig` 归一化；优先级 = 工具参数(显式) > 设置页 > 默认值。
4. **env 映射**：OCR 引擎/池/缓存/前处理/手写路由/升级/兴趣点并发等以 `envFromSettings` + `applySettingsEnv` 写入 `DSH_*` 环境变量；仅在用户未显式设置时回退写入（用户 env 优先），设置改回默认时自动清理残留；池参数在下次工具调用生效。
5. **设置分区自动暴露**：dsh(`dsh-host-apiproxy` >=0.1.0-rc.7)已改用 `settings.describe()` 枚举注册的命名空间、无硬编码 `WEB_SETTINGS_NAMESPACES` 白名单，故只需 `register()` 成功注册、设置客户端即可枚举到「图像识别」分区，无需任何额外暴露文件。
6. **入口接入**（`src/index.js`）：注册命名空间（base 用 `toSettingsBase(configRaw)` 保证 configRaw 与设置页正确分层）；工具执行时经 `getRuntimeConfig()` 读最新配置（Proxy 转发）；新增 `debug` 调试日志钩子。

### 设计要点

- 新的设置命名空间独立于旧 configRaw（DEFAULT_CONFIG）；`toSettingsBase` 把 configRaw 的 camelCase 键转为 snake_case 作为第 2 层 base，避免 schema 默认值遮蔽用户显式写入的配置。
- 工具执行时经 `getRuntimeConfig()` 惰性读取，参数覆盖 cfg（显式参数优先语义不变）。

### 验证

单测 **93/93** 全绿（原 73 + 新增 20：`settings.test.js` 12 项 + `client-bundle.test.js` 5 项 + 第 93 项为既有套件累计）；覆盖设置 schema 键一致性、snake→camel 键映射、env 映射与热生效、运行时快照、client bundle 冒烟断言。

---

## v0.2.0（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能

1. **OCR 前处理管线**（`src/preprocess.js`，纯 pngjs 零新依赖）：深底白字图**自动反色**、低对比图 **Otsu 二值化**、手写/小字 **≤2× 放大**、百分位对比度拉伸；纯色/高对比印刷体自动跳过（零副作用），任何异常**返原图**；
2. **手写判别分流增强**：前处理 + **Paddle 高精度模型 `DSH_OCR_MODEL=server`**（PP-OCRv4_server_rec，下载失败自动回退）+ **手写/低置信/深底失败区域自动升级视觉 API 转录**（`DSH_OCR_UPGRADE=full|low|off`）；
3. **新工具参数 `preprocess`（auto/off）与 `upgrade`（full/low/off）**，向后兼容；
4. **手写判别分流（分类分流）**：每个文字区先判别是否手写——**预检视觉标记**（模型预检输出 `isHandwrite`）+ **本地启发式判别器**（`src/handwrite.js`，笔画连通域密度/行投影起伏/笔画占比）**smart 互验**（分歧时视觉优先）；**手写区**直接视觉 API 转录（逐行，看不清用（？）标注）；**非手写区**高效本地 OCR 且**不放大**（省 ~60% 耗时）；`DSH_OCR_HANDWRITE=smart|visual|local|off`。判别器 15 样本（5 手写+10 印刷）校准 **100% 分离**（手写 0.62-0.82 / 印刷 0.37-0.49，阈值 0.55）；端到端验证：手写页文字区引擎=**handwrite-api**（逐行转录）。

### 性能权衡

默认前处理使本地 OCR 单张 ~0.45s → ~1.0-1.27s（换取深底/手写增益；`DSH_OCR_PREPROC=0` 关闭）。

### 验证

深底图 0→4 行；手写 5 张 47→58 行（×1.23）；印刷体漏检 0/10；判别器 15 样本校准 100% 分离（阈值 0.55）；单测 73/73；真机 4 轮 API 14/20。

---

## v0.1.4（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

### 新功能与优化

1. **本地 OCR 缓存** — 同一张图重复识别直接命中（默认 48 小时），实测 20 张批量从 10.7s 降至 15ms；`DSH_OCR_CACHE=0` 关闭。
2. **重点区域并行识别** — 兴趣点默认 2 路并发（参数 `interest_concurrency` / `DSH_INTEREST_CONCURRENCY` 调 1-4），大图整卷等待时间再减一半。
3. **置信度自适应升级** — 本地 OCR 平均置信度低于 0.85 的区域，自动改用视觉 API 转录，更快与更准自动取舍。
4. **429/5xx 指数退避重试** — 限流/服务端异常自动重试（尊重 Retry-After），识别更稳定。
5. **跨块表格/长句对齐增强** — 分块后跨块文字行、表格单元格自动按行拼接还原，不再重复或遗漏。
6. **损坏图/HEIC 友好提示** — 无法识别的图片格式给出明确转图指引，替代裸报错。
7. **Windows OCR 中文指引** — 未安装中文 OCR 语言包时提供一键安装命令提示，并自动降级为视觉 API 转录。
8. **参数暴露** — `vision_tile_recognize` 支持 `ocr_engine`（auto/paddle/rapid/windows）与 `interest_concurrency`，缺省行为不变（向后兼容）。

### 性能

- 本地识别单张：3.3s → **0.18s**（≈18×）；20 张批量：66s → **8s**（≈8×）；缓存命中后批量 ≈ **0.02s**。
- 兴趣点并行后，整卷大图（多区域）等待时间再减约 50%。

### 版本形态

- **完整版** `vision-exp-tile-v0.1.4.zip`：本地识别最强（可选 paddle/rapid Python 环境，未装自动降级）。
- **无 Python 零配置版** `vision-exp-tile-v0.1.4-nopython.zip`：无需任何 Python 环境，本地识别使用系统自带 Windows OCR（常驻池），开箱即用。

---

## v0.1.3（2026-08-23）

**本次更新完全由 DeepSeek Harness 自主完成。**

1. **本地 OCR 常驻进程池** — 模型只加载一次、多核并行（默认 4 进程 × 4 线程）：20 张批量 66s → **8s**（≈8×），单张 3.3s → 0.18s。
2. **Windows OCR 常驻池** — 免 Python 零配置形态的本地识别核心（系统自带 WinRT，单张 ≈0.45s）。
3. **默认引擎快速化** — rapid 优先（比 paddle 快约 27 倍）；`DSH_OCR_ENGINE=paddle` 切回高精度。
4. **pipeline 多区域并发** — 文字区并行（`DSH_PIPELINE_CONCURRENCY` 可调，1=旧串行）。
5. **引擎探测缓存 60s + 池崩溃自愈/超时重启/进程退出兜底清理**。
6. **双形态发布** — 完整版（venv 可选）+ 无 Python 零配置版（剔除 `ocr-worker.py`，自动降级 Windows OCR）。

---

## v0.1.2（2026-08-22）

**本次更新完全由 DeepSeek Harness 自主完成。**

1. **修复 `vision_region_crop` recognize=true 崩溃** — 未定义 `maxTokens` 引用（ReferenceError），修复后真机转录正常。
2. **预检/区域识别 maxTokens=8192 并全链透传** — 解决复杂图"思考耗尽预算 → 空正文"问题。
3. **错误信息健壮化** — 不再输出 `[object Object]`，展示真实取消/异常原因。
4. **空正文自动重试**（+4096/+8196 递增，上限 65536）。
5. **预检 JSON 失败兜底** — 退化为中文描述输出，不中断流程。
6. **测试环境修复**：CI Node 20 兼容（test 脚本）+ 测试泄漏隔离。

---

## v0.1.1（2026-08-22）

**首发纯净版：大图 800×800 无损切块识别（零依赖第三方 DSH 插件）。**

- 三个工具：`vision_tile_split`（切块）/ `vision_tile_recognize`（直连 DeepSeek 视觉 API 识别聚合）/ `vision_region_crop`（区域裁剪识别）；
- 核心思路：官方会把大图压缩到 ≈800×800 总像素 → 主动切成 800×800 无损块（每块 ≤384 token、不被二次压缩）+ 坐标标注 + 分块聚合逻辑；原图 ≤800 不切；
- 返回结构化答案；**不统计 token、不计算费用**；MIT 开源。
- 本版本由 DeepSeek Harness 全流程编写（初版需求来自用户：为 deepseek-v4-flash-vision-exp 定制）。

---

## v0.1.0（2026-08-22）

**首个草案版本（技术验证版 0.1.0）。**

- 完成可行性验证：DeepSeek 视觉 API 直连 + 分块识别方案成立；
- 确立三种策略框架：smart（模型编排）/ full（全图网格切块）/ 区域裁剪识别；
- 明确官方规则：图片仅限 user 消息、384×384 放大、≈800×800 缩放、每张 ≤384 token；
- 为后续纯净版（v0.1.1）与完整版构建奠定基础。


