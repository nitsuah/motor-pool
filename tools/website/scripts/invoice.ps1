# Generate a professional HTML invoice for a client
# Usage: .\invoice.ps1 -Slug "acme-pizza-90210" -ClientName "Acme Pizza" -Amount 500
param(
    [Parameter(Mandatory)]
    [string]$Slug,

    [Parameter(Mandatory)]
    [string]$ClientName,

    [decimal]$Amount       = 500,
    [string] $Description  = "Website Design & Development — One-time setup",
    [string] $InvoiceNum   = "",
    [string] $DueDate      = "",
    [switch] $Monthly,               # generates $50/month recurring invoice instead
    [string] $OutputDir    = ""      # defaults to ../output (host and container safe)
)

$ErrorActionPreference = "Stop"
if ($Slug -cnotmatch '^[a-z0-9][a-z0-9-]{0,99}$') {
    Write-Error "Invalid -Slug: use lowercase letters, digits and hyphens only."
    exit 1
}
$outputRoot  = if ($OutputDir) { $OutputDir } else { Join-Path $PSScriptRoot ".." "output" }
$invoiceDir  = Join-Path $outputRoot $Slug "invoice"
New-Item -ItemType Directory -Force $invoiceDir | Out-Null

# ── Load .env ─────────────────────────────────────────────────────────────────
$envFile = Join-Path $PSScriptRoot ".." ".env"
$cfg = @{}
if (Test-Path $envFile) {
    Get-Content $envFile | Where-Object { $_ -match '^\s*[^#]\S+=\S' } | ForEach-Object {
        $parts = $_ -split '=', 2
        $cfg[$parts[0].Trim()] = $parts[1].Trim().Trim('"').Trim("'")
    }
}
$YourName    = $cfg['YOUR_NAME']    ?? "Your Name"
$YourCompany = $cfg['YOUR_COMPANY'] ?? "Your Web Agency"
$YourEmail   = $cfg['YOUR_EMAIL']   ?? "you@example.com"
$YourPhone   = $cfg['YOUR_PHONE']   ?? ""

if ($Monthly) {
    $Amount      = [decimal]($cfg['PRICE_MONTHLY'] ?? 50)
    $Description = "Website Maintenance & Hosting — Monthly"
}

$today      = Get-Date
$invoiceDate = $today.ToString("MMMM d, yyyy")
if (-not $InvoiceNum)  { $InvoiceNum = "INV-" + $today.ToString("yyyyMMdd") + "-" + ($Slug.Substring(0, [Math]::Min(6, $Slug.Length)).ToUpper()) }
if (-not $DueDate)     { $DueDate    = $today.AddDays(14).ToString("MMMM d, yyyy") }

$outFile = Join-Path $invoiceDir "$InvoiceNum.html"

$html = @"
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Invoice $InvoiceNum</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 font-sans p-8">
<div class="max-w-2xl mx-auto bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">

  <!-- Header -->
  <div class="bg-indigo-600 text-white px-8 py-6 flex justify-between items-start">
    <div>
      <h1 class="text-2xl font-bold">$YourCompany</h1>
      <p class="text-indigo-200 text-sm mt-1">$YourEmail</p>
      $(if ($YourPhone) { "<p class='text-indigo-200 text-sm'>$YourPhone</p>" })
    </div>
    <div class="text-right">
      <p class="text-indigo-200 text-sm uppercase tracking-wide">Invoice</p>
      <p class="text-xl font-bold mt-1">$InvoiceNum</p>
    </div>
  </div>

  <!-- Meta -->
  <div class="px-8 py-6 border-b border-gray-100 flex justify-between text-sm">
    <div>
      <p class="text-gray-500">Bill To</p>
      <p class="font-semibold text-gray-800 mt-1">$ClientName</p>
    </div>
    <div class="text-right">
      <p class="text-gray-500">Invoice Date: <span class="text-gray-800">$invoiceDate</span></p>
      <p class="text-gray-500 mt-1">Due Date: <span class="font-semibold text-gray-800">$DueDate</span></p>
    </div>
  </div>

  <!-- Line items -->
  <div class="px-8 py-6">
    <table class="w-full text-sm">
      <thead>
        <tr class="border-b border-gray-200 text-gray-500 uppercase tracking-wide text-xs">
          <th class="text-left py-2">Description</th>
          <th class="text-right py-2">Amount</th>
        </tr>
      </thead>
      <tbody>
        <tr class="border-b border-gray-100">
          <td class="py-4 text-gray-800">$Description</td>
          <td class="py-4 text-right font-semibold text-gray-800">`$$Amount</td>
        </tr>
      </tbody>
      <tfoot>
        <tr>
          <td class="pt-4 text-gray-500">Total Due</td>
          <td class="pt-4 text-right text-xl font-bold text-indigo-600">`$$Amount</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <!-- Payment -->
  <div class="px-8 pb-8">
    <div class="bg-gray-50 rounded-lg p-4 text-sm text-gray-600">
      <p class="font-semibold text-gray-800 mb-2">Payment Methods</p>
      <p>Venmo / PayPal / Zelle / Check — contact $YourEmail for details.</p>
      <p class="mt-2 text-xs text-gray-400">Payment due within 14 days of invoice date. Thank you for your business!</p>
    </div>
  </div>

</div>
<div class="max-w-2xl mx-auto mt-4 text-center">
  <button onclick="window.print()" class="bg-indigo-600 text-white px-6 py-2 rounded-lg text-sm hover:bg-indigo-700">Print / Save as PDF</button>
</div>
</body>
</html>
"@

$html | Set-Content -Encoding UTF8 $outFile
Write-Host "✓ Invoice: $outFile" -ForegroundColor Green
Write-Host "  Open in browser and use Print → Save as PDF to share with client." -ForegroundColor Cyan
