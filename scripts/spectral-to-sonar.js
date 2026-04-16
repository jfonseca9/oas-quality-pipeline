#!/usr/bin/env node
/**
 * spectral-to-sonar.js — v2
 * Convierte output JSON de Spectral al Generic Issue Format de SonarCloud.
 * Severidades y tipos basados en OPENAPI_RULES.xlsx
 *
 * Uso:
 *   spectral lint openapi.yaml -f json | node spectral-to-sonar.js > sonar-issues.json
 */

const fs = require("fs");
const path = require("path");

// ── Mapeo severidad del Excel → SonarQube ─────────────────────────────────────
// Excel: Critical, High, Medium, Low, Info
// Spectral: 0=error, 1=warn, 2=info, 3=hint
// Sonar: BLOCKER, CRITICAL, MAJOR, MINOR, INFO
const SPECTRAL_SEVERITY_MAP = {
  0: "CRITICAL",  // error   → CRITICAL
  1: "MAJOR",     // warn    → MAJOR
  2: "MINOR",     // info    → MINOR
  3: "INFO",      // hint    → INFO
};

// ── Mapeo de reglas del Excel a tipo Sonar y severidad exacta ─────────────────
// Categorías del Excel: Access Control, Encryption, Insecure Configurations,
//                       Structure and Semantics, Best Practices, Networking and Firewall
const RULE_MAP = {
  // ACCESS CONTROL — Critical/High/Medium → VULNERABILITY
  "no-basic-auth-plain-channel":         { type: "VULNERABILITY", severity: "CRITICAL" },
  "no-basic-auth-scheme":                { type: "VULNERABILITY", severity: "CRITICAL" },
  "oauth2-valid-token-url":              { type: "VULNERABILITY", severity: "MAJOR"    },
  "oauth2-valid-authorization-url":      { type: "VULNERABILITY", severity: "MAJOR"    },
  "no-oauth2-implicit-flow":             { type: "VULNERABILITY", severity: "MAJOR"    },
  "no-oauth2-password-flow":             { type: "VULNERABILITY", severity: "MAJOR"    },
  "no-oauth1":                           { type: "VULNERABILITY", severity: "MINOR"    },
  "no-http-basic":                       { type: "VULNERABILITY", severity: "MINOR"    },
  "no-http-digest":                      { type: "VULNERABILITY", severity: "MINOR"    },
  "no-http-negotiate":                   { type: "VULNERABILITY", severity: "MINOR"    },
  "http-scheme-iana-registered":         { type: "VULNERABILITY", severity: "MAJOR"    },
  "security-schemes-defined":            { type: "VULNERABILITY", severity: "MAJOR"    },
  "no-api-key-in-query":                 { type: "VULNERABILITY", severity: "MINOR"    },
  "global-security-scopes-defined":      { type: "VULNERABILITY", severity: "CRITICAL" },
  "operation-security-scopes-defined":   { type: "VULNERABILITY", severity: "MINOR"    },

  // ENCRYPTION — Critical → BUG
  "https-only-global-servers":           { type: "BUG", severity: "CRITICAL" },
  "https-only-path-servers":             { type: "BUG", severity: "CRITICAL" },

  // INSECURE CONFIGURATIONS — High/Medium → BUG
  "no-additional-properties-objects":    { type: "BUG", severity: "MINOR"    },
  "additional-properties-with-composition": { type: "BUG", severity: "MINOR" },
  "media-type-schema-defined":           { type: "BUG", severity: "MAJOR"    },
  "parameter-schema-defined":            { type: "BUG", severity: "MAJOR"    },

  // STRUCTURE AND SEMANTICS — High/Medium/Info → BUG o CODE_SMELL
  "parameter-no-schema-and-content":     { type: "BUG",        severity: "CRITICAL" },
  "server-url-absolute":                 { type: "BUG",        severity: "CRITICAL" },
  "server-url-variables-defined":        { type: "CODE_SMELL", severity: "MAJOR"    },
  "servers-array-not-empty":             { type: "CODE_SMELL", severity: "INFO"     },
  "openapi-required-fields":             { type: "BUG",        severity: "CRITICAL" },
  "no-readonly-writeonly-both":          { type: "BUG",        severity: "INFO"     },
  "security-field-in-security-schemes":  { type: "CODE_SMELL", severity: "INFO"     },
  "operation-security-in-security-schemes": { type: "CODE_SMELL", severity: "INFO"  },
  "oauth2-only-scopes-for-oauth":        { type: "CODE_SMELL", severity: "INFO"     },
  "component-keys-valid-regex":          { type: "CODE_SMELL", severity: "INFO"     },
  "no-empty-arrays":                     { type: "BUG",        severity: "INFO"     },
  "encoding-content-type-not-in-headers":{ type: "CODE_SMELL", severity: "INFO"     },
  "encoding-key-in-schema-properties":   { type: "CODE_SMELL", severity: "INFO"     },
  "examples-ref-to-components":          { type: "CODE_SMELL", severity: "INFO"     },
  "headers-ref-to-components":           { type: "CODE_SMELL", severity: "INFO"     },
  "header-schema-defined":               { type: "BUG",        severity: "MAJOR"    },
  "multipart-for-binary-arrays":         { type: "CODE_SMELL", severity: "INFO"     },
  "valid-media-type-format":             { type: "CODE_SMELL", severity: "INFO"     },
  "valid-media-type-prefix":             { type: "CODE_SMELL", severity: "INFO"     },
  "callbacks-ref-to-components":         { type: "CODE_SMELL", severity: "INFO"     },
  "callback-ref-exists":                 { type: "BUG",        severity: "INFO"     },
  "example-ref-exists":                  { type: "BUG",        severity: "INFO"     },
  "header-ref-exists":                   { type: "BUG",        severity: "INFO"     },
  "link-ref-exists":                     { type: "BUG",        severity: "INFO"     },
  "parameter-ref-exists":                { type: "BUG",        severity: "INFO"     },
  "request-body-ref-exists":             { type: "BUG",        severity: "INFO"     },
  "response-ref-exists":                 { type: "BUG",        severity: "INFO"     },
  "schema-ref-exists":                   { type: "BUG",        severity: "INFO"     },
  "links-ref-to-components":             { type: "CODE_SMELL", severity: "INFO"     },
  "link-operation-id-exists":            { type: "BUG",        severity: "INFO"     },
  "link-no-operation-id-and-ref":        { type: "BUG",        severity: "INFO"     },
  "parameter-content-one-entry":         { type: "BUG",        severity: "INFO"     },
  "parameter-ref-to-components":         { type: "CODE_SMELL", severity: "INFO"     },
  "parameter-schema-or-content":         { type: "BUG",        severity: "INFO"     },
  "allow-empty-value-valid-style":       { type: "CODE_SMELL", severity: "INFO"     },
  "allow-reserved-query-only":           { type: "CODE_SMELL", severity: "INFO"     },
  "encoding-allow-reserved-form-urlencoded": { type: "CODE_SMELL", severity: "INFO" },
  "encoding-explode-form-urlencoded":    { type: "CODE_SMELL", severity: "INFO"     },
  "encoding-style-form-urlencoded":      { type: "CODE_SMELL", severity: "INFO"     },
  "request-body-ref-to-components":      { type: "CODE_SMELL", severity: "INFO"     },
  "encoding-requires-form-media":        { type: "CODE_SMELL", severity: "INFO"     },
  "response-ref-to-components":          { type: "CODE_SMELL", severity: "INFO"     },
  "schema-ref-to-components":            { type: "CODE_SMELL", severity: "INFO"     },
  "server-variables-used-in-url":        { type: "CODE_SMELL", severity: "INFO"     },
  "known-openapi-properties":            { type: "CODE_SMELL", severity: "INFO"     },

  // BEST PRACTICES — Low/Info → CODE_SMELL
  "component-parameters-referenced":     { type: "CODE_SMELL", severity: "MINOR"    },
  "component-callbacks-referenced":      { type: "CODE_SMELL", severity: "INFO"     },
  "component-examples-referenced":       { type: "CODE_SMELL", severity: "INFO"     },
  "component-headers-referenced":        { type: "CODE_SMELL", severity: "INFO"     },
  "component-links-referenced":          { type: "CODE_SMELL", severity: "INFO"     },
  "component-request-bodies-referenced": { type: "CODE_SMELL", severity: "INFO"     },
  "component-responses-referenced":      { type: "CODE_SMELL", severity: "INFO"     },
  "component-schemas-referenced":        { type: "CODE_SMELL", severity: "INFO"     },
  "encoding-no-content-type-in-headers": { type: "CODE_SMELL", severity: "INFO"     },
  "valid-media-type-best-practices":     { type: "CODE_SMELL", severity: "INFO"     },
  "allow-empty-value-ignored-styles":    { type: "CODE_SMELL", severity: "INFO"     },
  "allow-reserved-encoding-form-urlencoded": { type: "CODE_SMELL", severity: "INFO" },
  "explode-encoding-form-urlencoded":    { type: "CODE_SMELL", severity: "INFO"     },
  "style-encoding-form-urlencoded":      { type: "CODE_SMELL", severity: "INFO"     },

  // NETWORKING AND FIREWALL — Medium/Low
  "header-object-schema-defined":        { type: "BUG",        severity: "MAJOR"    },
  "trace-200-response":                  { type: "BUG",        severity: "MINOR"    },
};

