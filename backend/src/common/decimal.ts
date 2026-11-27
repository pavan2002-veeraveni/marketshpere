import Decimal from 'decimal.js';

Decimal.set({
  precision: 24,
  rounding: Decimal.ROUND_HALF_UP,
});

export type MoneyInput = Decimal.Value;

export function money(value: MoneyInput): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function rate(value: MoneyInput): Decimal {
  return new Decimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

export function addMoney(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(new Decimal(v)), new Decimal(0)).toDecimalPlaces(2);
}

export function subMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return new Decimal(a).minus(new Decimal(b)).toDecimalPlaces(2);
}

export function mulMoney(amount: MoneyInput, factor: MoneyInput): Decimal {
  return new Decimal(amount).times(new Decimal(factor)).toDecimalPlaces(2);
}

export function minMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return (da.lessThan(db) ? da : db).toDecimalPlaces(2);
}

export function maxMoney(a: MoneyInput, b: MoneyInput): Decimal {
  const da = new Decimal(a);
  const db = new Decimal(b);
  return (da.greaterThan(db) ? da : db).toDecimalPlaces(2);
}

export function toMoneyString(value: MoneyInput): string {
  return money(value).toFixed(2);
}

export { Decimal };
