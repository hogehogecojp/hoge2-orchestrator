#Requires -Version 5.1
<#
.SYNOPSIS
    Windows で hoge2-orchestrator を動かすための前提を診断し、必要なら導入する。

.DESCRIPTION
    まっさらな Windows から `npm run up` が通る状態までを 1 コマンドにまとめたもの。
    ネイティブビルドの前提が 1 つでも欠けると、ビルドログを読まないと原因に辿り着けない
    エラーで止まるため（下記）、事前に揃っているかを確かめてから導入へ進む。

    このスクリプトが面倒を見る落とし穴:

      - Visual Studio Build Tools の C++ ワークロード未導入
      - Spectre 軽減ライブラリ未導入
        「推奨コンポーネントを含める」でも入らないため見落としやすい。
        欠けていると node-pty のビルドが MSB8040 で失敗する。
      - Git for Windows 未導入
        vk-agents の展開に使う sync.sh は bash が要る。PATH に載るのは <Git>\cmd だけで
        bash.exe のある <Git>\bin は載らないため、orchestrator 側が自動で探しに行く。
      - 環境変数 NoDefaultCurrentDirectoryInExePath
        設定されていると node-pty 同梱の winpty のビルドが
        'GetCommitHash.bat' is not recognized で失敗する。

    既定は**診断のみ**（何も変更しない）。実際に導入するには -Install を付ける。

    このスクリプトはリポジトリの中にあるので、実行するにはリポジトリが手元に必要。
    Git がまだ入っていない環境では、先に Git を入れるか、GitHub から ZIP で取得する:

        winget install Git.Git
        git clone https://github.com/hogehogecojp/hoge2-orchestrator.git
        cd hoge2-orchestrator
        powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Install

    なお、このスクリプトが済ませられるのは「手元のマシンで GUI が起動するところ」まで。
    利用者ごとの認証（Claude Code へのログイン、gh auth login）と、チームで共有する設定
    （タスク登録リポジトリの指定など）は別途必要になる。締めの案内に一覧を出す。

.PARAMETER Install
    不足している前提を実際に導入する。省略時は診断結果と、やろうとしている操作を表示するだけ。

.PARAMETER SkipBuildTools
    Visual Studio Build Tools と Spectre 軽減ライブラリの導入を飛ばす。
    別途導入済み、または管理者権限が取れない環境向け。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1
    診断だけを行う（何も変更しない）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup-windows.ps1 -Install
    不足しているものを導入し、VK Terminals の導入と doctor までを通す。
#>
[CmdletBinding()]
param(
    [switch]$Install,
    [switch]$SkipBuildTools
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot

# 導入対象の定数。VS のコンポーネント ID は VS Installer が受け取る正式名。
$VsBuildToolsWingetId = 'Microsoft.VisualStudio.2022.BuildTools'
$VsWorkloadVCTools    = 'Microsoft.VisualStudio.Workload.VCTools'
$VsComponentSpectre   = 'Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre'
$VsComponentVCTools   = 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64'
$MinNodeMajor         = 20

# 診断結果の蓄積。表示と「導入が必要か」の判断の両方に使う。
$script:Checks = @()

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host "== $Title ==" -ForegroundColor Cyan
}

<#
    診断 1 件を記録して表示する。
    Ok            … 充足しているか
    Required      … 欠けていると先へ進めないか（false なら警告止まり）
    Detail        … 現在の値（版など）
    Fix           … 何をすれば直るか（このスクリプトで直せない場合の案内）
    CanAutoInstall… -Install で自動導入できるか
#>
function Add-Check {
    param(
        [string]$Name,
        [bool]$Ok,
        [string]$Detail = '',
        [string]$Fix = '',
        [bool]$Required = $true,
        [bool]$CanAutoInstall = $false
    )
    $script:Checks += [pscustomobject]@{
        Name           = $Name
        Ok             = $Ok
        Detail         = $Detail
        Fix            = $Fix
        Required       = $Required
        CanAutoInstall = $CanAutoInstall
    }
    if ($Ok) {
        $mark = 'OK '; $color = 'Green'
    } elseif ($Required) {
        $mark = 'NG '; $color = 'Red'
    } else {
        $mark = '警告'; $color = 'Yellow'
    }
    $line = '  [{0}] {1}' -f $mark, $Name
    if ($Detail) { $line += " … $Detail" }
    Write-Host $line -ForegroundColor $color
}

