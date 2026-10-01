## 写在前面

这个插件是我用 **DeepSeek Harness** 写的——我本人没有写代码相关的知识，这个插件只是提供一个思路，外加自用。

**DeepSeek-v4-flash-vision-exp** 发布后，官方会把大图压缩到 **800×800** 像素，为了不丢失图片细节，就让 DeepSeek 帮我写了这个插件。

各位随意取用：有问题可以提交 **Issue**（如果能自己改的话就更好了——你提交了 Issue，我也只能给 DeepSeek 看然后让他自己改；我本人尝试过多次，均未学会任何写代码的能力，也是乘上 **AI** 的东风，让我有了开发插件的能力）。

> **本次更新（v0.5.0 正式版）**，内容：
> ① **适配 DSH 0.2.0**：恢复 `dsh.bundle.patch`（→ `cordis.patch.yml`，`main` 指回 `src/index.js`）——0.2.0 的插件装载机制仍是 Cordis bundle，插件现可在其上被识别与装载；同时保留 dsh-std 标准形态（`dsh-plugin.json` + `std-facet.js`）备用。
> ② **Web 设置页回归**：DSH 0.2.0 移除了旧的 `settingsScope` 客户端接口，旧设置页无法再用；本版按新机制（插件配置的 volatile 字段 + 客户端 `configForms`）重写设置页——在 Web 侧栏 **「插件」页**里出现「**图像分块识别**」设置卡片，**覆盖全部 37 项配置**，按六组呈现：识别与接口 / 切块与输出 / 性能与 OCR 池 / GPU 加速 / 设备适配 / 调试与测试；**改完点「保存」即时生效**（可「全部恢复默认」）。
> ③ **配置来源优先级**：设置页填写值 > 配置文件 `~/.dsh/vision-exp-tile.json` > 环境变量 > 内置默认（留空即回落下一层，三种方式可混用）。
> ④ **取消 picturereader 适配**：移除共存探测 / 分工引导 / 配置继承 / venv 复用，插件**完全独立运行**。
> ⑤ **验证**：`npm test` **176/176**；三套冒烟全过（标准入口 15 / Cordis 入口 20 / 设置页 19）；真机实测（DSH 0.2.0-rc.2）：三工具可用、切块与识别端到端通过、设置页可编辑保存并落盘。
>
> **开发过程版（v0.5.0-rc.1 ~ rc.4，仅存档）**：rc.1 生态化改造（`dsh-plugin.json` + `std-facet.js`、设置文件化）；rc.2 取消 picturereader 适配；rc.3 双形态（跟随 0.2.0 装载机制）；rc.4 设置界面回归（新机制重写 + 37 项全覆盖）。各版详情见 CHANGELOG。

# vision-exp-tile ◆ 为 deepseek-v4-flash-vision-exp 定制的大图智能识图插件

