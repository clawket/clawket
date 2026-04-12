import { useState, useEffect, useCallback } from 'react';
import type { Plan, Phase, Step, Bolt } from '../types';
import api from '../api';
import StatusBadge from './StatusBadge';
import { Button, Select } from './ui';

type SelectedItem = { type: 'plan'; id: string } | { type: 'phase'; id: string } | { type: 'step'; id: string };

interface PlanTreeProps {
  projectId: string;
  selectedItem: SelectedItem | null;
  onSelectItem: (item: SelectedItem) => void;
  onCreatePlan: () => void;
  onCreatePhase: (planId: string) => void;
  onCreateStep: (phaseId: string) => void;
}

interface PhaseWithSteps extends Phase {
  steps: Step[];
}

interface PlanWithPhases extends Plan {
  phases: PhaseWithSteps[];
}

const stepStatusIcon: Record<Step['status'], { icon: string; color: string }> = {
  todo: { icon: '\u25CB', color: 'text-muted' },
  in_progress: { icon: '\u25D0', color: 'text-warning' },
  review: { icon: '\u25D2', color: 'text-primary' },
  done: { icon: '\u25CF', color: 'text-success' },
  blocked: { icon: '\u2298', color: 'text-danger' },
  cancelled: { icon: '\u2715', color: 'text-muted' },
  superseded: { icon: '\u2715', color: 'text-muted' },
  deferred: { icon: '\u223C', color: 'text-muted' },
};

const priorityDotColor: Record<Step['priority'], string> = {
  critical: 'bg-danger',
  high: 'bg-warning',
  medium: 'bg-primary',
  low: 'bg-muted',
};

const STEP_STATUSES: { value: Step['status']; label: string }[] = [
  { value: 'todo', label: 'Todo' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'done', label: 'Done' },
  { value: 'blocked', label: 'Blocked' },
];

