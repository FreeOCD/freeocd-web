#!/usr/bin/env node

// Validates all JSON files under public/targets/

const fs = require("fs");
const path = require("path");

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

const targetDir = path.join(__dirname, "..", "public", "targets");
const files = findJsonFiles(targetDir);
let hasError = false;

for (const file of files) {
  const rel = path.relative(process.cwd(), file);
  try {
    const content = fs.readFileSync(file, "utf8");
    JSON.parse(content);

    // Check for trailing whitespace / BOM issues
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

    console.log(`\u2713 ${rel}`);
  } catch (err) {
    console.error(`\u2717 ${rel}: ${err.message}`);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log(`\nValidated ${files.length} JSON file(s)`);
