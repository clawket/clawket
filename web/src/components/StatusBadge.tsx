import { Badge, type BadgeProps } from './ui';

interface StatusBadgeProps {
  status: string;
  size?: 'sm' | 'md';
}

const statusConfig: Record<string, { label: string; variant: BadgeProps['variant'] }> = {
  // Step statuses
  todo: { label: 'Todo', variant: 'default' },
  in_progress: { label: 'In Progress', variant: 'warning' },
  done: { label: 'Done', variant: 'success' },
  blocked: { label: 'Blocked', variant: 'danger' },
  review: { label: 'Review', variant: 'info' },
  cancelled: { label: 'Cancelled', variant: 'default' },
  superseded: { label: 'Superseded', variant: 'default' },
  deferred: { label: 'Deferred', variant: 'default' },
  // Plan statuses
  draft: { label: 'Draft', variant: 'default' },
  active: { label: 'Active', variant: 'primary' },
  approved: { label: 'Approved', variant: 'success' },
  completed: { label: 'Completed', variant: 'success' },
  archived: { label: 'Archived', variant: 'default' },
  // Phase statuses
  pending: { label: 'Pending', variant: 'default' },
};

export default function StatusBadge({ status, size = 'sm' }: StatusBadgeProps) {
  const config = statusConfig[status] ?? { label: status, variant: 'default' as const };

  return (
    <Badge variant={config.variant} size={size}>
      {config.label}
    </Badge>
  );
}