function Get-CommandPath {
    param([string]$Name)
    $c = Get-Command $Name -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    return $null
}

function Get-VsWherePath {
    $p = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $p) { return $p }
    return $null
}

<#
    指定の VS コンポーネントが入っている VS のインストール先を返す（無ければ $null）。
    vswhere -requires は「そのコンポーネントを含むインストール」だけを返すので、
    ディレクトリの有無を自前で見るより確実。
#>
function Get-VsInstallPathWith {
    param([string]$ComponentId)
    $vswhere = Get-VsWherePath
    if (-not $vswhere) { return $null }
    $out = & $vswhere -products * -requires $ComponentId -latest -format value -property installationPath 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    $path = ($out | Select-Object -First 1)
    if ($path) { return $path.Trim() }
    return $null
}

function Test-IsElevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

<#
    winget で何かを導入した直後に、このプロセスの PATH を作り直す。

    winget が書き換えるのは「マシン／ユーザーの環境変数」で、既に動いているプロセスの
    PATH には反映されない。そのため node や git を入れた直後でも、同じ実行の中では
    `npm` が「見つからない」と言われて落ちる。レジストリ側の現在値を読み直して差し替える。
#>
function Update-ProcessPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
    $joined  = @($machine, $user) | Where-Object { $_ }
    if ($joined) { $env:Path = ($joined -join ';') }
}

# ---------------------------------------------------------------- 診断

Write-Host ''
Write-Host 'hoge2-orchestrator: Windows セットアップ' -ForegroundColor White
Write-Host "リポジトリ: $RepoRoot"
if (-not $Install) {
    Write-Host '（診断のみ。実際に導入するには -Install を付けてください）' -ForegroundColor DarkGray
}

Write-Section '前提の確認'

