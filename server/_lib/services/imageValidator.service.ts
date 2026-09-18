export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Mime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ValidatorError extends Error {
  code: 'INVALID_FILE' | 'FILE_TOO_LARGE';
}

export const imageValidator = {
  assertSize(buf: Buffer): void {
    if (buf.byteLength > MAX_UPLOAD_BYTES) {
      throw err('FILE_TOO_LARGE', 'image exceeds 10MB limit');
    }
  },

  detectMime(buf: Buffer): Mime {
    if (buf.length < 12) throw err('INVALID_FILE', 'buffer too small for mime detection');
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    ) {
      return 'image/png';
    }
    if (
      buf[0] === 0x52 &&
      buf[1] === 0x49 &&
      buf[2] === 0x46 &&
      buf[3] === 0x46 &&
      buf[8] === 0x57 &&
      buf[9] === 0x45 &&
      buf[10] === 0x42 &&
      buf[11] === 0x50
    ) {
      return 'image/webp';
    }
    throw err('INVALID_FILE', 'unsupported image format');
  },
};

function err(code: ValidatorError['code'], msg: string): ValidatorError {
  const e = new Error(msg) as ValidatorError;
  e.code = code;
  return e;
}
