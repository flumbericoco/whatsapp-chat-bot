# Pesat.ai WhatsApp Chatbot Platform

Chatbot WhatsApp multi-tenant untuk company, jalan di Cloudflare Workers.
Satu deployment melayani banyak client. Tiap client punya nomor WhatsApp,
knowledge base, persona, dan kuota sendiri.

- **WhatsApp**: Meta Cloud API resmi (webhook based)
- **Otak**: Claude API + RAG dari knowledge base per tenant
- **Infra**: Cloudflare Workers, D1, Vectorize, Workers AI, KV, R2, Queues

---

## Arsitektur

```
Customer WhatsApp
       |
       v
Meta Cloud API  --webhook-->  Worker /webhook/whatsapp
                                    |  verifikasi HMAC signature
                                    |  cari tenant dari phone_number_id
                                    |  buang duplikat (processed_messages)
                                    v
                              Queue: wa-inbound        (balas 200 ke Meta < 1 detik)
                                    |
                                    v
                              Queue consumer
                                    |  rate limit per kontak
                                    |  cek kuota bulanan
                                    |  retrieve RAG (Vectorize, filter tenant_id)
                                    |  Claude Messages API + tools
                                    v
                              Graph API sendMessage
```

Webhook sengaja tidak memanggil Claude. Meta melakukan retry agresif kalau
webhook tidak dijawab dalam hitungan detik, jadi semua kerja berat dipindah ke
queue consumer.

### Isolasi antar tenant

Ini produk multi-tenant, jadi batas antar client harus jelas:

| Lapisan | Mekanisme |
|---|---|
| Routing pesan masuk | `wa_phone_number_id` unik per tenant |
| Knowledge base | Filter metadata `tenant_id` di setiap query Vectorize |
| Data SQL | Semua tabel punya `tenant_id`, query selalu menyertakannya |
| API key | Key tenant hanya bisa akses baris tenant sendiri |
| Token WhatsApp | Dienkripsi AES-GCM, tidak pernah plaintext di database |

---

## Setup

### 1. Prasyarat

- Node.js 20+
- Akun Cloudflare dengan **Workers Paid plan** (5 USD/bulan). D1, Queues,
  Vectorize, dan R2 tidak tersedia di free plan.
- Meta Business account + WhatsApp Business Platform app
- Anthropic API key

### 2. Buat resource Cloudflare

```bash
npm install
npx wrangler login

npx wrangler d1 create pesat-wa-bot
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create pesat-wa-docs
npx wrangler queues create wa-inbound
npx wrangler queues create wa-inbound-dlq
npx wrangler vectorize create pesat-kb --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index pesat-kb --property-name=tenant_id --type=string
```

Salin `database_id` dan KV `id` yang dikembalikan ke `wrangler.toml`,
menggantikan dua placeholder `REPLACE_WITH_...`.

> Dimensi `1024` harus cocok dengan model embedding `@cf/baai/bge-m3`.
> Model ini dipilih karena multilingual, jadi knowledge base bahasa Indonesia
> tetap terambil dengan baik.

### 3. Jalankan migration

```bash
npm run db:migrate:local   # untuk wrangler dev
npm run db:migrate         # untuk production
```

### 4. Set secrets

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put META_APP_SECRET       # Meta App Dashboard > Settings > Basic
npx wrangler secret put META_VERIFY_TOKEN     # string bebas, dipakai lagi di langkah 6
npx wrangler secret put ADMIN_API_KEY         # openssl rand -hex 32
npx wrangler secret put ENCRYPTION_KEY        # openssl rand -base64 32
```

`ENCRYPTION_KEY` wajib base64 dari tepat 32 byte. Kalau key ini hilang, semua
token WhatsApp tenant tidak bisa didekripsi lagi dan harus diinput ulang.

Untuk development lokal, salin `.dev.vars.example` menjadi `.dev.vars`.

### 5. Deploy

```bash
npm run deploy
```

### 6. Hubungkan Meta webhook

Di Meta App Dashboard, WhatsApp > Configuration:

- Callback URL: `https://pesat-wa-bot.<subdomain>.workers.dev/webhook/whatsapp`
- Verify token: nilai `META_VERIFY_TOKEN` di langkah 4
- Subscribe ke field **messages**

