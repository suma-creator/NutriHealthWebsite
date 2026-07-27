// supabase/functions/_shared/otp.ts
//
// Small helper for generating and hashing one-time verification codes.
// The raw code is only ever sent over WhatsApp and returned in the
// function's own closure — never stored or logged in plaintext, only its
// SHA-256 hash goes into whatsapp_settings.otp_code_hash.

export function generateOtp(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
  return String(n).padStart(6, "0");
}

export async function hashOtp(code: string): Promise<string> {
  const data = new TextEncoder().encode(code);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(phone.trim());
}