> **简介**：DSH（DeepSeek Harness）插件——大图智能识别：整图预检 → 本地 OCR + 像素网格转录文字 → 兴趣点区域按比例切块（最长边 800）让视觉模型精读 → 自动汇总；支持模型编排（smart）/ 全自动（pipeline）/ 全图网格（full）三种策略。为 deepseek-v4-flash-vision-exp 量身定制，识别大图"看不清"的最后一公里。

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![version](https://img.shields.io/badge/vision--exp--tile-v0.5.0--rc.4-orange.svg)](#)
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-plugin-purple.svg)](#)

> 独立 DSH 插件：**零依赖任何第三方 DSH 插件**（picturereader 等均未使用，仅用纯官方 DSH 服务 + 可选开源 OCR 环境）。把大图切成 **800×800 无损小块**（官方缩放规则的"甜蜜点"：块在模型侧**不被降采样**、每块**≤384 token**），携带**坐标标注 + 分块聚合逻辑**直接调用 DeepSeek 视觉 API 完成识别与聚合，返回结构化答案（**不代为统计/不显示 token 与费用，实际计费以 DeepSeek 官方 API 平台账单为准**）。

## 🎬 宣传片（v0.4.0）

> [▶️ 观看宣传片（128 秒 · 带 BGM · 含致谢页）](https://github.com/Nicholaskin/vision-exp-tile/releases/download/v0.4.0/vision-exp-tile-v0.4.0-promo-bgm.mp4)
> 视频背景音乐：《春景故人来》—— 铁痕电台-MSR × Kirara Magic；DeepSeek 官方鲸鱼形象（deepseek.com）。

## 一、为什么要 800×800

官方文档（api-docs.deepseek.com/guides/vision）规定：每张图进模型前自动缩放——总像素 < ~384×384 放大，更大的图按长宽比缩小到 **≈800×800 总像素**，**每张图 token 封顶 384**。

- 块边长 800 → 处于"不缩放"边界：**细节零损失**，且每块恰好 ≤384 token；
- 原图 ≤800×800 → 不切分，原样识别；
- 原图更大 → 切成 800×800 网格（边缘块取实际尺寸，不补白不放大），全部 1:1 进模型。

## 二、安装与挂载

**双形态（v0.5.0-rc.3 起）**：插件同时携带两套装载入口，互不干扰——

| 形态 | 声明 | 用途 |
|---|---|---|
| **Cordis bundle**（当前可用） | `dsh.bundle.patch` → `cordis.patch.yml`；`main` = `src/index.js` | **DSH 0.2.0 实际支持的装载路径**（宿主按 `dsh.profile.bundles[]` 顺序叠加各 bundle 的 patch） |
| **dsh-std 标准**（备用） | `dsh-plugin.json` + `std-facet.js`（子导出 `./std-facet`） | 协议生态路径，等宿主内置该装载器后启用，无需改代码 |

```powershell
# 1. 复制/链接插件源码到 DSH 插件目录
#    ~/.dsh/plugins/vision-exp-tile          ← 插件源码（含 cordis.patch.yml / dsh-plugin.json / std-facet.js）

# 2. 目标 profile ~/.dsh/profiles/<name>/package.json：
#    "dependencies": { "vision-exp-tile": "link:C:/Users/<你>/.dsh/plugins/vision-exp-tile" }
#    "dsh": { "profile": { "bundles": [ ...现有项..., "vision-exp-tile" ] } }   ← bundle 形态需进 bundles 白名单

# 3. 在 profile 目录 pnpm install，然后重启 DSH 生效
#    （DSH 0.2.0 自带插件管理器，也可用它装载与开关）
```

> **实测说明（2026-10-01，宿主 0.2.0-rc.2）**：宿主装载机制为「按 `dsh.profile.bundles[]` 顺序，叠加各 bundle 包 `dsh.bundle.patch` 指向的 patch 文件」；宿主程序内**无 dsh-std 生态装载器**（对 app.asar 全量扫描：`tools.dsh` / `dsh-plugin.json` / `dshPlugin` / `@dsh-std` 均 0 命中），故采用上表第一种形态即可用；第二种形态原样保留。本插件**不声明任何 `@deepseek-ai/*` 运行时依赖**（入口只用 `node:` 内置与相对模块），因此不会触发 0.2.0 新增的「插件-宿主版本兼容性校验」。`desktop` profile 由 Electron 应用独占管理，装载请走其插件管理器界面。

**隔离测试**（推荐）：不要直接改正式 web profile，新建测试 profile：

```powershell
# 测试 profile：~/.dsh/profiles/vision-test
dsh --profile vision-test --port 3081
# 浏览器打开 http://127.0.0.1:3081 即可测试；正式 profile 与本次改动零关联。
```

### 纯净 DSH 快速上手（无任何其它插件，纯官方 DSH）

本插件**不依赖** picturereader / paddle / rapid / 任何第三方插件；纯净 DSH 三步即可用：

```powershell
# ① 安装依赖（在插件目录）
npm install

# ② 配置 API key（必做！）——插件从"系统环境变量"读取；DSH 凭据界面存的 key 不进环境变量
setx DEEPSEEK_API_KEY "sk-你的key"        # Windows；Linux/macOS 写入 ~/.bashrc 等

# ③ 新开终端重启 DSH（新终端才会加载 setx 的环境变量）
dsh web
```

- 纯净 DSH 上：`vision_tile_split` / `vision_region_crop` / `full` / `pipeline` **全功能可用**（pipeline 无 OCR 环境时自动降级：Windows 用系统 OCR，非 Windows 转交视觉 API 转录）；
- `smart`（默认）同样可用：文字区域自动走视觉直读（本插件自带能力），零依赖第三方插件；
- 可选增强（非必需）：装 `paddle`/`rapid` 本地 OCR 环境后，pipeline 的中文转录质量最佳（自动探测 `$HOME/paddle_venv` 等，路径可用 `DSH_PADDLE_PYTHON`/`DSH_RAPID_PYTHON` 覆盖）。

## 三、工具用法（模型调用）

### 1. `vision_tile_split` —— 只切图 + 标注 + 聚合逻辑

```json
{
  "file_path": "D:\\img\\截图.png",
  "block_size": 800,
  "cut_threshold": 800,
  "overlap": 0,
  "out_dir": ""
}
```

返回（模型可见文本）：切块结果 → 块目录 → 坐标清单（编号/行列/原图坐标/尺寸）→ 全局布局参考图（overview）→ **分块聚合逻辑**（识别顺序、坐标定位、跨块合并、禁止编造、输出要求）。块文件名自带坐标：`截图_r0_c1_x800_y0_800x800.png`。

- `cut_threshold=800`：长边 ≤800 直接返回"无需切分"，满足"小图不裁"；
- `overlap=64`：推荐用于文字/表格密集图（防跨块切断）；
- `format=png`（默认无损）/`jpeg`；
- `rotate=0/90/180/270`：识别前先顺时针旋转整图（默认 0）。**图片横倒/倒置、模型"误判方向"时使用**——切图、坐标与 overview 均基于旋转后的图像（需 sharp）。

### 2. `vision_tile_recognize` —— 智能识图（v0.1 多方案结合）

```json
{
  "file_path": "D:\\img\\大图.png",
  "strategy": "smart",
  "question": "这张图里有什么内容？请完整描述"
}
```

**`strategy` 三种模式：**
- **`smart`（默认·模型编排）**：先**整图预检**（`detail:'low'` 512×512 缩略，≈0.005 元）→ 返回：`有无文字 / 文字区域(1~3 个 0..1 相对矩形) / 兴趣点区域(模型判断的重点) / 整图概要`。模型按流程继续：重点不明确→先问用户；**有文字**→`vision_region_crop(recognize=true)` 视觉直读转录（本插件自带能力）；**兴趣点**→`vision_region_crop(recognize=true)` 逐点识别；最后汇总。**无文字**→整图概要 + 兴趣点区域识别，不做 OCR（注：本插件不调用任何第三方 DSH 插件的工具）。
- **`pipeline`（插件全自动）**：一次调用完成预检 → 本地 OCR（`ocr_engine`：auto/paddle/rapid/windows，默认 auto 自动降级）+ 像素网格 → 兴趣点按比例裁剪（最长边 800）识别 → 模板汇总 → 全部明细落盘系统临时目录（precheck.json / ocr.txt / pixel-grids.txt / 区域 PNG / answer.md）。无交互：重点不明时结果中说明。
- **`full`（原全网格）**：先 overview 整图缩略图 → 800×800 全图切块识别（`mode=auto/single/layered`、`block_size`、`json`、`out_dir` 等原参数），用于整页材料逐块完整转录。

其它通用参数：`rotate`（0/90/180/270 转正）、`max_tokens`；
**健壮性**：模型只思考未输出正文（content 为空）时自动放大 max_tokens 重试一次；仍为空报出 finish_reason 与思考摘要。
**返回**：预检清单/答案 + 统计；不代为统计/不显示 token 与费用，实际计费以 DeepSeek 官方 API 平台账单为准。

### 3. `vision_region_crop` —— 兴趣点/文字区域裁剪识别

- 参数：`file_path`（必填）、`rect`（必填 `[x0,y0,x1,y1]`，支持 0..1 相对或像素坐标自动识别）、`rotate`、`max_edge`（默认 800，**最长边 800 保比例**（4:3→800×600）；`0`=1:1 不缩放供本地 OCR）、`recognize`（默认 true=视觉 API 识别该区域；false=仅落盘 PNG，供本地 OCR 工具处理）、`question`、`out_dir`（默认系统临时目录）；
- 返回：区域图路径、输出尺寸、原图裁剪矩形（像素）、（recognize=true 时）区域描述。

### 4. 配置项（插件级）

| 配置 | 默认 | 说明 |
|---|---|---|
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | API key 环境变量名（**密钥不落配置**） |
| `baseURL` | `https://api.deepseek.com` | OpenAI 兼容端点 |
| `model` | `deepseek-v4-flash-vision-exp` | 模型名 |
| `blockSize` / `cutThreshold` | 800 / 800 | 块边长 / 切分阈值 |
| `overlap` | 0 | 相邻块交叠像素 |
| `groupSize` | 40 | 分层聚合每组的块数 |
| `mode` / `json` | auto / false | 识别模式 / 输出格式 |
| `format` / `quality` | png / 90 | 块编码 |
| `ocrPoolTimeoutMs` | `120000` | OCR 池单请求超时（ms，20000..1200000；慢机可调大） |
| `performanceTier` | `auto` | 性能档位：auto=自动探测（默认）/fast/normal/slow（非 auto=用户强制，不应用自动推荐） |
| `testTimeoutFactor` | `1` | 测试超时判定倍率（1..8；推荐 4=slow 档默认，手动最保守 8；慢机可调大，降低时序抖动失败） |
| `testSkipTiming` | `false` | 是否跳过时序敏感断言（用户声明跳过测试） |
| `deviceBenchmark` | `true` | 设备微基准算力评级（A）；false=跳过基准，档位只按 CPU/内存/GPU |
| `devicePowerProbe` | `true` | 电池/低功耗探测（B）；false=不探测（不应用省电推荐） |
| `platformFallback` | `auto` | ARM/WSL/容器平台降级（C）：auto=按环境自动降级 / on=强制降级 / off=关闭 |
| `slowNetAdapt` | `true` | 慢网适配（D）；false=slow 档不降兴趣点并发/不放大 API 超时 |

## 隐私与数据说明

- 识别时图片以 **base64 直连 DeepSeek 官方视觉 API**（默认 `https://api.deepseek.com`），按官方账单计费；请勿上传敏感/隐私材料，或自行脱敏。
- pipeline / smart 过程会在**系统临时目录**落盘明细（`precheck.json` / 区域 PNG / `ocr.txt` / `answer.md` 等），默认在系统临时目录；可用 `out_dir` 指定目录。
- 插件提供**过期清理**：默认清理超过 **24 小时**的旧临时目录/区域图（仅限插件自己的前缀，不触碰用户指定 `out_dir`）。

## 四、成本参考（仅供了解，插件本身不计算）

每块 800×800 = 384 token（封顶，官方规则）。以下按官方价（输入命中 0.1 / 未命中 3 / 输出 9 元·百万 tokens）估算，**实际计费以 DeepSeek API 平台账单为准**：

| 原图尺寸 | 网格 | 块数 | 图片输入 token | 输出 token(估) | **费用(约)** |
|---|---|---|---|---|---|
| ≤800×800 | 1×1 | 1 | 384 | 400 | **≈0.005 元** |
| 1600×1600 | 2×2 | 4 | 1,536 | 700 | **≈0.011 元** |
| 2400×1600 | 3×2 | 6 | 2,304 | 900 | **≈0.015 元** |
| 4000×3000 | 5×4 | 20 | 7,680 | 1,600 | **≈0.035 元** |
| 6000×4500 | 8×6 | 48 | 18,432 | 2,400 | **≈0.075 元** |
| 8000×6000 | 10×8 | 80 | 30,720 | 3,200 | **≈0.12 元** |

## 五、验证清单（功能自测）

> **推荐用 `npm run selfcheck`**（即 `node scripts/self-check.mjs`）：先自动识别设备（CPU/内存/GPU → 档位），再问"是否运行全量测试？"（一般推荐运行，因为要根据实测确认插件可用性），并按设备档位自动注入超时/倍率跑测试。慢机仍超时？在设置页「图像识别→高级」调高 `ocr_pool_timeout_ms`（或设 `performance_tier=slow`），或开启 `test_skip_timing` 声明跳过时序敏感断言（对应环境变量 `VISION_TEST_SKIP_TIMING=1`）。

1. `npm test`：网格/坐标/提示模板/mock API 全部通过（新增 device/suite-env 纯逻辑测试）；
2. `dsh --profile vision-test --dump-config`：输出树中应出现 `vision-exp-tile` 行；
3. 启动 `dsh --profile vision-test --port 3081` → 新会话 → 工具列表出现 `vision_tile_split` / `vision_tile_recognize`；
4. 上传一张 4000×3000 测试图 → 调 `vision_tile_split` → 检查输出目录 20 块 + overview + 坐标清单；
5. 调 `vision_tile_recognize`（需环境变量 `DEEPSEEK_API_KEY` 有值）→ 检查结构化识别答案与统计（不显示 token/费用）。

## 六、开发与测试工作流（双环境）

插件的任何改动都先在**隔离测试实例**验证，确认无误后再让**正式实例**生效——两者共用同一份源码（junction），互不干扰。

| 端口 | 实例 | 用途 |
|---|---|---|
| **3080** | `web` profile（正式） | 日常使用（生产环境） |
| **3081** | `vision-test` profile（隔离测试） | 改动验证、实验，零风险 |

### 标准流程（改插件源码时）

1. **在 3081 验证**（改动后）：
   ```powershell
   # 一键：校验挂载 + 启动测试实例（自动拆建 junction）
   powershell -ExecutionPolicy Bypass -File .\scripts\run-test-profile.ps1
   # 浏览器打开 http://127.0.0.1:3081 → 新会话问"列出工具" → 真实跑一张图
   ```
2. 3081 通过后，**重启 3080 让正式实例加载新代码**（`dsh web` 重启即可；宿主插件不热重载）；
3. 改动即时性：源码经 junction 直连 → **重启对应实例即生效**，无需重新安装/构建。

### 依赖版本约束（重要）

- 插件的 `sharp` 版本必须与 DSH 内置 sharp **一致**（当前两者均为 **0.35.3**）；
- 若不一致，同进程会出现两个 sharp 原生库，报 `colourspace: parameter space not set` 类错误；
- 升级 DSH 后如遇该错误：`npm install sharp@<DSH的sharp版本>`（DSH 版本见 `node_modules\@deepseek-ai\dsh\node_modules\sharp\package.json`）。

### 环境重置

- 关闭 3081：`Ctrl+C`（或联系杀掉进程）；
- 彻底清理测试环境：删除 `~/.dsh/profiles/vision-test` 与 `~/.dsh/plugins/vision-exp-tile`（正式 profile 不受影响）；
- 正式环境卸载/回滚：`powershell -File .\scripts\install-to-web-profile.ps1 -Rollback`（自动还原 package.json 备份）。

## 七、依赖与适配（对其他用户环境）

**最低要求（人人可跑）**：DSH 基础环境（`tools`/`fs` 服务，官方 dsh-base 自带）· Node ≥ 20 · DeepSeek API key（环境变量 `DEEPSEEK_API_KEY`）· `npm install`（sharp/pngjs/jpeg-js，sharp 有全平台预编译二进制）。

| 能力 | 依赖 | 缺失时的表现 |
|---|---|---|
| 切块 / 预检 / 兴趣点识别 / 像素网格 | 插件自带（**pixelgrid 自实现，不依赖任何其它插件**） | ✅ 始终可用 |
| pipeline 本地 OCR | 探测本机 **paddle_venv / rapid_venv**（`$HOME` 下，路径可用 `DSH_PADDLE_PYTHON`/`DSH_RAPID_PYTHON` 覆盖）→ 无则用 **Windows OCR**（WinRT，零依赖） | ✅ 自动降级；仍无 OCR（如 Linux 未装 venv）→ **自动转交视觉 API 转录该区域**，pipeline 不中断 |
| smart 模式文字识别 | 本插件自带（`vision_region_crop` 视觉直读转录） | ✅ 始终可用，零依赖第三方插件 |
| 其它图像插件 | **无**（v0.5.0 起取消 picturereader 适配） | ✅ 本插件完全独立：不探测其它插件是否在场、不在工具描述追加任何分工引导、不继承其它插件的视觉端点或 venv 配置；也不读改任何第三方插件的文件 |

**结论**：本插件**零依赖任何第三方 DSH 插件**（picturereader 等均未使用）；paddle/rapid 是用户可选安装的开源 OCR 环境（Apache-2.0，仅环境探测，非插件依赖），装了中文转录质量最好，不装也完全可用。

## 八、已知边界

- 插件直连官方 API，不受 DSH 内置 deepseek 适配器 text-only 限制；结果以**文本**回流会话；
- 官方限制：图片仅可在 user 消息（已遵守）；单请求 ≤600 图（本插件默认 ≤240 更保守）；base64 请求体 ≤48MiB（超预算自动提示分批/转 JPEG）；
- "完美识别"是质量目标：块数越多难度越高，分层聚合显著缓解；跨块被切断的细线级元素仍可能合并出错（建议 `overlap=64`）；
- 全自动 pipeline 无交互通道：预检"重点不明确"时会在结果中说明，可改用 smart（模型先问你）或 `vision_region_crop` 指定坐标；
- **arm64/WSL/容器环境**建议开启保守预设（默认已 `platform_fallback=auto` 自动降级：块格式 jpeg、OCR 池并发 2、不自动开 GPU）；如确需更强算力可设 `platform_fallback=off` 或显式覆盖。

### 用户如何安装发布版

下载 Release 里的 `vision-exp-tile-vX.Y.Z.zip`，解压后按前面"二、安装与挂载"步骤操作（放到 `~/.dsh/plugins/vision-exp-tile` + profile 挂 `link:` 依赖），或直接从源码仓库 `git clone` 后同样挂载。

## 许可

MIT © vision-exp-tile contributors

---

如果这个插件对你有帮助，欢迎点个 ⭐ **Star** 支持一下～（你的支持就是持续更新的动力）

