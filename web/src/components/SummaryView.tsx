import { useState, useEffect, useCallback } from 'react';
import type { Project, Plan, Phase, Step, Bolt, Run } from '../types';
import { CLOSED_STATUSES } from '../types';
import api from '../api';
import StatusBadge from './StatusBadge';
import { ProjectSettings } from './ProjectSettings';

interface SummaryViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

interface PhaseWithPlan extends Phase {
  planTitle: string;
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-muted mt-1">{label}</div>
    </div>
  );
}

function ProgressBar({ done, inProgress, todo, blocked }: { done: number; inProgress: number; todo: number; blocked: number }) {
  const total = done + inProgress + todo + blocked;
  if (total === 0) return null;

  const pDone = (done / total) * 100;
  const pInProgress = (inProgress / total) * 100;
  const pBlocked = (blocked / total) * 100;

  return (
    <div className="w-full h-2 rounded-full bg-surface-high overflow-hidden flex">
      {pDone > 0 && <div className="bg-success h-full" style={{ width: `${pDone}%` }} />}
      {pInProgress > 0 && <div className="bg-warning h-full" style={{ width: `${pInProgress}%` }} />}
      {pBlocked > 0 && <div className="bg-danger h-full" style={{ width: `${pBlocked}%` }} />}
    </div>
  );
}

