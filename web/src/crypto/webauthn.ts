/**
 * Phase 2.1: passkey authentication with the WebAuthn PRF extension.
 *
 * Plain passkeys only prove identity; they do not hand the browser a secret.
 * The PRF extension (hmac-secret on the authenticator) does: given a fixed
 * salt, the Secure Enclave / TPM returns 32 bytes that never leave the device
 * unencrypted. Those bytes are the K_m seed on the passkey path.
 *
 * Browser support for PRF is uneven (Chrome and Safari 18+ on platform
 * authenticators; label: verify on each target device). isPrfSupported()
 * probes it; callers fall back to the password path when it is absent.
 */

import { bs, utf8 } from "./bytes.js";

/** Fixed, public PRF salt. Changing it changes every user's K_m. */
export const PRF_SALT = utf8("omni-cell/prf/v1");

export interface PasskeyRegistration {
  credentialId: Uint8Array;
  /** Present only if the authenticator supports PRF; use it as the K_m seed. */
  prfOutput: Uint8Array | null;
  attestationObject: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
}

export interface PasskeyAssertion {
  credentialId: Uint8Array;
  prfOutput: Uint8Array | null;
  authenticatorData: ArrayBuffer;
  clientDataJSON: ArrayBuffer;
  signature: ArrayBuffer;
  userHandle: ArrayBuffer | null;
}

interface PrfResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } };
}

export function isWebAuthnSupported(): boolean {
  return typeof PublicKeyCredential !== "undefined";
}

export async function isPlatformAuthenticatorAvailable(): Promise<boolean> {
  if (!isWebAuthnSupported()) return false;
  return PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
}

/**
 * Registers a resident (discoverable) platform passkey.
 * `challenge` and `userId` come from the server; the server stores only the
 * public key, credentialId, and a user handle, never K_auth-derivable data.
 */
export async function registerPasskey(opts: {
  rpId: string;
  rpName: string;
  userId: Uint8Array;
  userName: string;
  challenge: Uint8Array;
}): Promise<PasskeyRegistration> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { id: opts.rpId, name: opts.rpName },
      user: { id: bs(opts.userId), name: opts.userName, displayName: opts.userName },
      challenge: bs(opts.challenge),
      pubKeyCredParams: [
        { type: "public-key", alg: -8 }, // Ed25519
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 }, // RS256 (Windows Hello)
      ],
      authenticatorSelection: {
        authenticatorAttachment: "platform",
        residentKey: "required",
        userVerification: "required",
      },
      timeout: 120_000,
      attestation: "none",
      extensions: { prf: { eval: { first: bs(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey registration cancelled");
  const resp = cred.response as AuthenticatorAttestationResponse;
  const ext = cred.getClientExtensionResults() as PrfResults;
  const first = ext.prf?.results?.first;
  return {
    credentialId: new Uint8Array(cred.rawId),
    prfOutput: first ? new Uint8Array(first) : null,
    attestationObject: resp.attestationObject,
    clientDataJSON: resp.clientDataJSON,
  };
}

/** Signs a server challenge and evaluates PRF for the K_m seed. */
export async function assertPasskey(opts: {
  rpId: string;
  challenge: Uint8Array;
  allowCredentialIds?: Uint8Array[];
}): Promise<PasskeyAssertion> {
  const cred = (await navigator.credentials.get({
    publicKey: {
      rpId: opts.rpId,
      challenge: bs(opts.challenge),
      userVerification: "required",
      timeout: 120_000,
      allowCredentials: (opts.allowCredentialIds ?? []).map((id) => ({ type: "public-key" as const, id: bs(id) })),
      extensions: { prf: { eval: { first: bs(PRF_SALT) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("passkey assertion cancelled");
  const resp = cred.response as AuthenticatorAssertionResponse;
  const ext = cred.getClientExtensionResults() as PrfResults;
  const first = ext.prf?.results?.first;
  return {
    credentialId: new Uint8Array(cred.rawId),
    prfOutput: first ? new Uint8Array(first) : null,
    authenticatorData: resp.authenticatorData,
    clientDataJSON: resp.clientDataJSON,
    signature: resp.signature,
    userHandle: resp.userHandle,
  };
}
