import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FindOrgForm, isValidSubdomain } from '../FindOrgForm';

// --- tests unitaires de la regex ---

describe('isValidSubdomain', () => {
  it('accepte un identifiant simple', () => {
    expect(isValidSubdomain('boutique-durand')).toBe(true);
  });

  it('accepte un identifiant d\'un seul caractère', () => {
    expect(isValidSubdomain('a')).toBe(true);
  });

  it('accepte chiffres et tirets valides', () => {
    expect(isValidSubdomain('shop123')).toBe(true);
  });

  it('refuse les majuscules', () => {
    expect(isValidSubdomain('Boutique')).toBe(false);
  });

  it('refuse les tirets consécutifs', () => {
    expect(isValidSubdomain('boutique--durand')).toBe(false);
  });

  it('refuse un début par tiret', () => {
    expect(isValidSubdomain('-boutique')).toBe(false);
  });

  it('refuse une fin par tiret', () => {
    expect(isValidSubdomain('boutique-')).toBe(false);
  });

  it('refuse une chaîne vide', () => {
    expect(isValidSubdomain('')).toBe(false);
  });
});

// --- tests composant ---

describe('FindOrgForm', () => {
  const user = userEvent.setup();

  beforeEach(() => {
    // Réinitialise window.location.href avant chaque test
    Object.defineProperty(window, 'location', {
      value: { href: '' },
      writable: true,
    });
  });

  it('affiche le champ et le bouton désactivé quand le champ est vide', () => {
    render(<FindOrgForm />);
    expect(screen.getByRole('button', { name: 'Accéder' })).toBeDisabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('active le bouton pour un identifiant valide', async () => {
    render(<FindOrgForm />);
    await user.type(screen.getByRole('textbox'), 'boutique-durand');
    expect(screen.getByRole('button', { name: 'Accéder' })).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('affiche l\'erreur et désactive le bouton pour un identifiant avec majuscule', async () => {
    render(<FindOrgForm />);
    await user.type(screen.getByRole('textbox'), 'Boutique');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accéder' })).toBeDisabled();
  });

  it('affiche l\'erreur et désactive le bouton pour des tirets consécutifs', async () => {
    render(<FindOrgForm />);
    await user.type(screen.getByRole('textbox'), 'boutique--durand');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accéder' })).toBeDisabled();
  });

  it('affiche l\'erreur et désactive le bouton pour un tiret initial', async () => {
    render(<FindOrgForm />);
    await user.type(screen.getByRole('textbox'), '-boutique');
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accéder' })).toBeDisabled();
  });

  it('redirige vers le bon sous-domaine à la soumission', async () => {
    render(<FindOrgForm />);
    await user.type(screen.getByRole('textbox'), 'boutique-durand');
    await user.click(screen.getByRole('button', { name: 'Accéder' }));
    expect(window.location.href).toBe('https://boutique-durand.monapp.com/login');
  });

  it('ne redirige pas si le champ est vide', async () => {
    render(<FindOrgForm />);
    // Le bouton est désactivé, pas de soumission possible
    const button = screen.getByRole('button', { name: 'Accéder' });
    expect(button).toBeDisabled();
    expect(window.location.href).toBe('');
  });

  it('le champ a un label accessible', () => {
    render(<FindOrgForm />);
    expect(
      screen.getByLabelText('Identifiant de votre organisation'),
    ).toBeInTheDocument();
  });
});
