import { x25519 } from '@noble/curves/ed25519.js';
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { ChatIdentity, ChatRecipient, ChatContext, Envelope } from './types';
const encode = (s: string) => new TextEncoder().encode(s);
const random = (size: number) => crypto.getRandomValues(new Uint8Array(size));
export const toBase64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
export const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export function generateIdentity(): ChatIdentity {
  const privateKey = random(32);
  return { privateKey: toBase64(privateKey), publicKey: toBase64(x25519.getPublicKey(privateKey)) };
}
export function validIdentity(value: unknown): value is ChatIdentity {
  try {
    const key = value as ChatIdentity;
    const privateKey = fromBase64(key.privateKey);
    return privateKey.length === 32 && key.publicKey === toBase64(x25519.getPublicKey(privateKey));
  } catch {
    return false;
  }
}
function aad(context: ChatContext, clientId: string) {
  return encode(
    JSON.stringify([
      'relay3-chat-v1',
      context.stationId,
      context.senderId,
      clientId,
      context.remark,
      context.remarkStyle,
    ]),
  );
}
function wrappingKey(secret: Uint8Array, salt: Uint8Array, id: string, associated: Uint8Array) {
  return hkdf(
    sha256,
    secret,
    salt,
    encode('relay3-wrap-v1:' + id + ':' + toBase64(associated)),
    32,
  );
}
export function encryptMessage(
  text: string,
  recipients: ChatRecipient[],
  context: ChatContext,
  clientId: string,
): Envelope {
  if ([...text].length > 10000) throw new Error('正文最多 10000 个字符');
  const key = random(32),
    privateKey = random(32),
    salt = random(32),
    nonce = random(12);
  const associated = aad(context, clientId);
  const result: Envelope = {
    version: 1,
    clientId,
    ephemeral: toBase64(x25519.getPublicKey(privateKey)),
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    body: toBase64(gcm(key, nonce, associated).encrypt(encode(text))),
    recipients: recipients.map((d) => {
      const wrapNonce = random(12);
      const shared = x25519.getSharedSecret(privateKey, fromBase64(d.publicKey));
      const wrapKey = wrappingKey(shared, salt, d.id, associated);
      return {
        id: d.id,
        publicKey: d.publicKey,
        nonce: toBase64(wrapNonce),
        key: toBase64(gcm(wrapKey, wrapNonce, associated).encrypt(key)),
      };
    }),
  };
  key.fill(0);
  privateKey.fill(0);
  return result;
}
export function decryptMessage(
  envelope: Envelope,
  identity: ChatIdentity,
  id: string,
  context: ChatContext,
): string | null {
  const recipient = envelope.recipients.find(
    (d) => d.id === id && d.publicKey === identity.publicKey,
  );
  if (!recipient) return null;
  try {
    const associated = aad(context, envelope.clientId);
    const shared = x25519.getSharedSecret(
      fromBase64(identity.privateKey),
      fromBase64(envelope.ephemeral),
    );
    const wrapKey = wrappingKey(shared, fromBase64(envelope.salt), id, associated);
    const key = gcm(wrapKey, fromBase64(recipient.nonce), associated).decrypt(
      fromBase64(recipient.key),
    );
    const plain = gcm(key, fromBase64(envelope.nonce), associated).decrypt(
      fromBase64(envelope.body),
    );
    key.fill(0);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return null;
  }
}
