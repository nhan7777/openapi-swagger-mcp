import { describe, expect, test } from 'vitest';
import { fold, truncateCodePoints } from '../../src/search/text.js';

describe('fold', () => {
  test('removes accents from Latin letters, including Vietnamese and d-stroke', () => {
    expect(fold('Đơn hàng')).toBe('don hang');
    expect(fold('Cộng hòa')).toBe('cong hoa');
  });

  test('keeps marks that carry meaning in other scripts', () => {
    expect(fold('が')).not.toBe(fold('か'));
    expect(fold('ガ')).not.toBe(fold('カ'));
    expect(fold('й')).not.toBe(fold('и'));
    expect(fold('กิน')).toBe('กิน');
  });

  test('compatibility forms meet their plain form', () => {
    expect(fold('ＯｒｄｅｒＩＤ')).toBe(fold('OrderID'));
  });
});

describe('truncateCodePoints', () => {
  test('never splits a surrogate pair', () => {
    expect(truncateCodePoints('a😀b', 2)).toBe('a😀');
  });
});
