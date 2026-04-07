$ErrorActionPreference = "Stop"

$Version = "local-release"
Write-Host "Creating Release directory..."
if (-not (Test-Path "Release")) {
    New-Item -ItemType Directory -Path "Release" | Out-Null
}

Write-Host "Building Server..."
Set-Location Server
go build -o ../Release/chatserver.exe -ldflags "-s -w -X main.version=$Version" .
Set-Location ..

Write-Host "Configuring Client (disabling updater artifacts for local build)..."
$path = "Client/tauri-client/src-tauri/tauri.conf.json"
$json = Get-Content $path -Raw | ConvertFrom-Json
$json.bundle.createUpdaterArtifacts = $false
$jsonString = $json | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding $False
[System.IO.File]::WriteAllText("$PWD/$path", $jsonString, $utf8NoBom)

Write-Host "Building Client..."
Set-Location Client/tauri-client
npm install
npm run tauri build
Set-Location ../../

Write-Host "Copying Client Artifacts..."
if (Test-Path "Client/tauri-client/src-tauri/target/release/rylo-client.exe") {
    Copy-Item "Client/tauri-client/src-tauri/target/release/rylo-client.exe" -Destination "Release/"
}

$installer = Get-ChildItem -Path "Client/tauri-client/src-tauri/target/release/bundle/nsis/*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($installer) {
    Copy-Item $installer.FullName -Destination "Release/"
}

Write-Host "Done! Local release artifacts are in the 'Release' folder."
