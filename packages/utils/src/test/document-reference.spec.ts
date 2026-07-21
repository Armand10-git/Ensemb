import { formatReference } from '../document-reference';

describe('formatReference', () => {
  it('SALE counter=1 → VTE-2026-000001', () => {
    expect(formatReference('SALE', 2026, 1)).toBe('VTE-2026-000001');
  });

  it('PURCHASE counter=42 → ACH-2026-000042', () => {
    expect(formatReference('PURCHASE', 2026, 42)).toBe('ACH-2026-000042');
  });

  it('counter=999999 → 6 chiffres sans troncature', () => {
    expect(formatReference('SALE', 2026, 999999)).toBe('VTE-2026-999999');
  });

  it('counter=1000000 → 7 chiffres (pas de troncature)', () => {
    expect(formatReference('SALE', 2026, 1000000)).toBe('VTE-2026-1000000');
  });

  it('tous les préfixes sont corrects', () => {
    expect(formatReference('QUOTATION',      2026, 1)).toBe('DEV-2026-000001');
    expect(formatReference('SALE_RETURN',    2026, 1)).toBe('RVT-2026-000001');
    expect(formatReference('PURCHASE_RETURN',2026, 1)).toBe('RAC-2026-000001');
    expect(formatReference('TRANSFER',       2026, 1)).toBe('TRF-2026-000001');
    expect(formatReference('ADJUSTMENT',     2026, 1)).toBe('AJT-2026-000001');
  });
});
