import React, { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { FindOrgForm } from './FindOrgForm';

/**
 * Barre de navigation principale du site marketing.
 * Le bouton "Se connecter" ouvre une modale avec FindOrgForm.
 */
export function Navbar(): React.ReactElement {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <nav className="bg-brand-900 text-white shadow-md">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <Link to="/" className="text-xl font-bold tracking-tight text-white hover:text-blue-200">
            Ensemb
          </Link>

          <div className="flex items-center gap-6">
            <Link
              to="/"
              className="text-sm font-medium text-blue-100 hover:text-white [&.active]:font-semibold [&.active]:text-white"
            >
              Accueil
            </Link>
            <Link
              to="/pricing"
              className="text-sm font-medium text-blue-100 hover:text-white [&.active]:font-semibold [&.active]:text-white"
            >
              Tarifs
            </Link>
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="rounded-md bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-300"
            >
              Se connecter
            </button>
          </div>
        </div>
      </nav>

      {modalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Accéder à votre organisation"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setModalOpen(false);
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Accéder à votre organisation</h2>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Fermer"
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
              >
                ✕
              </button>
            </div>
            <FindOrgForm />
          </div>
        </div>
      )}
    </>
  );
}
