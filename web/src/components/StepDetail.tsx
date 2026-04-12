import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import type { Step, Artifact, Run, Question, StepComment, Bolt } from '../types';
import api from '../api';
import StatusBadge from './StatusBadge';
import { Label, Input, Textarea, Select, Button } from './ui';

const STEP_STATUS_ICON: Record<Step['status'], { icon: string; color: string }> = {
  todo: { icon: '\u25CB', color: 'text-muted' },
  in_progress: { icon: '\u25D0', color: 'text-warning' },
  review: { icon: '\u25D2', color: 'text-primary' },
  done: { icon: '\u25CF', color: 'text-success' },
  blocked: { icon: '\u2298', color: 'text-danger' },
  cancelled: { icon: '\u2715', color: 'text-muted' },
  superseded: { icon: '\u2715', color: 'text-muted' },
  deferred: { icon: '\u223C', color: 'text-muted' },
};

function SubStepTree({ steps, depth = 0 }: { steps: Step[]; depth?: number }) {
  const [childMap, setChildMap] = useState<Record<string, Step[]>>({});

  useEffect(() => {
    if (depth >= 3) return;
    const ids = steps.map((s) => s.id);
    Promise.all(ids.map((id) => api.listChildSteps(id).catch(() => [] as Step[]))).then(
      (results) => {
        const map: Record<string, Step[]> = {};
        ids.forEach((id, i) => {
          if (results[i].length > 0) map[id] = results[i];
        });
        setChildMap(map);
      },
    );
  }, [steps, depth]);

  return (
    <>
      {steps.map((child) => {
        const si = STEP_STATUS_ICON[child.status];
        return (
          <div key={child.id}>
            <div
              className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-background/60 transition-colors"
              style={{ paddingLeft: `${depth * 20 + 8}px` }}
            >
              <span className={`text-sm ${si.color}`}>{si.icon}</span>
              {child.ticket_number && (
                <span className="text-xs font-mono text-muted shrink-0">{child.ticket_number}</span>
              )}
              <span className="text-sm text-foreground truncate flex-1">{child.title}</span>
              {child.assignee && (
                <span className="text-xs text-muted shrink-0">{child.assignee}</span>
              )}
              <StatusBadge status={child.status} size="sm" />
            </div>
            {childMap[child.id] && (
              <SubStepTree steps={childMap[child.id]} depth={depth + 1} />
            )}
          </div>
        );
      })}
    </>
  );
}

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

