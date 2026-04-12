import { useState, useEffect, useMemo } from 'react';
import type { Phase, Step, Run } from '../types';
import api from '../api';

interface TimelineViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

interface TimelineEntry {
  id: string;
  title: string;
  type: 'step' | 'run';
  agent?: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
  stepId: string;
  phaseName: string;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDuration(startMs: number, endMs: number | null): string {
  const end = endMs ?? Date.now();
  const diff = end - startMs;
  if (diff < 60000) return `${Math.round(diff / 1000)}s`;
  if (diff < 3600000) return `${Math.round(diff / 60000)}m`;
  const hours = Math.floor(diff / 3600000);
  const mins = Math.round((diff % 3600000) / 60000);
  return `${hours}h ${mins}m`;
}

type GroupBy = 'time' | 'agent' | 'phase';

export default function TimelineView({ projectId, onSelectStep }: TimelineViewProps) {
  const [, setPhases] = useState<Phase[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [groupBy, setGroupBy] = useState<GroupBy>('time');
  const [phaseMap, setPhaseMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const plans = await api.listPlans({ project_id: projectId });
        if (cancelled) return;

        const phaseResults = await Promise.all(
          plans.map(p => api.listPhases({ plan_id: p.id }))
        );
        const allPhases = phaseResults.flat();
        if (cancelled) return;
        setPhases(allPhases);

        const pMap: Record<string, string> = {};
        allPhases.forEach(ph => { pMap[ph.id] = ph.title; });
        setPhaseMap(pMap);

        const stepResults = await Promise.all(
          allPhases.map(ph => api.listSteps({ phase_id: ph.id }))
        );
        const allSteps = stepResults.flat();
        if (cancelled) return;
        setSteps(allSteps);

        const runResults = await Promise.all(
          allSteps.filter(s => s.started_at).slice(0, 50).map(s => api.listRuns({ step_id: s.id }))
        );
        if (cancelled) return;
        setRuns(runResults.flat());
      } catch (err) {
        console.error('Failed to load timeline:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  const entries = useMemo<TimelineEntry[]>(() => {
    const items: TimelineEntry[] = [];

    // Add runs
    for (const run of runs) {
      const step = steps.find(s => s.id === run.step_id);
      if (!step) continue;
      items.push({
        id: run.id,
        title: step.title,
        type: 'run',
        agent: run.agent,
        status: run.result || 'running',
        startedAt: run.started_at,
        endedAt: run.ended_at,
        stepId: step.id,
        phaseName: phaseMap[step.phase_id] || '',
      });
    }

    // Add steps without runs
    const runStepIds = new Set(runs.map(r => r.step_id));
    for (const step of steps) {
      if (runStepIds.has(step.id) || !step.started_at) continue;
      items.push({
        id: step.id,
        title: step.title,
        type: 'step',
        agent: step.assignee || undefined,
        status: step.status,
        startedAt: step.started_at,
        endedAt: step.completed_at,
        stepId: step.id,
        phaseName: phaseMap[step.phase_id] || '',
      });
    }

    return items.sort((a, b) => b.startedAt - a.startedAt);
  }, [steps, runs, phaseMap]);

  // Gantt chart range
  const gantt = useMemo(() => {
    if (entries.length === 0) return { min: 0, max: 0, range: 1 };
    const min = Math.min(...entries.map(e => e.startedAt));
    const max = Math.max(...entries.map(e => e.endedAt || Date.now()));
    return { min, max, range: max - min || 1 };
  }, [entries]);

  const grouped = useMemo(() => {
    if (groupBy === 'time') return { 'Timeline': entries };
    if (groupBy === 'agent') {
      const map: Record<string, TimelineEntry[]> = {};
      for (const e of entries) {
        const key = e.agent || 'unassigned';
        (map[key] ||= []).push(e);
      }
      return map;
    }
    // phase
    const map: Record<string, TimelineEntry[]> = {};
    for (const e of entries) {
      const key = e.phaseName || 'Unknown';
      (map[key] ||= []).push(e);
    }
    return map;
  }, [entries, groupBy]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted">
        Loading timeline...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Timeline</h2>
        <div className="flex gap-1 bg-surface-high rounded-lg p-0.5">
          {(['time', 'agent', 'phase'] as GroupBy[]).map(g => (
            <button
              key={g}
              onClick={() => setGroupBy(g)}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                groupBy === g
                  ? 'bg-surface text-foreground shadow-sm'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {g === 'time' ? 'Chronological' : g === 'agent' ? 'By Agent' : 'By Phase'}
            </button>
          ))}
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No activity yet. Steps with timestamps will appear here.
        </div>
      ) : (
        Object.entries(grouped).map(([groupName, items]) => (
          <div key={groupName} className="space-y-1">
            {groupBy !== 'time' && (
              <h3 className="text-sm font-medium text-foreground px-1 pt-2">
                {groupBy === 'agent' ? `@${groupName}` : groupName}
                <span className="text-xs text-muted ml-2">{items.length}</span>
              </h3>
            )}
            {items.map(entry => {
              const left = ((entry.startedAt - gantt.min) / gantt.range) * 100;
              const width = Math.max(
                (((entry.endedAt || Date.now()) - entry.startedAt) / gantt.range) * 100,
                1
              );
              const isFinished = !!entry.endedAt;

              return (
                <button
                  key={entry.id}
                  onClick={() => onSelectStep(entry.stepId)}
                  className="w-full text-left bg-surface rounded-lg border border-border p-3 hover:bg-surface-hover transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      isFinished
                        ? entry.status === 'success' || entry.status === 'done' ? 'bg-success' : 'bg-muted'
                        : 'bg-warning animate-pulse'
                    }`} />
                    <span className="text-sm text-foreground truncate flex-1">{entry.title}</span>
                    {entry.agent && (
                      <span className="text-xs text-primary">@{entry.agent}</span>
                    )}
                    <span className="text-xs text-muted">
                      {formatDuration(entry.startedAt, entry.endedAt)}
                    </span>
                  </div>
                  {/* Mini gantt bar */}
                  <div className="relative h-1.5 bg-surface-high rounded-full overflow-hidden">
                    <div
                      className={`absolute h-full rounded-full ${
                        isFinished ? 'bg-success/60' : 'bg-warning/60'
                      }`}
                      style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-[10px] text-muted">{formatDate(entry.startedAt)}</span>
                    {entry.endedAt && (
                      <span className="text-[10px] text-muted">{formatDate(entry.endedAt)}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        ))
      )}
    </div>
  );
}
