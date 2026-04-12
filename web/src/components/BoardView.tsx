import { useState, useEffect, useCallback } from 'react';
import type { Bolt, Step } from '../types';
import api from '../api';
import { Badge, Button, Input, Label, Modal, Select } from './ui';
import {
  DndContext,
  DragOverlay,
  useDraggable,
  useDroppable,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

interface BoardViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

const COLUMNS: {
  key: Step['status'];
  label: string;
  headerBg: string;
  headerText: string;
  countBg: string;
  countText: string;
}[] = [
  {
    key: 'todo',
    label: 'Todo',
    headerBg: 'bg-muted/10',
    headerText: 'text-muted',
    countBg: 'bg-muted/20',
    countText: 'text-muted',
  },
  {
    key: 'in_progress',
    label: 'In Progress',
    headerBg: 'bg-warning/10',
    headerText: 'text-warning',
    countBg: 'bg-warning/20',
    countText: 'text-warning',
  },
  {
    key: 'done',
    label: 'Done',
    headerBg: 'bg-success/10',
    headerText: 'text-success',
    countBg: 'bg-success/20',
    countText: 'text-success',
  },
  {
    key: 'review',
    label: 'Review',
    headerBg: 'bg-info/10',
    headerText: 'text-info',
    countBg: 'bg-info/20',
    countText: 'text-info',
  },
  {
    key: 'blocked',
    label: 'Blocked',
    headerBg: 'bg-danger/10',
    headerText: 'text-danger',
    countBg: 'bg-danger/20',
    countText: 'text-danger',
  },
];

const PRIORITY_DOT: Record<Step['priority'], string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted',
};

const PRIORITY_LABEL: Record<Step['priority'], string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const BOLT_STATUS_ORDER: Bolt['status'][] = ['planning', 'active', 'review', 'completed'];

const BOLT_STATUS_BADGE_VARIANT: Record<Bolt['status'], 'default' | 'primary' | 'warning' | 'success'> = {
  planning: 'default',
  active: 'primary',
  review: 'warning',
  completed: 'success',
};

const BOLT_STATUS_LABEL: Record<Bolt['status'], string> = {
  planning: 'Planning',
  active: 'Active',
  review: 'Review',
  completed: 'Completed',
};

const STATUS_TRANSITIONS: Record<
  Step['status'],
  { label: string; target: Step['status'] }[]
> = {
  todo: [{ label: 'Start \u2192', target: 'in_progress' }],
  in_progress: [
    { label: '\u2190 Todo', target: 'todo' },
    { label: 'Review \u2192', target: 'review' },
    { label: 'Done \u2192', target: 'done' },
  ],
  review: [
    { label: '\u2190 Reopen', target: 'in_progress' },
    { label: 'Done \u2192', target: 'done' },
  ],
  done: [{ label: '\u2190 Reopen', target: 'in_progress' }],
  blocked: [{ label: 'Unblock \u2192', target: 'todo' }],
  cancelled: [{ label: '\u2190 Reopen', target: 'todo' }],
  superseded: [],
  deferred: [{ label: '\u2190 Reopen', target: 'todo' }],
};

