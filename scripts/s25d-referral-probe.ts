// ============================================================================
// Sprint 25D — referral parser probe (DB-FREE). Verifies the pure CTWA +
// Messenger referral parsing decisions without any live Meta channel / DB.
//   Run:  npx tsx scripts/s25d-referral-probe.ts
// ============================================================================

import {
  parseWhatsAppReferral,
  parseMessengerReferral,
} from "../src/services/lead-source-capture.service";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

console.log("CTWA (WhatsApp messages[].referral):");

// Positive — a real Click-to-WhatsApp ad referral.
const ctwa = parseWhatsAppReferral({
  from: "905551234567",
  referral: {
    source_url: "https://fb.me/abc",
    source_id: "120210000000000000", // ad id
    source_type: "ad",
    headline: "Summer sale",
    body: "Tap to chat",
    media_type: "image",
    ctwa_clid: "ARBxClickId123",
  },
});
check("ad referral parses", ctwa !== null);
check("source = ctwa_ad", ctwa?.source === "ctwa_ad");
check("platform = meta", ctwa?.platform === "meta");
check("clickId = ctwa_clid", ctwa?.clickId === "ARBxClickId123");
check("adId = source_id", ctwa?.adId === "120210000000000000");
check("dedupeSeed prefers clickId", ctwa?.dedupeSeed === "ARBxClickId123");

// Negative — organic post referral (source_type 'post') → not ad-attributable.
check(
  "post referral ignored",
  parseWhatsAppReferral({ referral: { source_type: "post", source_id: "p1" } }) === null
);
// Negative — no referral at all.
check("plain message ignored", parseWhatsAppReferral({ from: "x", text: { body: "hi" } }) === null);
// Edge — ad referral with only a click id, no source_id.
const ctwaClidOnly = parseWhatsAppReferral({ referral: { source_type: "ad", ctwa_clid: "C9" } });
check("clid-only ad referral parses", ctwaClidOnly?.dedupeSeed === "C9");

console.log("\nClick-to-Messenger (messaging[].referral + postback.referral):");

// Positive — direct referral on an existing thread.
const msgr = parseMessengerReferral({
  sender: { id: "PSID1" },
  referral: {
    ref: "myref",
    source: "ADS",
    type: "OPEN_THREAD",
    ad_id: "23840000000000000",
    ads_context_data: { ad_title: "Promo", photo_url: "https://x/y.jpg", post_id: "po1" },
  },
});
check("ADS referral parses", msgr !== null);
check("source = messenger_ad", msgr?.source === "messenger_ad");
check("adId = ad_id", msgr?.adId === "23840000000000000");
check("dedupeSeed prefers adId", msgr?.dedupeSeed === "23840000000000000");
check("raw carries ad_title", (msgr?.raw as Record<string, unknown>)?.adTitle === "Promo");

// Positive — referral nested under postback (first open from m.me ad link).
const msgrPb = parseMessengerReferral({
  postback: { payload: "GET_STARTED", referral: { source: "ADS", ad_id: "999" } },
});
check("postback.referral parses", msgrPb?.adId === "999");

// Negative — shortlink (non-ad) referral.
check(
  "SHORTLINK referral ignored",
  parseMessengerReferral({ referral: { source: "SHORTLINK", ref: "r" } }) === null
);
// Negative — plain text message, no referral.
check("plain messenger msg ignored", parseMessengerReferral({ message: { text: "hi" } }) === null);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
