import { useState, useEffect, useCallback } from 'react';
import type { Plan, Phase, Artifact, Question } from '../types';
import api from '../api';
import StatusBadge from './StatusBadge';
import { Label } from './ui';

interface PlanDetailProps {
  planId: string;
  onClose: () => void;
}

export default function PlanDetail({ planId, onClose }: PlanDetailProps) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [phases, setPhases] = useState<Phase[]>([]);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, ph, a, q] = await Promise.all([
        api.getPlan(planId),
        api.listPhases({ plan_id: planId }),
        api.listArtifacts({ plan_id: planId }),
        api.listQuestions({ plan_id: planId }),
      ]);
      setPlan(p);
      setPhases(ph.sort((a, b) => a.idx - b.idx));
      setArtifacts(a);
      setQuestions(q);
    } catch (err) {
      console.error('Failed to load plan:', err);
    } finally {
      setLoading(false);
    }
  }, [planId]);

  useEffect(() => { load(); }, [load]);

  function formatTime(ts: number | null) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleString();
  }

  if (loading || !plan) {
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
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted font-mono">{plan.id.slice(0, 8)}</span>
          <StatusBadge status={plan.status} />
        </div>
        <button onClick={onClose} className="text-muted hover:text-foreground text-lg leading-none">&times;</button>
      </div>

      <div className="p-4 space-y-5">
        {/* Title */}
        <h2 className="text-lg font-semibold text-foreground">{plan.title}</h2>

        {/* Source */}
        <div className="flex gap-4 text-sm">
          <div>
            <span className="text-muted">Source:</span>{' '}
            <span className="text-foreground">{plan.source}</span>
          </div>
          {plan.source_path && (
            <div>
              <span className="text-muted">Path:</span>{' '}
              <span className="text-foreground font-mono text-xs">{plan.source_path}</span>
            </div>
          )}
        </div>

        {/* Description */}
        {plan.description && (
          <div>
            <Label>Description</Label>
            <div className="bg-background border border-border rounded p-3 text-sm text-foreground whitespace-pre-wrap">
              {plan.description}
            </div>
          </div>
        )}

        {/* Timestamps */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div><span className="text-muted">Created:</span> <span className="text-foreground">{formatTime(plan.created_at)}</span></div>
          <div><span className="text-muted">Approved:</span> <span className="text-foreground">{formatTime(plan.approved_at)}</span></div>
        </div>

        {/* Phases overview */}
        <div>
          <Label>Phases ({phases.length})</Label>
          {phases.length === 0 ? (
            <div className="text-sm text-muted italic">No phases yet</div>
          ) : (
            <div className="space-y-1.5">
              {phases.map((ph) => (
                <div key={ph.id} className="flex items-center gap-2 bg-background border border-border rounded px-3 py-2">
                  <span className="text-xs text-muted font-mono w-5">#{ph.idx + 1}</span>
                  <span className="text-sm text-foreground truncate flex-1">{ph.title}</span>
                  <StatusBadge status={ph.status} size="sm" />
                  {ph.approved_at && <span className="text-xs text-success">{'\u2713'}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Artifacts */}
        {artifacts.length > 0 && (
          <div>
            <Label>Artifacts ({artifacts.length})</Label>
            <div className="space-y-1.5">
              {artifacts.map((a) => (
                <div key={a.id} className="flex items-center gap-2 bg-background border border-border rounded px-3 py-2">
                  <span className="text-xs font-mono bg-secondary/20 text-secondary px-1.5 py-0.5 rounded">{a.type}</span>
                  <span className="text-sm text-foreground truncate flex-1">{a.title}</span>
                  <span className="text-xs text-muted">{a.content_format}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Questions */}
        {questions.length > 0 && (
          <div>
            <Label>Questions ({questions.length})</Label>
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
          </div>
        )}
      </div>
    </div>
  );
}
