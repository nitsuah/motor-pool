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
    [string]$EnvFile = ".env",
    [string]$Fixture
)

Set-StrictMode -Off
$ErrorActionPreference = "SilentlyContinue"

# ── Probe helpers ─────────────────────────────────────────────────────────────
function Test-NvidiaRuntime {
    param([string]$RuntimeJson)

    if ([string]::IsNullOrWhiteSpace($RuntimeJson)) { return $false }
    try {
        $runtimeData = $RuntimeJson | ConvertFrom-Json -ErrorAction Stop
        return (@($runtimeData.PSObject.Properties.Name) -contains 'nvidia')
    } catch {
        return $false
    }
}

# ── Hardware probes ───────────────────────────────────────────────────────────
if ($Fixture) {
    # Fixture mode replaces every live probe; it must never call WMI/CIM,
    # nvidia-smi, or Docker.
    $fixtureData = $Fixture | ConvertFrom-Json -ErrorAction Stop

    $vramMB  = 0
    $gpuName = "none"
    $nvidiaSmiWorks = $false
    $nvidiaSmiExitCode = 1
    if ($null -ne $fixtureData.nvidiaSmiExitCode) {
        try { $nvidiaSmiExitCode = [int]$fixtureData.nvidiaSmiExitCode } catch { $nvidiaSmiExitCode = 1 }
    }

    if ($nvidiaSmiExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace([string]$fixtureData.nvidiaSmiOutput)) {
        $smiOut = [string]$fixtureData.nvidiaSmiOutput
        $firstGpu = ($smiOut -split "`n")[0].Trim()
        $parts = $firstGpu -split ",\s*"
        if ($parts.Count -ge 2) {
            try {
                $parsedVram = [int]($parts[1].Trim())
                if ($parsedVram -ge 0) {
                    $gpuName = $parts[0].Trim()
                    $vramMB = $parsedVram
                    $nvidiaSmiWorks = $true
                }
            } catch {
                $vramMB = 0
            }
        }
    }

    $ramGB = 0
    if ($null -ne $fixtureData.ramGB) {
        try { $ramGB = [int]$fixtureData.ramGB } catch { $ramGB = 0 }
    }

    $hostGpus = @()
    if ($fixtureData.hostGpuNames) {
        $hostGpus = @($fixtureData.hostGpuNames | ForEach-Object {
            $name = [string]$_
            $vendor = if ($name -match 'NVIDIA|GeForce|Quadro|Tesla') { 'NVIDIA' }
                      elseif ($name -match 'AMD|Radeon|\bATI\b|Advanced Micro Devices') { 'AMD' }
                      elseif ($name -match 'Intel') { 'Intel' }
                      else { 'Other' }
            [pscustomobject]@{ Name = $name; Vendor = $vendor }
        })
    }

    $hostNvidiaPresent = $nvidiaSmiWorks -or (@($hostGpus | Where-Object { $_.Vendor -eq 'NVIDIA' }).Count -gt 0)
    $containerGpuAccess = "none"
    if ($hostNvidiaPresent) {
        if ($nvidiaSmiWorks -and (Test-NvidiaRuntime -RuntimeJson ([string]$fixtureData.dockerRuntimesJson))) {
            $containerGpuAccess = "verified"
        } else {
            $containerGpuAccess = "unverified"
        }
    }
} else {
    # ── NVIDIA VRAM detection ───────────────────────────────────────────────────
    $vramMB  = 0
    $gpuName = "none"
    $nvidiaSmiWorks = $false

    $smiOut = nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>$null
    if ($LASTEXITCODE -eq 0 -and $smiOut) {
        $firstGpu = ($smiOut -split "`n")[0].Trim()
        $parts = $firstGpu -split ",\s*"
        if ($parts.Count -ge 2) {
            try {
                $parsedVram = [int]($parts[1].Trim())
                if ($parsedVram -ge 0) {
                    $gpuName = $parts[0].Trim()
                    $vramMB = $parsedVram
                    $nvidiaSmiWorks = $true
                }
            } catch {
                $vramMB = 0
            }
        }
    }

    # ── RAM detection ───────────────────────────────────────────────────────────
    $ramGB = 0
    try {
        $cs = Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop
        $ramGB = [math]::Floor($cs.TotalPhysicalMemory / 1GB)
    } catch {
        try {
            $ramGB = [math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
        } catch { }
    }

    # ── Host GPU inventory (any vendor) ─────────────────────────────────────────
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

    # NVIDIA host hardware is not enough: runtime access must also be verified.
    $hostNvidiaPresent = $nvidiaSmiWorks -or (@($hostGpus | Where-Object { $_.Vendor -eq 'NVIDIA' }).Count -gt 0)
    $containerGpuAccess = "none"
    if ($hostNvidiaPresent) {
        if ($nvidiaSmiWorks) {
            $dockerInfo = docker info --format '{{json .Runtimes}}' 2>$null
            if ($LASTEXITCODE -eq 0 -and (Test-NvidiaRuntime -RuntimeJson ([string]$dockerInfo))) {
                $containerGpuAccess = "verified"
            } else {
                $containerGpuAccess = "unverified"
            }
        } else {
            $containerGpuAccess = "unverified"
        }
    }
}

# ── Profile selection ────────────────────────────────────────────────────────
# Profiles are ordered from most capable to least; first threshold that fits wins.
# VRAM only counts toward a tier when container GPU access is verified.
$profile = "minimal"

$vramForProfile = if ($containerGpuAccess -eq "verified") { $vramMB } else { 0 }

if ($vramForProfile -ge 16000 -and $ramGB -ge 24) {
    $profile = "desktop"
} elseif ($vramForProfile -ge 4000 -and $ramGB -ge 12) {
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
Write-Host "  Container GPU access: $containerGpuAccess"
if ($containerGpuAccess -eq "unverified") {
    $profileReason = "NVIDIA host GPU detected, but nvidia-smi or Docker runtime verification failed; using CPU-only minimal profile."
} elseif ($containerGpuAccess -eq "none") {
    $profileReason = "No NVIDIA container GPU path detected; using CPU-only minimal profile."
} elseif ($profile -eq "minimal") {
    $profileReason = "NVIDIA container access is verified, but VRAM/RAM are below the accelerated profile thresholds; using minimal."
} else {
    $profileReason = "NVIDIA container access is verified; GPU VRAM may be used for profile selection."
}
Write-Host "  Profile reason: $profileReason"
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
