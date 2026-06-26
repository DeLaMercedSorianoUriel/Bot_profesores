# ============================================================
#  setup.ps1  —  Tutor Academico: configuracion inicial
# ============================================================
#
#  QUE NECESITAS ANTES DE EJECUTAR ESTE SCRIPT
#  --------------------------------------------
#
#  1. Node.js 18 o mayor
#     Descarga: https://nodejs.org/
#     Verifica con:  node --version
#
#  2. PostgreSQL 14 o mayor
#     Descarga: https://www.postgresql.org/download/windows/
#     Durante la instalacion pon una contrasena al superusuario 'postgres'.
#     Verifica con:  psql --version
#
#  3. Dos API Keys (gratuitas):
#
#     a) NVIDIA_API_KEY  -- chatbot principal (modelo Nemotron de razonamiento)
#        - Crea cuenta en:  https://build.nvidia.com/
#        - Click en cualquier modelo -> "Get API Key" -> copia la clave
#        - Empieza con "nvapi-..."
#
#     b) ANALIZADOR_API_KEY  -- analizador Gemini (asistente por contrasena)
#        - Ve a:  https://aistudio.google.com/app/apikey
#        - Click en "Create API key" -> copia la clave
#        - Empieza con "AIza..."
#
#  4. Archivo .env  (el script lo crea automaticamente si no existe)
#     Si prefieres crearlo manualmente, debe quedar asi:
#
#       NVIDIA_API_KEY=nvapi-xxxxxxxxxxxxxxxxxxxx
#       ANALIZADOR_API_KEY=AIzaxxxxxxxxxxxxxxxx
#       PGHOST=127.0.0.1
#       PGPORT=5432
#       PGDATABASE=educacion
#       PGUSER=app_educacion
#       PGPASSWORD=tu_contrasena_bd
#       SESSION_SECRET=cadena_aleatoria_larga
#
#  El script creara automaticamente:
#    - Archivo .env con todas las variables de entorno
#    - Usuario y base de datos en PostgreSQL
#    - Todas las tablas del esquema (db/schema.sql)
#    - Cuenta de administrador inicial
#    - Carpeta chat_logs/ para guardar conversaciones
#    - Dependencias npm (node_modules/)
#
#  COMO EJECUTAR ESTE SCRIPT
#  -------------------------
#    Abre PowerShell en la carpeta del proyecto y ejecuta:
#    .\setup.ps1
#
#    Si PowerShell bloquea la ejecucion de scripts, ejecuta primero:
#    Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
# ============================================================

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Write-Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    WARN  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "    ERROR  $msg" -ForegroundColor Red }

# ── Banner ──────────────────────────────────────────────────────────────────
Clear-Host
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Yellow
Write-Host "    Tutor Academico -- Configuracion inicial  " -ForegroundColor Yellow
Write-Host "  ============================================" -ForegroundColor Yellow
Write-Host ""

# ── 1. Verificar Node.js ────────────────────────────────────────────────────
Write-Step "Verificando Node.js..."
try {
    $nodeVer = & node --version 2>&1
    Write-Ok "Node.js encontrado: $nodeVer"
} catch {
    Write-Fail "Node.js no encontrado."
    Write-Host "     Instala Node.js 18+ desde: https://nodejs.org/" -ForegroundColor Gray
    exit 1
}

# ── 2. Buscar psql ──────────────────────────────────────────────────────────
Write-Step "Buscando PostgreSQL (psql)..."
$psqlCmd = $null
$searchPaths = @(
    "psql",
    "$env:ProgramFiles\PostgreSQL\17\bin\psql.exe",
    "$env:ProgramFiles\PostgreSQL\16\bin\psql.exe",
    "$env:ProgramFiles\PostgreSQL\15\bin\psql.exe",
    "$env:ProgramFiles\PostgreSQL\14\bin\psql.exe"
)
foreach ($p in $searchPaths) {
    if (Get-Command $p -ErrorAction SilentlyContinue) {
        $psqlCmd = $p; break
    }
}
if (-not $psqlCmd) {
    Write-Fail "No se encontro psql."
    Write-Host "     Instala PostgreSQL desde: https://www.postgresql.org/download/windows/" -ForegroundColor Gray
    Write-Host "     Asegurate de que el instalador agrega psql al PATH." -ForegroundColor Gray
    exit 1
}
Write-Ok "psql encontrado: $psqlCmd"

# ── 3. Crear o reutilizar .env ───────────────────────────────────────────────
$envPath = Join-Path $scriptDir ".env"
Write-Step "Configuracion del archivo .env..."

$reuseEnv = $false
if (Test-Path $envPath) {
    Write-Warn "Se encontro un archivo .env existente."
    $resp = Read-Host "    Deseas reutilizarlo tal cual? (s/n)"
    if ($resp -match "^[sS]") { $reuseEnv = $true; Write-Ok "Usando .env existente." }
}

