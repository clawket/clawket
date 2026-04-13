import { useState, useEffect, useMemo, useRef } from 'react';
import type { Bolt, Step, Run, TimelineEvent, TimelineEventType } from '../types';
import { CLOSED_STATUSES } from '../types';
import api from '../api';

interface TimelineViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const RESULT_COLORS: Record<string, string> = {
  success: 'bg-success/70',
  fail: 'bg-danger/70',
  session_ended: 'bg-muted/50',
  running: 'bg-warning/70 animate-pulse',
};

// ── Swimlane types ──────────────────────────────────────────────────────────

interface SwimlaneRun extends Run {
  stepTitle: string;
  stepTicket?: string;
}

type ViewTab = 'swimlane' | 'activity';

// ── Activity Stream (existing, simplified) ──────────────────────────────────

const EVENT_CONFIG: Record<TimelineEventType, { icon: string; color: string; dotColor: string }> = {
  status_change: { icon: '●', color: 'text-primary', dotColor: 'bg-primary' },
  assignment:    { icon: '→', color: 'text-foreground', dotColor: 'bg-foreground' },
  comment:       { icon: '◇', color: 'text-foreground', dotColor: 'bg-muted' },
  artifact:      { icon: '□', color: 'text-foreground', dotColor: 'bg-accent' },
  run_start:     { icon: '▶', color: 'text-warning', dotColor: 'bg-warning' },
  run_end:       { icon: '■', color: 'text-success', dotColor: 'bg-success' },
  question:      { icon: '◇', color: 'text-warning', dotColor: 'bg-warning' },
  created:       { icon: '+', color: 'text-success', dotColor: 'bg-success' },
  updated:       { icon: '~', color: 'text-foreground', dotColor: 'bg-muted' },
};

function describeEvent(ev: TimelineEvent): { action: string; target: string; detail?: string } {
  const title = ev.entity_title || ev.entity_id;
  const actor = ev.actor ? `@${ev.actor}` : 'System';
  const d = ev.detail;
  switch (ev.event_type) {
    case 'status_change': return { action: `${actor} changed status`, target: title, detail: `${d.old_value || '?'} → ${d.new_value || '?'}` };
    case 'assignment': return { action: d.new_value ? `Assigned to @${d.new_value}` : `${actor} unassigned`, target: title };
    case 'comment': return { action: `${actor} commented`, target: title, detail: d.body?.slice(0, 80) };
    case 'artifact': return { action: `${d.artifact_type || 'Artifact'} added`, target: title };
    case 'run_start': return { action: `${actor} started`, target: title };
    case 'run_end': return { action: `${actor} finished`, target: title, detail: [d.result, d.duration_ms != null ? formatDuration(d.duration_ms) : null].filter(Boolean).join(' · ') };
    case 'question': return { action: `${actor} asked`, target: title, detail: d.body?.slice(0, 80) };
    case 'created': return { action: `${actor} created`, target: title };
    case 'updated': return { action: `${actor} updated ${d.field || ''}`, target: title, detail: d.field ? `${d.old_value || '?'} → ${d.new_value || '?'}` : undefined };
    default: return { action: actor, target: title };
  }
}

// ── Main component ──────────────────────────────────────────────────────────

interface BoltProgress {
  bolt: Bolt;
  steps: Step[];
  done: number;
  inProgress: number;
  blocked: number;
  total: number;
}

