param(
    [string]$ScriptPath = (Join-Path $PSScriptRoot "..\scripts\detect-profile.ps1")
)

$script:passed = 0
$script:failed = 0
$script:liveProbeCalls = 0

# Fixture-mode runs must not invoke any live hardware/runtime command.
function nvidia-smi {
    [void]($script:liveProbeCalls++)
    return "NVIDIA GeForce RTX 4090, 24576"
}
function docker {
    [void]($script:liveProbeCalls++)
    return '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}'
}
function Get-WmiObject {
    param([string]$Class)
    [void]($script:liveProbeCalls++)
    return [pscustomobject]@{ TotalPhysicalMemory = 32GB }
}
function Get-CimInstance {
    param([string]$Class)
    [void]($script:liveProbeCalls++)
    if ($Class -eq "Win32_ComputerSystem") {
        return [pscustomobject]@{ TotalPhysicalMemory = 32GB }
    }
    return @()
}

function Assert-Match {
    param(
        [string]$Actual,
        [string]$Expected,
        [string]$Message
    )
    if ($Actual -match [regex]::Escape($Expected)) {
        Write-Host "[PASS] $Message" -ForegroundColor Green
        [void]($script:passed++)
    } else {
        Write-Host "[FAIL] $Message" -ForegroundColor Red
        Write-Host "  Expected text: $Expected" -ForegroundColor Red
        Write-Host "  Actual: $Actual" -ForegroundColor Red
        [void]($script:failed++)
    }
}

function New-Fixture {
    param(
        [string]$NvidiaSmiOutput = "",
        [int]$NvidiaSmiExitCode = 1,
        [string]$DockerRuntimesJson = "",
        [int]$RamGB = 8,
        [string[]]$HostGpuNames = @()
    )

    $fixture = @{
        nvidiaSmiExitCode = $NvidiaSmiExitCode
        nvidiaSmiOutput = $NvidiaSmiOutput
        dockerRuntimesJson = $DockerRuntimesJson
        ramGB = $RamGB
        hostGpuNames = @($HostGpuNames)
    }
    return ($fixture | ConvertTo-Json -Depth 4 -Compress)
}

function RunTest {
    param(
        [string]$Fixture,
        [string]$ExpectedProfile,
        [string]$ExpectedAccess,
        [string]$ExpectedReason,
        [string]$TestName
    )

    $script:liveProbeCalls = 0
    $output = & $ScriptPath -Fixture $Fixture *>&1 | Out-String
    Assert-Match -Actual $output -Expected "Recommended profile: $ExpectedProfile" -Message "$TestName - profile is $ExpectedProfile"
    Assert-Match -Actual $output -Expected "Container GPU access: $ExpectedAccess" -Message "$TestName - access is $ExpectedAccess"
    Assert-Match -Actual $output -Expected $ExpectedReason -Message "$TestName - reason is reported"
    if ($script:liveProbeCalls -eq 0) {
        Write-Host "[PASS] $TestName - fixture mode made no live probes" -ForegroundColor Green
        [void]($script:passed++)
    } else {
        Write-Host "[FAIL] $TestName - fixture mode made $script:liveProbeCalls live probe calls" -ForegroundColor Red
        [void]($script:failed++)
    }
    return $output
}

$verifiedRuntimes = '{"nvidia":{"path":"nvidia-container-runtime"},"runc":{"path":"runc"}}'
$runtimesWithoutNvidia = '{"runc":{"path":"runc"}}'
$verifiedReason = "NVIDIA container access is verified; GPU VRAM may be used for profile selection."
$unverifiedReason = "NVIDIA host GPU detected, but nvidia-smi or Docker runtime verification failed; using CPU-only minimal profile."
$noneReason = "No NVIDIA container GPU path detected; using CPU-only minimal profile."
$verifiedMinimalReason = "NVIDIA container access is verified, but VRAM/RAM are below the accelerated profile thresholds; using minimal."

$desktopFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 4090, 24576" -NvidiaSmiExitCode 0 -DockerRuntimesJson $verifiedRuntimes -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090", "AMD Radeon RX 7900 XTX")
$laptopFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 3070 Laptop, 8192" -NvidiaSmiExitCode 0 -DockerRuntimesJson $verifiedRuntimes -RamGB 16 -HostGpuNames @("NVIDIA GeForce RTX 3070 Laptop")
$verifiedMinimalFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce GTX 1050, 2048" -NvidiaSmiExitCode 0 -DockerRuntimesJson $verifiedRuntimes -RamGB 8 -HostGpuNames @("NVIDIA GeForce GTX 1050")
$failedNvidiaSmiFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 4090, 24576" -NvidiaSmiExitCode 1 -DockerRuntimesJson $verifiedRuntimes -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090")
$missingNvidiaSmiOutputFixture = New-Fixture -NvidiaSmiOutput "" -NvidiaSmiExitCode 0 -DockerRuntimesJson $verifiedRuntimes -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090")
$missingDockerRuntimeFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 4090, 24576" -NvidiaSmiExitCode 0 -DockerRuntimesJson "" -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090")
$malformedDockerRuntimeFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 4090, 24576" -NvidiaSmiExitCode 0 -DockerRuntimesJson "{malformed-json" -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090")
$noNvidiaRuntimeFixture = New-Fixture -NvidiaSmiOutput "NVIDIA GeForce RTX 4090, 24576" -NvidiaSmiExitCode 0 -DockerRuntimesJson $runtimesWithoutNvidia -RamGB 32 -HostGpuNames @("NVIDIA GeForce RTX 4090")
$amdOnlyFixture = New-Fixture -NvidiaSmiOutput "" -NvidiaSmiExitCode 1 -DockerRuntimesJson $verifiedRuntimes -RamGB 32 -HostGpuNames @("AMD Radeon RX 470")
$cpuOnlyFixture = New-Fixture -NvidiaSmiOutput "" -NvidiaSmiExitCode 1 -DockerRuntimesJson "" -RamGB 4 -HostGpuNames @()
$intelOnlyFixture = New-Fixture -NvidiaSmiOutput "" -NvidiaSmiExitCode 1 -DockerRuntimesJson "" -RamGB 8 -HostGpuNames @("Intel UHD Graphics")

$desktopOutput = RunTest -Fixture $desktopFixture -ExpectedProfile "desktop" -ExpectedAccess "verified" -ExpectedReason $verifiedReason -TestName "Verified NVIDIA desktop"
$laptopOutput = RunTest -Fixture $laptopFixture -ExpectedProfile "laptop" -ExpectedAccess "verified" -ExpectedReason $verifiedReason -TestName "Verified NVIDIA laptop"
[void](RunTest -Fixture $verifiedMinimalFixture -ExpectedProfile "minimal" -ExpectedAccess "verified" -ExpectedReason $verifiedMinimalReason -TestName "Verified NVIDIA below tier thresholds")
[void](RunTest -Fixture $failedNvidiaSmiFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host with failed nvidia-smi exit code")
[void](RunTest -Fixture $missingNvidiaSmiOutputFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host with missing nvidia-smi output")
[void](RunTest -Fixture $missingDockerRuntimeFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host with missing Docker runtime data")
[void](RunTest -Fixture $malformedDockerRuntimeFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host with malformed Docker runtime data")
[void](RunTest -Fixture $noNvidiaRuntimeFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host without NVIDIA Docker runtime")
[void](RunTest -Fixture $amdOnlyFixture -ExpectedProfile "minimal" -ExpectedAccess "none" -ExpectedReason $noneReason -TestName "AMD-only host")
$cpuOutput = RunTest -Fixture $cpuOnlyFixture -ExpectedProfile "minimal" -ExpectedAccess "none" -ExpectedReason $noneReason -TestName "CPU-only host"
[void](RunTest -Fixture $intelOnlyFixture -ExpectedProfile "minimal" -ExpectedAccess "none" -ExpectedReason $noneReason -TestName "Intel-only host")

# A missing exit-code field is treated as a failed probe, not as success.
$missingExitCodeFixture = '{"nvidiaSmiOutput":"NVIDIA GeForce RTX 4090, 24576","dockerRuntimesJson":"' + $verifiedRuntimes.Replace('"','\"') + '","ramGB":32,"hostGpuNames":["NVIDIA GeForce RTX 4090"]}'
[void](RunTest -Fixture $missingExitCodeFixture -ExpectedProfile "minimal" -ExpectedAccess "unverified" -ExpectedReason $unverifiedReason -TestName "NVIDIA host with missing nvidia-smi exit code")

Assert-Match -Actual $desktopOutput -Expected "NVIDIA GeForce RTX 4090" -Message "Desktop fixture reports NVIDIA host GPU"
Assert-Match -Actual $desktopOutput -Expected "AMD Radeon RX 7900 XTX" -Message "Desktop fixture reports AMD host GPU"
Assert-Match -Actual $cpuOutput -Expected "none detected" -Message "CPU-only fixture reports no host GPUs"

Write-Host ""
Write-Host "Results: $script:passed passed, $script:failed failed"
if ($script:failed -gt 0) { exit 1 }
