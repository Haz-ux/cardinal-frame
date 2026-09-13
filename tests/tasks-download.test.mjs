// L4: Content-Disposition filename sanitization on /files/:id/download.
// The route reflects the stored original_name into the header; the name
// must be header-safe (basename + no quotes/backslashes/line breaks),
// same treatment as chat-conversations.mjs.
import { describe, it, expect } from 'vitest';
import { sanitizeDownloadFilename } from '../src/server/routes/tasks.mjs';

describe('sanitizeDownloadFilename (L4)', () => {
  it('strips quotes, backslashes and line breaks', () => {
    expect(sanitizeDownloadFilename('a"b\\c\r\nd.txt')).toBe('abcd.txt');
  });

  it('reduces traversal attempts to a bare name', () => {
    expect(sanitizeDownloadFilename('../../etc/passwd')).toBe('passwd');
  });

  it('yields a header-safe value for a hostile name', () => {
    const name = sanitizeDownloadFilename('evil"; filename*=UTF-8\'\'x\r\nInjected: 1');
    expect(name).not.toMatch(/["\\\r\n]/);
    const header = `attachment; filename="${name}"`;
    // No embedded quote/CR/LF means the header cannot break out.
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('"').length).toBe(3); // exactly the wrapping quotes
  });

  it('keeps ordinary filenames intact', () => {
    expect(sanitizeDownloadFilename('report (final).pdf')).toBe('report (final).pdf');
  });

  it('falls back to a default for empty input', () => {
    expect(sanitizeDownloadFilename('')).toBe('download');
    expect(sanitizeDownloadFilename(null)).toBe('download');
  });
});
