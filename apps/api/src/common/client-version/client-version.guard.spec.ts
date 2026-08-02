import { ExecutionContext } from '@nestjs/common';
import { ClientVersionGuard } from './client-version.guard';
import { ClientVersionStaleException } from '../exceptions/domain.exception';
import { validateAppConfig } from '../../config/app-config.schema';

/**
 * Unit tests for the client/server version guard (API Contract Design §1,
 * Step 3.14 rulings B1(a)/B2(a)/B3(a)): exact-match comparison, the
 * missing-header pass, older AND newer clients both stale, whitespace
 * trimming, and the frozen exception shape. A second block covers the
 * schema half of B1(a): APP_VERSION is required, SemVer-formatted, and
 * fail-fast when absent or malformed.
 */
describe('ClientVersionGuard', () => {
  const SERVER_VERSION = '1.2.3';

  const guard = new ClientVersionGuard({ getOrThrow: () => SERVER_VERSION } as never);

  const contextWith = (header?: string | string[]): ExecutionContext =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ headers: header === undefined ? {} : { 'x-client-version': header } }),
      }),
    }) as ExecutionContext;

  it('passes when the header matches the server version exactly', () => {
    expect(guard.canActivate(contextWith('1.2.3'))).toBe(true);
  });

  it('B3(a) — passes when the header is absent (Host polling, Swagger, tooling stay unaffected)', () => {
    expect(guard.canActivate(contextWith())).toBe(true);
  });

  it('rejects an OLDER client version with the frozen 409 CLIENT_VERSION_STALE (D1)', () => {
    try {
      guard.canActivate(contextWith('1.2.2'));
      fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ClientVersionStaleException);
      expect((error as ClientVersionStaleException).code).toBe('CLIENT_VERSION_STALE');
      expect((error as ClientVersionStaleException).httpStatus).toBe(409);
      expect((error as ClientVersionStaleException).details).toBeUndefined(); // D1 — no version disclosure
    }
  });

  it('R2 — rejects a NEWER client version too: any mismatch is stale, refresh always converges', () => {
    expect(() => guard.canActivate(contextWith('9.9.9'))).toThrow(ClientVersionStaleException);
  });

  it('rejects malformed version strings simply because they are not equal (B2(a) — no parsing)', () => {
    expect(() => guard.canActivate(contextWith('latest'))).toThrow(ClientVersionStaleException);
    expect(() => guard.canActivate(contextWith('1.2'))).toThrow(ClientVersionStaleException);
    expect(() => guard.canActivate(contextWith(''))).toThrow(ClientVersionStaleException);
  });

  it('D2 — trims surrounding whitespace before comparing, but never case-folds or strips prefixes', () => {
    expect(guard.canActivate(contextWith('  1.2.3  '))).toBe(true);
    expect(() => guard.canActivate(contextWith('v1.2.3'))).toThrow(ClientVersionStaleException);
  });

  it('tolerates an array-valued header by comparing its first value', () => {
    expect(guard.canActivate(contextWith(['1.2.3']))).toBe(true);
    expect(() => guard.canActivate(contextWith(['1.2.2', '1.2.3']))).toThrow(ClientVersionStaleException);
  });
});

describe('AppConfig APP_VERSION (B1(a))', () => {
  const validRaw = {
    DATABASE_FILE_PATH: '/data/smarttable.db',
    HTTP_PORT: '8080',
    HTTPS_PORT: '8443',
    JWT_SIGNING_KEY: 'key',
    LOG_DIRECTORY: '/logs',
    BACKUP_DIRECTORY: '/backups',
    APP_VERSION: '1.2.3',
  };

  it('accepts a SemVer APP_VERSION', () => {
    expect(validateAppConfig(validRaw).APP_VERSION).toBe('1.2.3');
  });

  it('fails fast when APP_VERSION is missing — the guard can never be silently off (R3)', () => {
    const { APP_VERSION: _omitted, ...raw } = validRaw;
    expect(() => validateAppConfig(raw)).toThrow(/Invalid application configuration/);
  });

  it('fails fast on a non-SemVer APP_VERSION', () => {
    expect(() => validateAppConfig({ ...validRaw, APP_VERSION: 'v1.2' })).toThrow(/APP_VERSION must be a SemVer string/);
    expect(() => validateAppConfig({ ...validRaw, APP_VERSION: '1.2.3.4' })).toThrow(/APP_VERSION must be a SemVer string/);
  });
});
