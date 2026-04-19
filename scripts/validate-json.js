#!/usr/bin/env node

// Validates all JSON files under public/targets/.
//
// Every file is checked for:
//   - valid JSON syntax
//   - no UTF-8 BOM
//   - trailing newline
//
// Target MCU definition files (public/targets/<platform>/<family>/<mcu>.json)
// are additionally checked for schema conformance — see validateTargetDef()
// below. The top-level index.json and probe-filters.json are recognized by
// name and exempted from the target schema check.

const fs = require("fs");
const path = require("path");

const KNOWN_CAPABILITIES = new Set(["flash", "verify", "recover", "rtt"]);
const REQUIRED_STRING_FIELDS = ["id", "name", "platform", "description"];

function findJsonFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findJsonFiles(fullPath));
    } else if (entry.name.endsWith(".json")) {
      results.push(fullPath);
    }
  }
  return results;
}

// A target MCU JSON lives at public/targets/<platform>/<family>/<mcu>.json —
// i.e. three path segments below public/targets/. Top-level files such as
// index.json and probe-filters.json are not target definitions.
function isTargetDef(file, targetDir) {
  const rel = path.relative(targetDir, file);
  const parts = rel.split(path.sep);
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// Returns an array of human-readable error strings; empty array = pass.
function validateTargetDef(def, file, targetDir) {
  const errors = [];

  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof def[field] !== "string" || def[field].length === 0) {
      errors.push(`missing or non-string required field \`${field}\``);
    }
  }

  // `id` must match the file path (e.g. "nordic/nrf54/nrf54l15").
  const expectedId = path
    .relative(targetDir, file)
    .replace(/\.json$/i, "")
    .split(path.sep)
    .join("/");
  if (typeof def.id === "string" && def.id !== expectedId) {
    errors.push(
      `\`id\` "${def.id}" does not match the file path — expected "${expectedId}"`
    );
  }

  if (!Array.isArray(def.capabilities)) {
    errors.push(
      "missing `capabilities` array — every target must declare which UI " +
        "features (flash/verify/recover/rtt) it supports"
    );
  } else {
    if (def.capabilities.length === 0) {
      errors.push("`capabilities` is empty — declare at least one capability");
    }
    const unknown = def.capabilities.filter((c) => !KNOWN_CAPABILITIES.has(c));
    if (unknown.length > 0) {
      errors.push(
        `\`capabilities\` contains unknown value(s): ${unknown
          .map((c) => `"${c}"`)
          .join(", ")}. Known values: ${[...KNOWN_CAPABILITIES]
          .map((c) => `"${c}"`)
          .join(", ")}`
      );
    }
    const duplicates = def.capabilities.filter(
      (c, i) => def.capabilities.indexOf(c) !== i
    );
    if (duplicates.length > 0) {
      errors.push(
        `\`capabilities\` contains duplicate value(s): ${[
          ...new Set(duplicates),
        ]
          .map((c) => `"${c}"`)
          .join(", ")}`
      );
    }
  }

  // Probe USB filters are now managed centrally in
  // public/targets/probe-filters.json; target JSONs must not carry their own.
  if (Object.prototype.hasOwnProperty.call(def, "usbFilters")) {
    errors.push(
      "`usbFilters` is no longer allowed in target definitions — add the " +
        "vendor ID to public/targets/probe-filters.json instead (see " +
        "CONTRIBUTING.md \u201cAdding a New CMSIS-DAP Probe Vendor ID\u201d)"
    );
  }

  return errors;
}

const publicDir = path.join(__dirname, "..", "public");
const targetDir = path.join(publicDir, "targets");

// probe-filters.json now lives under public/targets/, so the recursive
// findJsonFiles() walk below already picks it up.
const files = findJsonFiles(targetDir);
let hasError = false;

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    console.error(`\u2717 ${rel}: ${err.message}`);
    hasError = true;
    continue;
  }

  // Check for UTF-8 BOM
  if (content.charCodeAt(0) === 0xfeff) {
    console.error(`\u2717 ${rel}: contains BOM`);
    hasError = true;
    continue;
  }

  // Check the file ends with a newline
  if (!content.endsWith("\n")) {
    console.error(`\u2717 ${rel}: missing trailing newline`);
    hasError = true;
    continue;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.error(`\u2717 ${rel}: ${err.message}`);
    hasError = true;
    continue;
  }

  if (isTargetDef(file, targetDir)) {
    const errors = validateTargetDef(parsed, file, targetDir);
    if (errors.length > 0) {
      console.error(`\u2717 ${rel}:`);
      for (const e of errors) {
        console.error(`    - ${e}`);
      }
      hasError = true;
      continue;
    }
  }

  console.log(`\u2713 ${rel}`);
}

if (hasError) {
  process.exit(1);
}

console.log(`\nValidated ${files.length} JSON file(s)`);
