# release-pack.ps1 — 生成 GitHub Release 资产（双形态 zip 包）
#
# 打包内容：源代码 + 测试 + 脚本 + 文档 + 许可证（不含 node_modules）
#   - vision-exp-tile-v<版本>.zip         完整版（local OCR 可用 rapid_gpu_venv 等 venv）
#   - vision-exp-tile-v<版本>-nopython.zip 无 Python 零配置版（剔除 src/ocr-worker.py，自动降级 Windows OCR）
# 用法：powershell -ExecutionPolicy Bypass -File .\scripts\release-pack.ps1
# 输出：dist/ 下两个 zip 资产
# ---------------------------------------------------------------------------

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 读取版本号（显式 UTF8：PS 5.1 默认按 ANSI 读会乱码；package.json 不能加 BOM，npm 不接受）
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = $pkg.version
if (-not $ver) { throw 'package.json 缺少 version 字段' }
Write-Host "[1] 版本：v$ver" -ForegroundColor Cyan

# 准备打包目录（临时 staging）
$distDir = Join-Path $root 'dist'
New-Item -ItemType Directory -Path $distDir -Force | Out-Null

# 打包清单：完整版 = 全部发布文件（含 client.js 设置界面；v0.3.1 起修正：v0.3.0 曾漏打包 client.js）。
# v0.5.0 起补入：std-facet.js + dsh-plugin.json（dsh-std 标准形态备用入口）、CHANGELOG.md（全历史）。
# nopython 版在其基础上去掉 src/ocr-worker.py（自动降级为 Windows OCR 常驻池）。
$include = @('src', 'tests', 'scripts', 'client.js', 'std-facet.js', 'dsh-plugin.json', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'package.json', '.gitignore')

function Build-Zip {
  param(
    [string]$ZipName,
    [string[]]$ExtraExclude
  )
  $stage = Join-Path $distDir "stage-$ver"
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage -Force | Out-Null

  foreach ($item in $include) {
    $src = Join-Path $root $item
    if (Test-Path $src) {
      Copy-Item $src (Join-Path $stage $item) -Recurse -Force
      Write-Host "  + $item"
    } else {
      Write-Host "  ! 跳过（不存在）：$item" -ForegroundColor Yellow
    }
  }

  # 额外剔除（nopython 版去掉 src/ocr-worker.py）
  foreach ($ex in $ExtraExclude) {
    $exPath = Join-Path $stage $ex
    if (Test-Path $exPath) {
      Remove-Item $exPath -Force
      Write-Host "  - $ex（nopython 版剔除）" -ForegroundColor Yellow
    }
  }

  # 清理 Python 字节码缓存（本地构建会带入，不应进发布包）
  $pycache = Join-Path $stage 'src\__pycache__'
  if (Test-Path $pycache) {
    Remove-Item $pycache -Recurse -Force
    Write-Host "  - src\__pycache__（清理）" -ForegroundColor Yellow
  }

  $zip = Join-Path $distDir $ZipName
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
  Remove-Item $stage -Recurse -Force
  return $zip
}

$zipFull = Build-Zip -ZipName "vision-exp-tile-v$ver.zip" -ExtraExclude @()
$zipNoPy = Build-Zip -ZipName "vision-exp-tile-v$ver-nopython.zip" -ExtraExclude @('src/ocr-worker.py')

Write-Host ""
Write-Host "[2] 完整版：$zipFull" -ForegroundColor Green
Write-Host "[3] 零配置版：$zipNoPy" -ForegroundColor Green
Get-Item $zipFull, $zipNoPy | Select-Object FullName, @{ n = 'Size(MB)'; e = { [math]::Round($_.Length / 1MB, 2) } } | Format-List
Write-Host "将 zip 上传到 GitHub Releases 作为 v$ver 的资产，即可供用户下载安装。"
