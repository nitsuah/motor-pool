#!/usr/bin/env pwsh

# Agent Stack Manager
# Manages the motor-pool docker compose stack

param(
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$ComposeFile = "$PSScriptRoot/../config/docker-compose.yml"
# Compose interpolates from the root .env (the project directory is config/).
$EnvFile = "$PSScriptRoot/../.env"

function Write-Header {
    param([string]$text)
    Write-Host ""
    Write-Host "=== $text ===" -ForegroundColor Cyan
    Write-Host ""
}

function Start-Stack {
    Write-Header "Starting Agent Stack"
    docker compose --env-file $EnvFile -f $ComposeFile up -d
    Show-Status
}

function Stop-Stack {
    Write-Header "Stopping Agent Stack"
    docker compose --env-file $EnvFile -f $ComposeFile down
}

function Restart-Stack {
    Write-Header "Restarting Agent Stack"
    docker compose --env-file $EnvFile -f $ComposeFile restart
    Show-Status
}

function Show-Status {
    Write-Header "Service Status"
    docker compose --env-file $EnvFile -f $ComposeFile ps
    Write-Host ""
    Write-Host "Endpoints:" -ForegroundColor Cyan
    Write-Host "  Dashboard:   http://localhost:3000"
    Write-Host "  Ollama API:  http://localhost:8081"
    Write-Host "  NemoClaw:    http://localhost:9000"
    Write-Host ""
}

function Show-Logs {
    Write-Header "Recent Logs"
    docker compose --env-file $EnvFile -f $ComposeFile logs --tail=50
}

switch ($Action) {
    'start'   { Start-Stack }
    'stop'    { Stop-Stack }
    'restart' { Restart-Stack }
    'status'  { Show-Status }
    'logs'    { Show-Logs }
}
