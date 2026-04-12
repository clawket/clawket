import { useState } from 'react';
import api from '../api';
import { Modal, Input, Textarea, Select, Label, Button } from './ui';

interface CreatePlanModalProps {
  projectId: string;
  onClose: () => void;
  onCreated: () => void;
}

export default function CreatePlanModal({ projectId, onClose, onCreated }: CreatePlanModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [source, setSource] = useState('manual');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await api.createPlan({
        project_id: projectId,
        title: title.trim(),
        description: description.trim() || undefined,
        source,
      });
      onCreated();
      onClose();
    } catch (err) {
      console.error('Failed to create plan:', err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal.Overlay onClose={onClose}>
      <Modal.Content>
        <Modal.Header>New Plan</Modal.Header>
        <Modal.Body>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <Label>Title</Label>
              <Input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full"
                placeholder="Plan title"
                autoFocus
              />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full resize-none"
                placeholder="Plan description"
                rows={3}
              />
            </div>
            <div>
              <Label>Source</Label>
              <Select
                value={source}
                onChange={(e) => setSource(e.target.value)}
                className="w-full"
              >
                <option value="manual">Manual</option>
                <option value="plan-mode">Plan Mode</option>
                <option value="import">Import</option>
              </Select>
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
                {submitting ? 'Creating...' : 'Create Plan'}
              </Button>
            </div>
          </form>
        </Modal.Body>
      </Modal.Content>
    </Modal.Overlay>
  );
}
