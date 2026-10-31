param(
    [string]$ScriptPath = (Join-Path $PSScriptRoot "..\scripts\detect-profile.ps1")
)

# Verified NVIDIA (nvidia-smi + docker nvidia runtime)
$fixtureJson = @{
    nvidiaSmiOutput   = "NVIDIA GeForce RTX 4090, 24576"
    dockerRuntimesJson = '{"nvidia": {"path": "nvidia-container-runtime"}, "runc": {"path": "runc"}}'
    ramGB             = 32
    hostGpuNames      = @(
        "NVIDIA GeForce RTX 4090"
        "AMD Radeon RX 7900 XTX"
    )
} | ConvertTo-Json -Depth 3

# Laptop tier - verified
$laptopFixture = @{
    nvidiaSmiOutput   = "NVIDIA GeForce RTX 3070 Laptop, 8192"
    dockerRuntimesJson = '{"nvidia": {"path": "nvidia-container-runtime"}, "runc": {"path": "runc"}}'
    ramGB             = 16
    hostGpuNames      = @(
        "NVIDIA GeForce RTX 3070 Laptop"
    )
} | ConvertTo-Json -Depth 3

# Minimal - no NVIDIA VRAM
$minimalFixture = @{
    nvidiaSmiOutput   = ""
    dockerRuntimesJson = '{"runc": {"path": "runc"}}'
    ramGB             = 8
    hostGpuNames      = @(
        "Intel UHD Graphics"
    )
} | ConvertTo-Json -Depth 3

# Empty GPU
$emptyGpuFixture = @{
    nvidiaSmiOutput   = ""
    dockerRuntimesJson = '{"runc": {"path": "runc"}}'
    ramGB             = 4
    hostGpuNames      = @()
} | ConvertTo-Json -Depth 3

# AMD-only fixture (no NVIDIA GPU)
$amdOnlyFixture = @{
    nvidiaSmiOutput   = ""
    dockerRuntimesJson = '{"runc": {"path": "runc"}}'
    ramGB             = 32
    hostGpuNames      = @(
        "AMD Radeon RX 7900 XTX"
    )
} | ConvertTo-Json -Depth 3

# NVIDIA GPU but no docker nvidia runtime (unverified)
$nvidiaUnverifiedFixture = @{
    nvidiaSmiOutput   = "NVIDIA GeForce RTX 3070, 8192"
    dockerRuntimesJson = '{"runc": {"path": "runc"}}'
    ramGB             = 16
    hostGpuNames      = @(
        "NVIDIA GeForce RTX 3070"
    )
} | ConvertTo-Json -Depth 3

# NVIDIA GPU with sufficient VRAM/RAM but no docker runtime - should be minimal
$nvidiaNoRuntimeFixture = @{
    nvidiaSmiOutput   = "NVIDIA GeForce RTX 4090, 24576"
    dockerRuntimesJson = '{"runc": {"path": "runc"}}'
    ramGB             = 32
    hostGpuNames      = @(
        "NVIDIA GeForce RTX 4090"
    )
} | ConvertTo-Json -Depth 3

$script:passed = 0
$script:failed = 0

function Assert-Match($actual, $expected, $message) {
    if ($actual -match $expected) {
        Write-Host "[PASS] $message" -ForegroundColor Green
        $script:passed++
    } else {
        Write-Host "[FAIL] $message" -ForegroundColor Red
        Write-Host "  Expected match: $expected" -ForegroundColor Red
        Write-Host "  Actual: $actual" -ForegroundColor Red
        $script:failed++
    }
}

function RunTest($fixture, $expectedProfile, $expectedAccess, $expectedReason, $testName) {
    $output = & $ScriptPath -Fixture $fixture *>&1 | Out-String
    Assert-Match $output "Recommended profile: $expectedProfile" "$testName - profile is $expectedProfile"
    Assert-Match $output "Container GPU access: $expectedAccess" "$testName - access is $expectedAccess"
    # Check that no live probes were invoked in fixture mode (nvidia-smi/docker info not called)
    Assert-Match $output "Detected hardware:" "$testName - output shows detected hardware header"
}

RunTest $fixtureJson "desktop" "verified" "verified" "Desktop tier fixture (verified NVIDIA)"
RunTest $laptopFixture "laptop" "verified" "verified" "Laptop tier fixture (verified NVIDIA)"
RunTest $minimalFixture "minimal" "none" "none" "Minimal tier fixture (no NVIDIA VRAM)"
RunTest $emptyGpuFixture "minimal" "none" "none" "Empty GPU fixture"
RunTest $amdOnlyFixture "minimal" "none" "none" "AMD-only fixture (no NVIDIA)"
RunTest $nvidiaUnverifiedFixture "minimal" "unverified" "unverified" "NVIDIA unverified fixture (no docker runtime)"
RunTest $nvidiaNoRuntimeFixture "minimal" "unverified" "unverified" "NVIDIA high VRAM but no docker runtime (should be minimal)"

# Test host GPU inventory output
$output = & $ScriptPath -Fixture $fixtureJson *>&1 | Out-String
Assert-Match $output "NVIDIA GeForce RTX 4090" "Desktop fixture - NVIDIA GPU in output"
Assert-Match $output "AMD Radeon RX 7900 XTX" "Desktop fixture - AMD GPU in output"

$output = & $ScriptPath -Fixture $emptyGpuFixture *>&1 | Out-String
Assert-Match $output "none detected" "Empty GPU fixture - 'none detected' shown"

# Test container GPU access output
$output = & $ScriptPath -Fixture $fixtureJson *>&1 | Out-String
Assert-Match $output "Container GPU access: verified" "Desktop fixture - container access verified"

$output = & $ScriptPath -Fixture $amdOnlyFixture *>&1 | Out-String
Assert-Match $output "Container GPU access: none" "AMD-only fixture - container access none"

$output = & $ScriptPath -Fixture $nvidiaUnverifiedFixture *>&1 | Out-String
Assert-Match $output "Container GPU access: unverified" "NVIDIA unverified fixture - container access unverified"

$output = & $ScriptPath -Fixture $nvidiaNoRuntimeFixture *>&1 | Out-String
Assert-Match $output "Container GPU access: unverified" "NVIDIA no runtime fixture - container access unverified"

Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }