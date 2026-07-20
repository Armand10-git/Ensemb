import Decimal from 'decimal.js';
import { convertToBase, convertFromBase } from '../unit-conversion';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const CARTON = { operator: '*', operatorValue: new Decimal('12') };  // 1 carton = 12 pièces
const CENTILITRE = { operator: '/', operatorValue: new Decimal('100') }; // 100 cL = 1 L
const BASE_UNIT = { operator: '*', operatorValue: new Decimal('1') }; // unité de base neutre

// ─── convertToBase ───────────────────────────────────────────────────────────

describe('convertToBase', () => {
  it('opérateur * : 2 cartons × 12 = 24 pièces', () => {
    const result = convertToBase(new Decimal('2'), CARTON);
    expect(result.equals(new Decimal('24'))).toBe(true);
  });

  it('opérateur / : 50 cL ÷ 100 = 0.5 L', () => {
    const result = convertToBase(new Decimal('50'), CENTILITRE);
    expect(result.equals(new Decimal('0.5'))).toBe(true);
  });

  it('unité de base (operatorValue: 1, operator: *) → résultat identique à la quantité', () => {
    const qty = new Decimal('7.5');
    const result = convertToBase(qty, BASE_UNIT);
    expect(result.equals(qty)).toBe(true);
  });

  it('valeur non entière : 1.5 cartons × 12 = 18', () => {
    const result = convertToBase(new Decimal('1.5'), CARTON);
    expect(result.equals(new Decimal('18'))).toBe(true);
  });

  it('résultat Decimal exact — pas de dérive floating-point', () => {
    // 0.1 + 0.2 = 0.30000000000000004 en float — doit être 0.3 avec Decimal
    const unit = { operator: '*', operatorValue: new Decimal('3') };
    const result = convertToBase(new Decimal('0.1'), unit);
    expect(result.toFixed(1)).toBe('0.3');
  });
});

// ─── convertFromBase ─────────────────────────────────────────────────────────

describe('convertFromBase', () => {
  it('opérateur * : 24 pièces ÷ 12 = 2 cartons', () => {
    const result = convertFromBase(new Decimal('24'), CARTON);
    expect(result.equals(new Decimal('2'))).toBe(true);
  });

  it('opérateur / : 0.5 L × 100 = 50 cL', () => {
    const result = convertFromBase(new Decimal('0.5'), CENTILITRE);
    expect(result.equals(new Decimal('50'))).toBe(true);
  });

  it('unité de base (operatorValue: 1, operator: *) → résultat identique à la quantité', () => {
    const qty = new Decimal('42');
    const result = convertFromBase(qty, BASE_UNIT);
    expect(result.equals(qty)).toBe(true);
  });

  it('aller-retour : convertFromBase(convertToBase(q)) = q', () => {
    const qty = new Decimal('3.5');
    const inBase = convertToBase(qty, CARTON);
    const back = convertFromBase(inBase, CARTON);
    expect(back.equals(qty)).toBe(true);
  });
});
