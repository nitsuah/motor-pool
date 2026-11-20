param(
    [string]$ScriptPath = (Join-Path $PSScriptRoot "..\tools\website\scripts\invoice.ps1")
)
$ErrorActionPreference = "Stop"
$failed = 0
function Assert-That([bool]$Cond, [string]$Name) {
    if ($Cond) { Write-Host "  ok  $Name" } else { Write-Host "  FAIL $Name"; $script:failed++ }
}

$out = Join-Path ([System.IO.Path]::GetTempPath()) ("invoice-test-" + [guid]::NewGuid().ToString("N"))
try {
    $payload = '<img src=x onerror=alert(1)>'
    & pwsh -NoProfile -File $ScriptPath -Slug "acme-1" -ClientName $payload -Description "<script>x</script> & more" -InvoiceNum "INV-1" -OutputDir $out | Out-Null
    $file = Join-Path $out "acme-1" "invoice" "INV-1.html"
    Assert-That (Test-Path $file) "invoice written"
    $html = Get-Content -Raw $file
    Assert-That (-not $html.Contains($payload)) "client name is not emitted as markup"
    Assert-That $html.Contains('&lt;img src=x onerror=alert(1)&gt;') "client name is HTML-encoded"
    Assert-That (-not $html.Contains('<script>x</script>')) "description is not emitted as markup"
    Assert-That $html.Contains('&lt;script&gt;x&lt;/script&gt; &amp; more') "description is HTML-encoded"

    & pwsh -NoProfile -File $ScriptPath -Slug "acme-1" -ClientName "Acme" -InvoiceNum "..\..\evil" -OutputDir $out 2>$null | Out-Null
    Assert-That ($LASTEXITCODE -ne 0) "path-like invoice number is refused"
    Assert-That (-not (Test-Path (Join-Path $out "evil.html"))) "nothing written outside the invoice directory"
} finally {
    Remove-Item -Recurse -Force $out -ErrorAction SilentlyContinue
}
if ($failed -gt 0) { Write-Host "$failed check(s) failed"; exit 1 }
Write-Host "invoice tests passed"
