import { useState } from 'react';
import api from '../api';
import { Modal, Input, Textarea, Label, Button } from './ui';

interface CreatePhaseModalProps {
  planId: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreatePhaseModal({ planId, onClose, onCreated }: CreatePhaseModalProps) {
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [idx, setIdx] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.createPhase({
        plan_id: planId,
        title: title.trim(),
        goal: goal.trim() || undefined,
        idx,
      });
      onCreated();
      onClose();
    } catch (err) {
      console.error('Failed to create phase:', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Overlay onClose={onClose}>
      <Modal.Content>
        <Modal.Header>New Phase</Modal.Header>
        <Modal.Body>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full"
                placeholder="Phase title"
                autoFocus
              />
            </div>
            <div>
              <Label>Goal (optional)</Label>
              <Textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                className="w-full resize-none"
                placeholder="Phase goal"
                rows={3}
              />
            </div>
            <div>
              <Label>Index</Label>
              <Input
                type="number"
                value={idx}
                onChange={(e) => setIdx(parseInt(e.target.value, 10) || 0)}
                className="w-24"
                min={0}
              />
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
                {submitting ? 'Creating...' : 'Create Phase'}
              </Button>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Overlay>
  );
}
