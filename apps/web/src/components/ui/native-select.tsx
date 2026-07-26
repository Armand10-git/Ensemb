import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * <select> natif stylé (pas Radix Select) : préserve la compatibilité avec
 * userEvent.selectOptions() dans les tests, tout en reprenant le langage visuel
 * du design system. Utilisé pour les sélecteurs d'entités (client, entrepôt, produit…).
 */
export type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

const NativeSelect = React.forwardRef<HTMLSelectElement, NativeSelectProps>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          'flex h-9 w-full appearance-none rounded-field border border-neutral-300 bg-white px-3 py-1.5 pr-8 text-[14px] font-sans text-neutral-900 shadow-1 transition-colors focus-visible:border-brand-500 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-400" />
    </div>
  ),
);
NativeSelect.displayName = 'NativeSelect';

export { NativeSelect };
