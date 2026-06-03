# CLAUDE.md

Guidance for working in the Zyrix CRM backend.

## AI services (Gemini)

All AI features share one client + key: `env.GEMINI_API_KEY` → `new GoogleGenerativeAI(...)`,
initialized independently in each service (`ai.service`, `ai-cfo.service`, `ai-agent.service`,
`ai-modes.service`, `bonus.service`, `workflow-actions`, `support/ai`). There are no hardcoded
keys. The current model across all of them is **`gemini-2.5-flash`**.

### When AI replies stop coming back, check in this order

Google retires models on a schedule, and the symptom is usually a *silent* failure: callers
catch the error and degrade (e.g. the support widget returns `aiReplied:false`), so the HTTP
response is still `200`. Diagnose at the source, not the endpoint:

1. **Key validity (not just presence).** The `/health` field and startup banner only check that
   `GEMINI_API_KEY` exists, not that it works. A present-but-invalid key returns
   `400 API_KEY_INVALID`. A valid key is 39 chars, prefix `AIzaSy`. Watch for paste corruption
   (e.g. a duplicated `AIza` prefix → 43 chars).
2. **Billing.** `429 "prepayment credits are depleted"` means valid key, no credits — top up on
   the Google project that owns the key.
3. **Model retirement.** `404 "This model ... is no longer available"` means the model string is
   retired. **`listModels` is unreliable** — it keeps listing retired models, so only a real
   `generateContent` call reveals it. Bump the model string in the services above to a current
   one (verify the replacement with an actual `generateContent` + `responseSchema` call first).

Note: only the stable models support controlled generation (`responseSchema`); experimental
`*-exp` models reject it. Keep schema-using paths (support, ai-agent meeting notes) on a stable
model.
