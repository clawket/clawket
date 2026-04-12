import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import type { TimelineEvent, TimelineEventType } from '../types';
import api from '../api';

interface TimelineViewProps {
  projectId: string;
  onSelectStep: (stepId: string) => void;
}

// ── Event type config ──────────────────────────────────────────────────────

const EVENT_CONFIG: Record<
  TimelineEventType,
  { icon: string; label: string; color: string; dotColor: string }
> = {
  status_change: { icon: '●', label: 'Status', color: 'text-primary', dotColor: 'bg-primary' },
  assignment:    { icon: '👤', label: 'Assignment', color: 'text-foreground', dotColor: 'bg-foreground' },
  comment:       { icon: '💬', label: 'Comments', color: 'text-foreground', dotColor: 'bg-muted' },
  artifact:      { icon: '📄', label: 'Artifacts', color: 'text-foreground', dotColor: 'bg-accent' },
  run_start:     { icon: '▶', label: 'Runs', color: 'text-warning', dotColor: 'bg-warning' },
  run_end:       { icon: '■', label: 'Runs', color: 'text-success', dotColor: 'bg-success' },
  question:      { icon: '?', label: 'Questions', color: 'text-foreground', dotColor: 'bg-muted' },
  created:       { icon: '+', label: 'Status', color: 'text-success', dotColor: 'bg-success' },
  updated:       { icon: '✎', label: 'Status', color: 'text-foreground', dotColor: 'bg-muted' },
};

