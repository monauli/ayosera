# PROJECT REQUIREMENT DOCUMENT (PRD)

# AYO Real-Time Transaction Integration Platform

## 1. Overview

### Project Name

AYO Real-Time Transaction Integration Platform

### Background

Perusahaan membutuhkan sistem yang dapat membaca transaksi secara real-time dari aplikasi AYO menggunakan Production API yang telah tersedia. Data transaksi akan disimpan ke database internal dan dapat digunakan untuk monitoring, reporting, analytics, integrasi perpajakan, ERP, CRM, maupun sistem operasional lainnya.

### Objectives

* Mengambil data transaksi dari API AYO secara real-time.
* Menyimpan seluruh histori transaksi ke database internal.
* Menampilkan dashboard monitoring transaksi.
* Menyediakan API internal untuk sistem lain.
* Mengurangi ketergantungan terhadap dashboard AYO.
* Menjadi fondasi integrasi ke sistem perpajakan, accounting, dan business intelligence.

### Success Metrics

* Data transaksi tersinkronisasi < 1 menit dari AYO.
* Akurasi sinkronisasi > 99.9%.
* Dashboard dapat diakses < 2 detik.
* Tidak ada transaksi duplikat.

---

# 2. Requirements

## Functional Requirements

### Authentication

* Login Administrator
* Role-based Access Control
* JWT Authentication

### Transaction Sync

* Menarik data transaksi dari API AYO
* Sinkronisasi otomatis
* Sinkronisasi manual
* Retry jika API gagal
* Logging seluruh aktivitas sinkronisasi

### Transaction Management

* Menampilkan daftar transaksi
* Filter berdasarkan:

  * Tanggal
  * Cabang
  * Customer
  * Status
  * Payment Method

### Dashboard

Menampilkan:

* Total transaksi hari ini
* Revenue hari ini
* Revenue bulanan
* Jumlah customer
* Transaksi per jam
* Top selling services
* Occupancy rate

### Reporting

* Export Excel
* Export CSV
* Export PDF
* Scheduled Reports

### Integration

* REST API Internal
* Webhook untuk aplikasi lain

---

## Non Functional Requirements

### Performance

* Response dashboard < 2 detik
* Sinkronisasi maksimal 1 menit

### Security

* HTTPS
* JWT Authentication
* API Key Encryption
* Audit Log

### Scalability

* Mendukung multi-cabang
* Mendukung >100.000 transaksi

### Availability

* Uptime 99.9%

---

# 3. Core Features

## Feature 1 — Real-Time Transaction Sync

Mengambil transaksi terbaru dari API AYO secara otomatis.

### Capabilities

* Auto polling API
* Delta Sync
* Retry mechanism
* Error handling

---

## Feature 2 — Transaction Dashboard

Monitoring transaksi secara real-time.

### Widgets

* Revenue Today
* Revenue This Month
* Transactions Count
* Top Services
* Revenue Trend
* Payment Breakdown

---

## Feature 3 — Transaction Explorer

Pencarian transaksi cepat.

### Filters

* Date Range
* Branch
* Customer
* Status
* Payment Type

---

## Feature 4 — Reporting Center

Generate laporan bisnis.

### Reports

* Daily Sales
* Monthly Revenue
* Customer Report
* Service Report

---

## Feature 5 — Webhook Integration

Mengirim event transaksi ke aplikasi lain.

### Event Examples

* transaction.created
* transaction.updated
* payment.completed
* booking.completed

---

## Feature 6 — Audit & Monitoring

Mencatat semua aktivitas sistem.

### Logs

* API Requests
* Sync Status
* User Activity
* Failed Jobs

---

# 4. User Flow

## Automatic Sync Flow

AYO API
↓
Scheduler Trigger
↓
Fetch Transactions
↓
Validate Data
↓
Save Database
↓
Update Dashboard
↓
Trigger Webhook
↓
Audit Log

---

## User Dashboard Flow

Login
↓
Dashboard
↓
View Revenue
↓
View Transactions
↓
Filter Data
↓
Export Report

---

## Manual Sync Flow

Admin
↓
Click Sync Now
↓
Fetch Latest Data
↓
Validate
↓
Store Database
↓
Success Notification

---

# 5. Architecture

## High Level Architecture

┌────────────────────┐
│ AYO Production API │
└─────────┬──────────┘
│
▼
┌────────────────────┐
│ Sync Service │
│ (Cron Worker) │
└─────────┬──────────┘
│
▼
┌────────────────────┐
│ Backend API │
│ Node.js/NestJS │
└─────────┬──────────┘
│
├──────────────┐
│ │
▼ ▼

