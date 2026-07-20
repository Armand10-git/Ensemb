import Decimal from 'decimal.js';

export type UnitForConversion = {
  /** Opérateur de conversion : "*" (multiplication) ou "/" (division) */
  operator: string;
  /** Facteur de conversion — Decimal obligatoire (§17 point A) */
  operatorValue: Decimal;
};

/**
 * Convertit une quantité dans une unité dérivée en quantité dans son unité de base.
 *
 * Ex : 2 cartons × 12 = 24 pièces  →  convertToBase(new Decimal('2'), { operator: '*', operatorValue: new Decimal('12') }) = 24
 * Ex : 50 cL ÷ 100 = 0.5 L         →  convertToBase(new Decimal('50'), { operator: '/', operatorValue: new Decimal('100') }) = 0.5
 *
 * @param quantity - Quantité dans l'unité dérivée
 * @param unit     - Descripteur de l'unité dérivée (operator + operatorValue)
 * @returns Quantité exprimée dans l'unité de base
 */
export function convertToBase(quantity: Decimal, unit: UnitForConversion): Decimal {
  return unit.operator === '*'
    ? quantity.mul(unit.operatorValue)
    : quantity.div(unit.operatorValue);
}

/**
 * Convertit une quantité en unité de base vers une unité dérivée.
 *
 * Ex : 24 pièces ÷ 12 = 2 cartons  →  convertFromBase(new Decimal('24'), { operator: '*', operatorValue: new Decimal('12') }) = 2
 * Ex : 0.5 L × 100 = 50 cL         →  convertFromBase(new Decimal('0.5'), { operator: '/', operatorValue: new Decimal('100') }) = 50
 *
 * @param quantityInBase - Quantité dans l'unité de base
 * @param unit           - Descripteur de l'unité dérivée (operator + operatorValue)
 * @returns Quantité exprimée dans l'unité dérivée
 */
export function convertFromBase(quantityInBase: Decimal, unit: UnitForConversion): Decimal {
  return unit.operator === '*'
    ? quantityInBase.div(unit.operatorValue)
    : quantityInBase.mul(unit.operatorValue);
}
