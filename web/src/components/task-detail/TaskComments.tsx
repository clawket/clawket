import { useState, useCallback } from 'react';
import type { TaskComment } from '../../types';
import api from '../../api';
import { Label, Input, Textarea, Button } from '../ui';

function formatTime(ts: number | null): string {
  if (!ts) return '\u2014';
  const d = new Date(ts);
  return `${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

export function TaskComments({
  taskId,
  comments,
  onCommentsChange,
}: {
  taskId: string;
  comments: TaskComment[];
  onCommentsChange: (comments: TaskComment[]) => void;
}) {
  const [commentAuthor, setCommentAuthor] = useState('main');
  const [commentBody, setCommentBody] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!commentAuthor.trim() || !commentBody.trim()) return;
    setSubmitting(true);
    try {
      const newComment = await api.createTaskComment(taskId, commentAuthor.trim(), commentBody.trim());
      onCommentsChange([...comments, newComment]);
      setCommentBody('');
    } catch (err) {
      console.error('Failed to add comment:', err);
    } finally {
      setSubmitting(false);
    }
  }, [taskId, commentAuthor, commentBody, comments, onCommentsChange]);

  const handleDelete = useCallback(async (commentId: string) => {
    try {
      await api.deleteTaskComment(commentId);
      onCommentsChange(comments.filter((c) => c.id !== commentId));
    } catch (err) {
      console.error('Failed to delete comment:', err);
    }
  }, [comments, onCommentsChange]);

  return (
    <div>
      <Label>Comments ({comments.length})</Label>
      {comments.length > 0 && (
        <div className="space-y-2 mb-3">
          {comments.map((c) => (
            <div key={c.id} className="bg-background border border-border rounded p-3">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-foreground">{c.author}</span>
                  <span className="text-xs text-muted">{formatTime(c.created_at)}</span>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(c.id)} title="Delete comment">&times;</Button>
              </div>
              <div className="text-sm text-foreground">{c.body}</div>
            </div>
          ))}
        </div>
      )}
      <div className="bg-background border border-border rounded p-3 space-y-2">
        <Input value={commentAuthor} onChange={(e) => setCommentAuthor(e.target.value)} placeholder="Author" size="sm" />
        <Textarea value={commentBody} onChange={(e) => setCommentBody(e.target.value)} placeholder="Write a comment..." rows={3} size="sm" />
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" onClick={handleAdd} disabled={submitting || !commentAuthor.trim() || !commentBody.trim()}>
            {submitting ? 'Posting...' : 'Add Comment'}
          </Button>
        </div>
      </div>
    </div>
  );
}
