# Simple local static development server & LLM proxy for MyLife PWA
param([int]$Port = 5050)

Add-Type -AssemblyName System.Net.Http

$Root = $PSScriptRoot
$Listener = New-Object System.Net.HttpListener
$Listener.Prefixes.Add("http://127.0.0.1:$Port/")
$Listener.Start()

Write-Host "======================================================"
Write-Host "  MyLife PWA Server running at http://127.0.0.1:$Port/"
Write-Host "  LLM Proxy: http://127.0.0.1:$Port/api/llm/ -> http://127.0.0.1:8081/"
Write-Host "======================================================"
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

$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.Timeout = [TimeSpan]::FromMinutes(5)

while ($Listener.IsListening) {
    $Context = $null
    try {
        $Context = $Listener.GetContext()
        $req = $Context.Request
        $res = $Context.Response

        $path = $req.Url.LocalPath
        if ($path -eq "/" -or $path -eq "") { $path = "/index.html" }

        # Always add Cross-Origin Isolation headers for SharedArrayBuffer / OPFS SQLite
        $res.Headers.Add("Cross-Origin-Opener-Policy", "same-origin")
        $res.Headers.Add("Cross-Origin-Embedder-Policy", "require-corp")
        $res.Headers.Add("Access-Control-Allow-Origin", "*")
        $res.Headers.Add("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE")
        $res.Headers.Add("Access-Control-Allow-Headers", "Content-Type, Authorization, *")

        # Handle CORS preflight immediately
        if ($req.HttpMethod -eq "OPTIONS") {
            $res.StatusCode = 200
            continue
        }

        # Transparent LLM Proxy to local llama-server on port 8081
        if ($path.StartsWith("/api/llm/")) {
            $subPath = $path.Substring(8)
            $targetUrl = "http://127.0.0.1:8081$subPath"

            $httpMethod = [System.Net.Http.HttpMethod]::new($req.HttpMethod)
            $httpReq = [System.Net.Http.HttpRequestMessage]::new($httpMethod, $targetUrl)

            if ($req.HasEntityBody) {
                $ms = New-Object System.IO.MemoryStream
                $req.InputStream.CopyTo($ms)
                $bodyBytes = $ms.ToArray()
                $ms.Dispose()

                $httpReq.Content = [System.Net.Http.ByteArrayContent]::new($bodyBytes)
                if ($req.ContentType) {
                    $httpReq.Content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($req.ContentType)
                }
            }

            try {
                $httpRes = $httpClient.SendAsync($httpReq, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
                $res.StatusCode = [int]$httpRes.StatusCode
                if ($httpRes.Content.Headers.ContentType) {
                    $res.ContentType = $httpRes.Content.Headers.ContentType.ToString()
                }

                $stream = $httpRes.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
                $buf = New-Object byte[] 4096
                while (($n = $stream.Read($buf, 0, $buf.Length)) -gt 0) {
                    $res.OutputStream.Write($buf, 0, $n)
                    $res.OutputStream.Flush()
                }
                $stream.Close()
                $httpRes.Dispose()
            } catch {
                $res.StatusCode = 502
                $errMsg = [System.Text.Encoding]::UTF8.GetBytes("Cannot connect to local LLM server on port 8081. Verify llama-server is running.")
                $res.OutputStream.Write($errMsg, 0, $errMsg.Length)
            }
            continue
        }

        # Static file delivery
        $localFile = [System.IO.Path]::Combine($Root, $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar))

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
    } catch {
        Write-Host "Request error: $_"
    } finally {
        if ($Context -and $Context.Response) {
            try { $Context.Response.Close() } catch {}
        }
    }
}
