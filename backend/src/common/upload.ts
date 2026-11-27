import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import { env } from '../config/env';
import { ValidationError } from './errors';

const ALLOWED_MIME_EXTENSIONS: Record<string, string[]> = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'image/webp': ['.webp'],
  'application/pdf': ['.pdf'],
  'text/csv': ['.csv'],
  'application/json': ['.json'],
};

function matchesMagicBytes(mime: string, buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  if (mime === 'image/png') {
    return buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  }
  if (mime === 'image/jpeg') {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mime === 'application/pdf') {
    return buffer.subarray(0, 4).toString('ascii') === '%PDF';
  }
  if (mime === 'text/csv' || mime === 'application/json') {
    // Reject binary null bytes in text feeds
    return !buffer.subarray(0, 512).includes(0x00);
  }
  return false;
}

export const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.MAX_UPLOAD_SIZE_BYTES,
    files: 1,
  },
});

export interface StoredFileMetadata {
  originalName: string;
  storageKey: string;
  mimeType: string;
  fileSizeBytes: number;
  checksumSha256: string;
}

export async function validateAndPersistSandboxUpload(
  file: Express.Multer.File,
  folder: 'onboarding' | 'products' | 'returns' | 'feeds',
  allowedMimes: string[],
): Promise<StoredFileMetadata> {
  if (!file) {
    throw new ValidationError('No file provided', [], 'FILE_REQUIRED');
  }
  if (!allowedMimes.includes(file.mimetype)) {
    throw new ValidationError(`Unsupported MIME type: ${file.mimetype}`, [], 'UNSUPPORTED_MIME_TYPE');
  }

  const ext = path.extname(file.originalname).toLowerCase();
  const validExts = ALLOWED_MIME_EXTENSIONS[file.mimetype] ?? [];
  if (!validExts.includes(ext)) {
    throw new ValidationError(
      `File extension ${ext || '(none)'} does not match MIME type ${file.mimetype}`,
      [],
      'INVALID_FILE_EXTENSION',
    );
  }

  if (file.size <= 0 || file.size > env.MAX_UPLOAD_SIZE_BYTES) {
    throw new ValidationError(
      `File size must be between 1 byte and ${env.MAX_UPLOAD_SIZE_BYTES} bytes`,
      [],
      'INVALID_FILE_SIZE',
    );
  }

  if (!matchesMagicBytes(file.mimetype, file.buffer)) {
    throw new ValidationError('File binary signature does not match declared MIME type', [], 'INVALID_FILE_SIGNATURE');
  }

  const checksumSha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const safeFileName = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  const storageKey = `${folder}/${safeFileName}`;

  const baseDir = path.resolve(process.cwd(), env.UPLOAD_STORAGE_DIR);
  const targetPath = path.resolve(baseDir, storageKey);
  if (!targetPath.startsWith(baseDir + path.sep)) {
    throw new ValidationError('Invalid upload path', [], 'INVALID_UPLOAD_PATH');
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, file.buffer);

  return {
    originalName: path.basename(file.originalname),
    storageKey,
    mimeType: file.mimetype,
    fileSizeBytes: file.size,
    checksumSha256,
  };
}
