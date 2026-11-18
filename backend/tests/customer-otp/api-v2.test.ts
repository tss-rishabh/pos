import { describe, expect, it } from 'vitest';
import { customerOtpApiV2 } from '../../src/modules/customer-otp/api-v2.js';
import {
  interpretSendReply,
  interpretVerifyReply,
} from '../../src/modules/customer-otp/service.js';

const config = {
  NODE_ENV: 'test' as const,
  TSS_API_BASE_URL: 'https://api-v2.fixture.test/api/v1',
};
describe('API-v2 omnichannel OTP adapter (legacy order/views.py:2549-2597)', () => {
  it('posts the legacy JSON payloads with Content-Type only and no Authorization', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const api = customerOtpApiV2(config, async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(
        String(url).endsWith('sendotp')
          ? { mobile: true, email: false }
          : { message: 'OTP verified successfully!' },
      );
    });
    expect(await api.sendOtp(7)).toEqual({ status: 200, body: { mobile: true, email: false } });
    expect(await api.verifyOtp(7, 1234)).toEqual({
      status: 200,
      body: { message: 'OTP verified successfully!' },
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://api-v2.fixture.test/api/v1/omnichannel-sendotp',
      'https://api-v2.fixture.test/api/v1/omnichannel-verifyotp',
    ]);
    expect(calls.map((call) => JSON.parse(String(call.init?.body)) as unknown)).toEqual([
      { user_id: 7 },
      { user_id: 7, otp: 1234 },
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe('POST');
      expect(call.init?.redirect).toBe('error');
      const headers = call.init?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization');
    }
  });
  it('reports an unknown outcome as null and refuses a missing or plaintext base URL', async () => {
    const offline = customerOtpApiV2(config, () => Promise.reject(new Error('offline')));
    expect(await offline.sendOtp(7)).toBeNull();
    const failed = customerOtpApiV2(config, async () => new Response('oops', { status: 400 }));
    expect(await failed.verifyOtp(7, 1)).toEqual({ status: 400, body: null });
    for (const base of [undefined, 'http://api-v2.fixture.test/'])
      expect(() =>
        customerOtpApiV2({ NODE_ENV: 'production', TSS_API_BASE_URL: base }).assertReady(),
      ).toThrowError(expect.objectContaining({ code: 'CUSTOMER_OTP_UNAVAILABLE', status: 503 }));
  });
  it('interprets send replies as legacy AjaxSendOtpView does', () => {
    expect(interpretSendReply({ status: 200, body: { mobile: true, email: false } })).toBe('sent');
    expect(interpretSendReply({ status: 200, body: { mobile: false, email: true } })).toBe('sent');
    expect(interpretSendReply({ status: 200, body: { mobile: false, email: false } })).toBe(
      'rejected',
    );
    expect(interpretSendReply({ status: 400, body: null })).toBe('rejected');
    expect(interpretSendReply({ status: 502, body: null })).toBe('uncertain');
    expect(interpretSendReply(null)).toBe('uncertain');
  });
  it('interprets verify replies as legacy AjaxVerifyOtpView does', () => {
    expect(
      interpretVerifyReply({ status: 200, body: { message: 'OTP verified successfully!' } }),
    ).toBe('verified');
    expect(interpretVerifyReply({ status: 200, body: { message: 'Invalid OTP' } })).toBe('wrong');
    expect(interpretVerifyReply({ status: 400, body: { message: 'Invalid OTP' } })).toBe('wrong');
    expect(interpretVerifyReply({ status: 503, body: null })).toBe('unavailable');
    expect(interpretVerifyReply(null)).toBe('unavailable');
  });
});
