import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { projects, plans, phases, steps } from './repo.js';

// Parse a Claude Code plan markdown file into Lattice entities.
// Rules (deterministic, no LLM):
//   - First `# <title>` line is the Plan title.
//   - `## Phase N: <title>` (or `## Phase: <title>`) sections become Phase rows.
//     If no explicit Phase heading found, the whole plan becomes a single "Phase 1".
//   - Within a Phase, `### <title>` headings become Steps.
//     Or, if the Phase contains a numbered list ("1. foo", "2. bar") at the top level,
//     those become Steps instead.
//   - The text content between headings becomes the body of the enclosing entity.

export function parsePlanMarkdown(md) {
  const lines = md.split('\n');
  const plan = { title: null, description: '', phases: [] };

  // Find plan title
  const titleMatch = lines.find(l => /^#\s+/.test(l));
  if (titleMatch) plan.title = titleMatch.replace(/^#\s+/, '').trim();

  // Find phase sections by looking for ## Phase N: or ## Phase: headings
  const phaseHeadingRe = /^##\s+Phase\s*(\d+)?\s*[:.]?\s*(.*)$/i;
  const h2Re = /^##\s+(.+)$/;
  const h3Re = /^###\s+(.+)$/;

  // Locate phase headings
  const phaseMarkers = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(phaseHeadingRe);
    if (m) {
      phaseMarkers.push({
        lineIdx: i,
        idx: phaseMarkers.length,
        title: (m[2] && m[2].trim()) || `Phase ${m[1] || phaseMarkers.length + 1}`,
      });
    }
  }

  if (phaseMarkers.length === 0) {
    // No explicit Phase section: synthesize a single Phase containing all content
    plan.phases.push({
      idx: 0,
      title: 'Phase 1',
      goal: null,
      body: lines.join('\n').trim(),
      steps: extractStepsFromBody(lines, 0, lines.length),
    });
  } else {
    // Description = content from start to first phase
    plan.description = lines.slice(0, phaseMarkers[0].lineIdx).join('\n').trim();

    for (let p = 0; p < phaseMarkers.length; p++) {
      const start = phaseMarkers[p].lineIdx;
      const end = p + 1 < phaseMarkers.length ? phaseMarkers[p + 1].lineIdx : lines.length;
      plan.phases.push({
        idx: p,
        title: phaseMarkers[p].title,
        goal: null,
        body: lines.slice(start, end).join('\n').trim(),
        steps: extractStepsFromBody(lines, start + 1, end),
      });
    }
  }

  return plan;
}

function extractStepsFromBody(lines, start, end) {
  // Prefer ### subheadings as steps
  const h3Re = /^###\s+(.+)$/;
  const h3Indices = [];
  for (let i = start; i < end; i++) {
    const m = lines[i].match(h3Re);
    if (m) h3Indices.push({ lineIdx: i, title: m[1].trim() });
  }

  if (h3Indices.length > 0) {
    const out = [];
    for (let j = 0; j < h3Indices.length; j++) {
      const s = h3Indices[j].lineIdx;
      const e = j + 1 < h3Indices.length ? h3Indices[j + 1].lineIdx : end;
      out.push({
        idx: j,
        title: h3Indices[j].title,
        body: lines.slice(s + 1, e).join('\n').trim(),
      });
    }
    return out;
  }

  // Fallback: look for numbered list items at paragraph starts
  const numberedRe = /^\s*\d+\.\s+\*?\*?([^*]+)\*?\*?(.*)$/;
  const steps = [];
  for (let i = start; i < end; i++) {
    const m = lines[i].match(numberedRe);
    if (m) {
      steps.push({
        idx: steps.length,
        title: (m[1] || '').trim(),
        body: ((m[2] || '') + '\n' + gatherContinuation(lines, i + 1, end)).trim(),
      });
    }
  }
  return steps;
}

function gatherContinuation(lines, from, end) {
  // Collect lines until next list item or heading
  const out = [];
  for (let i = from; i < end; i++) {
    if (/^##?#?\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

export function importPlanFile(filePath, { projectName = null, cwd = null, source = 'import', dryRun = false } = {}) {
  const md = readFileSync(filePath, 'utf8');
  const parsed = parsePlanMarkdown(md);
  if (!parsed.title) throw new Error('no plan title (first # heading) found');

  // Resolve project
  let project;
  if (projectName) {
    project = projects.getByName(projectName);
    if (!project) {
      project = projects.create({ name: projectName, cwd: cwd || process.cwd() });
    }
  } else {
    project = projects.getByCwd(cwd || process.cwd());
    if (!project) {
      const fallback = basename(filePath, '.md').slice(0, 40);
      project = projects.create({ name: fallback, cwd: cwd || process.cwd() });
    }
  }

  if (dryRun) {
    return {
      dryRun: true,
      project: project,
      plan_title: parsed.title,
      phase_count: parsed.phases.length,
      step_count: parsed.phases.reduce((n, ph) => n + ph.steps.length, 0),
      phases: parsed.phases.map(p => ({ title: p.title, steps: p.steps.map(s => s.title) })),
    };
  }

  // Create plan
  const plan = plans.create({
    project_id: project.id,
    title: parsed.title,
    description: parsed.description || null,
    source,
    source_path: filePath,
  });

  // Create phases + steps
  const createdPhases = [];
  for (const ph of parsed.phases) {
    const phaseRow = phases.create({
      plan_id: plan.id,
      title: ph.title,
      goal: null,
      idx: ph.idx,
      approval_required: false,
    });
    const createdSteps = [];
    for (const st of ph.steps) {
      const stepRow = steps.create({
        phase_id: phaseRow.id,
        title: st.title,
        body: st.body,
        idx: st.idx,
      });
      createdSteps.push(stepRow);
    }
    createdPhases.push({ phase: phaseRow, steps: createdSteps });
  }

  return {
    project,
    plan,
    phases: createdPhases,
    summary: {
      phase_count: createdPhases.length,
      step_count: createdPhases.reduce((n, p) => n + p.steps.length, 0),
    },
  };
}
