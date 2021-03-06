import secp256k1 from 'secp256k1';

import { KeyPair } from '../services/interfaces/ISigningAlgorithm';

export class SECP256K1KeyPair implements KeyPair {
  public readonly publicKey: Buffer;
  public readonly secretKey: Buffer;

  constructor(publicKey: Buffer, secretKey: Buffer) {
    this.publicKey = publicKey;
    this.secretKey = secretKey;
  }

  public isValidKeyPair = (): Promise<boolean> => {
    try {
      const isValidPrivate = secp256k1.privateKeyVerify(this.secretKey);
      const isValidPublic = secp256k1.publicKeyVerify(this.publicKey);

      const testPubKey = Buffer.from(secp256k1.publicKeyCreate(this.secretKey));
      const isActualPubKey = this.publicKey.equals(testPubKey);
      return Promise.resolve(isValidPrivate && isValidPublic && isActualPubKey);
    } catch (error) {
      console.error(error);
      return Promise.reject(false);
    }
  };
}
