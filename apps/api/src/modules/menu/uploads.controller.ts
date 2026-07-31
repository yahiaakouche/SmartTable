import { Controller, Get, Header, Param, StreamableFile } from '@nestjs/common';
import { ImageStorageService } from './image-storage.service';
import { Public } from '../auth/decorators/public.decorator';
import { InvalidFileUploadException } from '../../common/exceptions/domain.exception';

/** Generated filenames are UUIDv7 + a fixed image extension — anything else
 * is rejected before it ever reaches the filesystem (path-traversal wall;
 * the service re-validates structurally as a second layer). */
const SAFE_FILENAME = /^[0-9a-f-]{36}\.(png|jpg|webp)$/;

/**
 * Read-only serving of re-encoded uploads (Database Schema Design §1/§4:
 * `image_path`/`logo_path` are "local file paths served statically").
 * Public because the customer QR menu displays product images without
 * authentication; the content is non-sensitive by design — every byte
 * served here was produced by our own re-encoder (Security §6).
 */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly imageStorage: ImageStorageService) {}

  @Public()
  @Get(':filename')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(@Param('filename') filename: string): Promise<StreamableFile> {
    if (!SAFE_FILENAME.test(filename)) {
      throw new InvalidFileUploadException('invalid file name');
    }
    const { buffer, contentType } = await this.imageStorage.readStored(filename);
    return new StreamableFile(buffer, { type: contentType });
  }
}
