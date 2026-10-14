<?php
header('Content-Type: application/json');
header('Cache-Control: no-store, private');

$scriptDirectory = str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/'));
$cookiePath = rtrim($scriptDirectory, '/') . '/';
session_set_cookie_params([
    'httponly' => true,
    'secure' => !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
    'samesite' => 'Lax',
    'path' => $cookiePath ?: '/'
]);
session_start();

$action = $_GET['action'] ?? '';
$usersFile = __DIR__ . '/users.json';
$dataDir = __DIR__ . '/data';

function respond($payload, $status = 200) {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

function requestData() {
    $input = json_decode(file_get_contents('php://input'), true);
    return is_array($input) ? $input : [];
}

function requireLogin($role = null) {
    $user = $_SESSION['user'] ?? null;
    if (!$user || !isset($user['role'], $user['id'])) {
        respond(['success' => false, 'message' => 'Sesi login tidak valid atau telah berakhir. Silakan login kembali.'], 401);
    }
    if ($role !== null && $user['role'] !== $role) {
        respond(['success' => false, 'message' => 'Akses ditolak.'], 403);
    }
    return $user;
}

function allowedFilename($filename) {
    return is_string($filename)
        && strcasecmp($filename, 'status.json') !== 0
        && preg_match('/\A[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,98}\.(py|html|js|css|json|txt)\z/i', $filename) === 1;
}

function sanitize($value) {
    return preg_replace('/[^a-zA-Z0-9_-]/', '', (string)$value);
}

function saveUsers($usersFile, $usersData) {
    return file_put_contents($usersFile, json_encode($usersData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX) !== false;
}

function sanitize_folder($str) {
    $clean = preg_replace('/[^a-zA-Z0-9_\-\s]/', '', $str);
    return trim($clean) ?: 'TANPA_ROMBEL';
}

function createSecureFolder($dir) {
    if (!file_exists($dir)) {
        if (!mkdir($dir, 0750, true) && !is_dir($dir)) {
            respond(['success' => false, 'message' => 'Gagal membuat folder penyimpanan.'], 500);
        }
    }
    $indexFile = $dir . '/index.php';
    if (!file_exists($indexFile)) {
        file_put_contents($indexFile, '<?php http_response_code(403); exit("403 Forbidden - Access Denied"); ?>');
    }
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && ($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'XMLHttpRequest') {
    respond(['success' => false, 'message' => 'Permintaan tidak valid.'], 403);
}

createSecureFolder($dataDir);

function getUserFolder($role, $id, $dataDir, $usersFile) {
    $idClean = sanitize($id);
    if ($role === 'guru') {
        $guruDir = $dataDir . '/_GURU/' . $idClean;
        createSecureFolder($dataDir . '/_GURU');
        createSecureFolder($guruDir);
        return $guruDir;
    }

    $rombel = 'TANPA_ROMBEL';
    if (file_exists($usersFile)) {
        $usersData = json_decode(file_get_contents($usersFile), true)['siswa'] ?? [];
        foreach ($usersData as $s) {
            if (($s['nipd'] ?? '') === $idClean) {
                $rombel = sanitize_folder($s['rombel_saat_ini'] ?? 'TANPA_ROMBEL');
                break;
            }
        }
    }

    $rombelDir = $dataDir . '/' . $rombel;
    createSecureFolder($rombelDir);

    $studentDir = $rombelDir . '/' . $idClean;
    createSecureFolder($studentDir);

    return $studentDir;
}

if ($action === 'login') {
    $input = requestData();
    $role = $input['role'] ?? '';
    
    if (!file_exists($usersFile)) {
        respond(['success' => false, 'message' => 'File users.json tidak ditemukan!'], 500);
    }
    
    $usersData = json_decode(file_get_contents($usersFile), true);
    if (!is_array($usersData)) {
        respond(['success' => false, 'message' => 'File users.json tidak valid.'], 500);
    }
    if (!isset($usersData['siswa']) || !is_array($usersData['siswa'])) {
        $usersData['siswa'] = [];
    }
    if (!isset($usersData['guru']) || !is_array($usersData['guru'])) {
        $usersData['guru'] = [];
    }

    $verifyPassword = function (&$record, $password) use ($usersFile, &$usersData) {
        $storedPassword = (string)($record['password'] ?? '');
        $isHashed = str_starts_with($storedPassword, '$2y$')
            || str_starts_with($storedPassword, '$argon2i$')
            || str_starts_with($storedPassword, '$argon2id$');
        $valid = $isHashed
            ? password_verify($password, $storedPassword)
            : hash_equals($storedPassword, $password);

        if ($valid && !$isHashed) {
            $record['password'] = password_hash($password, PASSWORD_DEFAULT);
            if (!saveUsers($usersFile, $usersData)) {
                respond(['success' => false, 'message' => 'Gagal memperbarui penyimpanan password.'], 500);
            }
        }
        return $valid;
    };

    if ($role === 'siswa') {
        $nipd = trim((string)($input['nipd'] ?? ''));
        $password = (string)($input['password'] ?? '');
        $found = null;

        foreach ($usersData['siswa'] as &$s) {
            if (($s['nipd'] ?? '') === $nipd && $verifyPassword($s, $password)) {
                $found = $s;
                break;
            }
        }
        unset($s);
        
        if ($found) {
            $studentFolder = getUserFolder('siswa', $found['nipd'], $dataDir, $usersFile);
            if (!file_exists($studentFolder . '/main.py')) {
                file_put_contents($studentFolder . '/main.py', "# Selamat datang " . $found['nama'] . "\nnama = input(\"Masukkan nama: \")\nprint(f\"Halo {nama}\")");
                file_put_contents($studentFolder . '/status.json', json_encode(['active_file' => 'main.py']));
            }

            unset($found['password']);
            session_regenerate_id(true);
            $_SESSION['user'] = ['role' => 'siswa', 'id' => $found['nipd'], 'profile' => $found];
            respond(['success' => true, 'user' => $found]);
        } else {
            respond(['success' => false, 'message' => 'NIPD atau Password Siswa salah!'], 401);
        }
    } elseif ($role === 'guru') {
        $username = trim((string)($input['username'] ?? ''));
        $password = (string)($input['password'] ?? '');
        $found = null;

        foreach ($usersData['guru'] as &$g) {
            if (($g['username'] ?? '') === $username && $verifyPassword($g, $password)) {
                $found = $g;
                break;
            }
        }
        unset($g);

        if ($found) {
            $guruFolder = getUserFolder('guru', $found['username'], $dataDir, $usersFile);
            if (!file_exists($guruFolder . '/main.py')) {
                file_put_contents($guruFolder . '/main.py', "# Lab Coding Pengajar\nprint('Halo dari Workspace Guru!')");
                file_put_contents($guruFolder . '/status.json', json_encode(['active_file' => 'main.py']));
            }

            unset($found['password']);
            session_regenerate_id(true);
            $_SESSION['user'] = ['role' => 'guru', 'id' => $found['username'], 'profile' => $found];
            respond(['success' => true, 'user' => $found]);
        } else {
            respond(['success' => false, 'message' => 'Username atau Password Guru salah!'], 401);
        }
    } else {
        respond(['success' => false, 'message' => 'Role tidak valid.'], 400);
    }
}

if ($action === 'session') {
    $user = $_SESSION['user'] ?? null;
    if (!$user || !isset($user['role'], $user['id'], $user['profile'])) {
        respond(['success' => false, 'message' => 'Belum login.'], 401);
    }
    respond(['success' => true, 'user' => $user['profile'], 'role' => $user['role']]);
}

if ($action === 'logout') {
    requireLogin();
    $_SESSION = [];
    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
    }
    session_destroy();
    respond(['success' => true]);
}

if ($action === 'get_classes') {
    requireLogin('guru');
    $usersData = json_decode(file_get_contents($usersFile), true)['siswa'] ?? [];
    $classes = [];
    foreach ($usersData as $s) {
        $rombel = $s['rombel_saat_ini'] ?? '';
        if (!empty($rombel) && !in_array($rombel, $classes)) {
            $classes[] = $rombel;
        }
    }
    sort($classes);
    respond(['success' => true, 'classes' => $classes]);
}

if ($action === 'get_accounts') {
    requireLogin('guru');
    if (!file_exists($usersFile)) {
        respond(['success' => false, 'message' => 'File users.json tidak ditemukan.'], 500);
    }
    $usersData = json_decode(file_get_contents($usersFile), true);
    if (!is_array($usersData) || !isset($usersData['siswa'], $usersData['guru'])
        || !is_array($usersData['siswa']) || !is_array($usersData['guru'])) {
        respond(['success' => false, 'message' => 'Struktur users.json tidak valid.'], 500);
    }

    $accounts = [];
    foreach ($usersData['siswa'] as $student) {
        $accounts[] = [
            'role' => 'siswa',
            'identifier' => (string)($student['nipd'] ?? ''),
            'name' => (string)($student['nama'] ?? ''),
            'class' => (string)($student['rombel_saat_ini'] ?? '')
        ];
    }
    foreach ($usersData['guru'] as $teacher) {
        $accounts[] = [
            'role' => 'guru',
            'identifier' => (string)($teacher['username'] ?? ''),
            'name' => (string)($teacher['name'] ?? ''),
            'class' => ''
        ];
    }
    respond(['success' => true, 'accounts' => $accounts]);
}

if ($action === 'create_account') {
    requireLogin('guru');
    $input = requestData();
    $role = (string)($input['role'] ?? '');
    $identifier = trim((string)($input['identifier'] ?? ''));
    $name = trim((string)($input['name'] ?? ''));
    $password = trim((string)($input['password'] ?? ''));

    if (!in_array($role, ['siswa', 'guru'], true)
        || preg_match('/\A[a-zA-Z0-9_-]{1,64}\z/', $identifier) !== 1
        || $name === '' || strlen($name) > 120
        || strlen($password) < 8 || strlen($password) > 128) {
        respond(['success' => false, 'message' => 'Data akun tidak valid. Pastikan ID, nama, dan password (minimal 8 karakter) benar.'], 400);
    }

    if (!file_exists($usersFile)) {
        respond(['success' => false, 'message' => 'File users.json tidak ditemukan.'], 500);
    }
    $usersData = json_decode(file_get_contents($usersFile), true);
    if (!is_array($usersData) || !isset($usersData['siswa'], $usersData['guru'])
        || !is_array($usersData['siswa']) || !is_array($usersData['guru'])) {
        respond(['success' => false, 'message' => 'Struktur users.json tidak valid.'], 500);
    }

    $collection = $role === 'siswa' ? 'siswa' : 'guru';
    $idField = $role === 'siswa' ? 'nipd' : 'username';
    foreach ($usersData[$collection] as $account) {
        if ((string)($account[$idField] ?? '') === $identifier) {
            respond(['success' => false, 'message' => 'ID akun sudah digunakan.'], 409);
        }
    }

    $record = [
        $idField => $identifier,
        ($role === 'siswa' ? 'nama' : 'name') => $name,
        'password' => password_hash($password, PASSWORD_DEFAULT)
    ];
    if ($role === 'siswa') {
        $rombel = trim((string)($input['rombel'] ?? ''));
        $gender = (string)($input['gender'] ?? '');
        if ($rombel === '' || strlen($rombel) > 80 || !in_array($gender, ['L', 'P'], true)) {
            respond(['success' => false, 'message' => 'Rombel dan jenis kelamin siswa wajib diisi.'], 400);
        }
        $record['jk'] = $gender;
        $record['rombel_saat_ini'] = $rombel;
    }

    $usersData[$collection][] = $record;
    if (!saveUsers($usersFile, $usersData)) {
        respond(['success' => false, 'message' => 'Gagal menyimpan akun baru.'], 500);
    }
    respond(['success' => true, 'message' => 'Akun berhasil ditambahkan.']);
}

if ($action === 'reset_account_password') {
    $actingUser = requireLogin('guru');
    $input = requestData();
    $role = (string)($input['role'] ?? '');
    $identifier = trim((string)($input['identifier'] ?? ''));
    $password = trim((string)($input['password'] ?? ''));
    if (!in_array($role, ['siswa', 'guru'], true)
        || preg_match('/\A[a-zA-Z0-9_-]{1,64}\z/', $identifier) !== 1
        || strlen($password) < 8 || strlen($password) > 128) {
        respond(['success' => false, 'message' => 'ID atau password tidak valid. Password minimal 8 karakter.'], 400);
    }
    if ($role === 'guru' && $identifier === $actingUser['id']) {
        respond(['success' => false, 'message' => 'Gunakan menu Password untuk mengganti password akun sendiri.'], 400);
    }
    if (!file_exists($usersFile)) {
        respond(['success' => false, 'message' => 'File users.json tidak ditemukan.'], 500);
    }
    $usersData = json_decode(file_get_contents($usersFile), true);
    if (!is_array($usersData) || !isset($usersData['siswa'], $usersData['guru'])
        || !is_array($usersData['siswa']) || !is_array($usersData['guru'])) {
        respond(['success' => false, 'message' => 'Struktur users.json tidak valid.'], 500);
    }

    $collection = $role === 'siswa' ? 'siswa' : 'guru';
    $idField = $role === 'siswa' ? 'nipd' : 'username';
    foreach ($usersData[$collection] as &$account) {
        if ((string)($account[$idField] ?? '') === $identifier) {
            $account['password'] = password_hash($password, PASSWORD_DEFAULT);
            unset($account);
            if (!saveUsers($usersFile, $usersData)) {
                respond(['success' => false, 'message' => 'Gagal menyimpan password baru.'], 500);
            }
            respond(['success' => true, 'message' => 'Password akun berhasil direset.']);
        }
    }
    unset($account);
    respond(['success' => false, 'message' => 'Akun tidak ditemukan.'], 404);
}

if ($action === 'change_password') {
    $user = requireLogin();
    $input = requestData();
    $role = $user['role'];
    $id = $user['id'];
    $oldPassword = (string)($input['old_password'] ?? '');
    $newPassword = (string)($input['new_password'] ?? '');

    if (empty($newPassword)) {
        respond(['success' => false, 'message' => 'Password baru tidak boleh kosong!'], 400);
    }

    $usersData = json_decode(file_get_contents($usersFile), true);
    $updated = false;

    if ($role === 'siswa') {
        foreach ($usersData['siswa'] as &$s) {
            if ($s['nipd'] === $id) {
                if (!password_verify($oldPassword, $s['password']) && !hash_equals($s['password'], $oldPassword)) {
                    respond(['success' => false, 'message' => 'Password lama tidak cocok!'], 400);
                }
                $s['password'] = password_hash($newPassword, PASSWORD_DEFAULT);
                $updated = true;
                break;
            }
        }
    } elseif ($role === 'guru') {
        foreach ($usersData['guru'] as &$g) {
            if ($g['username'] === $id) {
                if (!password_verify($oldPassword, $g['password']) && !hash_equals($g['password'], $oldPassword)) {
                    respond(['success' => false, 'message' => 'Password lama tidak cocok!'], 400);
                }
                $g['password'] = password_hash($newPassword, PASSWORD_DEFAULT);
                $updated = true;
                break;
            }
        }
    }

    if ($updated) {
        if (!saveUsers($usersFile, $usersData)) {
            respond(['success' => false, 'message' => 'Gagal menyimpan password baru.'], 500);
        }
        session_destroy();
        respond(['success' => true, 'message' => 'Password berhasil diubah! Silakan login kembali.']);
    } else {
        respond(['success' => false, 'message' => 'Pengguna tidak ditemukan!'], 404);
    }
}

if ($action === 'set_active_file') {
    $user = requireLogin();
    $input = requestData();
    $role = $user['role'];
    $id = $user['id'];
    $filename = $input['filename'] ?? 'main.py';
    if (!allowedFilename($filename)) {
        respond(['success' => false, 'message' => 'Nama atau tipe file tidak diizinkan.'], 400);
    }

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    if (file_exists($folder)) {
        if (!file_exists($folder . '/' . $filename)) {
            respond(['success' => false, 'message' => 'File tidak ditemukan.'], 404);
        }
        if (file_put_contents($folder . '/status.json', json_encode(['active_file' => $filename]), LOCK_EX) === false) {
            respond(['success' => false, 'message' => 'Gagal menyimpan file aktif.'], 500);
        }
    }
    respond(['success' => true]);
}

if ($action === 'get_files') {
    $user = requireLogin();
    $role = $user['role'];
    $id = $user['id'];
    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    $files = [];
    $activeFile = 'main.py';

    if (file_exists($folder)) {
        $scanned = scandir($folder);
        $allowedExts = ['py', 'html', 'js', 'css', 'json', 'txt'];

        foreach ($scanned as $f) {
            $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
            if (allowedFilename($f) && in_array($ext, $allowedExts, true)) {
                $files[$f] = file_get_contents($folder . '/' . $f);
            }
        }

        $activeFile = isset($files['main.py']) ? 'main.py' : (array_key_first($files) ?? 'main.py');
        if (file_exists($folder . '/status.json')) {
            $status = json_decode(file_get_contents($folder . '/status.json'), true);
            if (is_array($status) && is_string($status['active_file'] ?? null)
                && isset($files[$status['active_file']])) {
                $activeFile = $status['active_file'];
            }
        }
    }

    respond(['success' => true, 'files' => $files, 'active_file' => $activeFile]);
}

if ($action === 'save_file') {
    $user = requireLogin();
    $input = requestData();
    $role = $user['role'];
    $id = $user['id'];
    $filename = $input['filename'] ?? 'main.py';
    $content = $input['content'] ?? '';
    if (!allowedFilename($filename) || !is_string($content)) {
        respond(['success' => false, 'message' => 'Nama file atau isi file tidak valid.'], 400);
    }
    if (strlen($content) > 1048576) {
        respond(['success' => false, 'message' => 'Ukuran file maksimum adalah 1 MB.'], 413);
    }

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    if (file_put_contents($folder . '/' . $filename, $content, LOCK_EX) === false
        || file_put_contents($folder . '/status.json', json_encode(['active_file' => $filename]), LOCK_EX) === false) {
        respond(['success' => false, 'message' => 'Gagal menyimpan file.'], 500);
    }
    
    respond(['success' => true]);
}

if ($action === 'share_file') {
    $teacher = requireLogin('guru');
    $input = requestData();
    $filename = $input['filename'] ?? '';
    $recipients = $input['recipients'] ?? null;
    if (!allowedFilename($filename) || !is_array($recipients) || count($recipients) < 1 || count($recipients) > 100) {
        respond(['success' => false, 'message' => 'File atau daftar siswa tidak valid. Pilih 1 sampai 100 siswa.'], 400);
    }

    $uniqueRecipients = [];
    foreach ($recipients as $recipient) {
        if (!is_string($recipient) || preg_match('/\A[a-zA-Z0-9_-]{1,64}\z/', $recipient) !== 1) {
            respond(['success' => false, 'message' => 'NIPD siswa tidak valid.'], 400);
        }
        $uniqueRecipients[$recipient] = true;
    }

    $usersData = json_decode(file_get_contents($usersFile), true);
    if (!is_array($usersData) || !isset($usersData['siswa']) || !is_array($usersData['siswa'])) {
        respond(['success' => false, 'message' => 'Data akun siswa tidak valid.'], 500);
    }

    $studentsById = [];
    foreach ($usersData['siswa'] as $student) {
        $studentId = (string)($student['nipd'] ?? '');
        if (isset($uniqueRecipients[$studentId])) {
            $studentsById[$studentId] = $student;
        }
    }
    if (count($studentsById) !== count($uniqueRecipients)) {
        respond(['success' => false, 'message' => 'Satu atau lebih siswa yang dipilih tidak ditemukan. Muat ulang daftar siswa.'], 404);
    }

    $teacherFolder = getUserFolder('guru', $teacher['id'], $dataDir, $usersFile);
    $sourcePath = $teacherFolder . '/' . $filename;
    if (!is_file($sourcePath)) {
        respond(['success' => false, 'message' => 'File guru tidak ditemukan. Simpan file lalu coba lagi.'], 404);
    }
    $content = file_get_contents($sourcePath);
    if ($content === false) {
        respond(['success' => false, 'message' => 'Gagal membaca file guru.'], 500);
    }
    if (strlen($content) > 1048576) {
        respond(['success' => false, 'message' => 'Ukuran file maksimum adalah 1 MB.'], 413);
    }

    $extension = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
    $sourceName = pathinfo($filename, PATHINFO_FILENAME);
    $sharedPrefix = 'guru_' . substr(hash('sha256', $teacher['id']), 0, 8) . '_';
    $results = [];
    $failures = [];
    foreach ($studentsById as $studentId => $student) {
        $studentFolder = getUserFolder('siswa', $studentId, $dataDir, $usersFile);
        $suffix = '.' . $extension;
        $availableNameLength = 99 - strlen($sharedPrefix) - strlen($suffix);
        $baseName = substr($sourceName, 0, $availableNameLength);
        $sharedFilename = $sharedPrefix . $baseName . $suffix;
        $version = 2;
        while (file_exists($studentFolder . '/' . $sharedFilename)) {
            $versionSuffix = '_' . $version++;
            $sharedFilename = $sharedPrefix
                . substr($sourceName, 0, $availableNameLength - strlen($versionSuffix))
                . $versionSuffix . $suffix;
        }

        if (file_put_contents($studentFolder . '/' . $sharedFilename, $content, LOCK_EX) === false) {
            $failures[] = ['name' => (string)($student['nama'] ?? ''), 'nipd' => $studentId];
            continue;
        }
        $results[] = [
            'name' => (string)($student['nama'] ?? ''),
            'nipd' => $studentId,
            'filename' => $sharedFilename
        ];
    }

    if (count($failures) > 0) {
        respond([
            'success' => false,
            'message' => 'Sebagian file gagal dibagikan. Periksa izin folder data siswa.',
            'shared' => $results,
            'failed' => $failures
        ], 500);
    }
    respond(['success' => true, 'shared' => $results]);
}

if ($action === 'delete_file') {
    $user = requireLogin();
    $input = requestData();
    $role = $user['role'];
    $id = $user['id'];
    $filename = $input['filename'] ?? '';
    if (!allowedFilename($filename)) {
        respond(['success' => false, 'message' => 'Nama atau tipe file tidak diizinkan.'], 400);
    }

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    $filePath = $folder . '/' . $filename;
    if (file_exists($filePath)) {
        if (!unlink($filePath)) {
            respond(['success' => false, 'message' => 'Gagal menghapus file.'], 500);
        }
    }
    respond(['success' => true]);
}

if ($action === 'get_all_students_data') {
    requireLogin('guru');
    $usersData = json_decode(file_get_contents($usersFile), true)['siswa'] ?? [];
    $filterClass = trim($_GET['class'] ?? '');
    $searchQuery = strtolower(trim($_GET['search'] ?? ''));

    $result = [];
    $totalStudents = count($usersData);

    foreach ($usersData as $student) {
        $rombel = $student['rombel_saat_ini'] ?? '';
        $nama = $student['nama'] ?? '';
        $nipd = $student['nipd'] ?? '';

        if (!empty($filterClass) && $filterClass !== 'ALL' && $rombel !== $filterClass) {
            continue;
        }

        if (!empty($searchQuery)) {
            $namaMatch = str_contains(strtolower($nama), $searchQuery);
            $nipdMatch = str_contains(strtolower($nipd), $searchQuery);
            if (!$namaMatch && !$nipdMatch) {
                continue;
            }
        }

        $studentFolder = getUserFolder('siswa', $nipd, $dataDir, $usersFile);
        $code = "# Belum ada file";
        $activeFile = "main.py";
        $fileList = [];

        if (file_exists($studentFolder)) {
            if (file_exists($studentFolder . '/status.json')) {
                $status = json_decode(file_get_contents($studentFolder . '/status.json'), true);
                if (isset($status['active_file'])) {
                    $activeFile = $status['active_file'];
                }
            }

            $scanned = scandir($studentFolder);
            $allowedExts = ['py', 'html', 'js', 'css', 'json', 'txt'];

            foreach ($scanned as $f) {
                $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
                if (allowedFilename($f) && in_array($ext, $allowedExts, true)) {
                    $fileList[] = $f;
                }
            }

            if (!in_array($activeFile, $fileList, true)) {
                $activeFile = $fileList[0] ?? 'main.py';
            }
            if (in_array($activeFile, $fileList, true)) {
                $code = file_get_contents($studentFolder . '/' . $activeFile);
            }
        }

        $result[] = [
            'nipd' => $nipd,
            'nama' => $nama,
            'rombel' => $rombel,
            'activeFile' => $activeFile,
            'files' => $fileList,
            'code' => $code
        ];
    }

    respond([
        'success' => true,
        'total' => $totalStudents,
        'filtered_count' => count($result),
        'students' => $result
    ]);
}

if ($action === 'get_student_file_content') {
    requireLogin('guru');
    $nipd = $_GET['nipd'] ?? '';
    $filename = $_GET['filename'] ?? '';
    if (!allowedFilename($filename)) {
        respond(['success' => false, 'message' => 'Nama atau tipe file tidak diizinkan.'], 400);
    }

    $studentFolder = getUserFolder('siswa', $nipd, $dataDir, $usersFile);
    $filePath = $studentFolder . '/' . $filename;
    if (file_exists($filePath)) {
        respond(['success' => true, 'code' => file_get_contents($filePath)]);
    } else {
        respond(['success' => false, 'message' => 'File tidak ditemukan'], 404);
    }
}

respond(['success' => false, 'message' => 'Aksi tidak valid'], 404);