import { cn } from '../../lib/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div data-testid="skeleton" className={cn('animate-pulse rounded-field bg-neutral-200/70', className)} {...props} />;
}

export { Skeleton };
