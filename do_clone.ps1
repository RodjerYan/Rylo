$ErrorActionPreference = "Stop"
git clone https://github.com/RodjerYan/Rylo C:\tmp\RyloGit
Copy-Item -Path C:\tmp\RyloGit\.git -Destination . -Recurse -Force
git add .
git commit -m "chore: release v1.0.13"
git tag v1.0.13
git push origin main
git push origin v1.0.13
Write-Host "Success!"
