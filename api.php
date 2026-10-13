<?php
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST');
header('Access-Control-Allow-Headers: Content-Type');

$action = $_GET['action'] ?? '';
$usersFile = __DIR__ . '/users.json';
$dataDir = __DIR__ . '/data';

function sanitize($str) {
    return preg_replace('/[^a-zA-Z0-9_\-\.]/', '', $str);
}

function sanitize_folder($str) {
    $clean = preg_replace('/[^a-zA-Z0-9_\-\s]/', '', $str);
    return trim($clean) ?: 'TANPA_ROMBEL';
}

function createSecureFolder($dir) {
    if (!file_exists($dir)) {
        mkdir($dir, 0777, true);
    }
    $indexFile = $dir . '/index.php';
    if (!file_exists($indexFile)) {
        file_put_contents($indexFile, '<?php http_response_code(403); exit("403 Forbidden - Access Denied"); ?>');
    }
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
    $input = json_decode(file_get_contents('php://input'), true);
    $role = $input['role'] ?? '';
    
    if (!file_exists($usersFile)) {
        echo json_encode(['success' => false, 'message' => 'File users.json tidak ditemukan!']);
        exit;
    }
    
    $usersData = json_decode(file_get_contents($usersFile), true);

    if ($role === 'siswa') {
        $nipd = trim($input['nipd'] ?? '');
        $password = trim($input['password'] ?? '');
        $found = null;

        foreach ($usersData['siswa'] as $s) {
            if ($s['nipd'] === $nipd && $s['password'] === $password) {
                $found = $s;
                break;
            }
        }
        
        if ($found) {
            $studentFolder = getUserFolder('siswa', $found['nipd'], $dataDir, $usersFile);
            if (!file_exists($studentFolder . '/main.py')) {
                file_put_contents($studentFolder . '/main.py', "# Selamat datang " . $found['nama'] . "\nnama = input(\"Masukkan nama: \")\nprint(f\"Halo {nama}\")");
                file_put_contents($studentFolder . '/status.json', json_encode(['active_file' => 'main.py']));
            }

            unset($found['password']);
            echo json_encode(['success' => true, 'user' => $found]);
        } else {
            echo json_encode(['success' => false, 'message' => 'NIPD atau Password Siswa salah!']);
        }
    } elseif ($role === 'guru') {
        $username = trim($input['username'] ?? '');
        $password = trim($input['password'] ?? '');
        $found = null;

        foreach ($usersData['guru'] as $g) {
            if ($g['username'] === $username && $g['password'] === $password) {
                $found = $g;
                break;
            }
        }

        if ($found) {
            $guruFolder = getUserFolder('guru', $found['username'], $dataDir, $usersFile);
            if (!file_exists($guruFolder . '/main.py')) {
                file_put_contents($guruFolder . '/main.py', "# Lab Coding Pengajar\nprint('Halo dari Workspace Guru!')");
                file_put_contents($guruFolder . '/status.json', json_encode(['active_file' => 'main.py']));
            }

            unset($found['password']);
            echo json_encode(['success' => true, 'user' => $found]);
        } else {
            echo json_encode(['success' => false, 'message' => 'Username atau Password Guru salah!']);
        }
    }
    exit;
}

if ($action === 'get_classes') {
    $usersData = json_decode(file_get_contents($usersFile), true)['siswa'] ?? [];
    $classes = [];
    foreach ($usersData as $s) {
        $rombel = $s['rombel_saat_ini'] ?? '';
        if (!empty($rombel) && !in_array($rombel, $classes)) {
            $classes[] = $rombel;
        }
    }
    sort($classes);
    echo json_encode(['success' => true, 'classes' => $classes]);
    exit;
}

if ($action === 'change_password') {
    $input = json_decode(file_get_contents('php://input'), true);
    $role = $input['role'] ?? '';
    $id = trim($input['id'] ?? '');
    $oldPassword = trim($input['old_password'] ?? '');
    $newPassword = trim($input['new_password'] ?? '');

    if (empty($newPassword)) {
        echo json_encode(['success' => false, 'message' => 'Password baru tidak boleh kosong!']);
        exit;
    }

    $usersData = json_decode(file_get_contents($usersFile), true);
    $updated = false;

    if ($role === 'siswa') {
        foreach ($usersData['siswa'] as &$s) {
            if ($s['nipd'] === $id) {
                if ($s['password'] !== $oldPassword) {
                    echo json_encode(['success' => false, 'message' => 'Password lama tidak cocok!']);
                    exit;
                }
                $s['password'] = $newPassword;
                $updated = true;
                break;
            }
        }
    } elseif ($role === 'guru') {
        foreach ($usersData['guru'] as &$g) {
            if ($g['username'] === $id) {
                if ($g['password'] !== $oldPassword) {
                    echo json_encode(['success' => false, 'message' => 'Password lama tidak cocok!']);
                    exit;
                }
                $g['password'] = $newPassword;
                $updated = true;
                break;
            }
        }
    }

    if ($updated) {
        file_put_contents($usersFile, json_encode($usersData, JSON_PRETTY_PRINT));
        echo json_encode(['success' => true, 'message' => 'Password berhasil diubah!']);
    } else {
        echo json_encode(['success' => false, 'message' => 'Pengguna tidak ditemukan!']);
    }
    exit;
}

