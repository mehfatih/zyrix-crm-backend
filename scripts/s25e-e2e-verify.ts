// ============================================================================
// Sprint 25E — Source Attribution e2e verify (throwaway data, auto-purged).
// Exercises the REAL service path against the prod DB:
//   • entitlement gating: enterprise source_attribution ON, free OFF
//   • manual stamp: set source (+ optional campaign link) → get reflects it
//   • manual precedence: auto capture does NOT overwrite a manual stamp
//   • landing UTM auto-capture: lead_sources row (platform from click id) + deal
//     stamp; FREE tenant → gated OFF (no row, no stamp)
//   • CTWA + Messenger referral capture: lead_sources + newest-open-deal stamp
//   • lead-ad backfill: captureLeadAdStamp sets deals.attributionSource
//   • rollup wiring: meta campaign now auto-matches meta_lead_ad AND ctwa_ad
//     lead_sources rows carrying campaignId = externalId
// Then purges all throwaway tenants + raw rows (0 leftovers).
// Run: npx tsx scripts/s25e-e2e-verify.ts
// ============================================================================
import { randomUUID } from "crypto";
import { prisma } from "../src/config/database";
import { invalidateAll, resolveFeature } from "../src/services/entitlements.service";
import { createDeal, updateDeal } from "../src/services/deal.service";
import {
  setManualAttribution,
  getDealAttribution,
  stampAttributionAuto,
} from "../src/services/deal-attribution.service";
import {
  captureLandingAttribution,
  captureWhatsAppReferral,
  captureMessengerReferral,
  captureLeadAdStamp,
} from "../src/services/lead-source-capture.service";
import { createCampaign, computeCampaignEconomics, getCampaign } from "../src/services/ad-campaign.service";

const stamp = Date.now().toString(36);
const pass: string[] = [];
const fail: string[] = [];
const ok = (c: boolean, msg: string) => (c ? pass : fail).push(msg);

const companies: string[] = [];

async function mkCompany(plan: string): Promise<{ companyId: string; userId: string }> {
  const companyId = randomUUID();
  const uniq = companyId.slice(0, 8);
  await prisma.$executeRawUnsafe(
    `INSERT INTO companies ("id","name","slug","plan","status","baseCurrency","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'active','TRY',NOW(),NOW())`,
    companyId, `S25 ${plan} ${stamp}`, `s25-${plan}-${stamp}-${uniq}`, plan
  );
  const userId = randomUUID();
  await prisma.$executeRawUnsafe(
    `INSERT INTO users ("id","companyId","email","fullName","passwordHash","role","status","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'x','owner','active',NOW(),NOW())`,
    userId, companyId, `s25.${userId.slice(0, 8)}@zyrix.co`, "Owner"
  );
  companies.push(companyId);
  return { companyId, userId };
}

async function mkCustomer(companyId: string, name: string) {
  return prisma.customer.create({
    data: { companyId, fullName: name, email: `${name.replace(/\s/g, "").toLowerCase()}.${stamp}@example.com`, status: "new", source: "s25-verify" },
    select: { id: true },
  });
}

// TRY deal so baseValue == value (no FX needed). Optionally close as won.
async function mkDeal(companyId: string, userId: string, custId: string, title: string, value: number, won: boolean): Promise<string> {
  const d = await createDeal(companyId, userId, { customerId: custId, title, value, currency: "TRY", stage: "qualified" });
  if (won) await updateDeal(companyId, d.id, { stage: "won" });
  return d.id;
}

