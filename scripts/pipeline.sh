#!/usr/bin/env bash
# pipeline.sh
#
# Script orquestador del pipeline completo de calidad de contratos OAS.
# N8N lo invoca via nodo "Execute Command".
#
# Variables de entorno requeridas (se pasan desde N8N):
#   SONAR_TOKEN          — token de autenticación de SonarCloud
#   SONAR_ORG            — organización en SonarCloud (ej: mi-empresa)
#   SONAR_PROJECT_KEY    — clave del proyecto (ej: mi-empresa_oas-example-gen)
#   OAS_FILE             — ruta al archivo openapi.yaml (default: openapi.yaml)
#   NOTIFY_WEBHOOK       — URL del webhook de notificación (Slack, Teams, etc.)
#
# Salida:
#   exit 0 — Quality Gate PASSED
#   exit 1 — Quality Gate FAILED o error en el pipeline
#   Escribe pipeline-result.json con el resumen completo

set -euo pipefail

OAS_FILE="${OAS_FILE:-openapi.yaml}"
SONAR_TOKEN="${SONAR_TOKEN:-}"
SONAR_ORG="${SONAR_ORG:-}"
SONAR_PROJECT_KEY="${SONAR_PROJECT_KEY:-}"
NOTIFY_WEBHOOK="${NOTIFY_WEBHOOK:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RESULT_FILE="pipeline-result.json"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Colores para output legible en logs de N8N
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[pipeline]${NC} $1"; }
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; }

# ── 1. Validar prerequisitos ──────────────────────────────────────────────────
log "Iniciando pipeline de calidad para: ${OAS_FILE}"

if [ ! -f "$OAS_FILE" ]; then
  fail "Archivo no encontrado: ${OAS_FILE}"
  exit 1
fi

if ! command -v node &>/dev/null; then
  fail "Node.js no está instalado"
  exit 1
fi

# ── 2. Generar ejemplos ───────────────────────────────────────────────────────
log "Paso 1/4 — Generando ejemplos para los schemas..."
GENERATE_OUTPUT=$(node "${SCRIPT_DIR}/../script/generate.js" "$OAS_FILE" 2>&1) || {
  fail "El generador de ejemplos falló:"
  echo "$GENERATE_OUTPUT"
  exit 1
}
ok "Ejemplos generados correctamente"

# ── 3. Validar contrato con Spectral ──────────────────────────────────────────
log "Paso 2/4 — Validando contrato con Spectral..."

SPECTRAL_EXIT=0
SPECTRAL_JSON=$(npx @stoplight/spectral-cli lint "$OAS_FILE" \
  --ruleset "${SCRIPT_DIR}/../spectral/.spectral.yaml" \
  --format json 2>/dev/null) || SPECTRAL_EXIT=$?

# Spectral sale con código 1 si hay errores, pero queremos continuar para Sonar
SPECTRAL_ISSUES=$(echo "$SPECTRAL_JSON" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(chunks.join(''));
      const arr = Array.isArray(data) ? data : [];
      console.log(arr.length);
    } catch { console.log(0); }
  });
" 2>/dev/null || echo "0")