export default function BoardView({ projectId, onSelectStep }: BoardViewProps) {
  const [bolts, setBolts] = useState<Bolt[]>([]);
  const [selectedBoltId, setSelectedBoltId] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewBoltModal, setShowNewBoltModal] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState(false);
  const [activeStep, setActiveStep] = useState<Step | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const selectedBolt = bolts.find((b) => b.id === selectedBoltId) ?? null;

  const loadStepsForBolt = useCallback(async (boltId: string) => {
    try {
      const boltSteps = await api.listBoltSteps(boltId);
      setSteps(boltSteps);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load steps');
    }
  }, []);

  const loadBolts = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const allBolts = await api.listBolts({ project_id: projectId });
      setBolts(allBolts);

      // Auto-select: prefer first active bolt, otherwise first bolt in list
      if (allBolts.length > 0) {
        const activeBolt = allBolts.find((b) => b.status === 'active');
        const toSelect = activeBolt ?? allBolts[0];
        setSelectedBoltId(toSelect.id);
        const boltSteps = await api.listBoltSteps(toSelect.id);
        setSteps(boltSteps);
      } else {
        setSelectedBoltId(null);
        setSteps([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load board data');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadBolts();
  }, [loadBolts]);

  const handleBoltSelect = useCallback(
    async (boltId: string) => {
      setSelectedBoltId(boltId);
      await loadStepsForBolt(boltId);
    },
    [loadStepsForBolt],
  );

  const handleBoltCreated = useCallback(
    (newBolt: Bolt) => {
      setBolts((prev) => [...prev, newBolt]);
      setSelectedBoltId(newBolt.id);
      setSteps([]);
      setShowNewBoltModal(false);
    },
    [],
  );

  const handleBoltStatusChange = useCallback(
    async (newStatus: Bolt['status']) => {
      if (!selectedBolt || statusUpdating) return;
      setStatusUpdating(true);
      try {
        const updated = await api.updateBolt(selectedBolt.id, { status: newStatus });
        setBolts((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update bolt status');
      } finally {
        setStatusUpdating(false);
      }
    },
    [selectedBolt, statusUpdating],
  );

  const reloadCurrentBoltSteps = useCallback(() => {
    if (selectedBoltId) {
      loadStepsForBolt(selectedBoltId);
    }
  }, [selectedBoltId, loadStepsForBolt]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const draggedStep = steps.find((s) => s.id === event.active.id);
      setActiveStep(draggedStep ?? null);
    },
    [steps],
  );

  const handleDragEnd = useCallback(
    async (event: DragEndEvent) => {
      setActiveStep(null);
      const { active, over } = event;
      if (!over) return;

      const stepId = active.id as string;
      const newStatus = over.id as Step['status'];
      const step = steps.find((s) => s.id === stepId);
      if (!step || step.status === newStatus) return;

      try {
        await api.updateStep(stepId, { status: newStatus });
        reloadCurrentBoltSteps();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to update step status');
      }
    },
    [steps, reloadCurrentBoltSteps],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-muted text-sm">Loading board...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-danger text-sm">{error}</div>
      </div>
    );
  }

  if (bolts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-muted text-sm">
          No bolts yet. Create one to start a sprint.
        </div>
        <Button variant="primary" onClick={() => setShowNewBoltModal(true)}>
          New Bolt
        </Button>
        {showNewBoltModal && (
          <NewBoltModal
            projectId={projectId}
            onCreated={handleBoltCreated}
            onClose={() => setShowNewBoltModal(false)}
          />
        )}
      </div>
    );
  }

  const stepsByStatus: Record<Step['status'], Step[]> = {
    todo: [],
    in_progress: [],
    review: [],
    done: [],
    blocked: [],
    cancelled: [],
    superseded: [],
    deferred: [],
  };

  for (const step of steps) {
    if (stepsByStatus[step.status]) {
      stepsByStatus[step.status].push(step);
    }
  }

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Bolt toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3 flex-wrap">
        {/* Bolt selector */}
        <Select
          size="sm"
          className="w-auto min-w-[200px] max-w-[320px]"
          value={selectedBoltId ?? ''}
          onChange={(e) => handleBoltSelect(e.target.value)}
        >
          {bolts.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title} [{BOLT_STATUS_LABEL[b.status]}]
            </option>
          ))}
        </Select>

        {/* New Bolt button */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowNewBoltModal(true)}
        >
          + New Bolt
        </Button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Status badge + status controls */}
        {selectedBolt && (
          <div className="flex items-center gap-2">
            <Badge variant={BOLT_STATUS_BADGE_VARIANT[selectedBolt.status]} size="sm">
              {BOLT_STATUS_LABEL[selectedBolt.status]}
            </Badge>
            <Select
              size="sm"
              className="w-auto min-w-[120px]"
              value={selectedBolt.status}
              onChange={(e) => handleBoltStatusChange(e.target.value as Bolt['status'])}
              disabled={statusUpdating}
            >
              {BOLT_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {BOLT_STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>

      {/* Bolt header */}
      {selectedBolt && (
        <div className="flex-shrink-0">
          <h2 className="text-lg font-semibold text-foreground">{selectedBolt.title}</h2>
          {selectedBolt.goal && (
            <p className="text-sm text-muted mt-1">{selectedBolt.goal}</p>
          )}
        </div>
      )}

      {/* Kanban columns */}
      <DndContext
        sensors={sensors}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        <div className="flex-1 grid grid-cols-5 gap-4 min-h-0">
          {COLUMNS.map((col) => {
            const colSteps = stepsByStatus[col.key];
            return (
              <DroppableColumn key={col.key} col={col} count={colSteps.length}>
                {colSteps.length === 0 && (
                  <div className="text-center text-muted/50 text-xs py-6">
                    No steps
                  </div>
                )}
                {colSteps.map((step) => (
                  <DraggableStepCard
                    key={step.id}
                    step={step}
                    onClick={() => onSelectStep(step.id)}
                    onStatusChange={async (newStatus) => {
                      await api.updateStep(step.id, { status: newStatus });
                      reloadCurrentBoltSteps();
                    }}
                  />
                ))}
              </DroppableColumn>
            );
          })}
        </div>

        <DragOverlay>
          {activeStep ? (
            <div className="opacity-75 pointer-events-none">
              <StepCard
                step={activeStep}
                onClick={() => {}}
                onStatusChange={() => {}}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* New Bolt Modal */}
      {showNewBoltModal && (
        <NewBoltModal
          projectId={projectId}
          onCreated={handleBoltCreated}
          onClose={() => setShowNewBoltModal(false)}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* NewBoltModal                                                               */
/* -------------------------------------------------------------------------- */

function NewBoltModal({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string;
  onCreated: (bolt: Bolt) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError('Title is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const newBolt = await api.createBolt({
        project_id: projectId,
        title: trimmedTitle,
        goal: goal.trim() || undefined,
      });
      onCreated(newBolt);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create bolt');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal.Overlay onClose={onClose}>
      <Modal.Content>
        <Modal.Header>New Bolt</Modal.Header>
        <Modal.Body>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="bolt-title">Title</Label>
              <Input
                id="bolt-title"
                size="md"
                placeholder="e.g. Sprint 1 - Core features"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="bolt-goal">Goal (optional)</Label>
              <Input
                id="bolt-goal"
                size="md"
                placeholder="What should this bolt achieve?"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
              />
            </div>
            {formError && (
              <p className="text-danger text-sm">{formError}</p>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={submitting}
              >
                {submitting ? 'Creating...' : 'Create Bolt'}
              </Button>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Overlay>
  );
}

/* -------------------------------------------------------------------------- */
/* DroppableColumn                                                            */
/* -------------------------------------------------------------------------- */

function DroppableColumn({
  col,
  count,
  children,
}: {
  col: (typeof COLUMNS)[number];
  count: number;
  children: React.ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: col.key });

  return (
    <div
      ref={setNodeRef}
      className={`flex flex-col min-h-0 rounded-lg border-2 transition-colors duration-150 bg-surface/50 ${
        isOver
          ? 'border-primary/60 bg-primary/5'
          : 'border-border'
      }`}
    >
      {/* Column header */}
      <div
        className={`flex-shrink-0 flex items-center justify-between px-3 py-2.5 rounded-t-lg ${col.headerBg}`}
      >
        <span className={`text-sm font-semibold ${col.headerText}`}>
          {col.label}
        </span>
        <span
          className={`inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full text-xs font-medium ${col.countBg} ${col.countText}`}
        >
          {count}
        </span>
      </div>

      {/* Cards container */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* DraggableStepCard                                                          */
/* -------------------------------------------------------------------------- */

function DraggableStepCard({
  step,
  onClick,
  onStatusChange,
}: {
  step: Step;
  onClick: () => void;
  onStatusChange: (newStatus: Step['status']) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: step.id,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`touch-none ${isDragging ? 'opacity-30' : ''}`}
    >
      <StepCard step={step} onClick={onClick} onStatusChange={onStatusChange} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* StepCard                                                                   */
/* -------------------------------------------------------------------------- */

function StepCard({
  step,
  onClick,
  onStatusChange,
}: {
  step: Step;
  onClick: () => void;
  onStatusChange: (newStatus: Step['status']) => void;
}) {
  const transitions = STATUS_TRANSITIONS[step.status] ?? [];

  return (
    <div className="w-full text-left rounded-md border border-border bg-background transition-colors duration-150 hover:bg-surface-hover hover:border-primary/30">
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-3 space-y-2 focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-t-md"
      >
        {/* Ticket number */}
        {step.ticket_number && (
          <span className="font-mono text-xs text-muted">
            {step.ticket_number}
          </span>
        )}

        {/* Title */}
        <p className="text-sm font-medium text-foreground leading-snug">
          {step.title}
        </p>

        {/* Footer: assignee + priority */}
        <div className="flex items-center justify-between gap-2">
          {step.assignee ? (
            <Badge variant="primary" size="sm">
              {step.assignee}
            </Badge>
          ) : (
            <span className="text-xs text-muted/50">Unassigned</span>
          )}

          <div className="flex items-center gap-1.5" title={PRIORITY_LABEL[step.priority]}>
            <span
              className={`inline-block w-2 h-2 rounded-full ${PRIORITY_DOT[step.priority]}`}
            />
            <span className="text-xs text-muted">{PRIORITY_LABEL[step.priority]}</span>
          </div>
        </div>
      </button>

      {/* Status transition buttons */}
      {transitions.length > 0 && (
        <div className="flex items-center gap-1 px-3 pb-2 pt-0">
          {transitions.map((t) => (
            <button
              key={t.target}
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStatusChange(t.target);
              }}
              className="px-2 py-0.5 text-xs rounded border border-border text-muted hover:text-foreground hover:border-primary/40 hover:bg-primary/10 transition-colors duration-150"
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