export default function PlanTree({ projectId, selectedItem, onSelectItem, onCreatePlan, onCreatePhase, onCreateStep }: PlanTreeProps) {
  const [plans, setPlans] = useState<PlanWithPhases[]>([]);
  const [expandedPlans, setExpandedPlans] = useState<Set<string>>(new Set());
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Edit mode state
  const [editMode, setEditMode] = useState(false);
  const [selectedStepIds, setSelectedStepIds] = useState<Set<string>>(new Set());
  const [bolts, setBolts] = useState<Bolt[]>([]);
  const [bulkUpdating, setBulkUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const planList = await api.listPlans({ project_id: projectId });
        const enriched: PlanWithPhases[] = await Promise.all(
          planList.map(async (plan) => {
            const phases = await api.listPhases({ plan_id: plan.id });
            const phasesWithSteps: PhaseWithSteps[] = await Promise.all(
              phases.map(async (phase) => {
                const steps = await api.listSteps({ phase_id: phase.id });
                return { ...phase, steps: steps.sort((a, b) => a.idx - b.idx) };
              }),
            );
            return { ...plan, phases: phasesWithSteps.sort((a, b) => a.idx - b.idx) };
          }),
        );
        if (!cancelled) {
          setPlans(enriched);
          // Auto-expand all plans on first load
          if (refreshCounter === 0) {
            setExpandedPlans(new Set(enriched.map((p) => p.id)));
            setExpandedPhases(new Set(enriched.flatMap((p) => p.phases.map((ph) => ph.id))));
          }
        }
      } catch (err) {
        console.error('Failed to load plans:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [projectId, refreshCounter]);

  // Fetch bolts when entering edit mode
  useEffect(() => {
    if (editMode) {
      api.listBolts({ project_id: projectId }).then(setBolts).catch(() => setBolts([]));
    }
  }, [editMode, projectId]);

  function togglePlan(id: string) {
    setExpandedPlans((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function togglePhase(id: string) {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Edit mode helpers
  function enterEditMode() {
    setEditMode(true);
    setSelectedStepIds(new Set());
  }

  function exitEditMode() {
    setEditMode(false);
    setSelectedStepIds(new Set());
  }

  function toggleStepSelection(stepId: string) {
    setSelectedStepIds((prev) => {
      const next = new Set(prev);
      if (next.has(stepId)) next.delete(stepId);
      else next.add(stepId);
      return next;
    });
  }

  const allStepIds = plans.flatMap((p) => p.phases.flatMap((ph) => ph.steps.map((s) => s.id)));

  function selectAll() {
    setSelectedStepIds(new Set(allStepIds));
  }

  function deselectAll() {
    setSelectedStepIds(new Set());
  }

  // Collect all phases for the phase-move dropdown
  const allPhases = plans.flatMap((p) =>
    p.phases.map((ph) => ({ id: ph.id, title: ph.title, planTitle: p.title })),
  );

  const performBulkAction = useCallback(
    async (fields: Partial<Pick<Step, 'status' | 'bolt_id' | 'phase_id'>>) => {
      if (selectedStepIds.size === 0) return;
      setBulkUpdating(true);
      try {
        await api.bulkUpdateSteps(Array.from(selectedStepIds), fields);
        exitEditMode();
        setRefreshCounter((c) => c + 1);
      } catch (err) {
        console.error('Bulk update failed:', err);
      } finally {
        setBulkUpdating(false);
      }
    },
    [selectedStepIds],
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        <div className="text-sm">Loading plans...</div>
      </div>
    );
  }

  if (plans.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        <div className="text-center">
          <div className="text-lg mb-1">No plans yet</div>
          <div className="text-sm mb-3">Create a plan to get started</div>
          <button
            onClick={onCreatePlan}
            className="text-sm text-primary hover:text-primary/80 font-medium"
          >
            + New Plan
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex-shrink-0 px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Plans</h2>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">{plans.length} plans</span>
          {editMode ? (
            <Button variant="outline" size="sm" onClick={exitEditMode}>
              Done
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={enterEditMode}>
              Edit
            </Button>
          )}
          {!editMode && (
            <button
              onClick={onCreatePlan}
              className="text-xs text-primary hover:text-primary/80 font-medium"
              title="New plan"
            >
              + New Plan
            </button>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
      {plans.map((plan) => (
        <div key={plan.id} className="mb-1">
          {/* Plan row */}
          <div
            className={`flex items-center gap-2 px-4 py-2 cursor-pointer hover:bg-surface-hover transition-colors ${
              selectedItem?.type === 'plan' && selectedItem.id === plan.id ? 'bg-primary/10' : ''
            }`}
          >
            <button
              onClick={() => togglePlan(plan.id)}
              className="text-muted hover:text-foreground shrink-0 w-4 text-xs"
            >
              {expandedPlans.has(plan.id) ? '\u25BC' : '\u25B6'}
            </button>
            <div
              className="flex-1 min-w-0 flex items-center gap-2"
              onClick={() => onSelectItem({ type: 'plan', id: plan.id })}
            >
              <span className="text-sm font-medium text-foreground truncate">{plan.title}</span>
              <StatusBadge status={plan.status} />
            </div>
            {!editMode && (
              <button
                onClick={(e) => { e.stopPropagation(); onCreatePhase(plan.id); }}
                className="text-muted hover:text-primary text-xs shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
                style={{ opacity: undefined }}
                title="Add phase"
              >
                +
              </button>
            )}
          </div>

          {/* Phases */}
          {expandedPlans.has(plan.id) &&
            plan.phases.map((phase) => {
              const doneCount = phase.steps.filter((s) => s.status === 'done').length;
              const totalCount = phase.steps.length;
              const progress = totalCount > 0 ? (doneCount / totalCount) * 100 : 0;

              return (
                <div key={phase.id}>
                  {/* Phase row */}
                  <div
                    className={`flex items-center gap-2 px-4 py-1.5 pl-10 cursor-pointer hover:bg-surface-hover transition-colors ${
                      selectedItem?.type === 'phase' && selectedItem.id === phase.id ? 'bg-primary/10' : ''
                    }`}
                  >
                    <button
                      onClick={() => togglePhase(phase.id)}
                      className="text-muted hover:text-foreground shrink-0 w-4 text-xs"
                    >
                      {expandedPhases.has(phase.id) ? '\u25BC' : '\u25B6'}
                    </button>
                    <div
                      className="flex-1 min-w-0 flex items-center gap-2"
                      onClick={() => onSelectItem({ type: 'phase', id: phase.id })}
                    >
                      <span className="text-sm text-foreground truncate">{phase.title}</span>
                      <StatusBadge status={phase.status} size="sm" />
                      {phase.approved_at && (
                        <span className="text-xs text-success" title="Approved">{'\u2713'}</span>
                      )}
                    </div>
                    {/* Progress bar */}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <div className="w-16 h-1.5 bg-border rounded-full overflow-hidden">
                        <div
                          className="h-full bg-success rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted w-8">
                        {doneCount}/{totalCount}
                      </span>
                    </div>
                    {!editMode && (
                      <button
                        onClick={(e) => { e.stopPropagation(); onCreateStep(phase.id); }}
                        className="text-muted hover:text-primary text-xs shrink-0"
                        title="Add step"
                      >
                        +
                      </button>
                    )}
                  </div>

                  {/* Steps */}
                  {expandedPhases.has(phase.id) &&
                    phase.steps.map((step) => {
                      const si = stepStatusIcon[step.status];
                      const isSelected = selectedStepIds.has(step.id);
                      return (
                        <div
                          key={step.id}
                          onClick={() => {
                            if (editMode) {
                              toggleStepSelection(step.id);
                            } else {
                              onSelectItem({ type: 'step', id: step.id });
                            }
                          }}
                          className={`flex items-center gap-2 px-4 py-1.5 pl-16 cursor-pointer hover:bg-surface-hover transition-colors ${
                            !editMode && selectedItem?.type === 'step' && selectedItem.id === step.id ? 'bg-primary/10' : ''
                          } ${editMode && isSelected ? 'bg-primary/10' : ''}`}
                        >
                          {editMode && (
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleStepSelection(step.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="shrink-0 w-4 h-4 rounded border-border text-primary focus:ring-primary cursor-pointer"
                            />
                          )}
                          <span className={`${si.color} text-sm shrink-0`}>{si.icon}</span>
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${priorityDotColor[step.priority]}`} title={`Priority: ${step.priority}`} />
                          <span className="text-xs text-muted font-mono shrink-0" title={step.id}>
                            {step.ticket_number ?? `...${step.id.slice(-6)}`}
                          </span>
                          <span className="text-sm text-foreground truncate flex-1">{step.title}</span>
                          {step.assignee && (
                            <span className="text-xs text-muted shrink-0 bg-border/50 px-1.5 py-0.5 rounded">
                              {step.assignee}
                            </span>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
        </div>
      ))}
      </div>

      {/* Floating Action Bar */}
      {editMode && selectedStepIds.size > 0 && (
        <div className="sticky bottom-0 bg-surface border-t border-border px-4 py-3 flex items-center gap-3 flex-shrink-0">
          <span className="text-sm font-medium text-foreground whitespace-nowrap">
            {selectedStepIds.size} selected
          </span>

          {/* Status dropdown */}
          <Select
            size="sm"
            value=""
            disabled={bulkUpdating}
            onChange={(e) => {
              const status = e.target.value as Step['status'];
              if (status) performBulkAction({ status });
            }}
          >
            <option value="" disabled>Status...</option>
            {STEP_STATUSES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>

          {/* Bolt dropdown */}
          <Select
            size="sm"
            value=""
            disabled={bulkUpdating}
            onChange={(e) => {
              const bolt_id = e.target.value;
              if (bolt_id) performBulkAction({ bolt_id: bolt_id === '__none__' ? null as unknown as string : bolt_id });
            }}
          >
            <option value="" disabled>Bolt...</option>
            <option value="__none__">No bolt</option>
            {bolts.map((b) => (
              <option key={b.id} value={b.id}>{b.title}</option>
            ))}
          </Select>

          {/* Phase dropdown */}
          <Select
            size="sm"
            value=""
            disabled={bulkUpdating}
            onChange={(e) => {
              const phase_id = e.target.value;
              if (phase_id) performBulkAction({ phase_id });
            }}
          >
            <option value="" disabled>Move to phase...</option>
            {allPhases.map((ph) => (
              <option key={ph.id} value={ph.id}>{ph.planTitle} / {ph.title}</option>
            ))}
          </Select>

          <div className="flex-1" />

          {/* Select All / Deselect All */}
          {selectedStepIds.size < allStepIds.length ? (
            <Button variant="ghost" size="sm" onClick={selectAll} disabled={bulkUpdating}>
              Select All
            </Button>
          ) : (
            <Button variant="ghost" size="sm" onClick={deselectAll} disabled={bulkUpdating}>
              Deselect All
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={deselectAll} disabled={bulkUpdating}>
            Deselect All
          </Button>
        </div>
      )}
    </div>
  );
}
