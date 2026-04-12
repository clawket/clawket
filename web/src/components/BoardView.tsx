import { useState, useEffect, useCallback } from 'react';
import type { Bolt, Step } from '../types';
import api from '../api';
import { Badge, Button, Select } from './ui';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';

import { COLUMNS } from './board/constants';
import { DroppableColumn } from './board/DroppableColumn';
import { StepCard, DraggableStepCard } from './board/StepCard';
import { NewBoltModal } from './board/NewBoltModal';
import { ArchivedSection } from './board/ArchivedSection';

interface BoardViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

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

      if (allBolts.length > 0) {
        const activeBolt = allBolts.find((b) => b.status === 'active');
        const nonCompleted = allBolts.filter((b) => b.status !== 'completed');
        const toSelect = activeBolt ?? nonCompleted[0] ?? allBolts[0];
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

  useEffect(() => { loadBolts(); }, [loadBolts]);

  const handleBoltSelect = useCallback(
    async (boltId: string) => { setSelectedBoltId(boltId); await loadStepsForBolt(boltId); },
    [loadStepsForBolt],
  );

  const handleBoltCreated = useCallback((newBolt: Bolt) => {
    setBolts((prev) => [...prev, newBolt]);
    setSelectedBoltId(newBolt.id);
    setSteps([]);
    setShowNewBoltModal(false);
  }, []);

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
    if (selectedBoltId) loadStepsForBolt(selectedBoltId);
  }, [selectedBoltId, loadStepsForBolt]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => { setActiveStep(steps.find((s) => s.id === event.active.id) ?? null); },
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
    return <div className="flex items-center justify-center h-64"><div className="text-muted text-sm">Loading board...</div></div>;
  }
  if (error) {
    return <div className="flex items-center justify-center h-64"><div className="text-danger text-sm">{error}</div></div>;
  }
  if (bolts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <div className="text-muted text-sm">No bolts yet. Create one to start a sprint.</div>
        <Button variant="primary" onClick={() => setShowNewBoltModal(true)}>New Bolt</Button>
        {showNewBoltModal && <NewBoltModal projectId={projectId} onCreated={handleBoltCreated} onClose={() => setShowNewBoltModal(false)} />}
      </div>
    );
  }

  const stepsByStatus: Record<Step['status'], Step[]> = {
    todo: [], in_progress: [], review: [], done: [], blocked: [], cancelled: [], superseded: [], deferred: [],
  };
  for (const step of steps) {
    if (stepsByStatus[step.status]) stepsByStatus[step.status].push(step);
  }

  return (
    <div className="flex flex-col h-full gap-4 p-4">
      {/* Bolt toolbar */}
      <div className="flex-shrink-0 flex items-center gap-3 flex-wrap">
        <Select size="sm" className="w-auto min-w-[200px] max-w-[320px]" value={selectedBoltId ?? ''} onChange={(e) => handleBoltSelect(e.target.value)}>
          {bolts.filter(b => b.status !== 'completed').map((b) => <option key={b.id} value={b.id}>{b.title} [{BOLT_STATUS_LABEL[b.status]}]</option>)}
          {bolts.some(b => b.status === 'completed') && <option disabled>── Completed ──</option>}
          {bolts.filter(b => b.status === 'completed').map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
        </Select>
        <Button variant="outline" size="sm" onClick={() => setShowNewBoltModal(true)}>+ New Bolt</Button>
        <div className="flex-1" />
        {selectedBolt && (
          <div className="flex items-center gap-2">
            <Badge variant={BOLT_STATUS_BADGE_VARIANT[selectedBolt.status]} size="sm">{BOLT_STATUS_LABEL[selectedBolt.status]}</Badge>
            <Select size="sm" className="w-auto min-w-[120px]" value={selectedBolt.status} onChange={(e) => handleBoltStatusChange(e.target.value as Bolt['status'])} disabled={statusUpdating}>
              {BOLT_STATUS_ORDER.map((s) => <option key={s} value={s}>{BOLT_STATUS_LABEL[s]}</option>)}
            </Select>
          </div>
        )}
      </div>

      {/* Bolt header */}
      {selectedBolt && (
        <div className="flex-shrink-0">
          <h2 className="text-lg font-semibold text-foreground">{selectedBolt.title}</h2>
          {selectedBolt.goal && <p className="text-sm text-muted mt-1">{selectedBolt.goal}</p>}
        </div>
      )}

      {/* Kanban columns */}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex-1 grid grid-cols-5 gap-4 min-h-0">
          {COLUMNS.map((col) => {
            const colSteps = stepsByStatus[col.key];
            return (
              <DroppableColumn key={col.key} col={col} count={colSteps.length}>
                {colSteps.length === 0 && <div className="text-center text-muted/50 text-xs py-6">No steps</div>}
                {colSteps.map((step) => (
                  <DraggableStepCard
                    key={step.id}
                    step={step}
                    onClick={() => onSelectStep(step.id)}
                    onStatusChange={async (newStatus) => { await api.updateStep(step.id, { status: newStatus }); reloadCurrentBoltSteps(); }}
                  />
                ))}
              </DroppableColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeStep ? (
            <div className="opacity-75 pointer-events-none">
              <StepCard step={activeStep} onClick={() => {}} onStatusChange={() => {}} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <ArchivedSection stepsByStatus={stepsByStatus} onSelectStep={onSelectStep} />

      {showNewBoltModal && <NewBoltModal projectId={projectId} onCreated={handleBoltCreated} onClose={() => setShowNewBoltModal(false)} />}
    </div>
  );
}
