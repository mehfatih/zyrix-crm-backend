-- Sprint 15 Phase B — live FX rates (additive)
CREATE TABLE IF NOT EXISTS fx_rates (
  id TEXT PRIMARY KEY,
  base CHAR(3) NOT NULL DEFAULT 'USD',
  quote CHAR(3) NOT NULL,
  rate DECIMAL(18,8) NOT NULL,
  "fetchedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "rateDate" DATE NOT NULL,
  source TEXT NOT NULL DEFAULT 'open.er-api.com'
);
CREATE UNIQUE INDEX IF NOT EXISTS fx_rates_base_quote_date_uq ON fx_rates(base, quote, "rateDate");
CREATE INDEX IF NOT EXISTS fx_rates_pair_idx ON fx_rates(base, quote, "rateDate" DESC);
