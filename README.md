# Zyrix CRM Backend

> Backend API for [Zyrix CRM](https://github.com/mehfatih/zyrix-crm) — the CRM built for MENA & Turkey.

[![Node](https://img.shields.io/badge/Node-20+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Prisma](https://img.shields.io/badge/Prisma-5.22-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org)

## 🏗️ Tech Stack

- **Runtime:** Node.js 20 LTS
- **Framework:** Express 4
- **Language:** TypeScript 5.7
- **ORM:** Prisma 5.22
- **Database:** PostgreSQL 16 (Railway)
- **Cache:** Redis 7 (optional — Phase 2)
- **Auth:** JWT + Google OAuth 2.0 + 2FA (TOTP)
- **Deployment:** Railway

## 🌐 URLs

- **Production API:** https://api.crm.zyrix.co
- **Frontend:** https://crm.zyrix.co
- **Frontend Repo:** https://github.com/mehfatih/zyrix-crm

## ✨ Feature Matrix

Trilingual (EN / AR / TR, RTL-safe) CRM for MENA & Turkey. Status as of Sprint 13 (program complete).

| Area | Capabilities | Status |
|------|--------------|--------|
| **Contacts & Deals** | Contacts, pipeline/stages, tasks, activities, line items, custom fields, CSV import | ✅ |
| **Products & Inventory** | Unified catalog (local + synced), stock levels & movements, low-stock automation | ✅ |
| **CPQ — Quote Builder Pro** | Price books, discount rules + approval governance, bundles, public quote links, AI discount suggestion | ✅ |
| **E-commerce sync** | Shopify (OAuth) + WooCommerce + 40-platform adapter; customers, orders **and products** → unified catalog | ✅ |
| **Omnichannel inbox** | WhatsApp (Cloud API), Messenger, Instagram; AI support widget with handoff | ✅ |
| **Lead capture** | Meta Lead Ads, Google Ads Lead Forms, public Form Flows (wizard/kiosk) with anti-spam | ✅ |
| **Email intelligence** | Open/click tracking (own pixel + signed links), Resend delivery webhooks, per-contact timeline, AI drafts, best-send-time | ✅ |
| **Automation Engine** | Visual workflows, **Cadences** (sequences) + **Journeys** (branch canvas), AI-from-natural-language builder, **Custom Actions** (webhook/compute/conditional recipes) | ✅ |
| **AI suite** | AI CFO, sales/content/meeting agents, Architect/Builder/Report modes, **AI Studio** (company personality injected across all AI + saved scheduled reports) | ✅ |
| **Data Tools** | AI-assisted dedupe & merge (full reference re-pointing + undo), bulk cleanup with preview/undo | ✅ |
| **Dashboards & Reports** | Customizable widget grid, configurable KPI/gauge/AI-insight widgets, analytics, scheduled digests | ✅ |
| **Loyalty & Marketing** | Points/tiers, campaigns, customer health & predictive lead scoring | ✅ |
| **Finance & Compliance** | ZATCA Phase 2 (Saudi) + e-Fatura (Türkiye) invoicing, multi-currency, tax regimes | ✅ |
| **Governance & Security** | RBAC + custom roles, audit logs, IP allowlisting, data retention, GDPR/CCPA API, SCIM 2.0, 2FA, session auto-lock | ✅ |
| **Platform** | Multi-brand, onboarding wizard, per-merchant feature flags, Google Workspace integration | ✅ |

**Exclusives vs Zoho / Salesforce / HubSpot / Bitrix24:** AI workflow builder from natural language · WhatsApp-native journeys · trilingual AI with per-company personality.

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ and npm 10+
- PostgreSQL 16 (local or Railway)
- Git

### Installation

```bash
# Clone the repo
git clone https://github.com/mehfatih/zyrix-crm-backend.git
cd zyrix-crm-backend

# Install dependencies
npm install

# Copy env template
cp .env.example .env

# Fill in .env with your values (see .env.example for reference)

# Generate Prisma client
npm run prisma:generate

# Run database migrations
npm run prisma:migrate

# Start dev server
npm run dev
```

The API will be available at `http://localhost:4000`

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build TypeScript to `dist/` |
| `npm start` | Run production build |
| `npm run type-check` | TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run prisma:studio` | Open Prisma Studio (DB GUI) |
| `npm run prisma:migrate` | Run database migrations |
| `npm run prisma:generate` | Regenerate Prisma client |

## 📂 Project Structure