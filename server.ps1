# Simple local static development server for MyLife PWA
param([int]$Port = 5050)

$Root = $PSScriptRoot
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/")
$Listener.Prefixes.Add("http://localhost:$Port/")
$Listener.Start()

Write-Host "MyLife PWA Server running at http://127.0.0.1:$Port/"
Write-Host "Local network access: http://$((Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notlike '*Loopback*' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress):$Port/"
Write-Host "Press Ctrl+C to stop."

$mimeTypes = @{
    ".html" = "text/html; charset=utf-8"
    ".css"  = "text/css; charset=utf-8"
    ".js"   = "application/javascript; charset=utf-8"
    ".json" = "application/json; charset=utf-8"
    ".wasm" = "application/wasm"
    ".svg"  = "image/svg+xml"
    ".png"  = "image/png"
}

while ($Listener.IsListening) {
    try {
        $Context = $Listener.GetContext()
        $req = $Context.Request
        $res = $Context.Response

        $path = $req.Url.LocalPath
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }

        $localFile = [System.IO.Path]::Combine($Root, $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar))

        # Add Cross-Origin Isolation headers for SharedArrayBuffer / OPFS
        $res.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
        $res.Headers.Add("Cross-Origin-Embedder-Policy", "require-corp")
        $res.Headers.Add("Access-Control-Allow-Origin", "*")

        if ([System.IO.File]::Exists($localFile)) {
            $ext = [System.IO.Path]::GetExtension($localFile).ToLower()
            $mime = if ($mimeTypes.ContainsKey($ext)) { $mimeTypes[$ext] } else { "application/octet-stream" }
            $res.ContentType = $mime

            $bytes = [System.IO.File]::ReadAllBytes($localFile)
            $res.ContentLength64 = $bytes.Length
            if ($req.HttpMethod -ne "HEAD") {
                $res.OutputStream.Write($bytes, 0, $bytes.Length)
            }
        } else {
            $res.StatusCode = 404
            $errBytes = [System.Text.Encoding]::UTF8.GetBytes("File Not Found")
            $res.OutputStream.Write($errBytes, 0, $errBytes.Length)
        }
        $res.Close()
    } catch {
        Write-Host "Request error: $_"
    }
}
