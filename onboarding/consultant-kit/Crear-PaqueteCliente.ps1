[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Plantilla,
    [string]$ClavePublica,
    [string]$Salida,
    [string]$Consultor = "$env:USERDOMAIN\$env:USERNAME",
    [switch]$ExigirFirma,
    [Security.SecureString]$TokenSeguro,
    [hashtable]$ApiKeysSeguras
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($ClavePublica)) {
    $ClavePublica = Join-Path $PSScriptRoot "platform-public-key.json"
}
$ExpectedCryptoSourceSha256 = "e5a104866d976d1f0143debf6fd0c8bc3c5d59c6f2a35f46819a81303cf20d34"
$ExpectedPublicMaterialFingerprint = "8274ba9929378daa04824e27dd4d13519d959b61697906561329bf2191d2eb77"

function Convert-SecureStringToPlainText {
    param([Security.SecureString]$SecureValue)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Get-Sha256Hex {
    param([byte[]]$Bytes)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return (($sha.ComputeHash($Bytes) | ForEach-Object { $_.ToString("x2") }) -join "") }
    finally { $sha.Dispose() }
}

function Convert-CellReferenceToIndex {
    param([string]$Reference)
    $letters = ([regex]::Match($Reference, "^[A-Z]+")).Value
    $index = 0
    foreach ($character in $letters.ToCharArray()) {
        $index = ($index * 26) + ([int]$character - [int][char]'A' + 1)
    }
    return $index - 1
}

function Get-XlsxData {
    param([string]$Path)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        function Read-EntryXml([string]$Name) {
            $entry = $archive.GetEntry($Name)
            if (-not $entry) { throw "La plantilla no contiene $Name." }
            $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8)
            try { return [xml]$reader.ReadToEnd() } finally { $reader.Dispose() }
        }
        $sharedStrings = @()
        $sharedEntry = $archive.GetEntry("xl/sharedStrings.xml")
        if ($sharedEntry) {
            $reader = [IO.StreamReader]::new($sharedEntry.Open(), [Text.Encoding]::UTF8)
            try {
                [xml]$sharedXml = $reader.ReadToEnd()
                $manager = [Xml.XmlNamespaceManager]::new($sharedXml.NameTable)
                $manager.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
                foreach ($item in $sharedXml.SelectNodes("//x:si", $manager)) {
                    $parts = $item.SelectNodes(".//x:t", $manager) | ForEach-Object { $_.get_InnerText() }
                    $sharedStrings += ($parts -join "")
                }
            } finally { $reader.Dispose() }
        }
        $workbook = Read-EntryXml "xl/workbook.xml"
        $relations = Read-EntryXml "xl/_rels/workbook.xml.rels"
        $wbNs = [Xml.XmlNamespaceManager]::new($workbook.NameTable)
        $wbNs.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
        $wbNs.AddNamespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
        $relNs = [Xml.XmlNamespaceManager]::new($relations.NameTable)
        $relNs.AddNamespace("p", "http://schemas.openxmlformats.org/package/2006/relationships")
        $targets = @{}
        foreach ($rel in $relations.SelectNodes("//p:Relationship", $relNs)) {
            $targets[$rel.GetAttribute("Id")] = $rel.GetAttribute("Target")
        }
        $result = @{}
        foreach ($sheet in $workbook.SelectNodes("//x:sheets/x:sheet", $wbNs)) {
            $id = $sheet.GetAttribute("id", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
            $target = $targets[$id].Replace("\", "/").TrimStart("/")
            $entryName = if ($target.StartsWith("xl/")) { $target } else { "xl/$target" }
            $sheetXml = Read-EntryXml $entryName
            $sheetNs = [Xml.XmlNamespaceManager]::new($sheetXml.NameTable)
            $sheetNs.AddNamespace("x", "http://schemas.openxmlformats.org/spreadsheetml/2006/main")
            $rows = @()
            foreach ($rowNode in $sheetXml.SelectNodes("//x:sheetData/x:row", $sheetNs)) {
                $row = @{}
                foreach ($cell in $rowNode.SelectNodes("./x:c", $sheetNs)) {
                    $column = Convert-CellReferenceToIndex $cell.GetAttribute("r")
                    $type = $cell.GetAttribute("t")
                    $value = ""
                    if ($type -eq "inlineStr") {
                        $value = (($cell.SelectNodes(".//x:t", $sheetNs) | ForEach-Object { $_.get_InnerText() }) -join "")
                    } else {
                        $valueNode = $cell.SelectSingleNode("./x:v", $sheetNs)
                        if ($null -eq $valueNode) {
                            $row[$column] = $value
                            continue
                        }
                        $rawValue = $valueNode.get_InnerText()
                        if ($type -eq "s") { $value = $sharedStrings[[int]$rawValue] }
                        elseif ($type -eq "b") { $value = ([int]$rawValue -eq 1) }
                        else { $value = $rawValue }
                    }
                    $row[$column] = $value
                }
                $rows += ,$row
            }
            $result[$sheet.GetAttribute("name")] = $rows
        }
        return $result
    } finally {
        $archive.Dispose()
    }
}