if (-not $reuseEnv) {
    Write-Host ""
    Write-Host "  Ingresa los valores para el archivo .env." -ForegroundColor White
    Write-Host "  (Presiona Enter para aceptar el valor por defecto entre corchetes)" -ForegroundColor Gray
    Write-Host ""

    $nvidiaKey = (Read-Host "  NVIDIA_API_KEY").Trim()
    while ($nvidiaKey -eq "") { $nvidiaKey = (Read-Host "  NVIDIA_API_KEY (requerido)").Trim() }

    $geminiKey = (Read-Host "  ANALIZADOR_API_KEY (Gemini)").Trim()
    while ($geminiKey -eq "") { $geminiKey = (Read-Host "  ANALIZADOR_API_KEY (requerido)").Trim() }

    Write-Host ""
    $pgHost = (Read-Host "  Host de PostgreSQL [127.0.0.1]").Trim()
    if ($pgHost -eq "") { $pgHost = "127.0.0.1" }

    $pgPort = (Read-Host "  Puerto de PostgreSQL [5432]").Trim()
    if ($pgPort -eq "") { $pgPort = "5432" }

    $pgDb = (Read-Host "  Nombre de la base de datos [educacion]").Trim()
    if ($pgDb -eq "") { $pgDb = "educacion" }

    $pgUser = (Read-Host "  Usuario de la base de datos [app_educacion]").Trim()
    if ($pgUser -eq "") { $pgUser = "app_educacion" }

    $pgPass = ""
    while ($pgPass -eq "") {
        $pgPass = (Read-Host "  Contrasena para el usuario '$pgUser' (elige una segura)").Trim()
    }

    $sessionSecret = ([System.Guid]::NewGuid().ToString("N") + [System.Guid]::NewGuid().ToString("N")).ToUpper()

    $envContent = @"
# Chatbot principal -- NVIDIA NIM (modelo Nemotron de razonamiento)
NVIDIA_API_KEY=$nvidiaKey

# Analizador -- Google Gemini 2.5 Flash
ANALIZADOR_API_KEY=$geminiKey

# PostgreSQL
PGHOST=$pgHost
PGPORT=$pgPort
PGDATABASE=$pgDb
PGUSER=$pgUser
PGPASSWORD=$pgPass

# Sesion de Express (cadena secreta aleatoria, no la cambies una vez en produccion)
SESSION_SECRET=$sessionSecret
"@
    Set-Content -Path $envPath -Value $envContent -Encoding utf8 -NoNewline:$false
    Write-Ok "Archivo .env creado en: $envPath"
}

# Leer variables del .env para usarlas en este script
$envVars = @{}
Get-Content $envPath | Where-Object { $_ -match "^\s*[^#\s].*=.*" } | ForEach-Object {
    $parts = $_ -split "=", 2
    $k = $parts[0].Trim()
    $v = $parts[1].Trim()
    $envVars[$k] = $v
}
$pgHost = if ($envVars.ContainsKey("PGHOST"))     { $envVars["PGHOST"] }     else { "127.0.0.1" }
$pgPort = if ($envVars.ContainsKey("PGPORT"))     { $envVars["PGPORT"] }     else { "5432" }
$pgDb   = if ($envVars.ContainsKey("PGDATABASE")) { $envVars["PGDATABASE"] } else { "educacion" }
$pgUser = if ($envVars.ContainsKey("PGUSER"))     { $envVars["PGUSER"] }     else { "app_educacion" }
$pgPass = if ($envVars.ContainsKey("PGPASSWORD")) { $envVars["PGPASSWORD"] } else { "" }

# ── 4. Contrasena del superusuario postgres ──────────────────────────────────
Write-Step "Creando usuario '$pgUser' y base de datos '$pgDb'..."
Write-Host ""
Write-Host "  Se necesita la contrasena del superusuario 'postgres' de PostgreSQL" -ForegroundColor Gray
Write-Host "  (la que pusiste al instalar PostgreSQL) para crear el usuario y la BD." -ForegroundColor Gray
Write-Host ""
$pgSuperPass = (Read-Host "  Contrasena del usuario 'postgres'").Trim()

$env:PGPASSWORD = $pgSuperPass

# Crear usuario si no existe
$createUserSql = @"
DO `$body`$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '$pgUser') THEN
    EXECUTE format('CREATE USER %I WITH PASSWORD %L', '$pgUser', '$pgPass');
  ELSE
    EXECUTE format('ALTER USER %I WITH PASSWORD %L', '$pgUser', '$pgPass');
  END IF;
END
`$body`$;
"@
try {
    & $psqlCmd -h $pgHost -p $pgPort -U postgres -c $createUserSql 2>&1 | Out-Null
    Write-Ok "Usuario '$pgUser' listo."
} catch {
    Write-Fail "No se pudo crear el usuario. Verifica la contrasena de 'postgres'."
    $env:PGPASSWORD = ""
    exit 1
}

