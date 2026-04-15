import { useState, useEffect, useRef } from 'react';
import type { Task } from '../types';
import api from '../api';
import { Modal, Input, Textarea, Select, Label, Button } from './ui';

interface CreateTaskModalProps {
  unitId: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreateTaskModal({ unitId, onClose, onCreated }: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [idx, setIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [agents, setAgents] = useState<string[]>([]);
  const [duplicates, setDuplicates] = useState<Task[]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    fetch('/agents').then(r => r.json()).then(setAgents).catch(() => {});
  }, []);

  // Debounced duplicate check on title change
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = title.trim();
    if (trimmed.length < 3) { setDuplicates([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await api.searchTasks(trimmed, 5);
        setDuplicates(results.filter(s => s.title.toLowerCase().includes(trimmed.toLowerCase())));
      } catch { setDuplicates([]); }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [title]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.createTask({
        unit_id: unitId,
        title: title.trim(),
        body: body.trim(),
        idx,
        assignee: assignee.trim() || undefined,
      });
      onCreated();
      onClose();
    } catch (err) {
      console.error('Failed to create task:', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Overlay onClose={onClose}>
      <Modal.Content>
        <Modal.Header>New Task</Modal.Header>
        <Modal.Body>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full"
                placeholder="Task title"
                autoFocus
              />
              {duplicates.length > 0 && (
                <div className="mt-1.5 p-2 rounded border border-warning/30 bg-warning/5 text-xs">
                  <span className="text-warning font-medium">Similar tasks found:</span>
                  {duplicates.map(d => (
                    <div key={d.id} className="text-muted mt-0.5 truncate">
                      {d.ticket_number && <span className="font-mono mr-1">{d.ticket_number}</span>}
                      {d.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <Label>Body</Label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full resize-none font-mono"
                placeholder="Task details..."
                rows={4}
              />
            </div>
            <div className="flex gap-4">
              <div className="flex-1">
                <Label>Assignee (optional)</Label>
                {agents.length > 0 ? (
                  <Select
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    className="w-full"
                  >
                    <option value="">Unassigned</option>
                    {agents.map(a => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    type="text"
                    value={assignee}
                    onChange={(e) => setAssignee(e.target.value)}
                    className="w-full"
                    placeholder="agent name"
                  />
                )}
              </div>
              <div>
                <Label>Index</Label>
                <Input
                  type="number"
                  value={idx}
                  onChange={(e) => setIdx(parseInt(e.target.value, 10) || 0)}
                  className="w-20"
                  min={0}
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="outline" size="md" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={!title.trim() || submitting}
              >
                {submitting ? 'Creating...' : 'Create Task'}
              </Button>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Overlay>
  );
}
