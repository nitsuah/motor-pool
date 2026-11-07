# Deploy a generated site to Netlify
# Usage: .\deploy.ps1 -Slug "acme-pizza-90210" [-SiteName "acme-pizza"] [-Draft]
param(
    [Parameter(Mandatory)]
    [string]$Slug,

    [string]$SiteName  = "",  # custom Netlify subdomain (slug used if blank)
    [switch]$Draft,           # preview deploy (no --prod flag)
    [string]$OutputDir = ""   # defaults to ../output (correct on host and in container)
)

$ErrorActionPreference = "Stop"
if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]{0,99}$') {
    Write-Error "Invalid -Slug: use lowercase letters, digits and hyphens only."
    exit 1
}
$outputRoot = if ($OutputDir) { $OutputDir } else { Join-Path $PSScriptRoot ".." "output" }
$siteDir    = Join-Path $outputRoot $Slug "site"

# ── Validate ──────────────────────────────────────────────────────────────────
if (-not (Test-Path $siteDir)) {
    Write-Host "✗ Site directory not found: $siteDir" -ForegroundColor Red
    Write-Host "  Run /site-gen build $Slug first." -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path (Join-Path $siteDir "index.html"))) {
    Write-Host "✗ No index.html in $siteDir" -ForegroundColor Red
    exit 1
}

# ── Check Netlify CLI ─────────────────────────────────────────────────────────
$netlifyVer = netlify --version 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "✗ netlify-cli not installed. Run: npm install -g netlify-cli" -ForegroundColor Red
    exit 1
}
Write-Host "✓ $netlifyVer" -ForegroundColor Green

# ── Check login ───────────────────────────────────────────────────────────────
$status = netlify status 2>&1
if ($status -match "Not logged in") {
    Write-Host "✗ Not logged in to Netlify. Run: netlify login" -ForegroundColor Red
    exit 1
}
Write-Host "✓ Netlify authenticated" -ForegroundColor Green

# ── Create or link site ───────────────────────────────────────────────────────
$tomlFile = Join-Path $siteDir ".netlify" "state.json"
if (-not (Test-Path $tomlFile)) {
    $netlifyName = if ($SiteName) { $SiteName } else { $Slug }
    Write-Host "Creating new Netlify site: $netlifyName..." -ForegroundColor Cyan
    Set-Location $siteDir
    netlify sites:create --name $netlifyName --disable-linking 2>&1 | Tee-Object -Variable siteCreateOutput
    if ($LASTEXITCODE -ne 0) {
        Write-Host "⚠ Could not auto-create named site (name may be taken). Netlify will assign a random name." -ForegroundColor Yellow
    }
} else {
    Set-Location $siteDir
}

# ── Deploy ────────────────────────────────────────────────────────────────────
Write-Host "Deploying $siteDir..." -ForegroundColor Cyan
$deployArgs = @("deploy", "--dir", ".", "--message", "site-gen deploy $Slug")
if (-not $Draft) { $deployArgs += "--prod" }

$deployOutput = netlify @deployArgs 2>&1
$deployOutput | ForEach-Object { Write-Host $_ }

# ── Extract URL ───────────────────────────────────────────────────────────────
$liveUrl = ($deployOutput | Select-String -Pattern "https://[a-z0-9\-]+\.netlify\.app" -AllMatches).Matches.Value | Select-Object -Last 1
if (-not $liveUrl) {
    $liveUrl = ($deployOutput | Select-String -Pattern "Website URL:\s+(.+)" | ForEach-Object { $_.Matches[0].Groups[1].Value }) | Select-Object -Last 1
}

if ($liveUrl) {
    Write-Host ""
    Write-Host "✓ Deployed: $liveUrl" -ForegroundColor Green
    Write-Host "  Netlify dashboard: https://app.netlify.com" -ForegroundColor Cyan
} else {
    Write-Host "⚠ Deploy may have succeeded but could not extract URL. Check Netlify dashboard." -ForegroundColor Yellow
}
