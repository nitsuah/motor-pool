param(
    [string]$ScriptPath = (Join-Path $PSScriptRoot "..\scripts\detect-profile.ps1")
)

$fixtureJson = @{
    vramMB    = 16384
    gpuName   = "NVIDIA GeForce RTX 4090"
    ramGB     = 32
    hostGpus  = @(
        @{ Name = "NVIDIA GeForce RTX 4090"; Vendor = "NVIDIA" }
        @{ Name = "AMD Radeon RX 7900 XTX"; Vendor = "AMD" }
    )
} | ConvertTo-Json -Depth 3

$laptopFixture = @{
    vramMB    = 8192
    gpuName   = "NVIDIA GeForce RTX 3070 Laptop"
    ramGB     = 16
    hostGpus  = @(
        @{ Name = "NVIDIA GeForce RTX 3070 Laptop"; Vendor = "NVIDIA" }
    )
} | ConvertTo-Json -Depth 3

$minimalFixture = @{
    vramMB    = 2048
    gpuName   = "Intel UHD Graphics"
    ramGB     = 8
    hostGpus  = @(
        @{ Name = "Intel UHD Graphics"; Vendor = "Intel" }
    )
} | ConvertTo-Json -Depth 3

$emptyGpuFixture = @{
    vramMB    = 0
    gpuName   = "none"
    ramGB     = 4
    hostGpus  = @()
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

function RunTest($fixture, $expectedProfile, $testName) {
    $output = & $ScriptPath -Fixture $fixture *>&1 | Out-String
    Assert-Match $output "Recommended profile: $expectedProfile" "$testName - profile is $expectedProfile"
}

RunTest $fixtureJson "desktop" "Desktop tier fixture"
RunTest $laptopFixture "laptop" "Laptop tier fixture"
RunTest $minimalFixture "minimal" "Minimal tier fixture"
RunTest $emptyGpuFixture "minimal" "Empty GPU fixture"

# Test host GPU inventory output
$output = & $ScriptPath -Fixture $fixtureJson *>&1 | Out-String
Assert-Match $output "NVIDIA GeForce RTX 4090" "Desktop fixture - NVIDIA GPU in output"
Assert-Match $output "AMD Radeon RX 7900 XTX" "Desktop fixture - AMD GPU in output"

$output = & $ScriptPath -Fixture $emptyGpuFixture *>&1 | Out-String
Assert-Match $output "none detected" "Empty GPU fixture - 'none detected' shown"

Write-Host ""
Write-Host "Results: $passed passed, $failed failed"
if ($failed -gt 0) { exit 1 }