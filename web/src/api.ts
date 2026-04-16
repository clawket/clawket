import type {
  Project,
  Cycle,
  Plan,
  Unit,
  Task,
  Artifact,
  Run,
  Question,
  TaskComment,
  ArtifactVersion,
  TimelineEvent,
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
  data: Partial<Pick<Project, 'name' | 'description' | 'cwds' | 'enabled' | 'wiki_paths'>>,
): Promise<Project> {
  return patch(`/projects/${encodeURIComponent(id)}`, data);
}

export function deleteProject(id: string): Promise<void> {
  return del(`/projects/${encodeURIComponent(id)}`);
}

export function addProjectCwd(id: string, cwd: string): Promise<Project> {
  return post(`/projects/${encodeURIComponent(id)}/cwds`, { cwd });
}

export function removeProjectCwd(id: string, cwd: string): Promise<Project> {
  return request(`/projects/${encodeURIComponent(id)}/cwds`, {
    method: 'DELETE',
    body: JSON.stringify({ cwd }),
  });
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

export function approvePlan(id: string): Promise<Plan> {
  return post(`/plans/${encodeURIComponent(id)}/approve`);
}

// ---------------------------------------------------------------------------
// Cycles (Sprint — time-boxed iteration, cross-cutting)
// ---------------------------------------------------------------------------

export function listCycles(params?: {
  project_id?: string;
  status?: string;
}): Promise<Cycle[]> {
  return get(`/cycles${qs(params)}`);
}

export function getCycle(id: string): Promise<Cycle> {
  return get(`/cycles/${encodeURIComponent(id)}`);
}

export function createCycle(data: {
  project_id: string;
  title: string;
  goal?: string;
  idx?: number;
}): Promise<Cycle> {
  return post('/cycles', data);
}

export function updateCycle(
  id: string,
  data: Partial<Pick<Cycle, 'title' | 'goal' | 'status'>>,
): Promise<Cycle> {
  return patch(`/cycles/${encodeURIComponent(id)}`, data);
}

export function deleteCycle(id: string): Promise<void> {
  return del(`/cycles/${encodeURIComponent(id)}`);
}

export function listCycleTasks(id: string): Promise<Task[]> {
  return get(`/cycles/${encodeURIComponent(id)}/tasks`);
}

export function listBacklog(project_id: string): Promise<Task[]> {
  return get(`/backlog${qs({ project_id })}`);
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

export function listUnits(params?: {
  plan_id?: string;
  status?: string;
}): Promise<Unit[]> {
  return get(`/units${qs(params)}`);
}

export function getUnit(id: string): Promise<Unit> {
  return get(`/units/${encodeURIComponent(id)}`);
}

export function createUnit(data: {
  plan_id: string;
  idx: number;
  title: string;
  goal?: string;
  approval_required?: number;
}): Promise<Unit> {
  return post('/units', data);
}

export function updateUnit(
  id: string,
  data: Partial<Pick<Unit, 'title' | 'goal'>>,
): Promise<Unit> {
  return patch(`/units/${encodeURIComponent(id)}`, data);
}

export function deleteUnit(id: string): Promise<void> {
  return del(`/units/${encodeURIComponent(id)}`);
}

export function approveUnit(id: string, by?: string): Promise<Unit> {
  return post(`/units/${encodeURIComponent(id)}/approve`, by ? { approved_by: by } : undefined);
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function listTasks(params?: {
  unit_id?: string;
  plan_id?: string;
  status?: string;
}): Promise<Task[]> {
  return get(`/tasks${qs(params)}`);
}

export function listChildTasks(parentTaskId: string): Promise<Task[]> {
  return get(`/tasks${qs({ parent_task_id: parentTaskId })}`);
}

export function getTask(id: string): Promise<Task> {
  return get(`/tasks/${encodeURIComponent(id)}`);
}

export function createTask(data: {
  unit_id: string;
  idx: number;
  title: string;
  body: string;
  assignee?: string;
  depends_on?: string[];
  parent_task_id?: string;
}): Promise<Task> {
  return post('/tasks', data);
}

export function updateTask(
  id: string,
  data: Partial<Pick<Task, 'title' | 'body' | 'status' | 'assignee' | 'depends_on' | 'cycle_id' | 'unit_id'>>,
): Promise<Task> {
  return patch(`/tasks/${encodeURIComponent(id)}`, data);
}

export function deleteTask(id: string): Promise<void> {
  return del(`/tasks/${encodeURIComponent(id)}`);
}

export function bulkUpdateTasks(
  ids: string[],
  fields: Partial<Pick<Task, 'status' | 'cycle_id' | 'unit_id' | 'assignee'>>,
): Promise<Task[]> {
  return post('/tasks/bulk-update', { ids, fields });
}

export function appendTaskBody(id: string, text: string): Promise<Task> {
  return post(`/tasks/${encodeURIComponent(id)}/append`, { text });
}

export function searchTasks(query: string, limit?: number): Promise<Task[]> {
  return get(`/tasks/search${qs({ q: query, limit })}`);
}

export function addTaskLabel(id: string, label: string): Promise<Task> {
  return post(`/tasks/${encodeURIComponent(id)}/labels`, { label });
}

export function removeTaskLabel(id: string, label: string): Promise<Task> {
  return del(`/tasks/${encodeURIComponent(id)}/labels/${encodeURIComponent(label)}`);
}

// ---------------------------------------------------------------------------
// Wiki Files (project cwd file scanner)
// ---------------------------------------------------------------------------

export interface WikiFile {
  path: string;
  name: string;
  title?: string;
  size: number;
  modified_at: number;
  content?: string;
  content_format?: string;
  wiki_root?: string;
}

export function listWikiFiles(cwd: string, projectId?: string): Promise<WikiFile[]> {
  return get(`/wiki/files${qs({ cwd, project_id: projectId })}`);
}

export function getWikiFile(cwd: string, path: string, projectId?: string): Promise<WikiFile> {
  return get(`/wiki/file${qs({ cwd, path, project_id: projectId })}`);
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function listArtifacts(params?: {
  task_id?: string;
  unit_id?: string;
  plan_id?: string;
  type?: string;
}): Promise<Artifact[]> {
  return get(`/artifacts${qs(params)}`);
}

export function getArtifact(id: string): Promise<Artifact> {
  return get(`/artifacts/${encodeURIComponent(id)}`);
}

export function createArtifact(data: {
  task_id?: string;
  unit_id?: string;
  plan_id?: string;
  type: string;
  title: string;
  content: string;
  content_format: string;
  parent_id?: string;
  scope?: string;
}): Promise<Artifact> {
  return post('/artifacts', data);
}

export function updateArtifact(
  id: string,
  data: { title?: string; content?: string; content_format?: string; created_by?: string },
): Promise<Artifact> {
  return patch(`/artifacts/${encodeURIComponent(id)}`, data);
}

export function deleteArtifact(id: string): Promise<void> {
  return del(`/artifacts/${encodeURIComponent(id)}`);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function listRuns(params?: {
  task_id?: string;
  session_id?: string;
  project_id?: string;
}): Promise<Run[]> {
  return get(`/runs${qs(params)}`);
}

export function getRun(id: string): Promise<Run> {
  return get(`/runs/${encodeURIComponent(id)}`);
}

export function startRun(data: {
  task_id: string;
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
// Project Timeline
// ---------------------------------------------------------------------------

export function listProjectTimeline(
  projectId: string,
  params?: { limit?: number; offset?: number; types?: string },
): Promise<TimelineEvent[]> {
  return get(`/projects/${encodeURIComponent(projectId)}/timeline${qs(params)}`);
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function listQuestions(params?: {
  plan_id?: string;
  unit_id?: string;
  task_id?: string;
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
  unit_id?: string;
  task_id?: string;
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
// Task Comments
// ---------------------------------------------------------------------------

export function fetchTaskComments(taskId: string): Promise<TaskComment[]> {
  return get(`/tasks/${encodeURIComponent(taskId)}/comments`);
}

export function createTaskComment(
  taskId: string,
  author: string,
  body: string,
): Promise<TaskComment> {
  return post(`/tasks/${encodeURIComponent(taskId)}/comments`, { author, body });
}

export function deleteTaskComment(id: string): Promise<void> {
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
  addProjectCwd,
  removeProjectCwd,
  listPlans,
  getPlan,
  createPlan,
  updatePlan,
  deletePlan,
  approvePlan,
  listUnits,
  getUnit,
  createUnit,
  updateUnit,
  deleteUnit,
  approveUnit,
  listTasks,
  listChildTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  bulkUpdateTasks,
  appendTaskBody,
  searchTasks,
  addTaskLabel,
  removeTaskLabel,
  listArtifacts,
  getArtifact,
  createArtifact,
  updateArtifact,
  deleteArtifact,
  listRuns,
  getRun,
  startRun,
  finishRun,
  listProjectTimeline,
  listQuestions,
  getQuestion,
  createQuestion,
  answerQuestion,
  fetchTaskComments,
  createTaskComment,
  deleteTaskComment,
  fetchArtifactVersions,
  listCycles,
  getCycle,
  createCycle,
  updateCycle,
  deleteCycle,
  listCycleTasks,
  listBacklog,
  listWikiFiles,
  getWikiFile,
} as const;

export default api;
export { ApiError };
