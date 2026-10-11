// Shared input validators used by more than one route.

// Requires a local part, an "@", and a domain with at least one dot and a
// 2+ letter TLD. Rejects "user@domain", "user@domain.", "user@.com", "a@b@c.com".
const EMAIL_REGEX = /^[^\s@]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

export function validateEmail(email) {
  // Non-strings (arrays, numbers) would otherwise be coerced by RegExp.test()
  // and stored as-is, e.g. ["a@b.com"] passes the regex.
  if (typeof email !== 'string' || email.length > 254) {
    return false;
  }
  return EMAIL_REGEX.test(email);
}

// Emails are case-insensitive in practice; normalising prevents
// "Merchant@Test.com" and "merchant@test.com" becoming two accounts.
export function normalizeEmail(email) {
  return email.trim().toLowerCase();
}
