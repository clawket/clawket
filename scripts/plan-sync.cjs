#!/usr/bin/env node
// Lattice PostToolUse hook for ExitPlanMode.
// Instead of parsing markdown → DB import, injects a prompt telling Claude
// to read the plan file and register it to Lattice via CLI.
// This avoids fragile markdown parsing — LLM understands its own plan.
const { resolve, dirname } = require('path');
const { readdirSync, statSync, readFileSync } = require('fs');
const { homedir } = require('os');

// Find the most recently modified plan file (within 120s)
const plansDir = resolve(homedir(), '.claude', 'plans');
const MAX_AGE_MS = 120_000;
let planFile = null;
let planContent = null;

try {
  const now = Date.now();
  const files = readdirSync(plansDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ name: f, path: resolve(plansDir, f), mtime: statSync(resolve(plansDir, f)).mtimeMs }))
    .filter(f => (now - f.mtime) < MAX_AGE_MS)
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length > 0) {
    planFile = files[0].path;
    planContent = readFileSync(planFile, 'utf-8').trim();
  }
} catch { /* plans dir not found */ }

if (!planFile || !planContent) {
  // No recent plan file — nothing to do
  console.log(JSON.stringify({}));
  process.exit(0);
}

// Inject prompt telling Claude to register the plan to Lattice
const instruction = `# Lattice: Plan Mode 종료 — 래티스에 등록 필요

ExitPlanMode로 승인된 플랜 파일: \`${planFile}\`

이 플랜을 래티스에 등록하세요:
1. \`lattice plan new\` 또는 기존 플랜에 Phase/Step 추가
2. \`lattice phase new\` — 각 Phase 등록
3. \`lattice step new\` — 각 Step 등록 (--assignee, --priority 포함)
4. 모든 Step은 active Bolt에 배정

플랜 파일을 직접 Read해서 내용을 파악하고, lattice CLI로 등록하세요.
파일을 파싱하지 않고 당신이 직접 이해해서 구조화하세요.`;

console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PostToolUse',
    additionalContext: instruction,
  },
}));
