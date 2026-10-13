# PythonLive Studio

Aplikasi belajar coding multi-bahasa berbasis Vite, Monaco Editor, dan Pyodide, dengan API PHP untuk akun serta penyimpanan file.

## Persyaratan

- Node.js dan npm
- PHP dan Apache (Laragon direkomendasikan untuk API)

## Menjalankan saat pengembangan

1. Jalankan Apache dan PHP melalui Laragon.
2. Instal dependensi Node.js:

   ```bash
   npm ci
   ```

3. Jalankan Vite:

   ```bash
   npm run dev
   ```

   Browser akan terbuka otomatis. Pastikan URL proxy API pada `vite.config.js` sesuai dengan host dan nama folder Laragon Anda.

## Build untuk Laragon

Jalankan dari folder proyek:

```bash
npm run build
```

Hasil build ditempatkan langsung di folder proyek (`index.html`, `assets/`, dan `pyodide/`) agar dapat dibuka melalui:

```text
http://localhost/koding-python/
```

Setiap build membersihkan hanya folder output terkelola `assets/` dan `pyodide/` sebelum menghasilkan file baru. Ini menghapus aset bernama hash dari build sebelumnya tanpa menghapus `api.php`, `users.json`, `data/`, atau file proyek lain. `dist/` adalah output lama dan tidak digunakan oleh alur build saat ini.

## Konfigurasi dan data lokal

- `api.php` menangani login, pengelolaan kata sandi, file siswa/guru, dan data pemantauan.
- Data file disimpan di `data/`; folder ini tidak dimasukkan ke Git.
- Siapkan file konfigurasi dan akun lokal sebelum menjalankan aplikasi. Di PowerShell:

  ```powershell
  Copy-Item .env.example .env.local
  Copy-Item users.json.example users.json
  ```

- Sesuaikan `VITE_APP_TITLE` dan `VITE_API_BASE_URL` pada `.env.local`. Kosongkan `VITE_API_BASE_URL` untuk memakai URL relatif aplikasi, termasuk pada `http://localhost/koding-python/`.
- Ganti akun dan password dummy pada `users.json` dengan data lokal yang benar. File ini memakai password teks biasa; jangan gunakan password yang dipakai di layanan lain dan jangan unggah file aktual ke Git.
- `.env*` dan `users.json` diabaikan Git. `.env.example` dan `users.json.example` adalah template aman untuk dibagikan; variabel `VITE_*` akan dimasukkan ke bundle browser sehingga tidak boleh berisi rahasia.

## Catatan

Vite dapat menampilkan peringatan bahwa folder output build berada di luar source root. Ini disengaja karena output dipasang langsung di folder proyek Laragon. Pengosongan output umum Vite dinonaktifkan agar build tidak menghapus file backend atau data aplikasi.
