# ===========================================================================
# release-manual.ps1 — 生成「手动发布」用的三类产物（v0.4.3+）
#
# 用途：旧 GitHub 账号已停用，需在新账号（Nicholaskin）重新发布时使用。
#       与 release-pack.ps1 的区别：
#         - 额外产出「源码包 zip」（给 GitHub 网页上传用，白名单制、不含内部文档/视频）
#         - 产出 SHA256 清单（发布后核对附件有没有传坏）
#         - 产出 Release 说明模板（可直接粘贴到 GitHub 的 Release notes 栏）
#
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\release-manual.ps1
# 输出（默认到 <项目根>\发布包\v<版本>\，可用 -OutDir 覆盖）：
#   vision-exp-tile-v<版本>.zip           完整版（Release 附件）
#   vision-exp-tile-v<版本>-nopython.zip  零配置版（Release 附件）
#   vision-exp-tile-v<版本>-source.zip    源码包（网页上传 / 本地解压后 push）
#   SHA256SUMS.txt                        三个包的校验值
#   Release说明-v<版本>.md                  Release notes 模板
#   ../../发布指引/手动发布指引-v<版本>.md   分步发布指引
# 注：本脚本写 .ps1 必须带 UTF-8 BOM（PS 5.1 读无 BOM 的 UTF-8 会乱码）。
# ===========================================================================

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 读取版本号（显式 UTF8：PS 5.1 默认按 ANSI 读会乱码；package.json 不能加 BOM）
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
if (-not $ver) { throw 'package.json 缺少 version 字段' }

$outDir = Join-Path $root "发布包\v$ver"
$noteDir = Join-Path $root '发布说明'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
New-Item -ItemType Directory -Path $noteDir -Force | Out-Null

Write-Host "[1] 版本：v$ver" -ForegroundColor Cyan
Write-Host "[2] 输出目录：$outDir" -ForegroundColor Cyan

# --- 打包清单 ---------------------------------------------------------------
# 插件包（Release 附件）：与 release-pack.ps1 保持一致，另加 CHANGELOG.md（用户能在包内看更新历史）
$pluginInclude = @('src', 'tests', 'scripts', 'client.js', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', '.gitignore', 'cordis.patch.yml')

# 源码包（网页上传用）：仓库白名单——只放「应该进 GitHub 仓库」的东西。
# 内部文档（踩坑记录 / 会话恢复快照 / 发布总结 / 视频工程 / 历史版本目录）一律不进。
$sourceInclude = @(
  'src', 'tests', 'scripts', '.github', 'client.js', 'README.md', 'CHANGELOG.md',
  'LICENSE', 'package.json', 'package-lock.json', '.gitignore', 'cordis.patch.yml',
  'social-preview.png', 'v0.4.0-视频介绍文本.md'
)

# 通用清理：Python 字节码缓存、测试临时产物、dist 里不该带的东西
function Clear-Junk {
  param([string]$Stage)
  foreach ($rel in @('src\__pycache__', 'tests\__pycache__', 'scripts\__pycache__', 'scripts\e2e-out', 'tmp', 'dist', 'node_modules')) {
    $p = Join-Path $Stage $rel
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  - 清理 $rel" -ForegroundColor Yellow }
  }
  Get-ChildItem $Stage -Recurse -File -Include '*.pyc', '*.log', '.tmp' -ErrorAction SilentlyContinue | Remove-Item -Force
}

# 通用打包：stage 目录 -> zip
function New-StageZip {
  param([string]$Stage, [string]$ZipName)
  Clear-Junk -Stage $Stage
  $zip = Join-Path $outDir $ZipName
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $Stage '*') -DestinationPath $zip -CompressionLevel Optimal
  Remove-Item $Stage -Recurse -Force
  Write-Host ("  -> {0}（{1} KB）" -f $ZipName, [math]::Round((Get-Item $zip).Length / 1KB, 1)) -ForegroundColor Green
  return $zip
}

# 从白名单复制文件到 stage
function Copy-WhiteList {
  param([string]$Stage, [string[]]$List, [string[]]$Exclude = @())
  New-Item -ItemType Directory -Path $Stage -Force | Out-Null
  foreach ($item in $List) {
    $src = Join-Path $root $item
    if (-not (Test-Path $src)) { Write-Host "  ! 跳过（不存在）：$item" -ForegroundColor Yellow; continue }
    Copy-Item $src (Join-Path $Stage $item) -Recurse -Force
  }
  foreach ($ex in $Exclude) {
    $p = Join-Path $Stage $ex
    if (Test-Path $p) { Remove-Item $p -Recurse -Force; Write-Host "  - 剔除 $ex" -ForegroundColor Yellow }
  }
}

$stageBase = Join-Path $env:TEMP "vet-release-$ver"
if (Test-Path $stageBase) { Remove-Item $stageBase -Recurse -Force }

Write-Host "[3] 打包插件完整版…" -ForegroundColor Cyan
Copy-WhiteList -Stage (Join-Path $stageBase 'full') -List $pluginInclude
$zipFull = New-StageZip -Stage (Join-Path $stageBase 'full') -ZipName "vision-exp-tile-v$ver.zip"

