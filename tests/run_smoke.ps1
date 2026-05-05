$max=15
for ($i=0; $i -lt $max; $i++) {
  try {
    $null = Invoke-RestMethod -Uri 'http://localhost:5000/' -Method Get -TimeoutSec 2
    Write-Output 'SERVER_UP'
    break
  } catch {
    Start-Sleep -Seconds 1
    if ($i -eq $max-1) { Write-Error 'SERVER_NOT_UP'; exit 1 }
  }
}

Write-Output '--- GENERATE QR ---'
try {
  $body = @{ medicine = @{ name = 'TestMed'; dosage = '10mg' } } | ConvertTo-Json -Depth 5
  $res = Invoke-RestMethod -Uri 'http://localhost:5000/api/generate-qr' -Method Post -ContentType 'application/json' -Body $body -UseBasicParsing
  $res | ConvertTo-Json -Depth 5

  # if image returned, decode and POST back as file for scan roundtrip
  if ($res.image) {
    $tmp = [System.IO.Path]::GetTempFileName() + '.png'
    $bytes = [System.Convert]::FromBase64String($res.image)
    [System.IO.File]::WriteAllBytes($tmp, $bytes)
    Write-Output "Wrote temp QR to $tmp"

    Write-Output '--- SCAN QR (ROUNDTRIP) ---'
    try {
      # Use HttpClient to POST multipart form-data (compatible with PowerShell 5.1)
      # Use WebClient.UploadFile to POST multipart form-data (works on older PowerShell)
      $wc = New-Object System.Net.WebClient
      try { $wc.Headers.Add('User-Agent','run_smoke') } catch {}
      $respBytes = $wc.UploadFile('http://localhost:5000/api/scan-qr', $tmp)
      $body = [System.Text.Encoding]::UTF8.GetString($respBytes)
      Write-Output $body
    } catch {
      Write-Output 'scan-qr error:'
      Write-Output $_.Exception.Message
      if ($_.Exception.Response) {
        try { $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); Write-Output $sr.ReadToEnd() } catch {}
      }
    } finally {
      Remove-Item $tmp -ErrorAction SilentlyContinue
    }
  }

} catch {
  Write-Output 'generate-qr error:'
  Write-Output $_.Exception.Message
  if ($_.Exception.Response) {
    try { $sr = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream()); Write-Output $sr.ReadToEnd() } catch {}
  }
}