# Node.js
$nodePath = Get-CommandPath 'node'
if ($nodePath) {
    $nodeVersion = (& node -v).TrimStart('v')
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    Add-Check -Name "Node.js $MinNodeMajor 以上" -Ok ($nodeMajor -ge $MinNodeMajor) -Detail "v$nodeVersion" `
        -Fix 'https://nodejs.org/ から LTS を導入するか、winget install OpenJS.NodeJS.LTS' `
        -CanAutoInstall $true
} else {
    Add-Check -Name "Node.js $MinNodeMajor 以上" -Ok $false -Detail '未導入' `
        -Fix 'winget install OpenJS.NodeJS.LTS' -CanAutoInstall $true
}

# Git（Git Bash が要る。PATH に載るのは <Git>\cmd だけなので bin\bash.exe を自分で探す）
$gitPath = Get-CommandPath 'git'
$bashPath = $null
if ($gitPath) {
    $gitRoot = Split-Path -Parent (Split-Path -Parent $gitPath)
    $candidate = Join-Path $gitRoot 'bin\bash.exe'
    if (Test-Path $candidate) { $bashPath = $candidate }
    if (-not $bashPath) {
        foreach ($root in @('C:\Program Files\Git', 'C:\Program Files (x86)\Git')) {
            $c = Join-Path $root 'bin\bash.exe'
            if (Test-Path $c) { $bashPath = $c; break }
        }
    }
}
Add-Check -Name 'Git for Windows（Git Bash 同梱）' -Ok ([bool]$bashPath) `
    -Detail $(if ($bashPath) { $bashPath } else { '未導入 / bash.exe が見つからない' }) `
    -Fix 'winget install Git.Git（導入済みで見つからない場合は環境変数 VK_BASH に bash.exe の絶対パスを設定）' `
    -CanAutoInstall $true

# Visual Studio Build Tools（C++ ワークロード）
$vcToolsPath = Get-VsInstallPathWith -ComponentId $VsComponentVCTools
Add-Check -Name 'VS Build Tools（C++ によるデスクトップ開発）' -Ok ([bool]$vcToolsPath) `
    -Detail $(if ($vcToolsPath) { $vcToolsPath } else { '未導入' }) `
    -Fix "winget install --id $VsBuildToolsWingetId --override `"--quiet --wait --add $VsWorkloadVCTools --includeRecommended`"" `
    -CanAutoInstall $true

# Spectre 軽減ライブラリ（--includeRecommended でも入らない。欠けると MSB8040 で失敗）
$spectrePath = Get-VsInstallPathWith -ComponentId $VsComponentSpectre
Add-Check -Name 'Spectre 軽減ライブラリ（MSVC v143）' -Ok ([bool]$spectrePath) `
    -Detail $(if ($spectrePath) { '導入済み' } else { '未導入（node-pty のビルドが MSB8040 で失敗します）' }) `
    -Fix "VS Installer で $VsComponentSpectre を追加" `
    -CanAutoInstall $true

# Claude Code CLI（同梱・再配布はしない。各自で導入し、各自でログインする）
$claudePath = Get-CommandPath 'claude'
$claudeVersion = ''
if ($claudePath) {
    try { $claudeVersion = (& claude --version 2>$null | Select-Object -First 1) } catch { $claudeVersion = '' }
}
Add-Check -Name 'Claude Code CLI' -Ok ([bool]$claudePath) `
    -Detail $(if ($claudePath) { "$claudeVersion" } else { '未導入' }) `
    -Fix 'irm https://claude.ai/install.ps1 | iex （導入後に claude でログインしてください）'

# GitHub CLI（GitHub モードで使う。ローカルキュー運用なら必須ではない）
$ghPath = Get-CommandPath 'gh'
$ghAuthed = $false
if ($ghPath) {
    & gh auth status *> $null
    $ghAuthed = ($LASTEXITCODE -eq 0)
}
Add-Check -Name 'GitHub CLI（gh）と認証' -Ok $ghAuthed `
    -Detail $(if (-not $ghPath) { '未導入' } elseif ($ghAuthed) { '認証済み' } else { '未認証' }) `
    -Fix 'winget install GitHub.cli の後 gh auth login' -Required $false -CanAutoInstall $true

# 環境変数の落とし穴（値は変えない。このプロセスの中だけ後で外す）
$hasNoDefaultCwd = [bool]$env:NoDefaultCurrentDirectoryInExePath
Add-Check -Name '環境変数 NoDefaultCurrentDirectoryInExePath' -Ok (-not $hasNoDefaultCwd) `
    -Detail $(if ($hasNoDefaultCwd) { "設定あり（このスクリプトの実行中だけ外します）" } else { '未設定' }) `
    -Fix 'winpty のビルドが失敗するため、導入のときだけ外す必要があります' -Required $false

$hasElectronRunAsNode = [bool]$env:ELECTRON_RUN_AS_NODE
Add-Check -Name '環境変数 ELECTRON_RUN_AS_NODE' -Ok (-not $hasElectronRunAsNode) `
    -Detail $(if ($hasElectronRunAsNode) { '設定あり（このスクリプトの実行中だけ外します）' } else { '未設定' }) `
    -Fix '残っていると GUI が起動せず Node として動きます' -Required $false

# ---------------------------------------------------------------- 診断のみで終わる場合

$missingRequired = @($script:Checks | Where-Object { -not $_.Ok -and $_.Required })
$missingOptional = @($script:Checks | Where-Object { -not $_.Ok -and -not $_.Required })

if (-not $Install) {
    Write-Section '結果'
    if ($missingRequired.Count -eq 0) {
        Write-Host '  必須の前提はすべて揃っています。' -ForegroundColor Green
        Write-Host '  導入まで進めるには -Install を付けて実行してください。'
    } else {
        Write-Host "  不足している必須の前提が $($missingRequired.Count) 件あります:" -ForegroundColor Red
        foreach ($m in $missingRequired) {
            Write-Host "   - $($m.Name)"
            if ($m.Fix) { Write-Host "     → $($m.Fix)" -ForegroundColor DarkGray }
        }
        Write-Host ''
        Write-Host '  -Install を付けて実行すると、自動導入できるものは導入します。'
    }
    foreach ($m in $missingOptional) {
        Write-Host "  （任意）$($m.Name): $($m.Fix)" -ForegroundColor Yellow
    }
    return
}

# ---------------------------------------------------------------- 導入

Write-Section '不足している前提の導入'

$winget = Get-CommandPath 'winget'

function Invoke-Winget {
    param([string]$Id, [string]$Override = '')
    if (-not $winget) {
        Write-Host "  winget が使えないため $Id は自動導入できません。手動で導入してください。" -ForegroundColor Yellow
        return $false
    }
    Write-Host "  winget install $Id ..."
    $args = @('install', '--id', $Id, '--accept-package-agreements', '--accept-source-agreements')
    if ($Override) { $args += @('--override', $Override) }
    & winget @args
    return ($LASTEXITCODE -eq 0)
}

# Node.js（これが無いと後段の npm install / setup:terminals が動かない）
if (-not $nodePath -or $nodeMajor -lt $MinNodeMajor) {
    [void](Invoke-Winget -Id 'OpenJS.NodeJS.LTS')
    Update-ProcessPath
}

# Git（Git Bash が vk-agents の展開に要る）
if (-not $bashPath) {
    [void](Invoke-Winget -Id 'Git.Git')
    Update-ProcessPath
}

# GitHub CLI（GitHub をタスクキューに使う場合。認証は利用者が自分で行う）
if (-not $ghPath) {
    [void](Invoke-Winget -Id 'GitHub.cli')
    Update-ProcessPath
}

# VS Build Tools と Spectre 軽減ライブラリ
if (-not $SkipBuildTools) {
    if (-not $vcToolsPath) {
        [void](Invoke-Winget -Id $VsBuildToolsWingetId -Override "--quiet --wait --add $VsWorkloadVCTools --includeRecommended")
        $vcToolsPath = Get-VsInstallPathWith -ComponentId $VsComponentVCTools
    }

    $spectrePath = Get-VsInstallPathWith -ComponentId $VsComponentSpectre
    if (-not $spectrePath -and $vcToolsPath) {
        Write-Host '  Spectre 軽減ライブラリを追加します...'
        $vsInstaller = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vs_installer.exe'
        if (Test-Path $vsInstaller) {
            # --quiet / --passive は「最初から昇格して起動されていること」を要求する
            # （非昇格から渡すと exit 5007 で何もせず終わる）。そこで自分で昇格して起動する。
            $vsArgs = @(
                'modify',
                '--installPath', "`"$vcToolsPath`"",
                '--add', $VsComponentSpectre,
                '--passive', '--norestart'
            )
            if (Test-IsElevated) {
                & $vsInstaller @vsArgs
            } else {
                Write-Host '  （管理者権限が必要なため昇格します。UAC のダイアログを承認してください）' -ForegroundColor DarkGray
                Start-Process -FilePath $vsInstaller -ArgumentList $vsArgs -Verb RunAs -Wait
            }
            $spectrePath = Get-VsInstallPathWith -ComponentId $VsComponentSpectre
        } else {
            Write-Host '  vs_installer.exe が見つかりません。VS Installer から手動で追加してください。' -ForegroundColor Yellow
        }
    }
    if ($spectrePath) {
        Write-Host '  Spectre 軽減ライブラリ: 導入済み' -ForegroundColor Green
    } else {
        Write-Host '  Spectre 軽減ライブラリ: 未導入のままです（node-pty のビルドが失敗します）' -ForegroundColor Red
    }
} else {
    Write-Host '  -SkipBuildTools が指定されたため、ビルドツールの導入は飛ばします。' -ForegroundColor DarkGray
}

