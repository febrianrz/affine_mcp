# Multi-akun AFFiNE

Satu container per akun, jadi kredensial dan profil tool terisolasi.

1. `cp account.env.example .env.kerja` (ulangi per akun), isi nilainya.
2. `docker compose up -d --build`
3. Daftarkan tiap akun di client MCP sebagai server terpisah:

```json
{
  "mcpServers": {
    "affine-kerja": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer <AFFINE_MCP_HTTP_TOKEN akun kerja>" }
    },
    "affine-pribadi": {
      "type": "http",
      "url": "http://127.0.0.1:3002/mcp",
      "headers": { "Authorization": "Bearer <AFFINE_MCP_HTTP_TOKEN akun pribadi>" }
    }
  }
}
```

Catatan: pakai akun AFFiNE khusus berhak minimal, token MCP unik per akun,
dan buka `destructive`/`admin` hanya bila memang perlu.
Nama grup di `AFFINE_DISABLED_GROUPS` mengikuti README utama.

## Banyak pengguna dan domain dalam satu deployment

Kalau akunnya dikelola aplikasi Anda dan jumlahnya banyak, jangan buat container per akun.
Pakai mode multi-tenant (`AFFINE_MCP_MULTI_TENANT=true`): aplikasi mengirim domain dan
kredensial pengguna di header saat `initialize`. Lihat bagian "Multi-tenant mode" di
`docs/configuration-and-deployment.md`.
