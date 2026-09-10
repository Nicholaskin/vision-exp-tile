## vision-exp-tile v0.4.3

> 仓库迁移说明：本仓库由原账号 `Nicholas023`（已被 GitHub 停用）迁移至 **`Nicholaskin`** 重新发布。
> v0.4.3 是迁移后发布的第一个版本，包内 `package.json` / README 的仓库地址已指向新账号，开箱可用。

**本次更新完全由 DeepSeek Harness 自主完成。**

### 背景与目标

v0.4.2 之后进入「仅本地同步、暂不发布」收尾：把工作区已新增/修正的代码与文档同步到 v0.4.3 版本号，完成 README/CHANGELOG 更新块对齐。内容包括：修正 `package.json` 仓库元数据、统一计费表述（避免「不统计」等易误读措辞）、补充「隐私与数据说明」、为 pipeline/region_crop 增加过期临时产物清理。

### 新功能与改动

1. **仓库元数据修复**：`package.json` 的 `repository` / `homepage` / `bugs` 由占位作者/仓库地址改为实际仓库地址；随仓库迁移至 `Nicholaskin/vision-exp-tile`。
2. **计费表述诚实化**：README、工具描述、脚本注释统一为「不代为统计/不显示 token 与费用，实际以 DeepSeek 官方 API 平台账单为准」，替换旧的「不统计 token / 不计算费用」表述。
3. **新增「隐私与数据说明」**：图片以 base64 直连 DeepSeek 官方视觉 API、按官方账单计费；pipeline/smart 过程明细落盘系统临时目录（可用 `out_dir` 指定）；插件默认清理超过 24 小时的旧临时目录/区域图（仅插件自身前缀，不触碰用户指定 `out_dir`）。
4. **过期清理模块**：新增 `src/temp-cleanup.js`（`cleanupOldTempArtifacts`：扫描系统临时目录，按 mtime 清理 >24h 的 `vision-tile-pipeline-*` 目录与 `region-*.png` / `vision-tile-ocr-*.png` 文件；支持注入 `now`/`ttlMs`/`tmpRoot`/`excludePaths`；异常静默容错），并在 `src/pipeline.js` / `src/index.js`（region_crop 路径）结束时调用。
5. **测试**：新增 `tests/temp-cleanup.test.js`（5 项：默认不删新鲜文件、过期前缀清理且非前缀保留、注入 now/ttlMs 可控、excludePaths 保护、异常路径不抛），并加入 `package.json` 的 `test` 显式列表。

### 验证

- `npm test`：**168/168 全绿**（原 163 + temp-cleanup.test.js 5 项）；
- 打包：完整版 `vision-exp-tile-v0.4.3.zip` + 零配置版 `vision-exp-tile-v0.4.3-nopython.zip`（附件已附在本 Release）。

### 安装

1. 下载附件 `vision-exp-tile-v0.4.3.zip`（或零配置版 `-nopython.zip`），解压到任意目录；
2. 在该目录执行 `npm install`（零配置版同样需要，仅少了本地 Python OCR 引擎）；
3. 按 README 的「安装与挂载」章节把插件挂到 DSH profile；
4. 需要本地 OCR 时可再装 rapid/paddle venv；不装也行——本地识别自动降级为 Windows OCR 常驻池，识别仍可走视觉 API。

> 本插件**不代为统计、不显示 token 与费用**；实际计费以 DeepSeek 官方 API 平台账单为准。