function Convert-RowsToRecords {
    param(
        [object[]]$Rows,
        [string]$FirstHeader
    )
    $headerIndex = -1
    for ($i = 0; $i -lt $Rows.Count; $i++) {
        if ([string]$Rows[$i][0] -eq $FirstHeader) { $headerIndex = $i; break }
    }
    if ($headerIndex -lt 0) { throw "No se encontró el encabezado '$FirstHeader'." }
    $headers = @{}
    foreach ($column in $Rows[$headerIndex].Keys) {
        $header = ([string]$Rows[$headerIndex][$column]).Trim()
        if ($header) { $headers[[int]$column] = $header }
    }
    $records = @()
    for ($i = $headerIndex + 1; $i -lt $Rows.Count; $i++) {
        $record = [ordered]@{}
        $hasValue = $false
        foreach ($column in $headers.Keys) {
            $value = if ($Rows[$i].ContainsKey($column)) { $Rows[$i][$column] } else { "" }
            $record[$headers[$column]] = $value
            if ([string]$value) { $hasValue = $true }
        }
        if ($hasValue) { $records += [pscustomobject]$record }
    }
    return $records
}

function Convert-ToBoolean {
    param($Value)
    if ($Value -is [bool]) { return $Value }
    return ([string]$Value).Trim() -match "^(true|si|sí|1)$"
}

if ($ExigirFirma) {
    $signature = Get-AuthenticodeSignature -FilePath $PSCommandPath
    if ($signature.Status -ne "Valid") {
        throw "La herramienta no tiene una firma Authenticode corporativa válida."
    }
}

$templatePath = (Resolve-Path -LiteralPath $Plantilla).Path
$publicKeyPath = (Resolve-Path -LiteralPath $ClavePublica).Path
if ([IO.Path]::GetExtension($templatePath) -ne ".xlsx") { throw "La plantilla debe ser .xlsx." }

$cryptoSource = Join-Path $PSScriptRoot "OdooAiPortableCrypto.cs"
if (-not (Test-Path -LiteralPath $cryptoSource)) { throw "Falta OdooAiPortableCrypto.cs." }
$cryptoSourceHash = (Get-FileHash -LiteralPath $cryptoSource -Algorithm SHA256).Hash.ToLowerInvariant()
if ($cryptoSourceHash -ne $ExpectedCryptoSourceSha256) {
    throw "El componente criptográfico fue modificado. Solicite un kit oficial nuevo."
}
Add-Type -TypeDefinition (Get-Content -LiteralPath $cryptoSource -Raw) `
    -ReferencedAssemblies @("System.Core.dll", "System.Security.dll")

$sheets = Get-XlsxData $templatePath
$configurationSheet = "Configuraci$([char]0x00F3)n"
foreach ($required in @("Instrucciones", "Cliente", "Telegram", "Usuarios", $configurationSheet)) {
    if (-not $sheets.ContainsKey($required)) { throw "Falta la hoja obligatoria '$required'." }
}
$clientRows = Convert-RowsToRecords $sheets["Cliente"] "Campo"
$telegramRows = Convert-RowsToRecords $sheets["Telegram"] "Campo"
$users = Convert-RowsToRecords $sheets["Usuarios"] "row_id"
$configurationRows = Convert-RowsToRecords $sheets[$configurationSheet] "grupo"

$clientData = @{}
foreach ($row in $clientRows) { $clientData[[string]$row.Campo] = $row.Valor }
$telegramData = @{}
foreach ($row in $telegramRows) { $telegramData[[string]$row.Campo] = $row.Valor }

$slug = ([string]$clientData["slug"]).Trim().ToLowerInvariant()
if ($slug -notmatch "^[a-z0-9][a-z0-9_-]{1,62}$") { throw "El slug no es válido." }
$url = ([string]$clientData["odoo_base_url"]).Trim().TrimEnd("/")
if ($url) {
    $parsedUrl = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$parsedUrl) `
        -or $parsedUrl.Scheme -notin @("http", "https")) {
        throw "odoo_base_url no es una URL HTTP/HTTPS válida."
    }
}

