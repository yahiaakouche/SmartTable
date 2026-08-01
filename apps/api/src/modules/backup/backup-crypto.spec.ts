import { BackupDecryptionError, decryptBackup, encryptBackup, isEncryptedBackup } from './backup-crypto';

/**
 * Unit tests for the versioned AES-256-GCM + scrypt export container
 * (Step 3.9 ruling B4(a), format D11) — the format the future Host-phase
 * restore path will consume, so its guarantees are pinned here.
 */
describe('backup-crypto', () => {
  const plaintext = Buffer.from('SQLite format 3\0 — fake snapshot bytes, stand-in for a real VACUUM INTO artifact');
  const passphrase = 'correct horse battery staple';

  it('round-trips: encrypt then decrypt returns the exact plaintext', () => {
    const container = encryptBackup(plaintext, passphrase);
    expect(decryptBackup(container, passphrase)).toEqual(plaintext);
  });

  it('writes the versioned header: STB1 magic + format version 0x01', () => {
    const container = encryptBackup(plaintext, passphrase);
    expect(container.subarray(0, 4).toString('ascii')).toBe('STB1');
    expect(container[4]).toBe(0x01);
    expect(isEncryptedBackup(container)).toBe(true);
    expect(isEncryptedBackup(plaintext)).toBe(false);
  });

  it('never reuses salt/nonce: two exports of the same plaintext differ', () => {
    expect(encryptBackup(plaintext, passphrase).equals(encryptBackup(plaintext, passphrase))).toBe(false);
  });

  it('leaks nothing: the ciphertext contains no plaintext substring', () => {
    const container = encryptBackup(plaintext, passphrase);
    expect(container.includes(Buffer.from('fake snapshot bytes'))).toBe(false);
  });

  it('rejects a wrong passphrase (GCM auth tag, never silent corruption)', () => {
    const container = encryptBackup(plaintext, passphrase);
    expect(() => decryptBackup(container, 'wrong passphrase')).toThrow(BackupDecryptionError);
  });

  it('rejects tampering anywhere in the container', () => {
    const container = encryptBackup(plaintext, passphrase);
    const tampered = Buffer.from(container);
    tampered[tampered.length - 20] ^= 0xff;
    expect(() => decryptBackup(tampered, passphrase)).toThrow(BackupDecryptionError);
  });

  it('rejects truncation, a bad magic, and an unsupported format version', () => {
    const container = encryptBackup(plaintext, passphrase);
    expect(() => decryptBackup(container.subarray(0, 20), passphrase)).toThrow(BackupDecryptionError);
    expect(() => decryptBackup(plaintext, passphrase)).toThrow(/magic/);

    const futureVersion = Buffer.from(container);
    futureVersion[4] = 0x99;
    expect(() => decryptBackup(futureVersion, passphrase)).toThrow(/version/i);
  });

  it('handles an empty plaintext (a degenerate but legal snapshot)', () => {
    const container = encryptBackup(Buffer.alloc(0), passphrase);
    expect(decryptBackup(container, passphrase)).toEqual(Buffer.alloc(0));
  });
});
