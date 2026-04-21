-- ============================================================================
-- 2FA — add backup codes array for account recovery when authenticator is lost
-- ============================================================================

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "twoFactorBackupCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];
