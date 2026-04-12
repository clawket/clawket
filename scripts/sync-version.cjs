#!/usr/bin/env node
// Sync version from .claude-plugin/plugin.json to all other files
const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');

const root = resolve(__dirname, '..');
const plugin = JSON.parse(readFileSync(resolve(root, '.claude-plugin', 'plugin.json'), 'utf-8'));
const version = plugin.version;

const targets = [
  { file: '.claude-plugin/marketplace.json', key: ['plugins', 0, 'version'] },
  { file: 'daemon/package.json', key: ['version'] },
];

for (const { file, key } of targets) {
  const path = resolve(root, file);
  const json = JSON.parse(readFileSync(path, 'utf-8'));
  let obj = json;
  for (let i = 0; i < key.length - 1; i++) obj = obj[key[i]];
  const lastKey = key[key.length - 1];
  if (obj[lastKey] !== version) {
    obj[lastKey] = version;
    writeFileSync(path, JSON.stringify(json, null, 2) + '\n');
    console.log(`  ${file}: ${obj[lastKey]} → ${version}`);
  }
}

console.log(`Version synced to ${version}`);
