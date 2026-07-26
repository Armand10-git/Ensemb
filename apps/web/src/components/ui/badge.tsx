import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * Badge de statut — couleur + libellé toujours (jamais la couleur seule, tokens.md).
 * success = couleur de marque (PAID) · warning = ambre (PARTIAL) · danger = rouge (UNPAID)
 * info = ciel · neutral = statuts intermédiaires (PENDING, DRAFT…)
 */
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[12px] font-medium font-sans whitespace-nowrap',
  {
    variants: {
      variant: {
        success: 'bg-brand-50 text-brand-700 border-brand-200',
        warning: 'bg-amber-50 text-amber-700 border-amber-200',
        danger: 'bg-danger-50 text-danger-700 border-danger-200',
        info: 'bg-info-50 text-info-700 border-info-200',
        neutral: 'bg-neutral-100 text-neutral-600 border-neutral-200',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
