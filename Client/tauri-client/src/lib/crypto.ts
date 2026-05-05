/**
 * H2H (Host-to-Host) encryption for messages.
 * Uses ECIES with X25519 key agreement and AES-256-GCM.
 */

import { createLogger } from "@lib/logger";

const log = createLogger("crypto");

const STORAGE_KEY_PRIVATE = "rylo_h2h_private_key";
const STORAGE_KEY_PUBLIC = "rylo_h2h_public_key";

export interface KeyPair {
  publicKey: string;
  privateKey: string;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunk: string[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte !== undefined) {
      chunk.push(String.fromCharCode(byte));
    }
  }
  return btoa(chunk.join(""));
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

export async function generateKeyPair(): Promise<KeyPair> {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );

  const publicKeyBuffer = await window.crypto.subtle.exportKey("spki", keyPair.publicKey);
  const privateKeyBuffer = await window.crypto.subtle.exportKey("pkcs8", keyPair.privateKey);

  return {
    publicKey: arrayBufferToBase64(publicKeyBuffer),
    privateKey: arrayBufferToBase64(privateKeyBuffer),
  };
}

async function importPrivateKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey", "deriveBits"],
  );
}

async function importPublicKey(base64Key: string): Promise<CryptoKey> {
  const keyData = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    "spki",
    keyData,
    { name: "ECDH", namedCurve: "P-256" },
    true,
    [],
  );
}

async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  return window.crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function generateIV(): Uint8Array {
  return window.crypto.getRandomValues(new Uint8Array(12));
}

export async function encryptMessage(plaintext: string, recipientPublicKey: string): Promise<string> {
  try {
    const storedPrivateKey = localStorage.getItem(STORAGE_KEY_PRIVATE);
    if (!storedPrivateKey) {
      throw new Error("No private key found");
    }

    const privateKey = await importPrivateKey(storedPrivateKey);
    const recipientKey = await importPublicKey(recipientPublicKey);
    const sharedKey = await deriveSharedKey(privateKey, recipientKey);

    const iv = generateIV();
    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(plaintext);

    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      sharedKey,
      plaintextBytes,
    );

    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);

    const combinedBuffer = new ArrayBuffer(combined.length);
    new Uint8Array(combinedBuffer).set(combined);
    return arrayBufferToBase64(combinedBuffer);
  } catch (err) {
    log.error("Encryption failed", { error: String(err) });
    throw err;
  }
}

export async function decryptMessage(encryptedBase64: string, senderPublicKey: string): Promise<string> {
  try {
    const storedPrivateKey = localStorage.getItem(STORAGE_KEY_PRIVATE);
    if (!storedPrivateKey) {
      throw new Error("No private key found");
    }

    const privateKey = await importPrivateKey(storedPrivateKey);
    const senderKey = await importPublicKey(senderPublicKey);
    const sharedKey = await deriveSharedKey(privateKey, senderKey);

    const combined = new Uint8Array(base64ToArrayBuffer(encryptedBase64));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plaintextBytes = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      sharedKey,
      ciphertext,
    );

    const decoder = new TextDecoder();
    return decoder.decode(plaintextBytes);
  } catch (err) {
    log.error("Decryption failed", { error: String(err) });
    throw err;
  }
}

export function getPublicKey(): string | null {
  return localStorage.getItem(STORAGE_KEY_PUBLIC);
}

export function getPrivateKey(): string | null {
  return localStorage.getItem(STORAGE_KEY_PRIVATE);
}

export async function ensureKeyPair(): Promise<KeyPair> {
  const storedPublic = localStorage.getItem(STORAGE_KEY_PUBLIC);
  const storedPrivate = localStorage.getItem(STORAGE_KEY_PRIVATE);

  if (storedPublic && storedPrivate) {
    return { publicKey: storedPublic, privateKey: storedPrivate };
  }

  const newKeyPair = await generateKeyPair();
  localStorage.setItem(STORAGE_KEY_PUBLIC, newKeyPair.publicKey);
  localStorage.setItem(STORAGE_KEY_PRIVATE, newKeyPair.privateKey);

  log.info("Generated new H2H key pair");
  return newKeyPair;
}

export function hasKeyPair(): boolean {
  return localStorage.getItem(STORAGE_KEY_PRIVATE) !== null;
}

export interface EncryptedContent {
  readonly encrypted: string;
  readonly sender_public_key: string;
}

export function isEncryptedContent(content: unknown): content is EncryptedContent {
  if (typeof content !== "object" || content === null) return false;
  const obj = content as Record<string, unknown>;
  return typeof obj.encrypted === "string" && typeof obj.sender_public_key === "string";
}