export default function SummaryView({ projectId, onSelectStep }: SummaryViewProps) {
  const [project, setProject] = useState<Project | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [phases, setPhases] = useState<PhaseWithPlan[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [bolts, setBolts] = useState<Bolt[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const reloadProject = useCallback(async () => {
    const p = await api.getProject(projectId);
    setProject(p);
    return p;
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const [proj, planList, boltList] = await Promise.all([
          api.getProject(projectId),
          api.listPlans({ project_id: projectId }),
          api.listBolts({ project_id: projectId }),
        ]);
        if (cancelled) return;
        setProject(proj);
        if (cancelled) return;
        setPlans(planList);
        setBolts(boltList);

        // Load phases for each plan
        const phaseResults = await Promise.all(
          planList.map(p => api.listPhases({ plan_id: p.id }).then(phases =>
            phases.map(ph => ({ ...ph, planTitle: p.title }))
          ))
        );
        if (cancelled) return;
        const allPhases = phaseResults.flat();
        setPhases(allPhases);

        // Load steps for each phase
        const stepResults = await Promise.all(
          allPhases.map(ph => api.listSteps({ phase_id: ph.id }))
        );
        if (cancelled) return;
        const allSteps = stepResults.flat();
        setSteps(allSteps);

        // Load recent runs (limited)
        const runResults = await Promise.all(
          allSteps.slice(0, 20).map(s => api.listRuns({ step_id: s.id }))
        );
        if (cancelled) return;
        setRuns(runResults.flat());
      } catch (err) {
        console.error('Failed to load summary:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        Loading summary...
      </div>
    );
  }

  // Step stats
  const stepsByStatus = {
    done: steps.filter(s => CLOSED_STATUSES.has(s.status)).length,
    in_progress: steps.filter(s => s.status === 'in_progress').length,
    todo: steps.filter(s => s.status === 'todo').length,
    blocked: steps.filter(s => s.status === 'blocked').length,
  };
  const totalSteps = steps.length;
  const completionPercent = totalSteps > 0 ? Math.round((stepsByStatus.done / totalSteps) * 100) : 0;

  // Active agents
  const activeAgents = [...new Set(
    steps.filter(s => s.status === 'in_progress' && s.assignee).map(s => s.assignee!)
  )];

  // Active bolts
  const activeBolts = bolts.filter(b => b.status === 'active');

  // Recent activity (last 10 runs sorted by started_at desc)
  const recentRuns = [...runs]
    .sort((a, b) => b.started_at - a.started_at)
    .slice(0, 10);

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold text-foreground">Summary</h2>
        <p className="text-sm text-muted mt-1">
          {plans.length} plan{plans.length !== 1 ? 's' : ''} &middot; {phases.length} phase{phases.length !== 1 ? 's' : ''} &middot; {totalSteps} step{totalSteps !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Overall progress */}
      <div className="bg-surface rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-foreground">Overall Progress</span>
          <span className="text-sm font-bold text-primary">{completionPercent}%</span>
        </div>
        <ProgressBar
          done={stepsByStatus.done}
          inProgress={stepsByStatus.in_progress}
          todo={stepsByStatus.todo}
          blocked={stepsByStatus.blocked}
        />
        <div className="flex gap-4 text-xs text-muted flex-wrap">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success inline-block" /> Closed {stepsByStatus.done}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-warning inline-block" /> Active {stepsByStatus.in_progress}</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-surface-high inline-block" /> Todo {stepsByStatus.todo}</span>
          {stepsByStatus.blocked > 0 && (
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-danger inline-block" /> Blocked {stepsByStatus.blocked}</span>
          )}
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Total Steps" value={totalSteps} color="text-foreground" />
        <StatCard label="Closed" value={stepsByStatus.done} color="text-success" />
        <StatCard label="In Progress" value={stepsByStatus.in_progress} color="text-warning" />
        <StatCard label="Blocked" value={stepsByStatus.blocked} color="text-danger" />
      </div>

      {/* Active agents & bolts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Active Agents */}
        <div className="bg-surface rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-foreground mb-3">Active Agents</h3>
          {activeAgents.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {activeAgents.map(agent => (
                <span key={agent} className="inline-flex items-center px-2 py-1 rounded-md bg-primary/10 text-primary text-xs font-medium">
                  @{agent}
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs text-muted">No active agents</div>
          )}
        </div>

        {/* Active Bolts */}
        <div className="bg-surface rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-foreground mb-3">Active Bolts</h3>
          {activeBolts.length > 0 ? (
            <div className="space-y-2">
              {activeBolts.map(bolt => {
                const boltSteps = steps.filter(s => s.bolt_id === bolt.id);
                const boltDone = boltSteps.filter(s => CLOSED_STATUSES.has(s.status)).length;
                return (
                  <div key={bolt.id} className="flex items-center justify-between">
                    <span className="text-sm text-foreground">{bolt.title}</span>
                    <span className="text-xs text-muted">{boltDone}/{boltSteps.length}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-muted">No active bolts</div>
          )}
        </div>
      </div>

      {/* Phase status */}
      <div className="bg-surface rounded-lg border border-border p-4">
        <h3 className="text-sm font-medium text-foreground mb-3">Phases</h3>
        <div className="space-y-2">
          {phases.map(phase => {
            const phaseSteps = steps.filter(s => s.phase_id === phase.id);
            const pDone = phaseSteps.filter(s => CLOSED_STATUSES.has(s.status)).length;
            const pDeferred = phaseSteps.filter(s => s.status === 'deferred').length;
            const pTotal = phaseSteps.length;
            return (
              <div key={phase.id} className="flex items-center gap-3">
                <StatusBadge status={phase.status} />
                <span className="text-sm text-foreground flex-1 truncate">{phase.title}</span>
                <span className="text-xs text-muted whitespace-nowrap">
                  {pDone}/{pTotal}{pDeferred > 0 ? ` (${pDeferred} deferred)` : ''}
                </span>
                <div className="w-24 h-1.5 rounded-full bg-surface-high overflow-hidden">
                  {pTotal > 0 && (
                    <div className="h-full bg-success rounded-full" style={{ width: `${(pDone / pTotal) * 100}%` }} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* In-progress steps */}
      {stepsByStatus.in_progress > 0 && (
        <div className="bg-surface rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-foreground mb-3">In Progress</h3>
          <div className="space-y-1">
            {steps.filter(s => s.status === 'in_progress').map(step => (
              <button
                key={step.id}
                onClick={() => onSelectStep(step.id)}
                className="w-full text-left px-3 py-2 rounded-md hover:bg-surface-hover transition-colors flex items-center gap-2 cursor-pointer"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-warning shrink-0" />
                <span className="text-sm text-foreground truncate flex-1">{step.title}</span>
                {step.assignee && (
                  <span className="text-xs text-muted">@{step.assignee}</span>
                )}
                {step.ticket_number && (
                  <span className="text-xs text-muted font-mono">{step.ticket_number}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent activity */}
      {recentRuns.length > 0 && (
        <div className="bg-surface rounded-lg border border-border p-4">
          <h3 className="text-sm font-medium text-foreground mb-3">Recent Activity</h3>
          <div className="space-y-1">
            {recentRuns.map(run => {
              const step = steps.find(s => s.id === run.step_id);
              const isFinished = !!run.ended_at;
              return (
                <div key={run.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isFinished ? 'bg-success' : 'bg-warning'}`} />
                  <span className="text-foreground truncate flex-1">
                    {step?.title || run.step_id}
                  </span>
                  <span className="text-xs text-muted">@{run.agent}</span>
                  {run.result && (
                    <span className={`text-xs ${run.result === 'success' ? 'text-success' : 'text-muted'}`}>
                      {run.result}
                    </span>
                  )}
                  <span className="text-xs text-muted">
                    {new Date(run.started_at).toLocaleDateString()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {project && <ProjectSettings project={project} projectId={projectId} onProjectChange={reloadProject} />}
    </div>
  );
}
