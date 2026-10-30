# detect-profile.ps1 — detect local hardware and recommend a device profile for motor-pool.
#
# Usage:
#   .\scripts\detect-profile.ps1              # print detected profile + .env snippet
#   .\scripts\detect-profile.ps1 -Write       # append DEVICE_PROFILE= to .env
#
# The profile name is written to stdout. Pipe it or use -Write to persist it.
# Requires: PowerShell 5.1+ on Windows. nvidia-smi must be on PATH for NVIDIA VRAM detection.
# Host GPU inventory uses CIM for any vendor; only NVIDIA VRAM counts toward the profile today.

param(
    [switch]$Write,
    [string]$EnvFile = ".env"
)

Set-StrictMode -Off
$ErrorActionPreference = "SilentlyContinue"

# ── GPU detection ────────────────────────────────────────────────────────────
$vramMB  = 0
$gpuName = "none"

$smiOut = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
if ($LASTEXITCODE -eq 0 -and $smiOut) {
    $firstGpu = ($smiOut -split "`n")[0].Trim()
    $parts    = $firstGpu -split ",\s*"
    $gpuName  = $parts[0].Trim()
    $vramMB   = [int]($parts[1].Trim())
}

# ── RAM detection ────────────────────────────────────────────────────────────
$ramGB = 0
try {
    $cs    = Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop
    $ramGB = [math]::Floor($cs.TotalPhysicalMemory / 1GB)
} catch {
    try {
        $ramGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
    } catch { }
}

# ── Host GPU inventory (any vendor) ──────────────────────────────────────────
# Host hardware is separate from what Ollama's container can access.
$hostGpus = @()
try {
    $hostGpus = @(Get-CimInstance Win32_VideoController -ErrorAction Stop | ForEach-Object {
        $name = [string]$_.Name
        $vendor = if ($name -match 'NVIDIA|GeForce|Quadro|Tesla') { 'NVIDIA' }
                  elseif ($name -match 'AMD|Radeon|\bATI\b|Advanced Micro Devices') { 'AMD' }
                  elseif ($name -match 'Intel') { 'Intel' }
                  else { 'Other' }
        [pscustomobject]@{ Name = $name; Vendor = $vendor }
    })
} catch {
    # CIM is unavailable on non-Windows hosts; keep the inventory empty.
}

# ── Profile selection ────────────────────────────────────────────────────────
# Profiles are ordered from most capable to least; first threshold that fits wins.
$profile = "minimal"

if ($vramMB -ge 16000 -and $ramGB -ge 24) {
    $profile = "desktop"
} elseif ($vramMB -ge 4000 -and $ramGB -ge 12) {
    $profile = "laptop"
}

# ── Output ───────────────────────────────────────────────────────────────────
$envLine = "DEVICE_PROFILE=$profile"

Write-Host ""
Write-Host "Detected hardware:"
Write-Host "  NVIDIA GPU: $gpuName (VRAM: ${vramMB} MB)"
Write-Host "  RAM  : ${ramGB} GB"
Write-Host "  Host GPUs (not necessarily usable by containers):"
if ($hostGpus.Count -eq 0) {
    Write-Host "    none detected"
} else {
    foreach ($g in $hostGpus) { Write-Host "    $($g.Vendor): $($g.Name)" }
}
Write-Host ""
Write-Host "Recommended profile: $profile"
Write-Host ""
Write-Host "Add to your .env:"
Write-Host "  $envLine"
Write-Host ""

if ($Write) {
    if (-not (Test-Path $EnvFile)) {
        New-Item -ItemType File -Path $EnvFile | Out-Null
    }
    $existing = Get-Content $EnvFile -Raw -ErrorAction SilentlyContinue
    if ($existing -match "^DEVICE_PROFILE=") {
        # Replace existing entry
        $updated = $existing -replace "(?m)^DEVICE_PROFILE=.*", $envLine
        Set-Content -Path $EnvFile -Value $updated -NoNewline
        Write-Host "Updated DEVICE_PROFILE in $EnvFile"
    } else {
        Add-Content -Path $EnvFile -Value "`n$envLine"
        Write-Host "Added DEVICE_PROFILE to $EnvFile"
    }
}
