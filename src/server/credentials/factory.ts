import "server-only";

import { getCredentialEncryptionConfig } from "../config";
import { createLocalAesGcmCredentialCipher } from "./encryption";

export function createConfiguredCredentialCipher() {
  const config = getCredentialEncryptionConfig();
  return createLocalAesGcmCredentialCipher({ key: config.key, keyId: config.keyId });
}
