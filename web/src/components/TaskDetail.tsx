import { useState, useEffect, useCallback } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Task, Artifact, Run, Question, TaskComment, Cycle } from '../types';
import api from '../api';
import { Label, Input, Select, Button } from './ui';
import { TaskComments } from './task-detail/TaskComments';
import { TaskSubTasks } from './task-detail/TaskSubTasks';
import { ArtifactsSection, RunsSection, QuestionsSection } from './task-detail/TaskSections';

const PRIORITY_COLORS: Record<Task['priority'], string> = {
  critical: 'bg-danger/20 text-danger',
  high: 'bg-warning/20 text-warning',
  medium: 'bg-primary/20 text-primary',
  low: 'bg-muted/20 text-muted',
};

interface TaskDetailProps {
  taskId: string;
  projectId?: string;
  onClose: () => void;
}

const STATUS_OPTIONS: Task['status'][] = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'];

export default function TaskDetail({ taskId, projectId, onClose }: TaskDetailProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [editingAssignee, setEditingAssignee] = useState(false);
  const [assigneeDraft, setAssigneeDraft] = useState('');
  const [comments, setComments] = useState<TaskComment[]>([]);
  const [childTasks, setChildTasks] = useState<Task[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, a, r, q, c, ch] = await Promise.all([
        api.getTask(taskId),
        api.listArtifacts({ task_id: taskId }),
        api.listRuns({ task_id: taskId }),
        api.listQuestions({ task_id: taskId }),
        api.fetchTaskComments(taskId).catch((e) => { console.error('Failed to load comments:', e); return [] as TaskComment[]; }),
        api.listChildTasks(taskId).catch(() => [] as Task[]),
      ]);
      setTask(s);
      setArtifacts(a);
      setRuns(r);
      setQuestions(q);
      setComments(c);
      setChildTasks(ch);
    } catch (err) {
      console.error('Failed to load task:', err);
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!projectId) return;
    api.listCycles({ project_id: projectId }).then(setCycles).catch(() => setCycles([]));
  }, [projectId]);

  async function handleCycleChange(cycleId: string) {
    if (!task) return;
    try {
      const updated = await api.updateTask(task.id, { cycle_id: cycleId || null });
      setTask(updated);
    } catch (err) {
      console.error('Failed to update cycle assignment:', err);
    }
  }

  async function handleStatusChange(status: Task['status']) {
    if (!task) return;
    try {
      const updated = await api.updateTask(task.id, { status });
      setTask(updated);
    } catch (err) {
      console.error('Failed to update status:', err);
    }
  }

  async function handleTitleSave() {
    if (!task || !titleDraft.trim()) return;
    try {
      const updated = await api.updateTask(task.id, { title: titleDraft.trim() });
      setTask(updated);
      setEditingTitle(false);
    } catch (err) {
      console.error('Failed to update title:', err);
    }
  }

  async function handleAssigneeSave() {
    if (!task) return;
    try {
      const updated = await api.updateTask(task.id, { assignee: assigneeDraft.trim() || undefined });
      setTask(updated);
      setEditingAssignee(false);
    } catch (err) {
      console.error('Failed to update assignee:', err);
    }
  }

  async function handleDeleteTask() {
    if (!window.confirm('Are you sure you want to delete this task?')) return;
    try {
      await api.deleteTask(taskId);
      onClose();
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  }

  function formatTime(ts: number | null) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleString();
  }

  if (loading || !task) {
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
        <span className="text-xs text-muted font-mono" title={task.id}>...{task.id.slice(-6)}</span>
        <div className="flex items-center gap-2">
          <Button variant="danger" size="sm" onClick={handleDeleteTask}>Delete</Button>
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
              {task.ticket_number && (
                <span className="text-xs font-mono bg-primary/20 text-primary px-1.5 py-0.5 rounded shrink-0">
                  {task.ticket_number}
                </span>
              )}
              <h2
                className="text-lg font-semibold text-foreground cursor-pointer hover:text-primary transition-colors"
                onClick={() => { setTitleDraft(task.title); setEditingTitle(true); }}
              >
                {task.title}
              </h2>
            </div>
          )}
          {/* Priority + Complexity badges */}
          <div className="flex items-center gap-2 mt-1.5">
            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${PRIORITY_COLORS[task.priority]}`}>
              {task.priority}
            </span>
            {task.complexity && (
              <span className="text-xs bg-secondary/20 text-secondary px-1.5 py-0.5 rounded font-medium">
                {task.complexity}
              </span>
            )}
            {task.estimated_edits != null && (
              <span className="text-xs text-muted">
                ~{task.estimated_edits} edits
              </span>
            )}
          </div>
        </div>

        {/* Status + Assignee + Cycle row */}
        <div className="flex gap-4">
          <div className="flex-1">
            <Label>Status</Label>
            <Select
              value={task.status}
              onChange={(e) => handleStatusChange(e.target.value as Task['status'])}
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
                onClick={() => { setAssigneeDraft(task.assignee ?? ''); setEditingAssignee(true); }}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm cursor-pointer hover:border-primary transition-colors min-h-[34px]"
              >
                {task.assignee ? (
                  <span className="text-foreground">{task.assignee}</span>
                ) : (
                  <span className="text-muted">Unassigned</span>
                )}
              </div>
            )}
          </div>
          <div className="flex-1">
            <Label>Cycle</Label>
            {cycles.length > 0 ? (
              <Select
                value={task.cycle_id ?? ''}
                onChange={(e) => handleCycleChange(e.target.value)}
                size="sm"
              >
                <option value="">Unassigned</option>
                {cycles.map((b) => (
                  <option key={b.id} value={b.id}>
                    #{b.idx} {b.title}
                  </option>
                ))}
              </Select>
            ) : (
              <div className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm text-muted min-h-[34px]">
                {task.cycle_id ? (
                  <span className="text-foreground font-mono text-xs">...{task.cycle_id.slice(-6)}</span>
                ) : (
                  <span>Unassigned</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted">Created:</span> <span className="text-foreground">{formatTime(task.created_at)}</span></div>
          <div><span className="text-muted">Started:</span> <span className="text-foreground">{formatTime(task.started_at)}</span></div>
          <div><span className="text-muted">Completed:</span> <span className="text-foreground">{formatTime(task.completed_at)}</span></div>
        </div>

        {/* Dependencies */}
        {(task.depends_on || []).length > 0 && (
          <div>
            <Label>Dependencies</Label>
            <div className="flex flex-wrap gap-1.5">
              {(task.depends_on || []).map((dep) => (
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
            {task.body ? (
              <Markdown remarkPlugins={[remarkGfm]}>{task.body}</Markdown>
            ) : (
              <span className="text-muted italic">No content</span>
            )}
          </div>
        </div>

        <TaskSubTasks task={task} childTasks={childTasks} onChildCreated={(child) => setChildTasks(prev => [...prev, child])} />
        <ArtifactsSection artifacts={artifacts} />
        <RunsSection runs={runs} />
        <QuestionsSection questions={questions} />
        <TaskComments taskId={taskId} comments={comments} onCommentsChange={setComments} />
      </div>
    </div>
  );
}
