import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

/**
 * Optional passphrase encryption for backup exports — Step 3.9 ruling B4(a),
 * Security Architecture §4: the backup file is the one artifact that
 * routinely LEAVES the protected machine (USB drive, personal storage), so
 * the export path — never the live database — carries encryption.
 *
 * Versioned container format (D11), binary layout:
 *   [0..3]   magic 'STB1' — identifies an encrypted SmartTable backup
 *   [4]      format version (0x01)
 *   [5..20]  scrypt salt (16 bytes, random per export)
 *   [21..32] AES-GCM nonce (12 bytes, random per export)
 *   [33..]   AES-256-GCM ciphertext, with the 16-byte auth tag appended
 * Key = scrypt(passphrase, salt, 32). node:crypto only — no new dependency.
 *
 * The version byte is the forward seam: the future Host-phase restore path
 * reads it first, so the format can evolve without ambiguity. Verification
 * (Backup & Resilience §2) always runs on the PLAINTEXT snapshot before
 * encryption — encryption never weakens the verify-then-trust sequence.
 */

const MAGIC = Buffer.from('STB1', 'ascii');
const FORMAT_VERSION = 0x01;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;

export class BackupDecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupDecryptionError';
  }
}

export function isEncryptedBackup(payload: Buffer): boolean {
  return payload.length >= MAGIC.length && payload.subarray(0, MAGIC.length).equals(MAGIC);
}

export function encryptBackup(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = scryptSync(passphrase, salt, KEY_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, nonce, ciphertext, tag]);
}

/** Auth-decrypts a container produced by encryptBackup. Any mismatch —
 * magic, unsupported version, truncation, wrong passphrase, tampering —
 * throws BackupDecryptionError; GCM's auth tag makes silent corruption
 * structurally impossible. */
export function decryptBackup(payload: Buffer, passphrase: string): Buffer {
  const headerBytes = MAGIC.length + 1 + SALT_BYTES + NONCE_BYTES;
  if (!isEncryptedBackup(payload)) {
    throw new BackupDecryptionError('Not an encrypted SmartTable backup (missing magic header).');
  }
  if (payload.length < headerBytes + 16) {
    throw new BackupDecryptionError('Encrypted backup is truncated.');
  }
  const version = payload[MAGIC.length];
  if (version !== FORMAT_VERSION) {
    throw new BackupDecryptionError(`Unsupported backup encryption format version: ${version}.`);
  }
  const salt = payload.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const nonce = payload.subarray(MAGIC.length + 1 + SALT_BYTES, headerBytes);
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(headerBytes, payload.length - 16);

  const key = scryptSync(passphrase, salt, KEY_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new BackupDecryptionError('Decryption failed — wrong passphrase or corrupted file.');
  }
}
