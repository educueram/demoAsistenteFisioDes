# Test del endpoint de reconocimiento inteligente
$headers = @{
    "Content-Type" = "application/json"
}

$body = @{
    telefono = "+5214495847679"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri "http://localhost:3000/api/reconocer-cliente" -Method POST -Headers $headers -Body $body
    Write-Host "Response:"
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "Error: $($_.Exception.Message)"
    Write-Host "Response: $($_.Exception.Response.GetResponseStream())"
}