function getRuleInfo(ruleCode) {
  return RULE_MAP[ruleCode] ?? {
    type: "CODE_SMELL",
    severity: SPECTRAL_SEVERITY_MAP[0] ?? "MINOR",
  };
}

function convertToSonarFormat(spectralResults, baseDir = process.cwd()) {
  const issues = [];

  for (const result of spectralResults) {
    const absolutePath = path.isAbsolute(result.source)
      ? result.source
      : path.resolve(baseDir, result.source);
    const filePath = path.relative(baseDir, absolutePath);

    for (const issue of (result.results ?? [])) {
      const startLine   = (issue.range?.start?.line   ?? 0) + 1;
      const endLine     = (issue.range?.end?.line     ?? startLine - 1) + 1;
      const startColumn = issue.range?.start?.character ?? 0;
      const endColumn   = issue.range?.end?.character   ?? startColumn;

      const ruleId   = issue.code?.toString() ?? "unknown";
      const ruleInfo = getRuleInfo(ruleId);

      issues.push({
        engineId: "spectral",
        ruleId,
        severity: ruleInfo.severity,
        type:     ruleInfo.type,
        primaryLocation: {
          message:  `[${ruleId}] ${issue.message}`,
          filePath,
          textRange: {
            startLine:   Math.max(1, startLine),
            endLine:     Math.max(1, endLine),
            startColumn: Math.max(0, startColumn),
            endColumn:   Math.max(0, endColumn),
          },
        },
      });
    }
  }

  return { issues };
}

