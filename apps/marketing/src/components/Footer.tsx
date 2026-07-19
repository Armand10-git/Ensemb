import React from 'react';
import { Link } from '@tanstack/react-router';

/** Pied de page du site marketing avec liens légaux et contact. */
export function Footer(): React.ReactElement {
  return (
    <footer className="border-t border-gray-200 bg-gray-50">
      <div className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="text-sm font-semibold text-gray-700">Ensemb</p>
          <nav aria-label="Liens légaux" className="flex gap-6">
            <Link to="/mentions-legales" className="text-sm text-gray-600 hover:text-gray-900">
              Mentions légales
            </Link>
            <Link to="/cgu" className="text-sm text-gray-600 hover:text-gray-900">
              CGU
            </Link>
            <a
              href="mailto:contact@monapp.com"
              className="text-sm text-gray-600 hover:text-gray-900"
            >
              Contact
            </a>
          </nav>
          <p className="text-xs text-gray-500">
            © {new Date().getFullYear()} Ensemb. Tous droits réservés.
          </p>
        </div>
      </div>
    </footer>
  );
}
