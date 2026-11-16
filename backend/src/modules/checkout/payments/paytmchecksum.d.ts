declare module 'paytmchecksum' {
  export default class PaytmChecksum {
    static generateSignature(value: string | Record<string, string>, key: string): Promise<string>;
    static calculateChecksum(value: string, key: string, salt: string): string;
  }
}
