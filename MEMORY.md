# Project Memory: AYOSERA

## Architecture & Integration Principles
- Next.js 15, Node 22, TypeScript, MongoDB Atlas.
- API AYO: Booking list & payment events auto-synced via scheduled cron.
- API Olsera: Open API (app_id/secret) for sales & inventory; internal dashboard API for financial (JWT Bearer token `OLSERA_INTERNAL_TOKEN`, 30-day expiry).
- Single Source of Truth: AYOSERA mirrors AYO & Olsera as-is. Never patch manual Excel client adjustments into database.

## Automated Backlog & Self-Healing Sync
- AYO Backlog Sync: Every cron run re-pulls rotating 6-day slice from 1st of previous month to H-2 (handles delayed payments & price revisions, e.g. Langi 23 Oct 99k).
- Olsera Backlog Audit: Every sales cron run audits 3 older dates from backlog window (re-pulls if mismatch).
- Racket Add-on: Excluded from Dashboard court performance revenue, only included in Excel export.

## Token Expiry & Early Warning
- Dashboard displays early-warning banner when `OLSERA_INTERNAL_TOKEN` expires in <= 7 days (`AKAN_KEDALUWARSA`) or has expired (`KEDALUWARSA`).
- To renew: user copies token from Olsera dashboard v2 network tab (gainloss request Authorization header) -> updates Vercel env -> redeploys. Local `.env.local` can sync via `npx vercel env pull`.

## Reconciliation & Closing Workflow
- Omzet reconciliation matches AYO bookings/payment events against Olsera accounts 40001 (Court Fees) and 40004 (Pickleball).
- When nominal matches Rp0 but status shows PERLU_DICEK, it means the period is waiting for the accounting team's closing journal (`CL...`) in Olsera before it can be locked.
