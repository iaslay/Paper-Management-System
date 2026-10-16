param(
    [int]$Port = 8000,
    [string]$DataDirectory = 'data',
    [switch]$Rebuild,
    [switch]$Install
)

$ErrorActionPreference = 'Stop'
$taskRoot = $PSScriptRoot
$taskPython = Join-Path $taskRoot '.venv\Scripts\python.exe'

function Invoke-CheckedCommand {
    param([string]$Executable, [string[]]$Arguments)
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw '命令执行失败，请根据上方提示检查运行环境。' }
}

Push-Location -LiteralPath $taskRoot
try {
    if (!(Test-Path -LiteralPath $taskPython)) {
        Write-Host '正在创建项目内的 Python 环境…'
        Invoke-CheckedCommand -Executable 'python' -Arguments @('-m', 'venv', '.venv')
        $Install = $true
    }
    & $taskPython -c "import importlib.util, sys; sys.exit(0 if all(importlib.util.find_spec(name) for name in ['cryptography', 'pypdfium2', 'PIL', 'httpx', 'acl_anthology', 'bibtexparser']) else 1)"
    if ($LASTEXITCODE -ne 0) { $Install = $true }
    if ($Install) {
        Write-Host '正在安装锁定的 Python 依赖…'
        Invoke-CheckedCommand -Executable $taskPython -Arguments @('-m', 'pip', 'install', '-r', 'backend/requirements.lock', '--cache-dir', '.cache/pip')
    }
    $taskNodeModules = Join-Path $taskRoot 'frontend\node_modules'
    $taskBuiltPage = Join-Path $taskRoot 'frontend\dist\index.html'
    $taskVersionPath = Join-Path $taskRoot 'frontend\dist\version.json'
    $taskSourceVersion = (Get-Content -LiteralPath (Join-Path $taskRoot 'frontend\package.json') -Raw | ConvertFrom-Json).version
    $taskBuiltVersion = if (Test-Path -LiteralPath $taskVersionPath) { (Get-Content -LiteralPath $taskVersionPath -Raw | ConvertFrom-Json).version } else { '' }
    Push-Location -LiteralPath (Join-Path $taskRoot 'frontend')
    try {
        if ($Install -or !(Test-Path -LiteralPath $taskNodeModules)) {
            Write-Host '正在安装锁定的前端依赖…'
            Invoke-CheckedCommand -Executable 'npm.cmd' -Arguments @('ci', '--cache', '../.cache/npm')
            $Rebuild = $true
        }
        if ($Rebuild -or !(Test-Path -LiteralPath $taskBuiltPage) -or $taskBuiltVersion -ne $taskSourceVersion) {
            Write-Host '正在构建论文看板…'
            Invoke-CheckedCommand -Executable 'npm.cmd' -Arguments @('run', 'build')
        }
    }
    finally { Pop-Location }
    $env:PAPERBOARD_DATA_DIR = if ([System.IO.Path]::IsPathRooted($DataDirectory)) { $DataDirectory } else { Join-Path $taskRoot $DataDirectory }
    $env:PYTHONIOENCODING = 'utf-8'
    if (!$env:PAPERBOARD_ALLOWED_ORIGINS) {
        $env:PAPERBOARD_ALLOWED_ORIGINS = "http://127.0.0.1:$Port,http://localhost:$Port,http://127.0.0.1:5173,http://localhost:5173"
    }
    Write-Host "打开 http://127.0.0.1:$Port 使用论文看板。首次使用时设置账号，已有账号直接登录。"
    Write-Host "数据目录：$env:PAPERBOARD_DATA_DIR"
    Write-Host '在当前终端按 Ctrl+C 停止服务。'
    Invoke-CheckedCommand -Executable $taskPython -Arguments @('-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', "$Port")
}
finally { Pop-Location }
