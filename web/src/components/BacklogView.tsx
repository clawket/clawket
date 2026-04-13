import { useEffect, useState, useCallback } from 'react';
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
import type { Step, Bolt } from '../types';
import { CLOSED_STATUSES } from '../types';
import api from '../api';
import { Button, Select } from './ui';
import StatusBadge from './StatusBadge';

interface BacklogViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

const priorityDotColor: Record<Step['priority'], string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted',
};

export default function BacklogView({ projectId, onSelectStep }: BacklogViewProps) {
  const [bolts, setBolts] = useState<Bolt[]>([]);
  const [boltSteps, setBoltSteps] = useState<Record<string, Step[]>>({});
  const [backlogSteps, setBacklogSteps] = useState<Step[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [assigningStepId, setAssigningStepId] = useState<string | null>(null);
  const [collapsedBolts, setCollapsedBolts] = useState<Set<string>>(new Set());
  const [collapsedBacklog, setCollapsedBacklog] = useState(false);
  const [activeStep, setActiveStep] = useState<Step | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [boltList, backlog] = await Promise.all([
        api.listBolts({ project_id: projectId }),
        api.listBacklog(projectId),
      ]);
      setBolts(boltList);
      setBacklogSteps(backlog);

      // Fetch steps for each non-completed bolt
      const stepsMap: Record<string, Step[]> = {};
      await Promise.all(
        boltList
          .filter(b => b.status !== 'completed')
          .map(async (b) => {
            stepsMap[b.id] = await api.listBoltSteps(b.id);
          }),
      );
      setBoltSteps(stepsMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  async function handleAssignBolt(stepId: string, boltId: string) {
    try {
      await api.updateStep(stepId, { bolt_id: boltId });
      load();
    } catch (err) {
      console.error('Failed to assign step to bolt:', err);
    }
  }

  async function handleUnassign(stepId: string) {
    try {
      await api.updateStep(stepId, { bolt_id: null as unknown as string });
      load();
    } catch (err) {
      console.error('Failed to unassign step:', err);
    }
  }

  async function handleBoltStatusChange(boltId: string, status: Bolt['status']) {
    try {
      await api.updateBolt(boltId, { status });
      load();
    } catch (err) {
      console.error('Failed to update bolt status:', err);
    }
  }

  function toggleBolt(boltId: string) {
    setCollapsedBolts(prev => {
      const next = new Set(prev);
      if (next.has(boltId)) next.delete(boltId);
      else next.add(boltId);
      return next;
    });
  }

  // Find a step by id across all sections
  function findStep(stepId: string): Step | null {
    const backlog = backlogSteps.find(s => s.id === stepId);
    if (backlog) return backlog;
    for (const steps of Object.values(boltSteps)) {
      const found = steps.find(s => s.id === stepId);
      if (found) return found;
    }
    return null;
  }

  function handleDragStart(event: DragStartEvent) {
    const step = findStep(event.active.id as string);
    setActiveStep(step);
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveStep(null);
    const { active, over } = event;
    if (!over) return;

    const stepId = active.id as string;
    const targetId = over.id as string;

    // Determine current bolt_id of the step
    const step = findStep(stepId);
    if (!step) return;

    const currentBoltId = step.bolt_id;

    if (targetId === 'backlog') {
      // Move to backlog (unassign)
      if (!currentBoltId) return; // already in backlog
      try {
        await api.updateStep(stepId, { bolt_id: null as unknown as string });
        await load();
      } catch (err) {
        console.error('Failed to move step to backlog:', err);
      }
    } else {
      // Move to a bolt
      if (currentBoltId === targetId) return; // already in this bolt
      try {
        await api.updateStep(stepId, { bolt_id: targetId });
        await load();
      } catch (err) {
        console.error('Failed to move step to bolt:', err);
      }
    }
  }

  if (loading) {
    return <div className="flex items-center justify-center py-12 text-muted">Loading...</div>;
  }
  if (error) {
    return <div className="flex items-center justify-center py-12 text-danger">{error}</div>;
  }

  const activeBolts = bolts.filter(b => b.status !== 'completed');

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="flex flex-col gap-2 p-4 overflow-y-auto h-full">
        <h2 className="text-lg font-semibold text-foreground mb-2">Backlog</h2>

        {/* Bolt sections */}
        {activeBolts.map((bolt) => {
          const steps = boltSteps[bolt.id] || [];
          const collapsed = collapsedBolts.has(bolt.id);
          const doneCount = steps.filter(s => CLOSED_STATUSES.has(s.status)).length;

          return (
            <DroppableSection key={bolt.id} id={bolt.id}>
              {(isOver) => (
                <div className={`rounded-lg border bg-surface overflow-hidden transition-colors ${isOver ? 'border-primary' : 'border-border'}`}>
                  {/* Bolt header */}
                  <div className="flex items-center gap-3 px-4 py-3 bg-surface-high">
                    <button
                      onClick={() => toggleBolt(bolt.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                    >
                      <span className="text-muted text-xs shrink-0">
                        {collapsed ? '\u25B6' : '\u25BC'}
                      </span>
                      <span className="text-sm font-semibold text-foreground truncate">
                        {bolt.title}
                      </span>
                      <span className="text-xs text-muted shrink-0">
                        {doneCount}/{steps.length}
                      </span>
                      <StatusBadge status={bolt.status} size="sm" />
                    </button>
                    {bolt.status === 'planning' && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleBoltStatusChange(bolt.id, 'active'); }}
                      >
                        Start Bolt
                      </Button>
                    )}
                    {bolt.status === 'active' && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); handleBoltStatusChange(bolt.id, 'review'); }}
                      >
                        Complete
                      </Button>
                    )}
                  </div>

                  {/* Bolt steps */}
                  {!collapsed && (
                    <div className="max-h-80 overflow-y-auto">
                      {steps.length === 0 ? (
                        <div className="px-4 py-3 text-sm text-muted italic">
                          No steps in this bolt. Drag from backlog below.
                        </div>
                      ) : (
                        steps.map((step, i) => (
                          <DraggableStepRow
                            key={step.id}
                            step={step}
                            showBorder={i > 0}
                            onSelect={() => onSelectStep(step.id)}
                            trailing={
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleUnassign(step.id); }}
                                className="text-xs text-muted hover:text-danger px-1.5 py-0.5 rounded transition-colors cursor-pointer"
                                title="Remove from bolt"
                              >
                                &times;
                              </button>
                            }
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </DroppableSection>
          );
        })}

        {/* Backlog (unassigned) — same card style as bolt sections */}
        <DroppableSection id="backlog">
          {(isOver) => (
            <div className={`rounded-lg border bg-surface overflow-hidden mt-2 transition-colors ${isOver ? 'border-primary' : 'border-border'}`}>
              <div className="flex items-center gap-3 px-4 py-3 bg-surface-high">
                <button
                  onClick={() => setCollapsedBacklog(prev => !prev)}
                  className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
                >
                  <span className="text-muted text-xs shrink-0">
                    {collapsedBacklog ? '\u25B6' : '\u25BC'}
                  </span>
                  <span className="text-sm font-semibold text-foreground truncate">
                    Backlog
                  </span>
                  <span className="text-xs text-muted shrink-0">
                    {backlogSteps.length} items
                  </span>
                </button>
              </div>

              {!collapsedBacklog && (
                <>
                  {backlogSteps.length === 0 ? (
                    <div className="px-4 py-3 text-sm text-muted italic">
                      All steps are assigned to bolts.
                    </div>
                  ) : (
                    <div className="max-h-[60vh] overflow-y-auto">
                      {backlogSteps.map((step, i) => (
                        <DraggableStepRow
                          key={step.id}
                          step={step}
                          showBorder={i > 0}
                          onSelect={() => onSelectStep(step.id)}
                          trailing={
                            <div className="shrink-0" onClick={(e) => e.stopPropagation()}>
                              {assigningStepId === step.id ? (
                                <Select
                                  size="sm"
                                  value=""
                                  onChange={(e) => {
                                    if (e.target.value) handleAssignBolt(step.id, e.target.value);
                                    else setAssigningStepId(null);
                                  }}
                                  onBlur={() => setAssigningStepId(null)}
                                  autoFocus
                                  className="w-36 text-xs"
                                >
                                  <option value="">Select bolt...</option>
                                  {activeBolts.map((b) => (
                                    <option key={b.id} value={b.id}>{b.title}</option>
                                  ))}
                                </Select>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setAssigningStepId(step.id)}
                                  className="text-xs text-muted hover:text-primary px-2 py-1 rounded border border-transparent hover:border-border transition-colors whitespace-nowrap cursor-pointer"
                                >
                                  + Bolt
                                </button>
                              )}
                            </div>
                          }
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </DroppableSection>
      </div>

      {/* Drag overlay */}
      <DragOverlay>
        {activeStep ? (
          <div className="flex items-center gap-3 px-4 py-2 bg-surface border border-primary rounded-lg shadow-lg opacity-90">
            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDotColor[activeStep.priority]}`} />
            {activeStep.ticket_number && (
              <span className="font-mono text-xs text-muted shrink-0 w-16">{activeStep.ticket_number}</span>
            )}
            <span className="text-sm text-foreground truncate flex-1">{activeStep.title}</span>
            <StatusBadge status={activeStep.status} size="sm" />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

/* --- Droppable section wrapper --- */
function DroppableSection({
  id,
  children,
}: {
  id: string;
  children: (isOver: boolean) => React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return <div ref={setNodeRef}>{children(isOver)}</div>;
}

/* --- Draggable step row --- */
function DraggableStepRow({
  step,
  showBorder,
  onSelect,
  trailing,
}: {
  step: Step;
  showBorder: boolean;
  onSelect: () => void;
  trailing?: React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: step.id,
  });

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-3 px-4 py-2 hover:bg-surface-hover transition-colors ${showBorder ? 'border-t border-border' : ''} ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDotColor[step.priority]}`} />
        {step.ticket_number && (
          <span className="font-mono text-xs text-muted shrink-0 w-16">{step.ticket_number}</span>
        )}
        <span className="text-sm text-foreground truncate flex-1">{step.title}</span>
        <StatusBadge status={step.status} size="sm" />
        {step.assignee && (
          <span className="text-xs text-muted shrink-0">{step.assignee}</span>
        )}
      </button>
      {trailing}
    </div>
  );
}