foreach ($sheetName in $sheets.Keys) {
    foreach ($row in $sheets[$sheetName]) {
        foreach ($value in $row.Values) {
            if ([string]$value -match "(?i)^(api[_ -]?key|token|password|secret|clave maestra)$") {
                throw "La plantilla contiene una columna o etiqueta secreta prohibida: '$value'."
            }
        }
    }
}

$secureToken = if ($TokenSeguro) {
    $TokenSeguro
} else {
    Read-Host "Token del bot Telegram del cliente (Enter para omitir)" -AsSecureString
}
$token = Convert-SecureStringToPlainText $secureToken
$payloadUsers = @()
$secretStrings = [Collections.Generic.List[string]]::new()
$plaintext = $null
$contentKey = $null
try {
    if ($token) { $secretStrings.Add($token) }
    foreach ($row in $users) {
        $rowId = ([string]$row.row_id).Trim()
        if (-not $rowId) { continue }
        if ($rowId -notmatch "^[A-Za-z0-9_-]{1,64}$") { throw "row_id inválido: $rowId." }
        $telegramUserId = ([string]$row.telegram_user_id).Trim()
        if ($telegramUserId -and $telegramUserId -notmatch "^[1-9][0-9]{0,14}$") {
            throw "Telegram User ID inválido para '$rowId'. Use solamente el ID numérico positivo."
        }
        $apiKey = $null
        if (Convert-ToBoolean $row.suministrar_api_key) {
            $secureApiKey = if ($ApiKeysSeguras -and $ApiKeysSeguras.ContainsKey($rowId)) {
                $ApiKeysSeguras[$rowId]
            } else {
                Read-Host "API key de Odoo para '$rowId' (no se mostrará)" -AsSecureString
            }
            try {
                $apiKey = Convert-SecureStringToPlainText $secureApiKey
                if ($apiKey) { $secretStrings.Add($apiKey) }
            } finally {
                $secureApiKey.Dispose()
            }
        }
        $payloadUsers += [ordered]@{
            row_id = $rowId
            active = Convert-ToBoolean $row.activo
            odoo_login = ([string]$row.odoo_login).Trim()
            telegram_user_id = $telegramUserId
            # En chats privados Telegram usa el mismo identificador para la
            # persona y el chat. No se solicita un segundo dato al consultor.
            telegram_chat_id = $telegramUserId
            telegram_username = ([string]$row.telegram_username).Trim().TrimStart("@")
            odoo_api_key = $apiKey
        }
    }

    $limits = [ordered]@{}
    $tools = @()
    $models = @()
    foreach ($row in $configurationRows) {
        $group = ([string]$row.grupo).Trim().ToLowerInvariant()
        $key = ([string]$row.clave).Trim()
        $enabled = Convert-ToBoolean $row.habilitado
        if ($group -eq "limite" -and $key -and $row.valor) {
            $limits[$key] = [int]$row.valor
        } elseif ($group -eq "herramienta" -and $key -and $enabled) {
            $tools += $key
        } elseif ($group -eq "modelo" -and $key -and $enabled) {
            $models += $key
        }
    }

    $packageId = [Guid]::NewGuid().ToString()
    $payload = [ordered]@{
        schema_version = 1
        package_id = $packageId
        created_at = [DateTime]::UtcNow.ToString("o")
        consultant = $Consultor
        client = [ordered]@{
            slug = $slug
            name = ([string]$clientData["name"]).Trim()
            odoo_base_url = $url
            odoo_database = ([string]$clientData["odoo_database"]).Trim()
            timezone = if ($clientData["timezone"]) { ([string]$clientData["timezone"]).Trim() } else { "America/Bogota" }
            active = Convert-ToBoolean $clientData["active"]
        }
        telegram = [ordered]@{
            bot_name = ([string]$telegramData["bot_name"]).Trim()
            bot_username = ([string]$telegramData["bot_username"]).Trim().TrimStart("@")
            bot_token = $token
        }
        users = $payloadUsers
        configuration = [ordered]@{
            limits = $limits
            tools = $tools
            models = $models
        }
    }

    $json = $payload | ConvertTo-Json -Depth 12 -Compress
    $plaintext = [Text.Encoding]::UTF8.GetBytes($json)
    $contentKey = New-Object byte[] 32
    $nonce = New-Object byte[] 12
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $rng.GetBytes($contentKey)
        $rng.GetBytes($nonce)
    } finally { $rng.Dispose() }

    $aad = [Text.Encoding]::UTF8.GetBytes("odooai:v1:$packageId")
    $ciphertext = $null
    $tag = $null
    [OdooAiPortableCrypto]::EncryptAes256Gcm(
        $contentKey, $nonce, $aad, $plaintext, [ref]$ciphertext, [ref]$tag
    )
    $publicKey = Get-Content -LiteralPath $publicKeyPath -Raw | ConvertFrom-Json
    if ($publicKey.algorithm -ne "RSA-3072-OAEP-SHA256") {
        throw "La clave pública no usa el algoritmo esperado."
    }
    $computedPublicFingerprint = [OdooAiPortableCrypto]::PublicMaterialFingerprint(
        $publicKey.n, $publicKey.e
    )
    if ($computedPublicFingerprint -ne $publicKey.material_fingerprint `
        -or $computedPublicFingerprint -ne $ExpectedPublicMaterialFingerprint) {
        throw "La clave pública no pertenece a esta instalación."
    }
    $wrappedKey = [OdooAiPortableCrypto]::WrapKeyOaepSha256(
        $publicKey.n, $publicKey.e, $contentKey
    )
    $envelope = [ordered]@{
        format = "odooai"
        version = 1
        package_id = $packageId
        created_at = [DateTime]::UtcNow.ToString("o")
        key_id = $publicKey.key_id
        key_encryption = "RSA-3072-OAEP-SHA256"
        content_encryption = "AES-256-GCM"
        wrapped_key_b64 = [Convert]::ToBase64String($wrappedKey)
        nonce_b64 = [Convert]::ToBase64String($nonce)
        tag_b64 = [Convert]::ToBase64String($tag)
        ciphertext_b64 = [Convert]::ToBase64String($ciphertext)
        payload_sha256 = Get-Sha256Hex $plaintext
    }
    if (-not $Salida) {
        $timestamp = [DateTime]::Now.ToString("yyyyMMdd-HHmmss")
        $Salida = Join-Path (Get-Location) "$slug-$timestamp.odooai"
    }
    $outputPath = [IO.Path]::GetFullPath($Salida)
    if ([IO.Path]::GetExtension($outputPath) -ne ".odooai") {
        $outputPath += ".odooai"
    }
    [IO.File]::WriteAllText(
        $outputPath,
        ($envelope | ConvertTo-Json -Depth 5 -Compress),
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host ""
    Write-Host "Paquete cifrado creado correctamente." -ForegroundColor Green
    Write-Host "Archivo: $outputPath"
    Write-Host "Cliente: $slug"
    Write-Host "Usuarios: $($payloadUsers.Count)"
    Write-Host "Package ID: $packageId"
    Write-Host "Clave pública: $($publicKey.key_id)"
    Write-Host "El archivo Excel no fue modificado y los secretos no se guardaron fuera del paquete."
} finally {
    if ($null -ne $plaintext) { [Array]::Clear($plaintext, 0, $plaintext.Length) }
    if ($null -ne $contentKey) { [Array]::Clear($contentKey, 0, $contentKey.Length) }
    if ($null -ne $token) { $token = $null }
    foreach ($index in 0..($secretStrings.Count - 1)) {
        if ($index -ge 0 -and $secretStrings.Count -gt 0) { $secretStrings[$index] = "" }
    }
    if (-not $TokenSeguro) { $secureToken.Dispose() }
}