PostgreSQL Redis

│
▼

Next.js Dashboard

│
▼

Users/Admin

---

## Recommended Tech Stack

### Frontend

* Next.js 15
* React
* ShadCN
* Recharts

### Backend

* NestJS
* TypeScript
* REST API

### Database

* PostgreSQL

### Queue

* Redis
* BullMQ

### Hosting

* Vercel (Frontend)
* Railway / VPS (Backend)
* Supabase PostgreSQL / Neon

---

# 6. Design & Technical Constraints

## AYO API Dependency

Risiko:

* API downtime
* Rate limit
* API changes

Mitigasi:

* Retry mechanism
* Queue processing
* Error monitoring

---

## Data Consistency

Harus mencegah:

* Duplicate transaction
* Missing transaction
* Partial updates

Solusi:

* Unique External ID
* Upsert Strategy
* Sync checkpoints

---

## Security Constraints

* API Key encrypted
* IP Whitelist
* HTTPS only
* Audit logging

---

## Scalability Constraints

Desain harus mampu:

* Multi outlet
* Multi venue
* > 1 juta transaksi

---

# 7. Entity Relationship Diagram (ERD)

## Users

| Field      | Type      |
| ---------- | --------- |
| id         | UUID      |
| name       | String    |
| email      | String    |
| role       | Enum      |
| created_at | Timestamp |

---

## Branches

| Field         | Type   |
| ------------- | ------ |
| id            | UUID   |
| ayo_branch_id | String |
| name          | String |
| address       | Text   |

---

## Customers

| Field           | Type   |
| --------------- | ------ |
| id              | UUID   |
| ayo_customer_id | String |
| name            | String |
| phone           | String |
| email           | String |

---

## Transactions

| Field              | Type      |
| ------------------ | --------- |
| id                 | UUID      |
| ayo_transaction_id | String    |
| branch_id          | UUID      |
| customer_id        | UUID      |
| transaction_date   | Timestamp |
| total_amount       | Decimal   |
| payment_method     | String    |
| status             | String    |

---

## Transaction Items

| Field          | Type    |
| -------------- | ------- |
| id             | UUID    |
| transaction_id | UUID    |
| service_name   | String  |
| qty            | Integer |
| price          | Decimal |
| subtotal       | Decimal |

---

## Payments

| Field          | Type      |
| -------------- | --------- |
| id             | UUID      |
| transaction_id | UUID      |
| payment_type   | String    |
| amount         | Decimal   |
| payment_date   | Timestamp |

---

## Sync Logs

| Field             | Type      |
| ----------------- | --------- |
| id                | UUID      |
| sync_time         | Timestamp |
| status            | String    |
| records_processed | Integer   |
| error_message     | Text      |

---

## Relationships

Users
│
├── manages
│
Branches

Customers
│
└── Transactions
│
└── TransactionItems

Transactions
│
├── Payments
│
└── SyncLogs

---

# 8. Development Phases

## Phase 1 — Foundation (1 Week)

Deliverables:

* Setup Repository
* Database Design
* Authentication
* API Integration Setup

---

## Phase 2 — Sync Engine (1 Week)

Deliverables:

* API Connector
* Scheduler
* Retry Logic
* Logging

---

## Phase 3 — Dashboard (1-2 Weeks)

Deliverables:

* Dashboard UI
* Transaction Table
* Filtering
* Search

---

## Phase 4 — Reporting (1 Week)

Deliverables:

* Excel Export
* CSV Export
* PDF Export

---

## Phase 5 — Integration Layer (1 Week)

Deliverables:

* Internal API
* Webhook Engine

---

## Phase 6 — Monitoring & Deployment (1 Week)

Deliverables:

* Audit Logs
* Error Tracking
* Production Deployment

---

# Estimated Timeline

| Phase       | Duration |
| ----------- | -------- |
| Foundation  | 1 Week   |
| Sync Engine | 1 Week   |
| Dashboard   | 2 Weeks  |
| Reporting   | 1 Week   |
| Integration | 1 Week   |
| Deployment  | 1 Week   |

Total Development Time:
7–8 Weeks

---

# Future Roadmap

Version 2.0

* Real-time WebSocket Updates
* Multi-company Support
* AI Revenue Prediction
* WhatsApp Notifications
* Power BI Connector
* Data Warehouse Integration
* Automated Financial Reconciliation
