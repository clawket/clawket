import type { Artifact, Run, Question } from '../../types';
import StatusBadge from '../StatusBadge';
import { Label } from '../ui';

function formatTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function ArtifactsSection({ artifacts }: { artifacts: Artifact[] }) {
  return (
    <div>
      <Label>Artifacts ({artifacts.length})</Label>
      {artifacts.length === 0 ? (
        <div className="text-sm text-muted italic">No artifacts</div>
      ) : (
        <div className="space-y-1.5">
          {artifacts.map((a) => (
            <div key={a.id} className="flex items-center gap-2 bg-background border border-border rounded px-3 py-2">
              <span className="text-xs font-mono bg-secondary/20 text-secondary px-1.5 py-0.5 rounded">{a.type}</span>
              <span className="text-sm text-foreground truncate flex-1">{a.title}</span>
              <span className="text-xs text-muted">{a.content_format}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function RunsSection({ runs }: { runs: Run[] }) {
  return (
    <div>
      <Label>Runs ({runs.length})</Label>
      {runs.length === 0 ? (
        <div className="text-sm text-muted italic">No runs</div>
      ) : (
        <div className="border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-background text-muted">
                <th className="text-left px-2 py-1.5 font-medium">Agent</th>
                <th className="text-left px-2 py-1.5 font-medium">Started</th>
                <th className="text-left px-2 py-1.5 font-medium">Ended</th>
                <th className="text-left px-2 py-1.5 font-medium">Result</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-2 py-1.5 text-foreground">{r.agent}</td>
                  <td className="px-2 py-1.5 text-muted">{formatTime(r.started_at)}</td>
                  <td className="px-2 py-1.5 text-muted">{formatTime(r.ended_at)}</td>
                  <td className="px-2 py-1.5">
                    {r.result ? <StatusBadge status={r.result} size="sm" /> : <span className="text-warning">running</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function QuestionsSection({ questions }: { questions: Question[] }) {
  return (
    <div>
      <Label>Questions ({questions.length})</Label>
      {questions.length === 0 ? (
        <div className="text-sm text-muted italic">No questions</div>
      ) : (
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
      )}
    </div>
  );
}
