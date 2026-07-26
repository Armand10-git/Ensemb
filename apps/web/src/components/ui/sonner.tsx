import { Toaster as SonnerToaster } from 'sonner';

/** Toaster Sonner — verbe au participe, 4s, action Annuler quand possible (tokens.md). */
function Toaster() {
  return (
    <SonnerToaster
      position="bottom-right"
      duration={4000}
      toastOptions={{
        classNames: {
          toast: 'rounded-card border border-neutral-200 shadow-2 font-sans text-[13.5px]',
          success: '!border-brand-200 !bg-brand-50 !text-brand-800',
          error: '!border-danger-200 !bg-danger-50 !text-danger-800',
        },
      }}
    />
  );
}

export { Toaster };
