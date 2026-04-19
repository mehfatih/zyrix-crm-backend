import bcrypt from "bcrypt";

// ============================================================================
// PASSWORD UTILITIES
// ============================================================================

const SALT_ROUNDS = 12;

// ─────────────────────────────────────────────────────────────────────────
// Hash Password
// ─────────────────────────────────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

// ─────────────────────────────────────────────────────────────────────────
// Compare Password with Hash
// ─────────────────────────────────────────────────────────────────────────
export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ─────────────────────────────────────────────────────────────────────────
// Password Strength Validation
// ─────────────────────────────────────────────────────────────────────────
export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

export function validatePasswordStrength(
  password: string
): PasswordValidation {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Password must be at least 8 characters long");
  }
  if (!/[A-Z]/.test(password)) {
    errors.push("Password must contain at least one uppercase letter");
  }
  if (!/[a-z]/.test(password)) {
    errors.push("Password must contain at least one lowercase letter");
  }
  if (!/\d/.test(password)) {
    errors.push("Password must contain at least one number");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}