async function main() {
  let rawInput;
  const inputFile = process.argv[2];
  if (inputFile && fs.existsSync(inputFile)) {
    rawInput = fs.readFileSync(inputFile, "utf8");
  } else {
    rawInput = await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", c => { data += c; });
      process.stdin.on("end",  () => resolve(data));
      process.stdin.on("error", reject);
    });
  }

  if (!rawInput.trim()) {
    console.log(JSON.stringify({ issues: [] }, null, 2));
    process.exit(0);
  }

  let spectralResults;
  try {
    spectralResults = JSON.parse(rawInput);
  } catch (err) {
    console.error("Error parsing Spectral JSON:", err.message);
    process.exit(1);
  }

  // Normalizar formato
  let normalized;
  if (Array.isArray(spectralResults) && spectralResults[0]?.code !== undefined) {
    const grouped = {};
    for (const issue of spectralResults) {
      const src = issue.source ?? "openapi.yaml";
      if (!grouped[src]) grouped[src] = { source: src, results: [] };
      grouped[src].results.push(issue);
    }
    normalized = Object.values(grouped);
  } else {
    normalized = Array.isArray(spectralResults) ? spectralResults : [spectralResults];
  }

  const sonarOutput = convertToSonarFormat(
    normalized,
    process.env.PROJECT_ROOT ?? process.cwd()
  );

  console.log(JSON.stringify(sonarOutput, null, 2));

  // Resumen por tipo y severidad en stderr
  const count = sonarOutput.issues.length;
  const byType = sonarOutput.issues.reduce((acc, i) => {
    acc[i.type] = (acc[i.type] ?? 0) + 1; return acc;
  }, {});
  const bySev = sonarOutput.issues.reduce((acc, i) => {
    acc[i.severity] = (acc[i.severity] ?? 0) + 1; return acc;
  }, {});

  process.stderr.write(`\n✅  spectral-to-sonar v2: ${count} issues convertidos\n`);
  process.stderr.write(`   Por tipo:      ${Object.entries(byType).map(([k,v])=>`${k}:${v}`).join(' | ')}\n`);
  process.stderr.write(`   Por severidad: ${Object.entries(bySev).map(([k,v])=>`${k}:${v}`).join(' | ')}\n\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
