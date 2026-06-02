# 05 — Input Visibility Audit (pointer)

The global input-visibility fix (Problem 2) is a **frontend** concern. The full
before/after analysis and the list of files touched live in the respective repos:

- **Web:** `zyrix-crm/docs/shopify-oauth/05-input-visibility-audit.md`
  (global `@layer base` form layer in `app/globals.css` + shared
  `components/ui/Input.tsx` primitive on semantic tokens; fixes the reported
  `levanastore.com` invisible-text case).
- **Mobile:** `zyrix-crm-mobile/docs/shopify-oauth/05-input-visibility-audit.md`
  (swept all `<TextInput>`; added explicit `placeholderTextColor` to four field inputs; new
  `ShopifyScreen` uses the shared `common/Input`).

The backend has no form controls and required no changes for this problem.
