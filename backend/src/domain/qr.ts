import QRCode from 'qrcode';
import { AppError } from './errors.js';

/** Encode locally: credentials and personal data never become an external chart-service URL. */
export async function qrDataUrl(payload: string): Promise<string> {
  if (!payload || Buffer.byteLength(payload, 'utf8') > 2048)
    throw new AppError(400, 'QR_PAYLOAD_INVALID', 'The QR content is not supported.');
  try {
    return await QRCode.toDataURL(payload, {
      type: 'image/png',
      errorCorrectionLevel: 'M',
      margin: 4,
      scale: 4,
    });
  } catch {
    throw new AppError(503, 'QR_UNAVAILABLE', 'The QR code could not be generated.');
  }
}