Write-Host "[4] 打包插件零配置版（nopython）…" -ForegroundColor Cyan
Copy-WhiteList -Stage (Join-Path $stageBase 'nopy') -List $pluginInclude -Exclude @('src\ocr-worker.py')
$zipNoPy = New-StageZip -Stage (Join-Path $stageBase 'nopy') -ZipName "vision-exp-tile-v$ver-nopython.zip"

Write-Host "[5] 打包源码包（网页上传用）…" -ForegroundColor Cyan
Copy-WhiteList -Stage (Join-Path $stageBase 'src') -List $sourceInclude
$zipSrc = New-StageZip -Stage (Join-Path $stageBase 'src') -ZipName "vision-exp-tile-v$ver-source.zip"

# --- 校验值清单 -------------------------------------------------------------
$sums = @()
foreach ($z in @($zipFull, $zipNoPy, $zipSrc)) {
  $h = (Get-FileHash $z -Algorithm SHA256).Hash
  $sums += ('{0}  {1}' -f $h, (Split-Path -Leaf $z))
  Write-Host ("  {0}  {1}" -f ($h.Substring(0, 16) + '…'), (Split-Path -Leaf $z))
}
$sumFile = Join-Path $outDir 'SHA256SUMS.txt'
Set-Content -Path $sumFile -Value $sums -Encoding UTF8
Write-Host "[6] 校验值：$sumFile" -ForegroundColor Green

# --- 列出包内文件（供回报与自查） -------------------------------------------
Add-Type -AssemblyName System.IO.Compression.FileSystem
$listing = @()
foreach ($z in @($zipFull, $zipNoPy, $zipSrc)) {
  $za = [System.IO.Compression.ZipFile]::OpenRead($z)
  $listing += ('== {0} （{1} 个条目）' -f (Split-Path -Leaf $z), $za.Entries.Count)
  $listing += ($za.Entries | ForEach-Object { '   ' + $_.FullName })
  $za.Dispose()
}
Set-Content -Path (Join-Path $outDir '包内容清单.txt') -Value $listing -Encoding UTF8

# --- 从 CHANGELOG.md 提取各版说明（GitHub Release notes 直接粘贴用） --------
# 与 .github/workflows/release.yml 的提取规则一致：前缀匹配 "## vX.Y.Z（"，取到下一个 "## v" 段为止。
# 好处：Release 栏内容 = CHANGELOG.md 原样段落，不会因为手工复制而走样。
$changelog = Get-Content (Join-Path $root 'CHANGELOG.md') -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
# 当前发布版：优先用精修稿 scripts\release-notes-v$ver.md（脚本与说明同源，改说明只改这个文件）
$handWrittenNote = Join-Path $PSScriptRoot "release-notes-v$ver.md"
if (Test-Path $handWrittenNote) {
  Copy-Item $handWrittenNote (Join-Path $noteDir "Release说明-v$ver.md") -Force
  Write-Host ("[7] 已生成 Release 说明：Release说明-v{0}.md（精修稿）" -f $ver) -ForegroundColor Green
}
if ($changelog) {
  $lines = $changelog -split "?
"
  $targets = @('0.4.2', '0.4.1', '0.4.0')   # 历史版本从 CHANGELOG 提取；当前版见上面的精修稿
  foreach ($t in $targets) {
    $buf = New-Object System.Collections.Generic.List[string]
    $take = $false
    foreach ($line in $lines) {
      if ($line.StartsWith('## v')) {
        if ($line.StartsWith("## v$t（") -or $line.StartsWith("## v$t(")) { $take = $true; continue }
        elseif ($take) { break }
      }
      if ($take) { $buf.Add($line) }
    }
    if ($buf.Count -gt 0) {
      while ($buf.Count -gt 0 -and $buf[0].Trim() -eq '') { $buf.RemoveAt(0) }
      while ($buf.Count -gt 0 -and $buf[$buf.Count - 1].Trim() -eq '') { $buf.RemoveAt($buf.Count - 1) }
      $notePath = Join-Path $noteDir "Release说明-v$t.md"
      Set-Content -Path $notePath -Value $buf -Encoding UTF8
      Write-Host ("[7] 已提取 Release 说明：Release说明-v{0}.md（{1} 行）" -f $t, $buf.Count) -ForegroundColor Green
    } else {
      Write-Host ("[7] ! CHANGELOG.md 中未找到 ## v{0} 段" -f $t) -ForegroundColor Yellow
    }
  }
} else {
  Write-Host '[7] ! 未读到 CHANGELOG.md，跳过 Release 说明提取' -ForegroundColor Yellow
}

Write-Host ""
Write-Host "完成。产物目录：$outDir" -ForegroundColor Green
Get-ChildItem $outDir | Select-Object Name, @{ n = 'KB'; e = { [math]::Round($_.Length / 1KB, 1) } } | Format-Table -AutoSize
