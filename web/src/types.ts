export interface Project {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
  cwds: string[];
  enabled: number;
  wiki_paths: string[];
}

export interface Bolt {
  id: string;
  project_id: string;
  title: string;
  goal: string | null;
  idx: number;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  status: 'planning' | 'active' | 'completed';
}

export interface Plan {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  source: string;
  source_path: string | null;
  created_at: number;
  approved_at: number | null;
  status: 'draft' | 'active' | 'completed';
}

export interface Phase {
  id: string;
  plan_id: string;
  idx: number;
  title: string;
  goal: string | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  status: 'pending' | 'active' | 'completed';
  approval_required: number;
  approved_by: string | null;
  approved_at: number | null;
}

export interface Step {
  id: string;
  phase_id: string;
  idx: number;
  title: string;
  body: string;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  status: 'todo' | 'in_progress' | 'done' | 'blocked' | 'cancelled';
  assignee: string | null;
  depends_on: string[];
  ticket_number: string | null;
  parent_step_id: string | null;
  priority: 'critical' | 'high' | 'medium' | 'low';
  complexity: string | null;
  estimated_edits: number | null;
  bolt_id: string | null;
  labels: string[];
  reporter: string | null;
  type: 'task' | 'bug' | 'feature' | 'enhancement' | 'refactor' | 'docs' | 'test' | 'chore';
}

export interface StepComment {
  id: string;
  step_id: string;
  author: string;
  body: string;
  created_at: number;
}

export interface ArtifactVersion {
  id: string;
  artifact_id: string;
  version: number;
  content: string | null;
  content_format: string | null;
  created_at: number;
  created_by: string | null;
}

export interface Artifact {
  id: string;
  step_id: string | null;
  phase_id: string | null;
  plan_id: string | null;
  type: string;
  title: string;
  content: string;
  content_format: string;
  scope: 'rag' | 'reference' | 'archive';
  created_at: number;
}

export interface Run {
  id: string;
  step_id: string;
  session_id: string | null;
  agent: string;
  started_at: number;
  ended_at: number | null;
  result: string | null;
  notes: string | null;
}

export type TimelineEventType =
  | 'status_change' | 'comment' | 'artifact' | 'run_start' | 'run_end'
  | 'question' | 'created' | 'updated' | 'assignment';

export interface TimelineEvent {
  id: string;
  event_type: TimelineEventType;
  entity_type: 'step' | 'phase' | 'bolt' | 'plan';
  entity_id: string;
  entity_title: string;
  actor: string | null;
  created_at: number;
  detail: {
    field?: string;
    old_value?: string;
    new_value?: string;
    body?: string;
    artifact_type?: string;
    agent?: string;
    duration_ms?: number;
    result?: string;
  };
}

/** Terminal statuses — steps that count as "closed" for progress calculations */
/** Terminal statuses — steps that count as "closed" for progress calculations */
export const CLOSED_STATUSES: ReadonlySet<Step['status']> = new Set(['done', 'cancelled']);

export function isClosedStep(step: Pick<Step, 'status'>): boolean {
  return CLOSED_STATUSES.has(step.status);
}

export interface Question {
  id: string;
  plan_id: string | null;
  phase_id: string | null;
  step_id: string | null;
  kind: string;
  origin: string;
  body: string;
  asked_by: string;
  created_at: number;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
}
