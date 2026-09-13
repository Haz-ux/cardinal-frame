import { describe, it, expect } from 'vitest';
import { parseCompressArgs, tokenizeArgs } from '../src/server/routes/aimi.mjs';

describe('tokenizeArgs', () => {
  it('splits on whitespace', () => {
    expect(tokenizeArgs('a b  c')).toEqual(['a', 'b', 'c']);
  });
  it('honors double and single quotes', () => {
    expect(tokenizeArgs('--category "my notes" text')).toEqual(['--category', 'my notes', 'text']);
    expect(tokenizeArgs("--category 'my notes'")).toEqual(['--category', 'my notes']);
  });
  it('handles escaped quotes inside double quotes', () => {
    expect(tokenizeArgs('"a\\"b"')).toEqual(['a"b']);
  });
});

describe('parseCompressArgs', () => {
  it('parses plain payload with defaults', () => {
    const r = parseCompressArgs('hello world');
    expect(r.ok).toBe(true);
    expect(r.payload).toBe('hello world');
    expect(r.strategy).toBe('auto');
    expect(r.category).toBe('compressed-context');
    expect(r.storeInMemory).toBe(true);
    expect(r.usePrevious).toBe(false);
  });
  it('accepts flags in any order, before/after/interleaved', () => {
    const variants = [
      '--strategy dedupe --category ops --no-memory --continue some text here',
      'some text here --strategy dedupe --category ops --no-memory --continue',
      '--no-memory some --strategy dedupe text --category ops here --continue',
      '--continue --no-memory --category ops --strategy dedupe some text here',
    ];
    for (const v of variants) {
      const r = parseCompressArgs(v);
      expect(r.ok).toBe(true);
      expect(r.strategy).toBe('dedupe');
      expect(r.category).toBe('ops');
      expect(r.storeInMemory).toBe(false);
      expect(r.usePrevious).toBe(true);
      expect(r.payload).toBe('some text here');
    }
  });
  it('supports --flag=value form', () => {
    const r = parseCompressArgs('--strategy=headtail --category=ops payload text');
    expect(r.ok).toBe(true);
    expect(r.strategy).toBe('headtail');
    expect(r.category).toBe('ops');
    expect(r.payload).toBe('payload text');
  });
  it('supports quoted multi-word values', () => {
    const r = parseCompressArgs('--category "my notes" payload');
    expect(r.ok).toBe(true);
    expect(r.category).toBe('my notes');
    expect(r.payload).toBe('payload');
  });
  it('honors -- as end of flags', () => {
    const r = parseCompressArgs('--no-memory -- --strategy is literal text');
    expect(r.ok).toBe(true);
    expect(r.storeInMemory).toBe(false);
    expect(r.payload).toBe('--strategy is literal text');
  });
  it('rejects unknown flags loudly', () => {
    const r = parseCompressArgs('--bogus payload');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown flag/);
  });
  it('rejects invalid strategy', () => {
    const r = parseCompressArgs('--strategy frobnicate payload');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Unknown strategy/);
  });
  it('rejects missing flag values', () => {
    expect(parseCompressArgs('--strategy').ok).toBe(false);
    expect(parseCompressArgs('--category --no-memory x').ok).toBe(false);
    expect(parseCompressArgs('--strategy= x').ok).toBe(false);
  });
  it('reports empty payload', () => {
    const r = parseCompressArgs('--no-memory');
    expect(r.ok).toBe(true);
    expect(r.payload).toBe('');
  });
  it('a lone -- is literal text, not a flag', () => {
    const r = parseCompressArgs('a -- b');
    expect(r.ok).toBe(true);
    expect(r.payload).toBe('a b');
  });
});
