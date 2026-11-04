import { describe, expect, it } from 'vitest';
import { PermanentError, classifyError } from './classify-error.js';

const withCode = (code: string) => Object.assign(new Error(`failed with ${code}`), { code });

describe('classifyError', () => {
  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EPIPE',
    'ENOTFOUND',
    'EAI_AGAIN',
    '08006', // connection failure
    '08001', // unable to connect
    '57P01', // admin shutdown
    '57P02', // crash shutdown
    '57P03', // cannot connect now
    '57014', // statement timeout / query canceled
    '40001', // serialization failure
    '40P01', // deadlock
    '53300', // too many connections
    '55P03', // lock not available
    '25006', // read-only transaction (failover)
  ])('treats %s as transient', (code) => {
    expect(classifyError(withCode(code))).toBe('transient');
  });

  it.each([
    '22P02', // invalid text representation
    '22003', // numeric out of range
    '23502', // not null violation
    '23514', // check violation
    '23505', // unique violation on another constraint
    '42P01', // undefined table
    '42703', // undefined column
  ])('treats %s as permanent', (code) => {
    expect(classifyError(withCode(code))).toBe('permanent');
  });

  it('treats PermanentError as permanent', () => {
    expect(classifyError(new PermanentError('bad data'))).toBe('permanent');
  });

  it.each([
    ['plain Error', new Error('Connection terminated unexpectedly')],
    ['unknown SQLSTATE class', withCode('XX000')],
    ['non-string code', Object.assign(new Error('x'), { code: 42 })],
    ['string', 'boom'],
    ['null', null],
    ['undefined', undefined],
  ])('defaults %s to transient (retries are bounded)', (_label, err) => {
    expect(classifyError(err)).toBe('transient');
  });
});
