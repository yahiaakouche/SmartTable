import { ConfigService } from '@nestjs/config';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import sharp from 'sharp';
import { ImageStorageService } from './image-storage.service';
import { EntityNotFoundException, InvalidFileUploadException } from '../../common/exceptions/domain.exception';

/**
 * Unit tests for the Security Architecture §6 upload pipeline — content
 * sniffing (never extension trust), format allow-list with SVG rejected,
 * size ceiling, and MANDATORY re-encoding that strips smuggled payloads.
 * Uses real temp directories (fast, disposable) but never a database.
 */
describe('ImageStorageService', () => {
  let service: ImageStorageService;
  let uploadDir: string;
  let maxSize: number;

  const makeValidPng = () => sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
  const makeValidWebp = () =>
    sharp({ create: { width: 4, height: 4, channels: 3, background: '#996633' } }).webp().toBuffer();

  beforeEach(() => {
    uploadDir = mkdtempSync(path.join(tmpdir(), 'smarttable-uploads-'));
    maxSize = 1024 * 1024; // 1 MB test ceiling
    const config = {
      get: jest.fn((key: string, fallback: unknown) =>
        key === 'UPLOAD_DIRECTORY' ? uploadDir : key === 'UPLOAD_MAX_FILE_SIZE_BYTES' ? maxSize : fallback,
      ),
    } as unknown as ConfigService;
    service = new ImageStorageService(config);
  });

  it('accepts a valid PNG, re-encodes it, and stores it under a generated name', async () => {
    const png = await makeValidPng();
    const filename = await service.validateAndStore(png);

    expect(filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    const stored = await service.readStored(filename);
    expect(stored.contentType).toBe('image/png');
    // the stored bytes are decodable and really are PNG
    const meta = await sharp(stored.buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(4);
  });

  it('accepts WebP and preserves its format through re-encoding', async () => {
    const filename = await service.validateAndStore(await makeValidWebp());
    expect(filename).toMatch(/\.webp$/);
  });

  it('strips payload smuggled behind valid image bytes (mandatory re-encode)', async () => {
    const trailer = Buffer.from('<?php evil(); ?>');
    const boobyTrapped = Buffer.concat([await makeValidPng(), trailer]);

    const filename = await service.validateAndStore(boobyTrapped);
    const stored = await service.readStored(filename);

    expect(stored.buffer.includes(trailer)).toBe(false);
  });

  it('rejects SVG outright (stored-XSS vector, Security §6)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    await expect(service.validateAndStore(svg)).rejects.toBeInstanceOf(InvalidFileUploadException);
  });

  it('rejects random bytes and empty files', async () => {
    await expect(service.validateAndStore(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(
      InvalidFileUploadException,
    );
    await expect(service.validateAndStore(Buffer.alloc(0))).rejects.toBeInstanceOf(InvalidFileUploadException);
  });

  it('rejects content with a forged magic header that fails to decode', async () => {
    const forged = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
    await expect(service.validateAndStore(forged)).rejects.toBeInstanceOf(InvalidFileUploadException);
  });

  it('enforces the configured size ceiling', async () => {
    const png = await makeValidPng();
    maxSize = png.length - 1; // shrink ceiling below the real file
    await expect(service.validateAndStore(png)).rejects.toBeInstanceOf(InvalidFileUploadException);
  });

  it('refuses path traversal on the read path', async () => {
    await expect(service.readStored('../../etc/passwd')).rejects.toBeInstanceOf(InvalidFileUploadException);
    await expect(service.readStored('../../../../../../etc/shadow')).rejects.toBeInstanceOf(
      InvalidFileUploadException,
    );
  });

  it('reports a missing in-directory file as NOT_FOUND (no existence oracle leak)', async () => {
    await expect(service.readStored('00000000-0000-0000-0000-000000000000.png')).rejects.toBeInstanceOf(
      EntityNotFoundException,
    );
  });

  it('deleteStored tolerates an already-missing file (documented no-op)', async () => {
    await expect(service.deleteStored('00000000-0000-0000-0000-000000000000.png')).resolves.toBeUndefined();
    expect(existsSync(uploadDir)).toBe(true);
  });
});
