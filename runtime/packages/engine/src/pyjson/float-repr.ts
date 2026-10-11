// Python `float.__repr__` (design 01 section 1.9, verified bit for bit against CPython in E6).

/** Python's `repr(float)`: shortest round-trip digits, exponent form when `exp < -4 || exp >= 16`, `.0` for integral values. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan';
  if (x === Number.POSITIVE_INFINITY) return 'inf';
  if (x === Number.NEGATIVE_INFINITY) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';

  const [mantissa = '', exponentText = '0'] = x.toExponential().split('e');
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  const exp = Number(exponentText);

  let body: string;
  if (exp < -4 || exp >= 16) {
    const lead = digits.length > 1 ? `${digits.slice(0, 1)}.${digits.slice(1)}` : digits;
    const magnitude = String(Math.abs(exp)).padStart(2, '0');
    body = `${lead}e${exp < 0 ? '-' : '+'}${magnitude}`;
  } else if (exp >= 0) {
    body =
      digits.length <= exp + 1
        ? `${digits}${'0'.repeat(exp + 1 - digits.length)}.0`
        : `${digits.slice(0, exp + 1)}.${digits.slice(exp + 1)}`;
  } else {
    body = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return negative ? `-${body}` : body;
}
