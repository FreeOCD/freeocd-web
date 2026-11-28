#!/usr/bin/env node

// Checks that package.json and package-lock.json agree on the version and,
// when run for a tag (GITHUB_REF_TYPE=tag), that the tag is v<version>.

'use strict';

const path = require('path');

const root = path.resolve(__dirname, '..');

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const pkg = require(path.join(root, 'package.json'));
const lock = require(path.join(root, 'package-lock.json'));
const version = pkg.version;

const number = '(0|[1-9][0-9]*)';
const prerelease = `(${number}|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)`;
const semver = new RegExp(
  `^${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?` +
    '(\\+[0-9a-zA-Z-]+(\\.[0-9a-zA-Z-]+)*)?$',
);
if (!semver.test(version || '')) {
  fail(`package.json version "${version}" is not valid SemVer`);
}
for (const [label, value] of [
  ['package-lock.json version', lock.version],
  ['package-lock.json packages[""].version', lock.packages?.['']?.version],
]) {
  if (value !== version) {
    fail(`${label} (${value}) does not match package.json version (${version})`);
  }
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const tag = process.env.GITHUB_REF_NAME;
  if (tag !== `v${version}`) {
    fail(`Tag ${tag} does not match package.json version v${version}`);
  }
}

console.log(`Version check passed: ${version}`);
