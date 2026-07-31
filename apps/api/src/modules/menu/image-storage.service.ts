import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v7 as uuidv7 } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import sharp from 'sharp';
import { EntityNotFoundException, InvalidFileUploadException } from '../../common/exceptions/domain.exception';

type AllowedFormat = 'png' | 'jpeg' | 'webp';

/** Magic-number byte signatures — content-based validation, never
 * extension/MIME trust (Security Architecture §6). */
const SIGNATURES: Array<{ format: AllowedFormat; matches: (b: Buffer) => boolean }> = [
  {
    format: 'png',
    matches: (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  { format: 'jpeg', matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    format: 'webp',
    matches: (b) =>
      b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
];

/**
 * Secure image pipeline (Security Architecture §6):
 *   size ceiling → magic-byte sniffing against a PNG/JPEG/WebP allow-list
 *   (SVG is implicitly rejected — it has no binary signature here and is an
 *   explicit stored-XSS vector) → MANDATORY server-side re-encode, so no
 *   smuggled payload can survive inside an otherwise-valid container →
 *   storage under a random, non-user-controlled filename.
 *
 * Sharp is used strictly as an implementation-detail library for validation
 * and re-encoding (Step 3.2 ruling R3) — it changes no frozen decision.
 */
@Injectable()
export class ImageStorageService {
  constructor(private readonly config: ConfigService) {}

  private get uploadDirectory(): string {
    return this.config.get<string>('UPLOAD_DIRECTORY', 'uploads');
  }

  private get maxFileSizeBytes(): number {
    return this.config.get<number>('UPLOAD_MAX_FILE_SIZE_BYTES', 5 * 1024 * 1024);
  }

  /** Validates + re-encodes + stores one upload. Returns the generated
   * filename to persist in `image_path`. Throws InvalidFileUploadException
   * on any rejection. */
  async validateAndStore(buffer: Buffer): Promise<string> {
    if (buffer.length === 0) {
      throw new InvalidFileUploadException('file is empty');
    }
    if (buffer.length > this.maxFileSizeBytes) {
      throw new InvalidFileUploadException(`file exceeds the ${this.maxFileSizeBytes}-byte size limit`);
    }

    const detected = SIGNATURES.find((s) => s.matches(buffer));
    if (!detected) {
      throw new InvalidFileUploadException('content is not a PNG, JPEG, or WebP image');
    }

    // Mandatory re-encode — the stored bytes are produced entirely by our
    // encoder from decoded pixel data, never copied from the upload.
    let reencoded: Buffer;
    try {
      reencoded = await sharp(buffer).toFormat(detected.format).toBuffer();
    } catch {
      throw new InvalidFileUploadException('content could not be decoded as a valid image');
    }

    const filename = `${uuidv7()}.${detected.format === 'jpeg' ? 'jpg' : detected.format}`;
    await fs.mkdir(this.uploadDirectory, { recursive: true });
    await fs.writeFile(this.absolutePath(filename), reencoded);
    return filename;
  }

  /** Read-side for the static serving endpoint. The filename has already
   * passed strict shape validation in the controller; this resolves it
   * inside the upload directory and refuses anything that escapes. */
  async readStored(filename: string): Promise<{ buffer: Buffer; contentType: string }> {
    const absolute = this.absolutePath(filename);
    let buffer: Buffer;
    try {
      buffer = await fs.readFile(absolute);
    } catch {
      throw new EntityNotFoundException('upload', filename);
    }
    const ext = path.extname(filename).toLowerCase();
    const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { buffer, contentType };
  }

  /** Cleanup on product deletion / image replacement. */
  async deleteStored(filename: string): Promise<void> {
    try {
      await fs.unlink(this.absolutePath(filename));
    } catch {
      // Intentional no-op (Engineering Standards §7, documented): the file may
      // already be gone (manual cleanup, failed earlier attempt). The business
      // operation must not fail over an orphaned file; the Host's disk-space
      // health check is the backstop for orphaned storage.
    }
  }

  private absolutePath(filename: string): string {
    const root = path.resolve(this.uploadDirectory);
    const resolved = path.resolve(root, filename);
    if (!resolved.startsWith(root + path.sep)) {
      // Path traversal attempt — the controller's filename regex makes this
      // unreachable in practice; this is the structural backstop.
      throw new InvalidFileUploadException('invalid file name');
    }
    return resolved;
  }
}
