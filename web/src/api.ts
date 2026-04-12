import type {
  Project,
  Bolt,
  Plan,
  Phase,
  Step,
  Artifact,
  Run,
  Question,
  StepComment,
  ArtifactVersion,
} from './types';

const BASE = '';

class ApiError extends Error {
  status: number;
  statusText: string;
  body: unknown;

  constructor(status: number, statusText: string, body: unknown) {
    super(`API ${status} ${statusText}`);
    this.name = 'ApiError';
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

function qs(params?: Record<string, string | number | undefined>): string {
  if (!params) return '';
  const entries = Object.entries(params).filter(
    (e): e is [string, string | number] => e[1] !== undefined,
  );
  if (entries.length === 0) return '';
  return '?' + new URLSearchParams(entries.map(([k, v]) => [k, String(v)])).toString();
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => null);
    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body as string);
    } catch {
      // keep raw text
    }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: 'GET' });
}

function post<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}

function _put<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PUT',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}
void _put; // reserved for future use

function patch<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, {
    method: 'PATCH',
    body: data !== undefined ? JSON.stringify(data) : undefined,
  });
}

function del<T = void>(path: string): Promise<T> {
  return request<T>(path, { method: 'DELETE' });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function listProjects(): Promise<Project[]> {
  return get('/projects');
}

export function getProject(id: string): Promise<Project> {
  return get(`/projects/${encodeURIComponent(id)}`);
}

export function createProject(data: {
  name: string;
  description?: string;
  cwd?: string;
}): Promise<Project> {
  return post('/projects', data);
}

export function updateProject(
  id: string,
  data: Partial<Pick<Project, 'name' | 'description' | 'cwds'>>,
): Promise<Project> {
  return patch(`/projects/${encodeURIComponent(id)}`, data);
}

export function deleteProject(id: string): Promise<void> {
  return del(`/projects/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export function listPlans(params?: {
  project_id?: string;
  status?: string;
}): Promise<Plan[]> {
  return get(`/plans${qs(params)}`);
}

export function getPlan(id: string): Promise<Plan> {
  return get(`/plans/${encodeURIComponent(id)}`);
}

export function createPlan(data: {
  project_id: string;
  title: string;
  description?: string;
  source: string;
  source_path?: string;
}): Promise<Plan> {
  return post('/plans', data);
}

export function updatePlan(
  id: string,
  data: Partial<Pick<Plan, 'title' | 'description' | 'status'>>,
): Promise<Plan> {
  return patch(`/plans/${encodeURIComponent(id)}`, data);
}

export function deletePlan(id: string): Promise<void> {
  return del(`/plans/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Bolts (Sprint / AIDLC Bolt cycle)
// ---------------------------------------------------------------------------

export function listBolts(params?: {
  project_id?: string;
  status?: string;
}): Promise<Bolt[]> {
  return get(`/bolts${qs(params)}`);
}

export function getBolt(id: string): Promise<Bolt> {
  return get(`/bolts/${encodeURIComponent(id)}`);
}

export function createBolt(data: {
  project_id: string;
  title: string;
  goal?: string;
  idx?: number;
}): Promise<Bolt> {
  return post('/bolts', data);
}

export function updateBolt(
  id: string,
  data: Partial<Pick<Bolt, 'title' | 'goal' | 'status'>>,
): Promise<Bolt> {
  return patch(`/bolts/${encodeURIComponent(id)}`, data);
}

export function deleteBolt(id: string): Promise<void> {
  return del(`/bolts/${encodeURIComponent(id)}`);
}

export function listBoltSteps(id: string): Promise<Step[]> {
  return get(`/bolts/${encodeURIComponent(id)}/steps`);
}

export function listBacklog(project_id: string): Promise<Step[]> {
  return get(`/backlog${qs({ project_id })}`);
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

export function listPhases(params?: {
  plan_id?: string;
  status?: string;
}): Promise<Phase[]> {
  return get(`/phases${qs(params)}`);
}

export function getPhase(id: string): Promise<Phase> {
  return get(`/phases/${encodeURIComponent(id)}`);
}

export function createPhase(data: {
  plan_id: string;
  idx: number;
  title: string;
  goal?: string;
  approval_required?: number;
}): Promise<Phase> {
  return post('/phases', data);
}

export function updatePhase(
  id: string,
  data: Partial<Pick<Phase, 'title' | 'goal' | 'status' | 'approval_required'>>,
): Promise<Phase> {
  return patch(`/phases/${encodeURIComponent(id)}`, data);
}

export function deletePhase(id: string): Promise<void> {
  return del(`/phases/${encodeURIComponent(id)}`);
}

export function approvePhase(id: string, by?: string): Promise<Phase> {
  return post(`/phases/${encodeURIComponent(id)}/approve`, by ? { approved_by: by } : undefined);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function listSteps(params?: {
  phase_id?: string;
  plan_id?: string;
  status?: string;
}): Promise<Step[]> {
  return get(`/steps${qs(params)}`);
}

export function listChildSteps(parentStepId: string): Promise<Step[]> {
  return get(`/steps${qs({ parent_step_id: parentStepId })}`);
}

export function getStep(id: string): Promise<Step> {
  return get(`/steps/${encodeURIComponent(id)}`);
}

export function createStep(data: {
  phase_id: string;
  idx: number;
  title: string;
  body: string;
  assignee?: string;
  depends_on?: string[];
  parent_step_id?: string;
}): Promise<Step> {
  return post('/steps', data);
}

export function updateStep(
  id: string,
  data: Partial<Pick<Step, 'title' | 'body' | 'status' | 'assignee' | 'depends_on' | 'bolt_id' | 'phase_id'>>,
): Promise<Step> {
  return patch(`/steps/${encodeURIComponent(id)}`, data);
}

export function deleteStep(id: string): Promise<void> {
  return del(`/steps/${encodeURIComponent(id)}`);
}

export function bulkUpdateSteps(
  ids: string[],
  fields: Partial<Pick<Step, 'status' | 'bolt_id' | 'phase_id' | 'assignee'>>,
): Promise<Step[]> {
  return post('/steps/bulk-update', { ids, fields });
}

export function appendStepBody(id: string, text: string): Promise<Step> {
  return post(`/steps/${encodeURIComponent(id)}/append`, { text });
}

export function searchSteps(query: string, limit?: number): Promise<Step[]> {
  return get(`/steps/search${qs({ q: query, limit })}`);
}

export function addStepLabel(id: string, label: string): Promise<Step> {
  return post(`/steps/${encodeURIComponent(id)}/labels`, { label });
}

export function removeStepLabel(id: string, label: string): Promise<Step> {
  return del(`/steps/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`);
}

// ---------------------------------------------------------------------------
// Wiki Files (project cwd file scanner)
// ---------------------------------------------------------------------------

export interface WikiFile {
  path: string;
  name: string;
  size: number;
  modified_at: number;
  content?: string;
  content_format?: string;
}

export function listWikiFiles(cwd: string): Promise<WikiFile[]> {
  return get(`/wiki/files${qs({ cwd })}`);
}

export function getWikiFile(cwd: string, path: string): Promise<WikiFile> {
  return get(`/wiki/file${qs({ cwd, path })}`);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function listArtifacts(params?: {
  step_id?: string;
  phase_id?: string;
  plan_id?: string;
  type?: string;
}): Promise<Artifact[]> {
  return get(`/artifacts${qs(params)}`);
}

export function getArtifact(id: string): Promise<Artifact> {
  return get(`/artifacts/${encodeURIComponent(id)}`);
}

export function createArtifact(data: {
  step_id?: string;
  phase_id?: string;
  plan_id?: string;
  type: string;
  title: string;
  content: string;
  content_format: string;
}): Promise<Artifact> {
  return post('/artifacts', data);
}

export function deleteArtifact(id: string): Promise<void> {
  return del(`/artifacts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function listRuns(params?: {
  step_id?: string;
  session_id?: string;
}): Promise<Run[]> {
  return get(`/runs${qs(params)}`);
}

export function getRun(id: string): Promise<Run> {
  return get(`/runs/${encodeURIComponent(id)}`);
}

export function startRun(data: {
  step_id: string;
  session_id?: string;
  agent?: string;
}): Promise<Run> {
  return post('/runs', data);
}

export function finishRun(
  id: string,
  data: { result: string; notes?: string },
): Promise<Run> {
  return post(`/runs/${encodeURIComponent(id)}/finish`, data);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function listQuestions(params?: {
  plan_id?: string;
  phase_id?: string;
  step_id?: string;
  kind?: string;
  unanswered?: string;
}): Promise<Question[]> {
  return get(`/questions${qs(params)}`);
}

export function getQuestion(id: string): Promise<Question> {
  return get(`/questions/${encodeURIComponent(id)}`);
}

export function createQuestion(data: {
  plan_id?: string;
  phase_id?: string;
  step_id?: string;
  kind: string;
  origin: string;
  body: string;
  asked_by: string;
}): Promise<Question> {
  return post('/questions', data);
}

export function answerQuestion(
  id: string,
  data: { answer: string; answered_by?: string },
): Promise<Question> {
  return post(`/questions/${encodeURIComponent(id)}/answer`, data);
}

// ---------------------------------------------------------------------------
// Step Comments
// ---------------------------------------------------------------------------

export function fetchStepComments(stepId: string): Promise<StepComment[]> {
  return get(`/steps/${encodeURIComponent(stepId)}/comments`);
}

export function createStepComment(
  stepId: string,
  author: string,
  body: string,
): Promise<StepComment> {
  return post(`/steps/${encodeURIComponent(stepId)}/comments`, { author, body });
}

export function deleteStepComment(id: string): Promise<void> {
  return del(`/comments/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Artifact Versions
// ---------------------------------------------------------------------------

export function fetchArtifactVersions(artifactId: string): Promise<ArtifactVersion[]> {
  return get(`/artifacts/${encodeURIComponent(artifactId)}/versions`);
}

// ---------------------------------------------------------------------------
// Convenience namespace re-export
// ---------------------------------------------------------------------------

const api = {
  listProjects,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  listPhases,
  getPhase,
  createPhase,
  updatePhase,
  deletePhase,
  approvePhase,
  listSteps,
  listChildSteps,
  getStep,
  createStep,
  updateStep,
  deleteStep,
  bulkUpdateSteps,
  appendStepBody,
  searchSteps,
  addStepLabel,
  removeStepLabel,
  listArtifacts,
  getArtifact,
  createArtifact,
  deleteArtifact,
  listRuns,
  getRun,
  startRun,
  finishRun,
  listQuestions,
  getQuestion,
  createQuestion,
  answerQuestion,
  fetchStepComments,
  createStepComment,
  deleteStepComment,
  fetchArtifactVersions,
  listBolts,
  getBolt,
  createBolt,
  updateBolt,
  deleteBolt,
  listBoltSteps,
  listBacklog,
  listWikiFiles,
  getWikiFile,
} as const;

export default api;
export { ApiError };