// Filter chips group run_start and run_end under "Runs"
const FILTER_CHIPS: { key: string; label: string; types: TimelineEventType[] }[] = [
  { key: 'status', label: 'Status', types: ['status_change', 'created', 'updated'] },
  { key: 'assignment', label: 'Assignment', types: ['assignment'] },
  { key: 'comment', label: 'Comments', types: ['comment'] },
  { key: 'artifact', label: 'Artifacts', types: ['artifact'] },
  { key: 'run', label: 'Runs', types: ['run_start', 'run_end'] },
  { key: 'question', label: 'Questions', types: ['question'] },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function groupByDay(events: TimelineEvent[]): Record<string, TimelineEvent[]> {
  const groups: Record<string, TimelineEvent[]> = {};
  for (const ev of events) {
    const key = formatDate(ev.created_at);
    (groups[key] ||= []).push(ev);
  }
  return groups;
}

// ── Event description renderer ──────────────────────────────────────────────

function describeEvent(ev: TimelineEvent): { action: string; target: string; detail?: string } {
  const title = ev.entity_title || ev.entity_id;
  const actor = ev.actor ? `@${ev.actor}` : 'System';
  const d = ev.detail;

  switch (ev.event_type) {
    case 'status_change':
      return {
        action: `${actor} changed status`,
        target: title,
        detail: `${d.old_value || '?'} → ${d.new_value || '?'}`,
      };
    case 'assignment':
      return {
        action: d.new_value ? `Assigned to @${d.new_value}` : `${actor} unassigned`,
        target: title,
      };
    case 'comment':
      return {
        action: `${actor} commented`,
        target: title,
        detail: d.body ? (d.body.length > 80 ? d.body.slice(0, 80) + '…' : d.body) : undefined,
      };
    case 'artifact':
      return {
        action: `${d.artifact_type || 'Artifact'} added`,
        target: title,
        detail: d.body || undefined,
      };
    case 'run_start':
      return {
        action: `${actor} started working`,
        target: title,
      };
    case 'run_end':
      return {
        action: `${actor} finished`,
        target: title,
        detail: [
          d.result || 'done',
          d.duration_ms != null ? formatDuration(d.duration_ms) : null,
        ].filter(Boolean).join(' · '),
      };
    case 'question':
      return {
        action: `${actor} asked a question`,
        target: title,
        detail: d.body ? (d.body.length > 80 ? d.body.slice(0, 80) + '…' : d.body) : undefined,
      };
    case 'created':
      return { action: `${actor} created`, target: title };
    case 'updated':
      return {
        action: `${actor} updated ${d.field || 'field'}`,
        target: title,
        detail: d.field ? `${d.old_value || '?'} → ${d.new_value || '?'}` : undefined,
      };
    default:
      return { action: actor, target: title };
  }
}

// ── Main component ──────────────────────────────────────────────────────────

const PAGE_SIZE = 50;

export default function TimelineView({ projectId, onSelectStep }: TimelineViewProps) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [activeFilters, setActiveFilters] = useState<Set<string>>(
    () => new Set(FILTER_CHIPS.map(c => c.key)),
  );
  const [hoveredStepId, setHoveredStepId] = useState<string | null>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);

  // Compute which event types to request based on active filter chips
  const requestTypes = useMemo(() => {
    const allActive = FILTER_CHIPS.every(c => activeFilters.has(c.key));
    if (allActive) return undefined; // no filter → fetch all
    const types: TimelineEventType[] = [];
    for (const chip of FILTER_CHIPS) {
      if (activeFilters.has(chip.key)) types.push(...chip.types);
    }
    return types.join(',');
  }, [activeFilters]);

  // Load events
  const loadEvents = useCallback(
    async (reset: boolean) => {
      if (reset) {
        offsetRef.current = 0;
        setHasMore(true);
      }
      setLoading(true);
      try {
        const data = await api.listProjectTimeline(projectId, {
          limit: PAGE_SIZE,
          offset: offsetRef.current,
          types: requestTypes,
        });
        if (reset) {
          setEvents(data);
        } else {
          setEvents(prev => [...prev, ...data]);
        }
        offsetRef.current += data.length;
        if (data.length < PAGE_SIZE) setHasMore(false);
      } catch (err) {
        console.error('Failed to load timeline:', err);
      } finally {
        setLoading(false);
      }
    },
    [projectId, requestTypes],
  );

  // Initial load & filter change
  useEffect(() => {
    loadEvents(true);
  }, [loadEvents]);

  // Infinite scroll
  useEffect(() => {
    if (!loadMoreRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loading && hasMore) {
          loadEvents(false);
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(loadMoreRef.current);
    return () => observer.disconnect();
  }, [hasMore, loading, loadEvents]);

  // Compute max run duration for sparkline normalization
  const maxDuration = useMemo(() => {
    let max = 0;
    for (const ev of events) {
      if (ev.event_type === 'run_end' && ev.detail.duration_ms != null) {
        max = Math.max(max, ev.detail.duration_ms);
      }
    }
    return max || 1;
  }, [events]);

  const toggleFilter = (key: string) => {
    setActiveFilters(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const dayGroups = useMemo(() => groupByDay(events), [events]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Timeline</h2>
        <span className="text-xs text-muted">{events.length} events</span>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {FILTER_CHIPS.map(chip => {
          const active = activeFilters.has(chip.key);
          return (
            <button
              key={chip.key}
              onClick={() => toggleFilter(chip.key)}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors cursor-pointer ${
                active
                  ? 'bg-primary/15 border-primary/40 text-primary'
                  : 'bg-surface border-border text-muted hover:text-foreground'
              }`}
            >
              {chip.label}
            </button>
          );
        })}
      </div>

      {/* Event stream */}
      {loading && events.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-muted py-12">
          Loading timeline…
        </div>
      ) : events.length === 0 ? (
        <div className="text-center py-12 text-muted text-sm">
          No activity yet. Changes to steps will appear here.
        </div>
      ) : (
        <div className="relative">
          {/* Vertical rail */}
          <div className="absolute left-[11px] top-0 bottom-0 w-px bg-border" />

          {Object.entries(dayGroups).map(([day, dayEvents]) => (
            <div key={day} className="mb-4">
              {/* Day header */}
              <div className="flex items-center gap-2 mb-2 relative">
                <div className="w-[23px] h-[23px] rounded-full bg-surface-high border border-border flex items-center justify-center z-10">
                  <span className="text-[9px] text-muted font-medium">
                    {day === 'Today' ? 'T' : day === 'Yesterday' ? 'Y' : new Date(dayEvents[0].created_at).getDate()}
                  </span>
                </div>
                <span className="text-xs font-medium text-muted">{day}</span>
                <span className="text-[10px] text-muted">({dayEvents.length})</span>
              </div>

              {/* Events */}
              <div className="space-y-0.5">
                {dayEvents.map(ev => {
                  const config = EVENT_CONFIG[ev.event_type] || EVENT_CONFIG.updated;
                  const desc = describeEvent(ev);
                  const isStepEvent = ev.entity_type === 'step';
                  const isHovered = hoveredStepId != null && ev.entity_id === hoveredStepId;

                  return (
                    <button
                      key={ev.id}
                      onClick={() => isStepEvent && onSelectStep(ev.entity_id)}
                      onMouseEnter={() => isStepEvent && setHoveredStepId(ev.entity_id)}
                      onMouseLeave={() => setHoveredStepId(null)}
                      className={`w-full text-left flex items-start gap-2.5 pl-1 pr-3 py-1.5 rounded-md transition-colors group ${
                        isStepEvent ? 'cursor-pointer hover:bg-surface-hover' : 'cursor-default'
                      } ${isHovered ? 'bg-surface-hover' : ''}`}
                    >
                      {/* Dot */}
                      <div className="w-[23px] flex items-center justify-center shrink-0 pt-0.5 relative z-10">
                        <span className={`w-2 h-2 rounded-full ${config.dotColor}`} />
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-xs ${config.color}`}>{config.icon}</span>
                          <span className="text-xs text-muted">{desc.action}</span>
                          <span className="text-sm text-foreground truncate">{desc.target}</span>
                        </div>
                        {desc.detail && (
                          <p className="text-xs text-muted truncate mt-0.5">{desc.detail}</p>
                        )}
                        {/* Run duration sparkline */}
                        {ev.event_type === 'run_end' && ev.detail.duration_ms != null && (
                          <div className="mt-1 flex items-center gap-2">
                            <div className="relative w-24 h-1 bg-surface-high rounded-full overflow-hidden">
                              <div
                                className="absolute h-full bg-success/60 rounded-full"
                                style={{ width: `${Math.max((ev.detail.duration_ms / maxDuration) * 100, 2)}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-muted">{formatDuration(ev.detail.duration_ms)}</span>
                          </div>
                        )}
                      </div>

                      {/* Meta */}
                      <div className="shrink-0 flex flex-col items-end gap-0.5 pt-0.5">
                        <span className="text-[10px] text-muted">{formatTime(ev.created_at)}</span>
                        {ev.actor && (
                          <span className="text-[10px] text-muted">@{ev.actor}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}

          {/* Infinite scroll sentinel */}
          {hasMore && (
            <div ref={loadMoreRef} className="py-4 text-center text-xs text-muted">
              {loading ? 'Loading more…' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
