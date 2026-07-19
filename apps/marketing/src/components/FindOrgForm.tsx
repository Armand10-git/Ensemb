import React, { useId, useState } from 'react';

// TODO: extraire dans packages/validation (T10 — mutualisé avec la regex T04)
const SUBDOMAIN_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Valide un identifiant d'organisation (sous-domaine DNS).
 * Même règle que T04 : lettres minuscules, chiffres, tirets ; pas de tirets consécutifs.
 */
export function isValidSubdomain(value: string): boolean {
  return SUBDOMAIN_REGEX.test(value) && !/-{2,}/.test(value);
}

/**
 * Formulaire "Se connecter" du site marketing.
 * Redirige vers {subdomain}.{VITE_ROOT_DOMAIN}/login — aucun appel API.
 */
export function FindOrgForm(): React.ReactElement {
  const [value, setValue] = useState('');
  const inputId = useId();
  const errorId = useId();

  const rootDomain = import.meta.env.VITE_ROOT_DOMAIN as string;
  const isValid = value.length > 0 && isValidSubdomain(value);
  const showError = value.length > 0 && !isValid;

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!isValid) return;
    window.location.href = `https://${value}.${rootDomain}/login`;
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-2">
        <label htmlFor={inputId} className="text-sm font-medium text-gray-700">
          Identifiant de votre organisation
        </label>
        <div className="flex gap-2">
          <input
            id={inputId}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="boutique-durand"
            aria-describedby={showError ? errorId : undefined}
            aria-invalid={showError || undefined}
            className={`flex-1 rounded-md border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 ${
              showError ? 'border-red-500' : 'border-gray-300'
            }`}
          />
          <button
            type="submit"
            disabled={!isValid}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Accéder
          </button>
        </div>
        {showError && (
          <p id={errorId} role="alert" className="text-sm text-red-600">
            L'identifiant ne peut contenir que des lettres minuscules, des chiffres et des tirets
          </p>
        )}
      </div>
    </form>
  );
}