const STATUS_OPTIONS: Step['status'][] = ['todo', 'in_progress', 'review', 'done', 'blocked', 'cancelled', 'deferred'];

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
  const [commentAuthor, setCommentAuthor] = useState('');
  const [commentBody, setCommentBody] = useState('');
  const [submittingComment, setSubmittingComment] = useState(false);
  const [childSteps, setChildSteps] = useState<Step[]>([]);
  const [showChildForm, setShowChildForm] = useState(false);
  const [childTitleDraft, setChildTitleDraft] = useState('');
  const [childAssigneeDraft, setChildAssigneeDraft] = useState('');
  const [creatingChild, setCreatingChild] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, r, q, c, ch] = await Promise.all([
        api.getStep(stepId),
        api.listArtifacts({ step_id: stepId }),
        api.listRuns({ step_id: stepId }),
        api.listQuestions({ step_id: stepId }),
        api.fetchStepComments(stepId).catch(() => [] as StepComment[]),
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

  async function handleAddComment() {
    if (!step || !commentAuthor.trim() || !commentBody.trim()) return;
    setSubmittingComment(true);
    try {
      const newComment = await api.createStepComment(step.id, commentAuthor.trim(), commentBody.trim());
      setComments((prev) => [...prev, newComment]);
      setCommentBody('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setSubmittingComment(false);
    }
  }

  async function handleDeleteComment(commentId: string) {
    try {
      await api.deleteStepComment(commentId);
      setComments((prev) => prev.filter((c) => c.id !== commentId));
    } catch (err) {
      console.error('Failed to delete comment:', err);
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

  async function handleCreateChildStep() {
    if (!step || !childTitleDraft.trim()) return;
    setCreatingChild(true);
    try {
      const maxIdx = childSteps.reduce((max, s) => Math.max(max, s.idx), 0);
      await api.createStep({
        phase_id: step.phase_id,
        idx: maxIdx + 1,
        title: childTitleDraft.trim(),
        body: '',
        assignee: childAssigneeDraft.trim() || undefined,
        parent_step_id: step.id,
      });
      const updated = await api.listChildSteps(step.id);
      setChildSteps(updated);
      setChildTitleDraft('');
      setChildAssigneeDraft('');
      setShowChildForm(false);
    } catch (err) {
      console.error('Failed to create child step:', err);
    } finally {
      setCreatingChild(false);
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
        {step.depends_on.length > 0 && (
          <div>
            <Label>Dependencies</Label>
            <div className="flex flex-wrap gap-1.5">
              {step.depends_on.map((dep) => (
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
              <Markdown>{step.body}</Markdown>
            ) : (
              <span className="text-muted italic">No content</span>
            )}
          </div>
        </div>

        {/* Sub-Steps */}
        <div>
          <Label>Sub-Steps ({childSteps.length})</Label>
          {childSteps.length === 0 && !showChildForm ? (
            <div className="text-sm text-muted italic">No sub-steps</div>
          ) : (
            <div className="bg-background border border-border rounded overflow-hidden divide-y divide-border">
              <SubStepTree steps={childSteps} />
            </div>
          )}
          {showChildForm ? (
            <div className="mt-2 bg-background border border-border rounded p-3 space-y-2">
              <Input
                value={childTitleDraft}
                onChange={(e) => setChildTitleDraft(e.target.value)}
                placeholder="Sub-step title"
                size="sm"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateChildStep();
                  if (e.key === 'Escape') setShowChildForm(false);
                }}
              />
              <Input
                value={childAssigneeDraft}
                onChange={(e) => setChildAssigneeDraft(e.target.value)}
                placeholder="Assignee (optional)"
                size="sm"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCreateChildStep();
                  if (e.key === 'Escape') setShowChildForm(false);
                }}
              />
              <div className="flex items-center gap-2 justify-end">
                <Button variant="ghost" size="sm" onClick={() => setShowChildForm(false)}>Cancel</Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCreateChildStep}
                  disabled={creatingChild || !childTitleDraft.trim()}
                >
                  {creatingChild ? 'Creating...' : 'Create'}
                </Button>
              </div>
            </div>
          ) : (
            <button
              className="mt-2 flex items-center gap-1 text-xs text-muted hover:text-primary transition-colors"
              onClick={() => setShowChildForm(true)}
            >
              <span className="text-base leading-none">+</span> Add sub-step
            </button>
          )}
        </div>

        {/* Artifacts */}
        <div>
          <Label>Artifacts ({artifacts.length})</Label>
          {artifacts.length === 0 ? (
            <div className="text-sm text-muted italic">No artifacts</div>
          ) : (
            <div className="space-y-1.5">
              {artifacts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 bg-background border border-border rounded px-3 py-2">
                  <span className="text-xs font-mono bg-secondary/20 text-secondary px-1.5 py-0.5 rounded">{a.type}</span>
                  <span className="text-sm text-foreground truncate flex-1">{a.title}</span>
                  <span className="text-xs text-muted">{a.content_format}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Runs */}
        <div>
          <Label>Runs ({runs.length})</Label>
          {runs.length === 0 ? (
            <div className="text-sm text-muted italic">No runs</div>
          ) : (
            <div className="border border-border rounded overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-background text-muted">
                    <th className="text-left px-2 py-1.5 font-medium">Agent</th>
                    <th className="text-left px-2 py-1.5 font-medium">Started</th>
                    <th className="text-left px-2 py-1.5 font-medium">Ended</th>
                    <th className="text-left px-2 py-1.5 font-medium">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id} className="border-t border-border">
                      <td className="px-2 py-1.5 text-foreground">{r.agent}</td>
                      <td className="px-2 py-1.5 text-muted">{formatTime(r.started_at)}</td>
                      <td className="px-2 py-1.5 text-muted">{formatTime(r.ended_at)}</td>
                      <td className="px-2 py-1.5">
                        {r.result ? (
                          <StatusBadge status={r.result} size="sm" />
                        ) : (
                          <span className="text-warning">running</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Questions */}
        <div>
          <Label>Questions ({questions.length})</Label>
          {questions.length === 0 ? (
            <div className="text-sm text-muted italic">No questions</div>
          ) : (
            <div className="space-y-2">
              {questions.map((q) => (
                <div key={q.id} className="bg-background border border-border rounded p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-mono bg-primary/20 text-primary px-1.5 py-0.5 rounded">{q.kind}</span>
                    <span className="text-xs text-muted">by {q.asked_by}</span>
                  </div>
                  <div className="text-sm text-foreground">{q.body}</div>
                  {q.answer && (
                    <div className="mt-2 pl-3 border-l-2 border-success">
                      <div className="text-xs text-muted mb-0.5">Answer by {q.answered_by}</div>
                      <div className="text-sm text-foreground">{q.answer}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Comments */}
        <div>
          <Label>Comments ({comments.length})</Label>
          {comments.length > 0 && (
            <div className="space-y-2 mb-3">
              {comments.map((c) => (
                <div key={c.id} className="bg-background border border-border rounded p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-foreground">{c.author}</span>
                      <span className="text-xs text-muted">{formatTime(c.created_at)}</span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteComment(c.id)}
                      title="Delete comment"
                    >
                      &times;
                    </Button>
                  </div>
                  <div className="text-sm text-foreground">{c.body}</div>
                </div>
              ))}
            </div>
          )}
          {/* New comment form */}
          <div className="bg-background border border-border rounded p-3 space-y-2">
            <Input
              value={commentAuthor}
              onChange={(e) => setCommentAuthor(e.target.value)}
              placeholder="Author"
              size="sm"
            />
            <Textarea
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              placeholder="Write a comment..."
              rows={3}
              size="sm"
            />
            <div className="flex justify-end">
              <Button
                variant="secondary"
                size="sm"
                onClick={handleAddComment}
                disabled={submittingComment || !commentAuthor.trim() || !commentBody.trim()}
              >
                {submittingComment ? 'Posting...' : 'Add Comment'}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
