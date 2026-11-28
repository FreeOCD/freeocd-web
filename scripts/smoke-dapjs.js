#!/usr/bin/env node

// Smoke test for the built public/lib/dap.umd.js: loads it both as a
// CommonJS module and as a browser <script> (global DAPjs) and checks the
// exports the web app relies on.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "..", "public", "lib", "dap.umd.js");
const REQUIRED = ["ADI", "CmsisDAP", "CortexM", "DAPLink", "WebUSB"];

function check(label, dapjs) {
  const missing = REQUIRED.filter((name) => typeof dapjs?.[name] !== "function");
  if (missing.length > 0) {
    console.error(`✗ ${label}: missing exports ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log(`✓ ${label}: ${REQUIRED.join(", ")}`);
}

check("CommonJS", require(file));

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
check("browser global DAPjs", context.DAPjs);