# Claude Code CLI は自動導入しない。
# 各自のアカウントでログインが要るものを、セットアップスクリプトが黙って入れるべきではない。
if (-not $claudePath) {
    Write-Host ''
    Write-Host '  Claude Code CLI は自動導入しません。次を実行して導入し、ログインしてください:' -ForegroundColor Yellow
    Write-Host '    irm https://claude.ai/install.ps1 | iex'
    Write-Host '    claude   # 初回はブラウザでログインします'
}

# ---------------------------------------------------------------- ビルドと検証

Write-Section 'ビルド前の再確認'

# 導入を試みたあとに、後段（npm install / setup:terminals）が本当に動く状態かを見る。
#
# ここで止めずに進むと `npm` が見つからないという分かりにくいエラーで落ちる。とくに
# winget での導入直後は、PATH の更新が既存プロセスへ届かないことがある（Update-ProcessPath で
# レジストリから読み直してはいるが、インストーラの都合で反映が遅れる場合がある）。
# その場合はシェルを開き直せば直るので、そう案内して終わる。
Update-ProcessPath
$blockers = @()

$nodePath = Get-CommandPath 'node'
if ($nodePath) {
    $nodeVersion = (& node -v).TrimStart('v')
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt $MinNodeMajor) { $blockers += "Node.js が $MinNodeMajor 未満です（v$nodeVersion）" }
    else { Write-Host "  Node.js … v$nodeVersion" -ForegroundColor Green }
} else {
    $blockers += 'Node.js が見つかりません'
}

