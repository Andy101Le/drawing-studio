# OMNI-CELL ML sidecar, Windows. Run from ml\sidecar:  .\start.bat   (or .\start.ps1)
# Creates the venv, installs torch with the CUDA wheels matching your NVIDIA driver, runs the
# preflight (doctor.py) and starts the service on http://127.0.0.1:8790.
param([string]$Model = "dreamshaper-8-sd15", [string]$Profile = "6gb", [string]$ControlNet = "lineart", [switch]$NoIpAdapter, [int]$Port = 8790, [string]$CacheDir = "")

function Find-Python {
    # The "python" command on a clean Windows is the Microsoft Store alias stub, which prints a
    # message and exits 9009. Prefer the py launcher, then real python.exe on PATH, and verify
    # each candidate actually runs and reports 3.10-3.12.
    $cands = @()
    if (Get-Command py -ErrorAction SilentlyContinue) { foreach ($v in "3.12", "3.11", "3.10") { $cands += ,@("py", @("-$v")) } }
    foreach ($n in "python3.12", "python3.11", "python3.10", "python", "python3") {
        $c = Get-Command $n -ErrorAction SilentlyContinue
        if ($c -and $c.Source -notlike "*WindowsApps*") { $cands += ,@($c.Source, @()) }
    }
    foreach ($c in $cands) {
        $exe = $c[0]; $pre = $c[1]
        try { $out = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null } catch { continue }
        if ($LASTEXITCODE -ne 0 -or -not $out) { continue }
        $parts = $out.Trim().Split("."); $maj = [int]$parts[0]; $min = [int]$parts[1]
        if ($maj -eq 3 -and $min -ge 10 -and $min -le 12) { return ,@($exe, $pre, $out.Trim()) }
    }
    return $null
}

$py = Find-Python
if (-not $py) {
    Write-Host ""
    Write-Host "No usable Python found (need 3.10, 3.11 or 3.12)." -ForegroundColor Yellow
    Write-Host "Install it, then run this script again:"
    Write-Host "  winget install -e --id Python.Python.3.12" 
    Write-Host "  (or download from https://www.python.org/downloads/windows/ and tick 'Add python.exe to PATH')"
    Write-Host ""
    Write-Host "If 'python' opens the Microsoft Store instead: Settings > Apps > Advanced app settings >"
    Write-Host "App execution aliases, and turn off the two 'python' entries."
    Write-Host "Close and reopen the terminal after installing."
    exit 1
}
$pyExe = $py[0]; $pyPre = $py[1]
Write-Host "Using Python $($py[2]) ($pyExe $pyPre)"

$venvPy = ".\.venv\Scripts\python.exe"
if (!(Test-Path $venvPy)) {
    if (Test-Path .venv) { Write-Host "Removing an incomplete .venv"; Remove-Item .venv -Recurse -Force }
    Write-Host "Creating the virtual environment..."
    & $pyExe @pyPre -m venv .venv
    if ($LASTEXITCODE -ne 0 -or !(Test-Path $venvPy)) { Write-Host "venv creation failed." -ForegroundColor Red; exit 1 }
    & $venvPy -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { Write-Host "pip upgrade failed." -ForegroundColor Red; exit 1 }
    $cuda = & $venvPy doctor.py --cuda-index
    Write-Host "torch wheel index: $cuda"
    & $venvPy -m pip install torch torchvision --index-url $cuda
    if ($LASTEXITCODE -ne 0) { Write-Host "torch install failed." -ForegroundColor Red; exit 1 }
    & $venvPy -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { Write-Host "dependency install failed." -ForegroundColor Red; exit 1 }
}

# A previous sidecar still holding the port is the usual cause of "only one usage of each socket address".
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    $owner = $busy | Select-Object -First 1 -ExpandProperty OwningProcess
    $proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
    Write-Host "Port $Port is already in use by PID $owner ($($proc.ProcessName))." -ForegroundColor Yellow
    $ans = Read-Host "Stop it and continue? [Y/n]"
    if ($ans -eq "" -or $ans -match "^[Yy]") {
        Stop-Process -Id $owner -Force
        Start-Sleep -Seconds 2
        Write-Host "Stopped PID $owner."
    } else {
        Write-Host "Leaving it running. Start this one on another port: .\start.bat -Port 8791 (and set the Address in the Generate tab to match)."
        exit 1
    }
}

if ($CacheDir -ne "") { $env:HF_HOME = $CacheDir; Write-Host "Model cache: $CacheDir" }
& $venvPy doctor.py --check --model $Model
if ($LASTEXITCODE -ne 0) { Write-Host "Preflight found a blocking problem (above). Fix it and run again." -ForegroundColor Yellow; exit 1 }

$env:PYTORCH_CUDA_ALLOC_CONF = "expandable_segments:True"
$sidecarArgs = @("-m", "sidecar", "--model", $Model, "--profile", $Profile, "--controlnet", $ControlNet, "--port", "$Port")
if (-not $NoIpAdapter) { $sidecarArgs += "--ip-adapter" }
Write-Host "Starting: $venvPy $sidecarArgs"
& $venvPy @sidecarArgs