Meta akan langsung memanggil endpoint `GET` untuk verifikasi.

---

## Menambahkan client baru

Semua endpoint di bawah `/api` butuh header
`Authorization: Bearer <ADMIN_API_KEY>`.

```bash
curl -X POST https://<worker>/api/tenants \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Toko Sinar Jaya",
    "slug": "sinar-jaya",
    "wa_phone_number_id": "123456789012345",
    "wa_access_token": "EAAG...",
    "plan": "growth",
    "language": "id",
    "persona": "Toko elektronik di Surabaya, buka 09.00-17.00 WIB, melayani pengiriman se-Jawa Timur.",
    "greeting": "Halo! Selamat datang di Toko Sinar Jaya. Ada yang bisa kami bantu?",
    "escalation_number": "628123456789"
  }'
```

Response berisi `api_key` tenant. **Key ini hanya ditampilkan sekali** dan
hanya bisa mengakses data tenant tersebut, jadi aman diberikan ke client untuk
dashboard mereka sendiri.

Lalu isi knowledge base:

```bash
curl -X POST https://<worker>/api/tenants/<tenantId>/documents \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"title": "Daftar Harga 2026", "content": "..."}'
```

Cek apa yang akan dibaca bot sebelum customer bertanya:

```bash
curl -X POST https://<worker>/api/tenants/<tenantId>/search \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "berapa ongkir ke Malang?"}'
```

---

## API

| Method | Path | Akses | Fungsi |
|---|---|---|---|
| POST | `/api/tenants` | admin | Buat tenant, mengembalikan API key sekali |
| GET | `/api/tenants` | admin | Daftar semua tenant |
| GET | `/api/tenants/:id` | admin, tenant | Detail tenant plus pemakaian bulan ini |
| PATCH | `/api/tenants/:id` | admin, tenant | Ubah persona, greeting, model, token |
| POST | `/api/tenants/:id/rotate-key` | admin | Ganti API key tenant |
| DELETE | `/api/tenants/:id` | admin | Hapus tenant beserta vektornya |
| POST | `/api/tenants/:id/documents` | admin, tenant | Ingest dokumen knowledge base |
| GET | `/api/tenants/:id/documents` | admin, tenant | Daftar dokumen |
| DELETE | `/api/tenants/:id/documents/:docId` | admin, tenant | Hapus dokumen dan vektornya |
| POST | `/api/tenants/:id/search` | admin, tenant | Preview hasil retrieval |
| GET | `/api/tenants/:id/conversations` | admin, tenant | Daftar percakapan |
| GET | `/api/tenants/:id/conversations/:cid/messages` | admin, tenant | Transkrip |
| POST | `/api/tenants/:id/conversations/:cid/takeover` | admin, tenant | Agent ambil alih, bot diam |
| POST | `/api/tenants/:id/conversations/:cid/release` | admin, tenant | Kembalikan ke bot |
| POST | `/api/tenants/:id/conversations/:cid/send` | admin, tenant | Agent kirim pesan manual |
| GET | `/api/tenants/:id/leads` | admin, tenant | Lead yang ditangkap bot |
| GET | `/api/tenants/:id/usage` | admin, tenant | Kuota dan pemakaian harian |

`PATCH` oleh tenant tidak bisa mengubah `plan`, `monthly_quota`, atau
`status`. Itu setting komersial, khusus admin.

---

## Perilaku bot

**Tools.** Model punya dua tool. `escalate_to_human` mengubah status percakapan
jadi `human`, mengirim notifikasi ke `escalation_number`, dan membuat bot diam
sampai agent menekan release. `capture_lead` menyimpan nama, kontak, dan minat
customer ke tabel `leads`.

