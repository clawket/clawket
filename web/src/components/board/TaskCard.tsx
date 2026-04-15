import type { Task } from '../../types';
import { Badge } from '../ui';
import { useDraggable } from '@dnd-kit/core';
import { PRIORITY_DOT, PRIORITY_LABEL, STATUS_TRANSITIONS } from './constants';

interface TaskCardProps {
  task: Task;
  onClick: () => void;
  onStatusChange: (newStatus: Task['status']) => void;
}

export function TaskCard({ task, onClick, onStatusChange }: TaskCardProps) {
  const transitions = STATUS_TRANSITIONS[task.status] ?? [];

  return (
    <div className="w-full text-left rounded-md border border-border bg-background transition-colors duration-150 hover:bg-surface-hover hover:border-primary/30">
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left p-3 space-y-2 focus:outline-none focus:ring-2 focus:ring-primary/40 rounded-t-md"
      >
        {task.ticket_number && (
          <span className="font-mono text-xs text-muted">
            {task.ticket_number}
          </span>
        )}
        <p className="text-sm font-medium text-foreground leading-snug">
          {task.title}
        </p>
        <div className="flex items-center justify-between gap-2">
          {task.assignee ? (
            <Badge variant="primary" size="sm">
              {task.assignee}
            </Badge>
          ) : (
            <span className="text-xs text-muted/50">Unassigned</span>
          )}
          <div className="flex items-center gap-1.5" title={PRIORITY_LABEL[task.priority]}>
            <span className={`inline-block w-2 h-2 rounded-full ${PRIORITY_DOT[task.priority]}`} />
            <span className="text-xs text-muted">{PRIORITY_LABEL[task.priority]}</span>
          </div>
        </div>
      </button>
      {transitions.length > 0 && (
        <div className="flex items-center gap-1 px-3 pb-2 pt-0">
          {transitions.map((t) => (
            <button
              key={t.target}
              type="button"
              onClick={(e) => { e.stopPropagation(); onStatusChange(t.target); }}
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

export function DraggableTaskCard({ task, onClick, onStatusChange }: TaskCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });

  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={`touch-none ${isDragging ? 'opacity-30' : ''}`}>
      <TaskCard task={task} onClick={onClick} onStatusChange={onStatusChange} />
    </div>
  );
}
