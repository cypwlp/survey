$ErrorActionPreference = 'Continue'
Set-Location 'D:\WORK\Survey-System'

Write-Host ''
Write-Host '=== 1/3 Commit and push to GitHub ===' -ForegroundColor Cyan
git add cloudfunctions/osurvey cloudrun web tools/deploy-web.ps1
git commit -m "Multi-user accounts, per-survey ownership, WeChat binding and merge"

$env:HTTPS_PROXY = 'http://127.0.0.1:7892'
$env:HTTP_PROXY = 'http://127.0.0.1:7892'
git push origin main

Write-Host ''
Write-Host '=== 2/3 Deploy cloud function osurvey ===' -ForegroundColor Cyan
$cli = Get-ChildItem -Path 'D:\*\cli.bat' -ErrorAction SilentlyContinue | Where-Object {
  (Test-Path (Join-Path $_.DirectoryName 'cli.js')) -and (Test-Path (Join-Path $_.DirectoryName 'resources\app.asar'))
} | Select-Object -First 1

if ($cli) {
  & $cli.FullName cloud functions deploy --env cloud1-d2g83jh3td8664c67 --project 'D:\WORK\Survey-System' --names osurvey --remote-npm-install
} else {
  Write-Host 'DevTools CLI not found.' -ForegroundColor Yellow
  Write-Host 'In DevTools, right-click cloudfunctions/osurvey and choose: Upload and deploy - install dependencies in cloud.' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '=== 3/3 Done ===' -ForegroundColor Green
Write-Host 'CloudRun will auto-deploy from GitHub in about 1 minute.'
Write-Host 'URL: https://xiaoweiwenjuan-335599-10-1509118380.sh.run.tcloudbase.com/'
Write-Host ''
Read-Host 'Press Enter to close'
