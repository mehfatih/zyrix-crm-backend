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