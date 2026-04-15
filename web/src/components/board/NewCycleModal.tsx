import { useState } from 'react';
import type { Cycle } from '../../types';
import api from '../../api';
import { Button, Input, Label, Modal } from '../ui';

export function NewCycleModal({
  projectId,
  onCreated,
  onClose,
}: {
  projectId: string;
  onCreated: (cycle: Cycle) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError('Title is required');
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const newCycle = await api.createCycle({
        project_id: projectId,
        title: trimmedTitle,
        goal: goal.trim() || undefined,
      });
      onCreated(newCycle);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to create cycle');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal.Overlay onClose={onClose}>
      <Modal.Content>
        <Modal.Header>New Cycle</Modal.Header>
        <Modal.Body>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cycle-title">Title</Label>
              <Input id="cycle-title" size="md" placeholder="e.g. Sprint 1 - Core features" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cycle-goal">Goal (optional)</Label>
              <Input id="cycle-goal" size="md" placeholder="What should this cycle achieve?" value={goal} onChange={(e) => setGoal(e.target.value)} />
            </div>
            {formError && <p className="text-danger text-sm">{formError}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={submitting}>Cancel</Button>
              <Button type="submit" variant="primary" size="sm" disabled={submitting}>{submitting ? 'Creating...' : 'Create Cycle'}</Button>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Overlay>
  );
}