# Crear base de datos si no existe y asignar propietario
$createDbResult = & $psqlCmd -h $pgHost -p $pgPort -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$pgDb'" 2>&1
if ($createDbResult -notmatch "1") {
    & $psqlCmd -h $pgHost -p $pgPort -U postgres -c "CREATE DATABASE ""$pgDb"" OWNER ""$pgUser"";" 2>&1 | Out-Null
    Write-Ok "Base de datos '$pgDb' creada."
} else {
    Write-Ok "Base de datos '$pgDb' ya existia."
    & $psqlCmd -h $pgHost -p $pgPort -U postgres -c "ALTER DATABASE ""$pgDb"" OWNER TO ""$pgUser"";" 2>&1 | Out-Null
}

& $psqlCmd -h $pgHost -p $pgPort -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ""$pgDb"" TO ""$pgUser"";" 2>&1 | Out-Null
$env:PGPASSWORD = ""

# ── 5. Instalar dependencias npm ─────────────────────────────────────────────
Write-Step "Instalando dependencias npm..."
Push-Location $scriptDir
try {
    & npm install 2>&1 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    Write-Ok "node_modules listo."
} catch {
    Write-Fail "npm install fallo. Verifica tu conexion a internet."
    Pop-Location
    exit 1
}
Pop-Location

# ── 6. Aplicar esquema y crear admin (via Node.js) ──────────────────────────
Write-Step "Aplicando esquema de tablas y creando administrador..."
Write-Host ""
Write-Host "  Esta es la cuenta con la que podras gestionar profesores y alumnos." -ForegroundColor Gray
Write-Host ""

$adminUsuario = ""
while ($adminUsuario -eq "") {
    $adminUsuario = (Read-Host "  Usuario del administrador [admin]").Trim()
    if ($adminUsuario -eq "") { $adminUsuario = "admin" }
}

$adminNombre = (Read-Host "  Nombre completo del admin [Administrador General]").Trim()
if ($adminNombre -eq "") { $adminNombre = "Administrador General" }

$adminPass = ""
while ($adminPass -eq "") {
    $adminPass = (Read-Host "  Contrasena del admin (min. 8 caracteres, mayuscula, numero y simbolo)").Trim()
    if ($adminPass.Length -lt 8) {
        Write-Warn "La contrasena debe tener al menos 8 caracteres."
        $adminPass = ""
    }
}

$env:SETUP_ADMIN_USER   = $adminUsuario
$env:SETUP_ADMIN_PASS   = $adminPass
$env:SETUP_ADMIN_NOMBRE = $adminNombre

$setupScript = Join-Path $scriptDir "setup-db.js"
try {
    $output = & node $setupScript 2>&1
    $output | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
    if ($LASTEXITCODE -ne 0) { throw "setup-db.js salio con codigo $LASTEXITCODE" }
    Write-Ok "Esquema aplicado y administrador creado."
} catch {
    Write-Fail "Error al aplicar el esquema: $_"
    Remove-Item Env:\SETUP_ADMIN_USER   -ErrorAction SilentlyContinue
    Remove-Item Env:\SETUP_ADMIN_PASS   -ErrorAction SilentlyContinue
    Remove-Item Env:\SETUP_ADMIN_NOMBRE -ErrorAction SilentlyContinue
    exit 1
}

Remove-Item Env:\SETUP_ADMIN_USER   -ErrorAction SilentlyContinue
Remove-Item Env:\SETUP_ADMIN_PASS   -ErrorAction SilentlyContinue
Remove-Item Env:\SETUP_ADMIN_NOMBRE -ErrorAction SilentlyContinue

# ── 7. Crear carpeta chat_logs ───────────────────────────────────────────────
Write-Step "Creando carpeta chat_logs/..."
$logsPath = Join-Path $scriptDir "chat_logs"
if (-not (Test-Path $logsPath)) {
    New-Item -ItemType Directory -Path $logsPath | Out-Null
    Write-Ok "chat_logs/ creada."
} else {
    Write-Ok "chat_logs/ ya existia."
}

# ── LISTO ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ============================================" -ForegroundColor Green
Write-Host "    Configuracion completada exitosamente!    " -ForegroundColor Green
Write-Host "  ============================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Para iniciar el servidor ejecuta:" -ForegroundColor White
Write-Host "    node server.js" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Luego abre en el navegador:" -ForegroundColor White
Write-Host "    http://localhost:3000/presenta.html" -ForegroundColor Yellow
Write-Host ""
Write-Host "  Credenciales del administrador:" -ForegroundColor White
Write-Host "    Usuario:   $adminUsuario" -ForegroundColor Yellow
Write-Host "    Contrasena: (la que ingresaste)" -ForegroundColor Yellow
Write-Host ""
Write-Host "  IMPORTANTE: No compartas ni subas a git el archivo .env" -ForegroundColor Red
Write-Host ""