if (-not (Get-CommandPath 'npm')) { $blockers += 'npm が見つかりません' }
else { Write-Host "  npm … $(& npm -v)" -ForegroundColor Green }

if (-not $SkipBuildTools) {
    if (-not (Get-VsInstallPathWith -ComponentId $VsComponentVCTools)) {
        $blockers += 'VS Build Tools の C++ ワークロードが見つかりません'
    }
    if (-not (Get-VsInstallPathWith -ComponentId $VsComponentSpectre)) {
        $blockers += 'Spectre 軽減ライブラリが見つかりません（node-pty のビルドが MSB8040 で失敗します）'
    }
}

if ($blockers.Count -gt 0) {
    Write-Host ''
    Write-Host '  ビルドに進めません:' -ForegroundColor Red
    foreach ($b in $blockers) { Write-Host "   - $b" -ForegroundColor Red }
    Write-Host ''
    Write-Host '  導入直後であれば、PowerShell を開き直してからもう一度実行すると解決することがあります' -ForegroundColor Yellow
    Write-Host '  （インストーラが更新した PATH が、実行中のプロセスへ届いていない場合があるため）。' -ForegroundColor Yellow
    exit 1
}

Write-Section 'VK Terminals(GUI) の導入'

# node-pty 同梱の winpty は cmd 経由で GetCommitHash.bat を叩くため、
# NoDefaultCurrentDirectoryInExePath が設定されているとビルドが失敗する。
# 外すのは **このスクリプトのプロセスの中だけ** で、OS の設定は変更しない。
if ($env:NoDefaultCurrentDirectoryInExePath) {
    Write-Host '  NoDefaultCurrentDirectoryInExePath をこのプロセスから外します（OS の設定は変更しません）。' -ForegroundColor DarkGray
    Remove-Item Env:\NoDefaultCurrentDirectoryInExePath -ErrorAction SilentlyContinue
}
if ($env:ELECTRON_RUN_AS_NODE) {
    Write-Host '  ELECTRON_RUN_AS_NODE をこのプロセスから外します（OS の設定は変更しません）。' -ForegroundColor DarkGray
    Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
}

Push-Location $RepoRoot
try {
    Write-Host '  npm install ...'
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'npm install に失敗しました。' }

    Write-Host '  npm run setup:terminals ...'
    & npm run setup:terminals
    if ($LASTEXITCODE -ne 0) {
        throw 'VK Terminals の導入に失敗しました。上のビルドログを確認してください。'
    }

    Write-Section 'セットアップ診断（doctor）'
    & npm run doctor
} finally {
    Pop-Location
}

# ---------------------------------------------------------------- 締め

Write-Section '残りの手順'
Write-Host @'
  doctor で未充足の項目が残っている場合は、次を確認してください。

  1. Claude Code のログイン
       claude          （初回はブラウザでログイン。認証は利用者ごとに必要です）

  2. GitHub CLI の認証（GitHub をタスクキューに使う場合）
       gh auth login

  3. vk-agents の展開（~/.claude を変更します）
       npm run setup:agents

  4. 設定（config.json）
       github.owner / github.repo をタスク登録リポジトリへ向ける
       org.allowed_owners に自社オーナーを追加する

  起動:
       npm run up
       VS Code なら Ctrl+Shift+B（実行内容を選ぶメニューが出ます）
'@
Write-Host ''
