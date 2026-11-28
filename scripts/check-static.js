#!/usr/bin/env node

// Checks that the static site under public/ is complete:
//   - every local src/href in index.html exists
//   - every relative ES module import reachable from those scripts exists
//   - every target listed in public/targets/index.json exists
//
// public/lib/ is built from vendor/dapjs and is only checked with --with-lib.

const fs = require("fs");
const path = require("path");

const publicDir = path.join(__dirname, "..", "public");
const withLib = process.argv.includes("--with-lib");
const errors = [];

function exists(rel, from) {
  if (!withLib && rel.startsWith("lib/")) return;
  if (!fs.existsSync(path.join(publicDir, rel))) {
    errors.push(`${from}: missing ${rel}`);
  }
}

const html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
const scripts = [];
for (const [, attr, value] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
  if (/^([a-z]+:|\/\/|#)/i.test(value)) continue;
  const rel = path.posix.normalize(value.split(/[?#]/)[0]).replace(/^\/+/, "");
  exists(rel, "index.html");
  if (attr === "src" && rel.startsWith("js/")) scripts.push(rel);
}

const seen = new Set();
while (scripts.length > 0) {
  const rel = scripts.pop();
  if (seen.has(rel)) continue;
  seen.add(rel);
  const file = path.join(publicDir, rel);
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  for (const [, spec] of source.matchAll(/\bimport\s*(?:[^'"()]*?\bfrom\s*)?['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.posix.join(path.posix.dirname(rel), spec);
    exists(target, rel);
    scripts.push(target);
  }
}

const index = JSON.parse(fs.readFileSync(path.join(publicDir, "targets", "index.json"), "utf8"));
for (const id of index.targets || []) {
  exists(`targets/${id}.json`, "targets/index.json");
}

if (errors.length > 0) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log(`✓ index.html, ${seen.size} modules and ${(index.targets || []).length} targets present${withLib ? " (including lib/)" : ""}`);