export default function TimelineView({ projectId, onSelectStep }: TimelineViewProps) {
  const [runs, setRuns] = useState<SwimlaneRun[]>([]);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [boltProgress, setBoltProgress] = useState<BoltProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<ViewTab>('swimlane');
  const [hoveredRunId, setHoveredRunId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const [runData, eventData, boltList] = await Promise.all([
          api.listRuns({ project_id: projectId }),
          api.listProjectTimeline(projectId, { limit: 100 }),
          api.listBolts({ project_id: projectId }),
        ]);
        if (cancelled) return;

        // Active bolt progress
        const activeBolt = boltList.find(b => b.status === 'active');
        if (activeBolt) {
          const boltSteps = await api.listBoltSteps(activeBolt.id);
          if (!cancelled) {
            setBoltProgress({
              bolt: activeBolt,
              steps: boltSteps,
              done: boltSteps.filter(s => CLOSED_STATUSES.has(s.status)).length,
              inProgress: boltSteps.filter(s => s.status === 'in_progress').length,
              blocked: boltSteps.filter(s => s.status === 'blocked').length,
              total: boltSteps.length,
            });
          }
        }

        // Resolve step titles for runs
        const stepIds = [...new Set(runData.map(r => r.step_id))];
        const stepMap: Record<string, { title: string; ticket?: string }> = {};
        await Promise.all(
          stepIds.slice(0, 50).map(async id => {
            try { const s = await api.getStep(id); stepMap[id] = { title: s.title, ticket: s.ticket_number || undefined }; } catch { /* skip */ }
          })
        );

        setRuns(runData.map(r => ({
          ...r,
          stepTitle: stepMap[r.step_id]?.title || r.step_id,
          stepTicket: stepMap[r.step_id]?.ticket,
        })));
        setEvents(eventData);
      } catch (err) {
        console.error('Failed to load timeline:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, [projectId]);

  // ── Swimlane data ───────────────────────────────────────────────────────

  const agents = useMemo(() => {
    const map: Record<string, SwimlaneRun[]> = {};
    for (const r of runs) {
      (map[r.agent] ||= []).push(r);
    }
    // Sort agents: most runs first
    return Object.entries(map).sort((a, b) => b[1].length - a[1].length);
  }, [runs]);

  const timeRange = useMemo(() => {
    if (runs.length === 0) return { min: Date.now() - 3600000, max: Date.now(), range: 3600000 };
    const min = Math.min(...runs.map(r => r.started_at));
    const max = Math.max(...runs.map(r => r.ended_at || Date.now()));
    const range = max - min || 1;
    return { min, max, range };
  }, [runs]);

  // ── Activity stream data ────────────────────────────────────────────────

  const dayGroups = useMemo(() => {
    const groups: Record<string, TimelineEvent[]> = {};
    for (const ev of events) {
      const key = formatDate(ev.created_at);
      (groups[key] ||= []).push(ev);
    }
    return groups;
  }, [events]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-muted">Loading timeline...</div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Header + Tab switcher */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Timeline</h2>
        <div className="flex gap-1 bg-surface-high rounded-lg p-0.5">
          {(['swimlane', 'activity'] as ViewTab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`px-3 py-1 text-xs rounded-md transition-colors cursor-pointer ${
                tab === t ? 'bg-surface text-foreground shadow-sm' : 'text-muted hover:text-foreground'
              }`}
            >
              {t === 'swimlane' ? 'Swimlane' : 'Activity'}
            </button>
          ))}
        </div>
      </div>

      {/* Bolt Progress Meter */}
      {boltProgress && (
        <div className="bg-surface rounded-lg border border-border p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium text-foreground">{boltProgress.bolt.title}</span>
            <span className="text-xs text-muted">
              {boltProgress.done}/{boltProgress.total} done
              {boltProgress.inProgress > 0 && ` · ${boltProgress.inProgress} active`}
              {boltProgress.blocked > 0 && ` · ${boltProgress.blocked} blocked`}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-surface-high overflow-hidden flex">
            {boltProgress.done > 0 && (
              <div className="bg-success h-full" style={{ width: `${(boltProgress.done / boltProgress.total) * 100}%` }} />
            )}
            {boltProgress.inProgress > 0 && (
              <div className="bg-warning h-full" style={{ width: `${(boltProgress.inProgress / boltProgress.total) * 100}%` }} />
            )}
            {boltProgress.blocked > 0 && (
              <div className="bg-danger h-full" style={{ width: `${(boltProgress.blocked / boltProgress.total) * 100}%` }} />
            )}
          </div>
          {boltProgress.bolt.started_at && (
            <div className="text-[10px] text-muted mt-1">
              {Math.round((boltProgress.done / boltProgress.total) * 100)}% complete
              {' · '}started {formatDate(boltProgress.bolt.started_at)}
              {boltProgress.done > 0 && ` · ~${formatDuration((Date.now() - boltProgress.bolt.started_at) / boltProgress.done * (boltProgress.total - boltProgress.done))} remaining`}
            </div>
          )}
        </div>
      )}

      {/* ── Swimlane Tab ─────────────────────────────────────────────────── */}
      {tab === 'swimlane' && (
        <>
          {runs.length === 0 ? (
            <div className="text-center py-12 text-muted text-sm">No runs yet. Agent executions will appear here.</div>
          ) : (
            <div ref={containerRef} className="space-y-1">
              {/* Time axis header */}
              <div className="flex items-center mb-2">
                <div className="w-28 shrink-0" />
                <div className="flex-1 flex justify-between text-[10px] text-muted px-1">
                  <span>{formatDate(timeRange.min)} {formatTime(timeRange.min)}</span>
                  <span>{formatDate(timeRange.max)} {formatTime(timeRange.max)}</span>
                </div>
              </div>

              {/* Agent swimlanes */}
              {agents.map(([agent, agentRuns]) => (
                <div key={agent} className="flex items-center gap-2">
                  {/* Agent label */}
                  <div className="w-28 shrink-0 text-right pr-2">
                    <span className="text-xs font-medium text-foreground truncate block">@{agent}</span>
                    <span className="text-[10px] text-muted">{agentRuns.length} runs</span>
                  </div>

                  {/* Swimlane track */}
                  <div className="flex-1 relative h-8 bg-surface-high/50 rounded">
                    {agentRuns.map(run => {
                      const left = ((run.started_at - timeRange.min) / timeRange.range) * 100;
                      const end = run.ended_at || Date.now();
                      const width = Math.max(((end - run.started_at) / timeRange.range) * 100, 0.5);
                      const result = run.result || 'running';
                      const colorClass = RESULT_COLORS[result] || 'bg-muted/50';
                      const isHovered = hoveredRunId === run.id;
                      const duration = (end - run.started_at);
                      const isLongest = duration === Math.max(...agentRuns.map(r => (r.ended_at || Date.now()) - r.started_at));

                      return (
                        <button
                          key={run.id}
                          onClick={() => onSelectStep(run.step_id)}
                          onMouseEnter={() => setHoveredRunId(run.id)}
                          onMouseLeave={() => setHoveredRunId(null)}
                          className={`absolute top-1 bottom-1 rounded cursor-pointer transition-all ${colorClass} ${
                            isHovered ? 'ring-2 ring-primary z-10' : ''
                          } ${isLongest && !isHovered ? 'ring-1 ring-foreground/20' : ''}`}
                          style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }}
                          title={`${run.stepTitle}\n@${run.agent} · ${formatDuration(end - run.started_at)} · ${result}`}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}

              {/* Dependency / Blocked steps */}
              {boltProgress && (() => {
                const blocked = boltProgress.steps.filter(s => s.status === 'blocked');
                const withDeps = boltProgress.steps.filter(s => s.depends_on && s.depends_on.length > 0);
                if (blocked.length === 0 && withDeps.length === 0) return null;
                return (
                  <div className="mt-3 p-3 bg-surface border border-border rounded-lg">
                    {blocked.length > 0 && (
                      <div className="mb-2">
                        <span className="text-xs font-medium text-danger">Blocked ({blocked.length})</span>
                        {blocked.map(s => {
                          const blockers = boltProgress.steps.filter(b => s.depends_on.includes(b.id));
                          return (
                            <div key={s.id} className="flex items-center gap-2 mt-1 text-xs">
                              <span className="text-danger">⊘</span>
                              <button onClick={() => onSelectStep(s.id)} className="text-foreground hover:text-primary cursor-pointer">
                                {s.ticket_number} {s.title}
                              </button>
                              {blockers.length > 0 && (
                                <span className="text-muted">← blocked by {blockers.map(b => b.ticket_number || b.id.slice(-6)).join(', ')}</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {withDeps.length > 0 && blocked.length === 0 && (
                      <div>
                        <span className="text-xs font-medium text-muted">Dependencies ({withDeps.length} steps with depends_on)</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Legend */}
              <div className="flex items-center gap-4 pt-3 text-[10px] text-muted">
                <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-success/70 inline-block" /> success</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-warning/70 inline-block" /> running</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-danger/70 inline-block" /> fail</span>
                <span className="flex items-center gap-1"><span className="w-3 h-2 rounded bg-muted/50 inline-block" /> ended</span>
              </div>

              {/* Hovered run detail */}
              {hoveredRunId && (() => {
                const run = runs.find(r => r.id === hoveredRunId);
                if (!run) return null;
                const duration = (run.ended_at || Date.now()) - run.started_at;
                return (
                  <div className="mt-2 p-3 bg-surface border border-border rounded-lg text-sm">
                    <div className="flex items-center gap-2">
                      {run.stepTicket && <span className="text-xs font-mono text-primary">{run.stepTicket}</span>}
                      <span className="font-medium text-foreground">{run.stepTitle}</span>
                      <span className="text-xs text-muted">@{run.agent}</span>
                    </div>
                    <div className="flex items-center gap-3 mt-1 text-xs text-muted">
                      <span>{formatDate(run.started_at)} {formatTime(run.started_at)}</span>
                      <span>→</span>
                      <span>{run.ended_at ? `${formatDate(run.ended_at)} ${formatTime(run.ended_at)}` : 'running'}</span>
                      <span>·</span>
                      <span className="font-medium">{formatDuration(duration)}</span>
                      {run.result && <span className={run.result === 'success' ? 'text-success' : 'text-muted'}>{run.result}</span>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </>
      )}

      {/* ── Activity Tab ─────────────────────────────────────────────────── */}
      {tab === 'activity' && (
        <>
          {events.length === 0 ? (
            <div className="text-center py-12 text-muted text-sm">No activity yet.</div>
          ) : (
            <div className="relative">
              <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border" />
              {Object.entries(dayGroups).map(([day, dayEvents]) => (
                <div key={day} className="mb-4">
                  <div className="flex items-center gap-2 mb-2 relative">
                    <div className="w-[23px] h-[23px] rounded-full bg-surface-high border border-border flex items-center justify-center z-10">
                      <span className="text-[9px] text-muted font-medium">
                        {day === 'Today' ? 'T' : day === 'Yesterday' ? 'Y' : day}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-muted">{day}</span>
                    <span className="text-[10px] text-muted">({dayEvents.length})</span>
                  </div>
                  <div className="space-y-0.5">
                    {dayEvents.map(ev => {
                      const config = EVENT_CONFIG[ev.event_type] || EVENT_CONFIG.updated;
                      const desc = describeEvent(ev);
                      return (
                        <button
                          key={ev.id}
                          onClick={() => ev.entity_type === 'step' && onSelectStep(ev.entity_id)}
                          className="w-full text-left flex items-start gap-2.5 pl-1 pr-3 py-1.5 rounded-md transition-colors hover:bg-surface-hover cursor-pointer"
                        >
                          <div className="w-[23px] flex items-center justify-center shrink-0 pt-0.5 relative z-10">
                            <span className={`w-2 h-2 rounded-full ${config.dotColor}`} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span className={`text-xs ${config.color}`}>{config.icon}</span>
                              <span className="text-xs text-muted">{desc.action}</span>
                              <span className="text-sm text-foreground truncate">{desc.target}</span>
                            </div>
                            {desc.detail && <p className="text-xs text-muted truncate mt-0.5">{desc.detail}</p>}
                          </div>
                          <div className="shrink-0 pt-0.5">
                            <span className="text-[10px] text-muted">{formatTime(ev.created_at)}</span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