**Grounding.** System prompt melarang model mengarang harga, stok, waktu
kirim, alamat, dan kebijakan. Kalau tidak ada passage yang cocok, model
diinstruksikan mengaku tidak tahu dan menawarkan agent. Ini yang membedakan
produk yang bisa dijual dari demo yang menjawab ngawur soal harga.

**Jendela 24 jam.** WhatsApp hanya mengizinkan pesan teks bebas dalam 24 jam
sejak pesan terakhir customer. Endpoint `send` menolak dengan HTTP 409 di luar
jendela itu dan meminta template. Fungsi `sendTemplate` sudah tersedia untuk
kasus tersebut.

**Perintah khusus.** Customer bisa mengetik `/reset` untuk menghapus riwayat
percakapan. Berguna saat testing.

---

## Model dan biaya

Default `claude-opus-5` dengan adaptive thinking pada effort `low`. Thinking
sengaja dibiarkan menyala. Kalau thinking dimatikan di Opus 5, model kadang
menulis pemanggilan tool sebagai teks biasa alih-alih tool_use block, dan
eskalasi jadi diam-diam gagal. Effort `low` yang menurunkan biaya, bukan
mematikan thinking.

Kolom `model` per tenant memungkinkan paket murah pakai model lebih ringan
tanpa mengubah kode. Perkiraan biaya Claude per balasan, asumsi input sekitar
2.200 token dan output sekitar 350 token:

| Model | Input $/1M | Output $/1M | Perkiraan per balasan |
|---|---|---|---|
| `claude-opus-5` | 5.00 | 25.00 | ~$0.020 |
| `claude-sonnet-5` | 2.00 | 10.00 | ~$0.008 |
| `claude-haiku-4-5` | 1.00 | 5.00 | ~$0.004 |

Angka ini hanya biaya Claude, di luar Cloudflare dan Meta. Tarif berubah, jadi
cek harga terbaru sebelum menetapkan harga jual. Untuk paket 50 ribu per bulan,
Opus 5 tidak akan menutup biaya pada volume tinggi. Ukur dulu kualitas Haiku
4.5 dan Sonnet 5 pada knowledge base asli sebelum memutuskan paket mana pakai
model apa.

Meta tidak lagi menagih service conversation yang dimulai customer dalam
jendela 24 jam, tetapi template marketing dan utility tetap berbayar per
percakapan. Verifikasi tarif Indonesia terbaru di dokumentasi Meta.

---

## Pengendalian biaya yang sudah ada

- **Rate limit** 15 pesan per kontak per menit, ditolak sebelum memanggil model
- **Kuota bulanan** per tenant, dicek sebelum tiap balasan
- **Deduplikasi** `wa_message_id` di D1, retry Meta tidak menghasilkan tagihan ganda
- **Prompt caching** breakpoint di system prompt yang stabil per tenant
- **Batas 3 ronde tool** per pesan

Catatan soal caching: cache prefix baru aktif kalau prefix melewati batas
minimum token model. Persona yang pendek kemungkinan tidak akan kena cache.
Pantau `cache_read_input_tokens` kalau ingin memastikan.

---

## Development

```bash
npm run dev          # wrangler dev, butuh .dev.vars
npm run typecheck
npm test
npm run tail         # log production
```

Webhook lokal butuh tunnel publik agar Meta bisa memanggilnya, misalnya
`cloudflared tunnel --url http://localhost:8787`.

---

## Yang belum dikerjakan

Daftar jujur, supaya tidak dijanjikan ke client sebelum ada:

- Belum ada dashboard UI. Baru API, jadi client masih dilayani lewat curl atau
  frontend terpisah.
- Ingest dokumen baru menerima teks. PDF dan DOCX harus diekstrak di luar dulu.
- Pesan gambar, audio, dan dokumen dari customer diabaikan, hanya dicatat di log.
- Belum ada billing otomatis. Kuota diperiksa, tetapi penagihan masih manual.
- Belum ada tes integrasi end to end, baru unit test untuk chunker dan pemecah
  pesan WhatsApp.
- `business_hours` tersimpan di database tetapi belum dipakai logika apa pun.