async function leadSourceRow(companyId: string, dealId: string) {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT "source","platform","clickId","captureMethod","utmSource" FROM lead_sources
      WHERE "companyId"=$1 AND "dealId"=$2 ORDER BY "createdAt" DESC LIMIT 1`,
    companyId, dealId
  )) as Array<Record<string, unknown>>;
  return rows[0] ?? null;
}

(async () => {
  try {
    const ENT = await mkCompany("enterprise");
    const FREE = await mkCompany("free");
    invalidateAll();
    ok(true, "Setup: enterprise + free tenants (base TRY)");

    // ── Gating ──────────────────────────────────────────────────────────────
    const eE = await resolveFeature(ENT.companyId, "source_attribution");
    const eF = await resolveFeature(FREE.companyId, "source_attribution");
    ok(eE.enabled === true, "Gating: enterprise → source_attribution ENABLED");
    ok(eF.enabled === false, "Gating: free → source_attribution DISABLED");

    const cust = await mkCustomer(ENT.companyId, "S25 Cust");

    // ── Manual stamp + campaign link ──────────────────────────────────────────
    const camp = await createCampaign(ENT.companyId, ENT.userId, {
      name: "S25 Meta", platform: "meta", externalId: `S25EXT-${stamp}`,
    });
    const dManual = await mkDeal(ENT.companyId, ENT.userId, cust.id, "Manual deal", 1000, false);
    const m1 = await setManualAttribution(ENT.companyId, dManual, { source: "tiktok", adCampaignId: camp.id });
    ok(m1?.source === "tiktok" && m1?.captureMethod === "manual", `Manual: source=tiktok, method=manual [${m1?.source}/${m1?.captureMethod}]`);
    ok(m1?.adCampaignId === camp.id && m1?.adCampaignName === "S25 Meta", `Manual: campaign linked + name resolved [${m1?.adCampaignName}]`);

    // ── Manual precedence: auto must NOT overwrite ────────────────────────────
    const stamped = await stampAttributionAuto(ENT.companyId, dManual, "landing_utm");
    const after = await getDealAttribution(ENT.companyId, dManual);
    ok(stamped === false && after?.source === "tiktok" && after?.captureMethod === "manual",
      `Precedence: auto skipped a manual stamp (still tiktok/manual) [stamped=${stamped}, ${after?.source}]`);

    // ── Landing UTM auto-capture (enterprise) ─────────────────────────────────
    const dLand = await mkDeal(ENT.companyId, ENT.userId, cust.id, "Landing deal", 500, false);
    const cap = await captureLandingAttribution({
      companyId: ENT.companyId, contactId: cust.id, dealId: dLand, landingPageId: null,
      raw: { utm_source: "tiktok", utm_medium: "cpc", utm_campaign: "summer", ttclid: "TT123", landing_path: "/lp" },
    });
    const lsLand = await leadSourceRow(ENT.companyId, dLand);
    const aLand = await getDealAttribution(ENT.companyId, dLand);
    ok(cap === true && lsLand?.source === "landing_utm" && lsLand?.platform === "tiktok" && lsLand?.clickId === "TT123",
      `Landing: lead_sources landing_utm, platform tiktok (from ttclid), clickId TT123 [${lsLand?.platform}/${lsLand?.clickId}]`);
    ok(aLand?.source === "landing_utm" && aLand?.captureMethod === "auto", `Landing: deal stamped landing_utm/auto [${aLand?.source}/${aLand?.captureMethod}]`);

    // ── Landing UTM gating (free tenant → no capture) ─────────────────────────
    const fcust = await mkCustomer(FREE.companyId, "Free Cust");
    const fDeal = await mkDeal(FREE.companyId, FREE.userId, fcust.id, "Free landing", 500, false);
    const fcap = await captureLandingAttribution({
      companyId: FREE.companyId, contactId: fcust.id, dealId: fDeal, landingPageId: null,
      raw: { utm_source: "google", gclid: "G1" },
    });
    const fls = await leadSourceRow(FREE.companyId, fDeal);
    const fa = await getDealAttribution(FREE.companyId, fDeal);
    ok(fcap === false && fls === null && fa?.source === null,
      `Gate: free tenant landing capture skipped (no row, no stamp) [cap=${fcap}, row=${fls ? "row" : "none"}]`);

    // ── CTWA referral → newest open deal stamped ──────────────────────────────
    const waCust = await mkCustomer(ENT.companyId, "WA Cust");
    const waDeal = await mkDeal(ENT.companyId, ENT.userId, waCust.id, "WA open deal", 0, false);
    const waCap = await captureWhatsAppReferral(ENT.companyId, waCust.id, {
      referral: { source_type: "ad", source_id: "AD-CTWA", ctwa_clid: "CLID9", headline: "Promo" },
    });
    const waLs = await leadSourceRow(ENT.companyId, waDeal);
    const waA = await getDealAttribution(ENT.companyId, waDeal);
    ok(waCap === true && waLs?.source === "ctwa_ad" && waLs?.platform === "meta", `CTWA: lead_sources ctwa_ad/meta [${waLs?.source}]`);
    ok(waA?.source === "ctwa_ad" && waA?.captureMethod === "auto", `CTWA: newest open deal stamped ctwa_ad/auto [${waA?.source}]`);

    // ── Messenger referral → newest open deal stamped ─────────────────────────
    const fbCust = await mkCustomer(ENT.companyId, "FB Cust");
    const fbDeal = await mkDeal(ENT.companyId, ENT.userId, fbCust.id, "FB open deal", 0, false);
    const fbCap = await captureMessengerReferral(ENT.companyId, fbCust.id, {
      postback: { payload: "GET_STARTED", referral: { source: "ADS", ad_id: "AD-MSG", ads_context_data: { ad_title: "Promo" } } },
    });
    const fbA = await getDealAttribution(ENT.companyId, fbDeal);
    ok(fbCap === true && fbA?.source === "messenger_ad" && fbA?.captureMethod === "auto", `Messenger: deal stamped messenger_ad/auto [${fbA?.source}]`);

    // ── Lead-ad backfill: captureLeadAdStamp sets deals.attributionSource ──────
    const laCust = await mkCustomer(ENT.companyId, "LeadAd Cust");
    const laDeal = await mkDeal(ENT.companyId, ENT.userId, laCust.id, "Lead-ad deal", 0, false);
    const laStamped = await captureLeadAdStamp(ENT.companyId, laDeal, "meta_lead_ad");
    const laA = await getDealAttribution(ENT.companyId, laDeal);
    ok(laStamped === true && laA?.source === "meta_lead_ad" && laA?.captureMethod === "auto", `Backfill: lead-ad deal stamped meta_lead_ad/auto [${laA?.source}]`);

    // ── Rollup wiring: meta campaign auto-matches meta_lead_ad AND ctwa_ad ─────
    const ext = (await getCampaign(ENT.companyId, camp.id))!.externalId!;
    const dWon1 = await mkDeal(ENT.companyId, ENT.userId, cust.id, "Won via lead-ad", 300, true);
    const dWon2 = await mkDeal(ENT.companyId, ENT.userId, cust.id, "Won via ctwa", 200, true);
    await prisma.$executeRawUnsafe(
      `INSERT INTO lead_sources (id,"companyId","dealId",source,"leadgenId","campaignId","rawJson","createdAt")
       VALUES ($1,$2,$3,'meta_lead_ad',$4,$5,'{}',NOW())`,
      randomUUID(), ENT.companyId, dWon1, `lg-${stamp}`, ext
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO lead_sources (id,"companyId","dealId",source,"campaignId","captureMethod","dedupeKey","rawJson","createdAt")
       VALUES ($1,$2,$3,'ctwa_ad',$4,'auto',$5,'{}',NOW())`,
      randomUUID(), ENT.companyId, dWon2, ext, `ctwa_ad:roll:${stamp}`
    );
    const fresh = (await getCampaign(ENT.companyId, camp.id))!;
    const ec = await computeCampaignEconomics(ENT.companyId, fresh);
    ok(ec.dealsWon === 2 && Math.abs(ec.revenueBase - 500) <= 0.02,
      `Rollup: meta campaign attributes BOTH meta_lead_ad + ctwa_ad won deals (2 won, 500 TRY) [${ec.dealsWon}/${ec.revenueBase}]`);
  } catch (e) {
    fail.push(`EXCEPTION: ${(e as Error).message}`);
    console.error(e);
  } finally {
    // ── Purge throwaway data + verify zero leftovers ──────────────────────────
    let leftovers = 0;
    try {
      for (const cid of companies) {
        await prisma.$executeRawUnsafe(`DELETE FROM lead_sources WHERE "companyId"=$1`, cid);
        await prisma.$executeRawUnsafe(`DELETE FROM ad_campaigns WHERE "companyId"=$1`, cid);
        await prisma.dealItem.deleteMany({ where: { companyId: cid } });
        await prisma.deal.deleteMany({ where: { companyId: cid } });
        await prisma.customer.deleteMany({ where: { companyId: cid } });
        await prisma.user.deleteMany({ where: { companyId: cid } });
        await prisma.$executeRawUnsafe(`DELETE FROM companies WHERE id = $1`, cid);
      }
      for (const cid of companies) {
        for (const t of ["ad_campaigns", "lead_sources"]) {
          const r = (await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS c FROM ${t} WHERE "companyId"=$1`, cid)) as Array<{ c: number }>;
          leftovers += Number(r[0]?.c ?? 0);
        }
        leftovers += await prisma.deal.count({ where: { companyId: cid } });
        leftovers += await prisma.customer.count({ where: { companyId: cid } });
        leftovers += await prisma.user.count({ where: { companyId: cid } });
        const c = (await prisma.$queryRawUnsafe(`SELECT id FROM companies WHERE id = $1`, cid)) as unknown[];
        leftovers += c.length;
      }
      ok(leftovers === 0, `Purge: zero leftovers across all tenant tables (count=${leftovers})`);
    } catch (e) {
      fail.push(`PURGE EXCEPTION: ${(e as Error).message}`);
    }
    await prisma.$disconnect();
  }

  console.log("\n──────── RESULTS ────────");
  for (const p of pass) console.log("  PASS  " + p);
  for (const f of fail) console.log("  FAIL  " + f);
  console.log(`\n${pass.length} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
})();