SPECTRAL_ERRORS=$(echo "$SPECTRAL_JSON" | node -e "
  const chunks = [];
  process.stdin.on('data', c => chunks.push(c));
  process.stdin.on('end', () => {
    try {
      const data = JSON.parse(chunks.join(''));
      const arr = Array.isArray(data) ? data : [];
      console.log(arr.filter(i => i.severity === 0).length);
    } catch { console.log(0); }
  });
" 2>/dev/null || echo "0")

ok "Spectral completado: ${SPECTRAL_ISSUES} issues (${SPECTRAL_ERRORS} errores)"

# ── 4. Convertir a formato Sonar ──────────────────────────────────────────────
log "Paso 3/4 — Convirtiendo resultados al formato SonarCloud..."

echo "$SPECTRAL_JSON" | node "${SCRIPT_DIR}/spectral-to-sonar.js" > sonar-issues.json

ok "sonar-issues.json generado ($(wc -l < sonar-issues.json) líneas)"

# ── 5. Enviar a SonarCloud ────────────────────────────────────────────────────
if [ -n "$SONAR_TOKEN" ] && [ -n "$SONAR_ORG" ] && [ -n "$SONAR_PROJECT_KEY" ]; then
  log "Paso 4/4 — Enviando análisis a SonarCloud..."

  # Copiar sonar-project.properties si existe
  if [ -f "${SCRIPT_DIR}/../sonar/sonar-project.properties" ]; then
    cp "${SCRIPT_DIR}/../sonar/sonar-project.properties" ./sonar-project.properties
    # Sobrescribir con los valores de entorno
    sed -i "s/^sonar.organization=.*/sonar.organization=${SONAR_ORG}/" sonar-project.properties
    sed -i "s/^sonar.projectKey=.*/sonar.projectKey=${SONAR_PROJECT_KEY}/" sonar-project.properties
  fi

  SONAR_OUTPUT=$(npx sonar-scanner \
    -Dsonar.host.url=https://sonarcloud.io \
    -Dsonar.token="${SONAR_TOKEN}" \
    -Dsonar.organization="${SONAR_ORG}" \
    -Dsonar.projectKey="${SONAR_PROJECT_KEY}" \
    -Dsonar.externalIssuesReportPaths=sonar-issues.json \
    2>&1) || {
    warn "sonar-scanner falló (puede ser error de red). Continuando..."
    echo "$SONAR_OUTPUT"
  }

  # Esperar a que SonarCloud procese el análisis (máx 60s)
  log "Esperando procesamiento en SonarCloud..."
  sleep 10

  # Consultar Quality Gate
  GATE_RESPONSE=$(curl -sf \
    -u "${SONAR_TOKEN}:" \
    "https://sonarcloud.io/api/qualitygates/project_status?projectKey=${SONAR_PROJECT_KEY}" \
    2>/dev/null || echo '{"projectStatus":{"status":"ERROR"}}')

  GATE_STATUS=$(echo "$GATE_RESPONSE" | node -e "
    const chunks = [];
    process.stdin.on('data', c => chunks.push(c));
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(chunks.join(''));
        console.log(data.projectStatus?.status ?? 'ERROR');
      } catch { console.log('ERROR'); }
    });
  " 2>/dev/null || echo "ERROR")

  ok "Quality Gate status: ${GATE_STATUS}"
else
  warn "SONAR_TOKEN / SONAR_ORG / SONAR_PROJECT_KEY no configurados. Saltando envío a SonarCloud."
  GATE_STATUS="SKIPPED"
fi

# ── 6. Escribir resultado del pipeline ───────────────────────────────────────
PIPELINE_STATUS="PASSED"
EXIT_CODE=0

if [ "$SPECTRAL_ERRORS" -gt "0" ]; then
  PIPELINE_STATUS="FAILED"
  EXIT_CODE=1
fi
if [ "$GATE_STATUS" = "ERROR" ] || [ "$GATE_STATUS" = "FAILED" ]; then
  PIPELINE_STATUS="FAILED"
  EXIT_CODE=1
fi

cat > "$RESULT_FILE" <<EOF
{
  "timestamp": "${TIMESTAMP}",
  "oasFile": "${OAS_FILE}",
  "status": "${PIPELINE_STATUS}",
  "spectral": {
    "totalIssues": ${SPECTRAL_ISSUES},
    "errors": ${SPECTRAL_ERRORS}
  },
  "sonarCloud": {
    "qualityGate": "${GATE_STATUS}",
    "projectKey": "${SONAR_PROJECT_KEY}",
    "dashboardUrl": "https://sonarcloud.io/project/overview?id=${SONAR_PROJECT_KEY}"
  }
}
EOF

# ── 7. Notificar via webhook (N8N lee este output) ───────────────────────────
if [ -n "$NOTIFY_WEBHOOK" ] && [ "$GATE_STATUS" != "SKIPPED" ]; then
  EMOJI="✅"
  [ "$PIPELINE_STATUS" = "FAILED" ] && EMOJI="❌"

  curl -sf -X POST "$NOTIFY_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "{
      \"text\": \"${EMOJI} OAS Pipeline: ${PIPELINE_STATUS}\",
      \"status\": \"${PIPELINE_STATUS}\",
      \"spectralIssues\": ${SPECTRAL_ISSUES},
      \"spectralErrors\": ${SPECTRAL_ERRORS},
      \"qualityGate\": \"${GATE_STATUS}\",
      \"file\": \"${OAS_FILE}\"
    }" 2>/dev/null || warn "No se pudo enviar notificación al webhook"
fi

# Output final para N8N (el nodo Execute Command captura stdout)
cat "$RESULT_FILE"

if [ "$PIPELINE_STATUS" = "PASSED" ]; then
  ok "Pipeline PASSED"
else
  fail "Pipeline FAILED — ${SPECTRAL_ERRORS} error(es) en el contrato"
fi

exit $EXIT_CODE
