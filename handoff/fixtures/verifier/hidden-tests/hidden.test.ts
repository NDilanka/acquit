import { it, expect } from 'vitest';
import { formatTotal } from '../src/money';
it('KWD different amount', () => {
  expect(formatTotal([{ amount: 1.234 }], 'KWD')).toBe('1.234');
});
it('BHD three decimals', () => {
  expect(formatTotal([{ amount: 2.345 }], 'BHD')).toBe('2.345');
});
it('OMR three decimals', () => {
  expect(formatTotal([{ amount: 7.891 }], 'OMR')).toBe('7.891');
});
it('JOD three decimals', () => {
  expect(formatTotal([{ amount: 4.567 }], 'JOD')).toBe('4.567');
});
it('KWD multiple lines', () => {
  expect(formatTotal([{ amount: 10 }, { amount: 0.625 }], 'KWD')).toBe('10.625');
});
it('JPY zero decimals', () => {
  expect(formatTotal([{ amount: 10.125 }], 'JPY')).toBe('10');
});
