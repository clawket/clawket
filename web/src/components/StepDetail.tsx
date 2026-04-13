import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Step, Artifact, Run, Question, StepComment, Bolt } from '../types';
import api from '../api';
import { Label, Input, Select, Button } from './ui';
import { StepComments } from './step-detail/StepComments';
import { StepSubSteps } from './step-detail/StepSubSteps';
import { ArtifactsSection, RunsSection, QuestionsSection } from './step-detail/StepSections';

const PRIORITY_COLORS: Record<Step['priority'], string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-warning/20 text-warning',
  medium: 'bg-primary/20 text-primary',
  low: 'bg-muted/20 text-muted',
};

interface StepDetailProps {
  stepId: string;
  projectId?: string;
  onClose: () => void;
}

const STATUS_OPTIONS: Step['status'][] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

export default function StepDetail({ stepId, projectId, onClose }: StepDetailProps) {
  const [step, setStep] = useState<Step | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [bolts, setBolts] = useState<Bolt[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [comments, setComments] = useState<StepComment[]>([]);
  const [childSteps, setChildSteps] = useState<Step[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, r, q, c, ch] = await Promise.all([
        api.getStep(stepId),
        api.listArtifacts({ step_id: stepId }),
        api.listRuns({ step_id: stepId }),
        api.listQuestions({ step_id: stepId }),
        api.fetchStepComments(stepId).catch((e) => { console.error('Failed to load comments:', e); return [] as StepComment[]; }),
        api.listChildSteps(stepId).catch(() => [] as Step[]),
      ]);
      setStep(s);
      setArtifacts(a);
      setRuns(r);
      setQuestions(q);
      setComments(c);
      setChildSteps(ch);
    } catch (err) {
      console.error('Failed to load step:', err);
    } finally {
      setLoading(false);
    }
  }, [stepId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!projectId) return;
    api.listBolts({ project_id: projectId }).then(setBolts).catch(() => setBolts([]));
  }, [projectId]);

  async function handleBoltChange(boltId: string) {
    if (!step) return;
    try {
      const updated = await api.updateStep(step.id, { bolt_id: boltId || null });
      setStep(updated);
    } catch (err) {
      console.error('Failed to update bolt assignment:', err);
    }
  }

  async function handleStatusChange(status: Step['status']) {
    if (!step) return;
    try {
      const updated = await api.updateStep(step.id, { status });
      setStep(updated);
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  async function handleTitleSave() {
    if (!step || !titleDraft.trim()) return;
    try {
      const updated = await api.updateStep(step.id, { title: titleDraft.trim() });
      setStep(updated);
      setEditingTitle(false);
    } catch (err) {
      console.error('Failed to update title:', err);
    }
  }

  async function handleAssigneeSave() {
    if (!step) return;
    try {
      const updated = await api.updateStep(step.id, { assignee: assigneeDraft.trim() || undefined });
      setStep(updated);
      setEditingAssignee(false);
    } catch (err) {
      console.error('Failed to update assignee:', err);
    }
  }

  async function handleDeleteStep() {
    if (!window.confirm('Are you sure you want to delete this step?')) return;
    try {
      await api.deleteStep(stepId);
      onClose();
    } catch (err) {
      console.error('Failed to delete step:', err);
    }
  }

  function formatTime(ts: number | null) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleString();
  }

  if (loading || !step) {
    return (
      <div className="w-full bg-surface flex items-center justify-center text-muted text-sm">
        Loading...
      </div>
    );
  }

  return (
    <div className="w-full bg-surface flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <span className="text-xs text-muted font-mono" title={step.id}>...{step.id.slice(-6)}</span>
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={handleDeleteStep}>Delete</Button>
          <button onClick={onClose} className="text-muted hover:text-foreground text-lg leading-none">&times;</button>
        </div>
      </div>

      <div className="p-4 space-y-5">
        {/* Title */}
        <div>
          {editingTitle ? (
            <Input
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => { if (e.key === 'Enter') handleTitleSave(); if (e.key === 'Escape') setEditingTitle(false); }}
              className="w-full text-lg font-semibold"
              autoFocus
            />
          ) : (
            <div className="flex items-center gap-2 flex-wrap">
              {step.ticket_number && (
                <span className="text-xs font-mono bg-primary/20 text-primary px-1.5 py-0.5 rounded shrink-0">
                  {step.ticket_number}
                </span>
              )}
              <h2
                className="text-lg font-semibold text-foreground cursor-pointer hover:text-primary transition-colors"
                onClick={() => { setTitleDraft(step.title); setEditingTitle(true); }}
              >
                {step.title}
              </h2>
            </div>
          )}
          {/* Priority + Complexity badges */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PRIORITY_COLORS[step.priority]}`}>
              {step.priority}
            </span>
            {step.complexity && (
              <span className="text-xs bg-secondary/20 text-secondary px-1.5 py-0.5 rounded font-medium">
                {step.complexity}
              </span>
            )}
            {step.estimated_edits != null && (
              <span className="text-xs text-muted">
                ~{step.estimated_edits} edits
              </span>
            )}
          </div>
        </div>

        {/* Status + Assignee + Bolt row */}
        <div className="flex gap-4">
          <div className="flex-1">
            <Label>Status</Label>
            <Select
              value={step.status}
              onChange={(e) => handleStatusChange(e.target.value as Step['status'])}
              size="sm"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex-1">
            <Label>Assignee</Label>
            {editingAssignee ? (
              <Input
                value={assigneeDraft}
                onChange={(e) => setAssigneeDraft(e.target.value)}
                onBlur={handleAssigneeSave}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAssigneeSave(); if (e.key === 'Escape') setEditingAssignee(false); }}
                placeholder="Unassigned"
                size="sm"
                autoFocus
              />
            ) : (
              <div
                onClick={() => { setAssigneeDraft(step.assignee ?? ''); setEditingAssignee(true); }}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm cursor-pointer hover:border-primary transition-colors min-h-[34px]"
              >
                {step.assignee ? (
                  <span className="text-foreground">{step.assignee}</span>
                ) : (
                  <span className="text-muted">Unassigned</span>
                )}
              </div>
            )}
          </div>
          <div className="flex-1">
            <Label>Bolt</Label>
            {bolts.length > 0 ? (
              <Select
                value={step.bolt_id ?? ''}
                onChange={(e) => handleBoltChange(e.target.value)}
                size="sm"
              >
                <option value="">Unassigned</option>
                {bolts.map((b) => (
                  <option key={b.id} value={b.id}>
                    #{b.idx} {b.title}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-muted min-h-[34px]">
                {step.bolt_id ? (
                  <span className="text-foreground font-mono text-xs">...{step.bolt_id.slice(-6)}</span>
                ) : (
                  <span>Unassigned</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted">Created:</span> <span className="text-foreground">{formatTime(step.created_at)}</span></div>
          <div><span className="text-muted">Started:</span> <span className="text-foreground">{formatTime(step.started_at)}</span></div>
          <div><span className="text-muted">Completed:</span> <span className="text-foreground">{formatTime(step.completed_at)}</span></div>
        </div>

        {/* Dependencies */}
        {(step.depends_on || []).length > 0 && (
          <div>
            <Label>Dependencies</Label>
            <div className="flex flex-wrap gap-1.5">
              {(step.depends_on || []).map((dep) => (
                <span key={dep} className="text-xs font-mono bg-border/50 text-muted px-2 py-0.5 rounded" title={dep}>
                  ...{dep.slice(-6)}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        <div>
          <Label>Body</Label>
          <div className="bg-background border border-border rounded p-3 text-sm leading-relaxed max-h-80 overflow-y-auto prose prose-sm max-w-none">
            {step.body ? (
              <Markdown remarkPlugins={[remarkGfm]}>{step.body}</Markdown>
            ) : (
              <span className="text-muted italic">No content</span>
            )}
          </div>
        </div>

        <StepSubSteps step={step} childSteps={childSteps} onChildCreated={(child) => setChildSteps(prev => [...prev, child])} />
        <ArtifactsSection artifacts={artifacts} />
        <RunsSection runs={runs} />
        <QuestionsSection questions={questions} />
        <StepComments stepId={stepId} comments={comments} onCommentsChange={setComments} />
      </div>
    </div>
  );
}
