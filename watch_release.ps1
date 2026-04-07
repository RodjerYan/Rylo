$ErrorActionPreference = 'SilentlyContinue'

$runId = "24076312878"
$url = "https://api.github.com/repos/RodjerYan/Rylo/actions/runs/$runId/jobs"

while ($true) {
    try {
        $response = Invoke-RestMethod -Uri $url -UseBasicParsing -Headers @{'Accept'='application/vnd.github.v3+json'}
        Clear-Host
        Write-Host "=================================================" -ForegroundColor Cyan
        Write-Host "  LIVE GITHUB ACTIONS STATUS (Rylo v1.0.14)      " -ForegroundColor Cyan
        Write-Host "=================================================" -ForegroundColor Cyan
        Write-Host ""
        
        $allDone = $true
        foreach ($job in $response.jobs) {
            $status = $job.status
            $conclusion = $job.conclusion
            if ($status -eq "completed") {
                if ($conclusion -eq "success") { 
                    Write-Host " [] $($job.name)" -ForegroundColor Green 
                }
                elseif ($conclusion -eq "failure") { 
                    Write-Host " [] $($job.name)" -ForegroundColor Red 
                }
                else { 
                    Write-Host " [?] $($job.name) ($conclusion)" -ForegroundColor Yellow 
                }
            } else {
                $allDone = $false
                Write-Host " [ ] $($job.name) - In Progress..." -ForegroundColor Yellow
                
                if ($job.steps) {
                    $currentStep = $job.steps | Where-Object { $_.status -eq "in_progress" } | Select-Object -First 1
                    if ($currentStep) {
                        Write-Host "     -> Running: $($currentStep.name)" -ForegroundColor Magenta
                    }
                }
            }
        }
        
        Write-Host ""
        if ($allDone) {
            Write-Host "=================================================" -ForegroundColor Cyan
            Write-Host " BUILD WORKFLOW COMPLETED! " -ForegroundColor Green
            Write-Host "=================================================" -ForegroundColor Cyan
            break
        }
    } catch {
        # Silently retry on API errors
    }
    
    Start-Sleep -Seconds 5
}