if ($action === 'set_active_file') {
    $input = json_decode(file_get_contents('php://input'), true);
    $role = $input['role'] ?? 'siswa';
    $id = $input['id'] ?? '';
    $filename = sanitize($input['filename'] ?? 'main.py');

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    if (file_exists($folder)) {
        file_put_contents($folder . '/status.json', json_encode(['active_file' => $filename]));
    }
    echo json_encode(['success' => true]);
    exit;
}

if ($action === 'get_files') {
    $role = $_GET['role'] ?? 'siswa';
    $id = $_GET['id'] ?? '';
    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    $files = [];
    $activeFile = 'main.py';

    if (file_exists($folder)) {
        $scanned = scandir($folder);
        $allowedExts = ['py', 'html', 'js', 'css'];

        foreach ($scanned as $f) {
            $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
            if ($f !== '.' && $f !== '..' && $f !== 'index.php' && in_array($ext, $allowedExts)) {
                $files[$f] = file_get_contents($folder . '/' . $f);
            }
        }

        if (file_exists($folder . '/status.json')) {
            $status = json_decode(file_get_contents($folder . '/status.json'), true);
            if (isset($status['active_file']) && $status['active_file'] !== 'index.php') {
                $activeFile = $status['active_file'];
            }
        }
    }

    echo json_encode(['success' => true, 'files' => $files, 'active_file' => $activeFile]);
    exit;
}

if ($action === 'save_file') {
    $input = json_decode(file_get_contents('php://input'), true);
    $role = $input['role'] ?? 'siswa';
    $id = $input['id'] ?? '';
    $filename = sanitize($input['filename'] ?? 'main.py');
    $content = $input['content'] ?? '';

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    file_put_contents($folder . '/' . $filename, $content);
    file_put_contents($folder . '/status.json', json_encode(['active_file' => $filename]));
    
    echo json_encode(['success' => true]);
    exit;
}

if ($action === 'delete_file') {
    $input = json_decode(file_get_contents('php://input'), true);
    $role = $input['role'] ?? 'siswa';
    $id = $input['id'] ?? '';
    $filename = sanitize($input['filename'] ?? '');

    $folder = getUserFolder($role, $id, $dataDir, $usersFile);
    $filePath = $folder . '/' . $filename;
    if (file_exists($filePath)) {
        unlink($filePath);
    }
    echo json_encode(['success' => true]);
    exit;
}

if ($action === 'get_all_students_data') {
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
            $allowedExts = ['py', 'html', 'js', 'css'];

            foreach ($scanned as $f) {
                $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
                if ($f !== '.' && $f !== '..' && $f !== 'index.php' && in_array($ext, $allowedExts)) {
                    $fileList[] = $f;
                }
            }

            if (file_exists($studentFolder . '/' . $activeFile)) {
                $code = file_get_contents($studentFolder . '/' . $activeFile);
            } elseif (!empty($fileList)) {
                $activeFile = $fileList[0];
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

    echo json_encode([
        'success' => true,
        'total' => $totalStudents,
        'filtered_count' => count($result),
        'students' => $result
    ]);
    exit;
}

if ($action === 'get_student_file_content') {
    $nipd = $_GET['nipd'] ?? '';
    $filename = sanitize($_GET['filename'] ?? '');

    $studentFolder = getUserFolder('siswa', $nipd, $dataDir, $usersFile);
    $filePath = $studentFolder . '/' . $filename;
    if (file_exists($filePath)) {
        echo json_encode(['success' => true, 'code' => file_get_contents($filePath)]);
    } else {
        echo json_encode(['success' => false, 'message' => 'File tidak ditemukan']);
    }
    exit;
}

echo json_encode(['success' => false, 'message' => 'Aksi tidak valid']);