export const units = {
  g: { family: 'mass', toBase: 1 },
  kg: { family: 'mass', toBase: 1_000 },
  ml: { family: 'volume', toBase: 1 },
  L: { family: 'volume', toBase: 1_000 },
  个: { family: 'count', toBase: 1 },
  只: { family: 'count', toBase: 1 },
  枚: { family: 'count', toBase: 1 },
  根: { family: 'count', toBase: 1 },
  片: { family: 'count', toBase: 1 },
  瓣: { family: 'count', toBase: 1 },
  茶匙: { family: 'count', toBase: 1 },
  汤匙: { family: 'count', toBase: 1 },
  少许: { family: 'qualitative', toBase: 1 },
  适量: { family: 'qualitative', toBase: 1 },
} as const;

export type Unit = keyof typeof units;
export type UnitFamily = (typeof units)[Unit]['family'];

const unitAliases: Readonly<Record<string, Unit>> = {
  克: 'g',
  公克: 'g',
  公斤: 'kg',
  千克: 'kg',
  毫升: 'ml',
  升: 'L',
  小勺: '茶匙',
  大勺: '汤匙',
};

export const unitValues = Object.freeze(Object.keys(units) as Unit[]);

export const normalizeUnit = (value: string): Unit | undefined => {
  const normalized = value.normalize('NFKC').trim();
  const alias = unitAliases[normalized];
  if (alias !== undefined) {
    return alias;
  }
  return Object.hasOwn(units, normalized) ? normalized as Unit : undefined;
};

export const requireUnit = (value: string): Unit => {
  const unit = normalizeUnit(value);
  if (unit === undefined) {
    throw new Error('unknown_unit');
  }
  return unit;
};

export const unitFamily = (unit: Unit): UnitFamily => units[unit].family;

export const baseUnitFor = (unit: Unit): Unit => {
  const family = unitFamily(unit);
  if (family === 'mass') {
    return 'g';
  }
  if (family === 'volume') {
    return 'ml';
  }
  return unit;
};

export const canConvertUnit = (from: Unit, to: Unit): boolean => {
  const fromFamily = unitFamily(from);
  const toFamily = unitFamily(to);
  if (fromFamily !== toFamily) {
    return false;
  }
  return fromFamily === 'mass'
    || fromFamily === 'volume'
    || from === to;
};

export const convertUnit = (
  quantity: number,
  fromInput: string,
  toInput: string,
): number => {
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('invalid_quantity');
  }
  const from = requireUnit(fromInput);
  const to = requireUnit(toInput);
  if (!canConvertUnit(from, to)) {
    throw new Error('incompatible_unit_family');
  }
  return quantity * units[from].toBase / units[to].toBase;
};

export const toBaseQuantity = (
  quantity: number,
  unitInput: string,
): { readonly quantity: number; readonly unit: Unit } => {
  const unit = requireUnit(unitInput);
  const baseUnit = baseUnitFor(unit);
  return {
    quantity: convertUnit(quantity, unit, baseUnit),
    unit: baseUnit,
  };
};

const round = (value: number, decimalPlaces: number): number => {
  const factor = 10 ** decimalPlaces;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

export const roundDisplayQuantity = (
  quantity: number,
  unit: Unit,
  category: 'produce' | 'meat_egg_dairy' | 'staple' | 'seasoning' | 'other',
): number => {
  const decimals = category === 'seasoning'
    && (unit === 'g' || unit === 'ml')
    && quantity < 1
    ? 2
    : 1;
  return round(quantity, decimals);
};

export const toDisplayQuantity = (
  baseQuantity: number,
  baseUnit: Unit,
  category: 'produce' | 'meat_egg_dairy' | 'staple' | 'seasoning' | 'other',
): { readonly quantity: number; readonly unit: Unit } => {
  const displayUnit: Unit = baseUnit === 'g' && baseQuantity >= 1_000
    ? 'kg'
    : baseUnit === 'ml' && baseQuantity >= 1_000
      ? 'L'
      : baseUnit;
  const converted = displayUnit === baseUnit
    ? baseQuantity
    : convertUnit(baseQuantity, baseUnit, displayUnit);
  return {
    quantity: roundDisplayQuantity(converted, displayUnit, category),
    unit: displayUnit,
  };
};
