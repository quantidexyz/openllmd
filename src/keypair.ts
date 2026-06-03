/**
 * Per-daemon X25519 keypair + sealed-box transfer.
 *
 * Used to move a Claude SETUP-TOKEN between two of the user's own daemons
 * without the cloud ever reading it: the daemon on the machine with the
 * browser mints the token and SEALS it to the target daemon's public key; the
 * cloud relays only ciphertext (`/api/daemon/relay-credential`); the target
 * daemon opens it with its private key and stores it. See
 * docs/proposals/daemon-auth-loopback-forwarding.md §7.4.
 *
 * Sealed box = ephemeral X25519 + ECDH → HKDF-SHA256 → AES-256-GCM. The
 * private key is generated once and persisted `0600` under the state dir; only
 * the public key (SPKI DER, base64) ever leaves the box, on the status push.
 */
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./env";

const privFile = (): string => join(stateDir(), "x25519-priv");
const HKDF_INFO = Buffer.from("openllm-cred-seal-v1");

let cachedPriv: KeyObject | null = null;

/** The daemon's own X25519 private key, generated + persisted on first use. */
const ownPrivate = (): KeyObject => {
  if (cachedPriv !== null) return cachedPriv;
  try {
    const der = readFileSync(privFile());
    cachedPriv = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    return cachedPriv;
  } catch {
    // none yet — generate + persist below
  }
  const { privateKey } = generateKeyPairSync("x25519");
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      privFile(),
      privateKey.export({ format: "der", type: "pkcs8" }),
      { mode: 0o600 },
    );
  } catch {
    // best-effort persistence — an in-memory key still works this run
  }
  cachedPriv = privateKey;
  return privateKey;
};

/** This daemon's public key (SPKI DER, base64) — published on the status. */
export const daemonPublicKey = (): string =>
  Buffer.from(
    createPublicKey(ownPrivate()).export({ format: "der", type: "spki" }),
  ).toString("base64");

const deriveKey = (shared: Buffer): Buffer =>
  Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), HKDF_INFO, 32));

/**
 * Seal `plaintext` to a recipient daemon's public key (SPKI DER, base64).
 * Output is base64(JSON{ epk, iv, ct }) — the cloud relays it opaquely.
 */
export const sealTo = (recipientPubB64: string, plaintext: string): string => {
  const recipient = createPublicKey({
    key: Buffer.from(recipientPubB64, "base64"),
    format: "der",
    type: "spki",
  });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: recipient,
  });
  const key = deriveKey(shared);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const packed = {
    epk: Buffer.from(
      eph.publicKey.export({ format: "der", type: "spki" }),
    ).toString("base64"),
    iv: iv.toString("base64"),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString("base64"),
  };
  return Buffer.from(JSON.stringify(packed)).toString("base64");
};

/** Open a sealed blob with this daemon's private key. Null on any failure. */
export const openSealed = (sealedB64: string): string | null => {
  try {
    const { epk, iv, ct } = JSON.parse(
      Buffer.from(sealedB64, "base64").toString("utf8"),
    ) as { epk: string; iv: string; ct: string };
    const eph = createPublicKey({
      key: Buffer.from(epk, "base64"),
      format: "der",
      type: "spki",
    });
    const shared = diffieHellman({ privateKey: ownPrivate(), publicKey: eph });
    const key = deriveKey(shared);
    const ctBuf = Buffer.from(ct, "base64");
    const body = ctBuf.subarray(0, ctBuf.length - 16);
    const tag = ctBuf.subarray(ctBuf.length - 16);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    return null;
  }
};
