# Monitoring Integritas Data

Aktifkan modul privat dengan `AYOSERA_PRIVATE_TOOLS_USER_IDS=id-1,id-2`. Nilai kosong menonaktifkan modul untuk semua pengguna, termasuk supervisor.

Cron mingguan dapat memanggil `POST /api/cron/integration-audit` dengan `Authorization: Bearer $CRON_SECRET`. Endpoint ini read-only dan tidak menjalankan Sync AYO/Olsera atau auto-repair tanpa identity sumber yang terverifikasi.
