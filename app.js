import './style.css';
import * as lucide from 'lucide';
import * as monaco from 'monaco-editor';
import { loadPyodide } from 'pyodide';

// Konfigurasi Monaco Environment
self.MonacoEnvironment = {
  getWorker: function () {
    return null;
  }
};

const API_BASE = import.meta.env.VITE_API_BASE_URL || '';
const APP_TITLE = import.meta.env.VITE_APP_TITLE || 'PythonLive Studio';

// Otomatisasi URL Pyodide: CDN pada Dev mode, lokal folder pada Production build
const PYODIDE_INDEX_URL = import.meta.env.DEV
  ? "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
  : "./pyodide/";

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  return await fetch(url, options);
}

let currentUser = null;
let pyodideInstance = null;
let editor = null;
let inspectorEditor = null;
let files = {};
let activeFileName = 'main.py';
let teacherInterval = null;
let searchTimeout = null;
let currentTheme = localStorage.getItem('py_theme') || 'dark';

window.addEventListener('DOMContentLoaded', async () => {
  const appTitleHeader = document.getElementById('appTitleHeader');
  const appNavTitle = document.getElementById('appNavTitle');
  if (appTitleHeader) appTitleHeader.textContent = APP_TITLE;
  if (appNavTitle) appNavTitle.textContent = APP_TITLE;

  applyTheme(currentTheme);
  refreshIcons();

  // 1. Inisialisasi Monaco Editor lebih dulu agar elemen siap
  initMonacoEditor();
  setupAntiCopyPaste();

  // 2. Muat Sesi & File Siswa dari Backend
  checkSavedSession();

  // 3. Muat Pyodide
  await initPyodide();
});

function refreshIcons() {
  lucide.createIcons();
}

window.toggleTheme = function() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme(currentTheme);
};

function applyTheme(theme) {
  localStorage.setItem('py_theme', theme);
  const html = document.documentElement;
  const themeIcon = document.getElementById('themeIcon');

  if (theme === 'dark') {
    html.classList.add('dark');
    if (themeIcon) themeIcon.setAttribute('data-lucide', 'sun');
    if (editor) monaco.editor.setTheme('vs-dark');
    if (inspectorEditor) monaco.editor.setTheme('vs-dark');
  } else {
    html.classList.remove('dark');
    if (themeIcon) themeIcon.setAttribute('data-lucide', 'moon');
    if (editor) monaco.editor.setTheme('vs');
    if (inspectorEditor) monaco.editor.setTheme('vs');
  }
  refreshIcons();
}

function setupAntiCopyPaste() {
  ['copy', 'paste', 'cut', 'contextmenu', 'dragstart', 'drop'].forEach(eventType => {
    document.addEventListener(eventType, function(e) {
      if (currentUser && currentUser.role === 'siswa') {
        e.preventDefault();
        e.stopPropagation();

        if (eventType === 'copy') alert('⚠️ Dilarang Menyalin (Copy)!');
        else if (eventType === 'paste') alert('⚠️ Dilarang Menempel (Paste)!');
        else if (eventType === 'cut') alert('⚠️ Dilarang Mengubah (Cut)!');
        return false;
      }
    }, true);
  });

  document.addEventListener('keydown', function(e) {
    if (currentUser && currentUser.role === 'siswa') {
      const isCtrlOrCmd = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (
        (isCtrlOrCmd && (key === 'v' || key === 'c' || key === 'x')) ||
        (e.shiftKey && e.key === 'Insert')
      ) {
        e.preventDefault();
        e.stopPropagation();
        alert('⚠️ Akses Paste/Copy Dibatalkan! Anda wajib mengetik kode secara manual.');
        return false;
      }
    }
  }, true);
}

function checkSavedSession() {
  const saved = localStorage.getItem('py_user_session');
  if (saved) {
    currentUser = JSON.parse(saved);
    applyUserSession();
  } else {
    document.getElementById('loginModal').classList.remove('hidden');
  }
}

window.switchRoleTab = function(role) {
  const tabSiswa = document.getElementById('tabSiswaBtn');
  const tabGuru = document.getElementById('tabGuruBtn');
  const formSiswa = document.getElementById('formSiswa');
  const formGuru = document.getElementById('formGuru');

  if (role === 'siswa') {
    tabSiswa.className = "flex-1 py-2.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-2 bg-blue-600 text-white";
    tabGuru.className = "flex-1 py-2.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white";
    formSiswa.classList.remove('hidden');
    formGuru.classList.add('hidden');
  } else {
    tabGuru.className = "flex-1 py-2.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-2 bg-purple-600 text-white";
    tabSiswa.className = "flex-1 py-2.5 text-xs font-semibold rounded-lg transition flex items-center justify-center gap-2 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white";
    formGuru.classList.remove('hidden');
    formSiswa.classList.add('hidden');
  }
};

window.handleLoginSiswa = async function(e) {
  e.preventDefault();
  const nipd = document.getElementById('siswaNipd').value.trim();
  const password = document.getElementById('siswaPassword').value.trim();

  try {
    const res = await apiFetch('/api.php?action=login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ role: 'siswa', nipd, password })
    });
    const data = await res.json();

    if (data.success) {
      currentUser = { ...data.user, role: 'siswa' };
      localStorage.setItem('py_user_session', JSON.stringify(currentUser));
      applyUserSession();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert("Gagal terhubung ke server API!");
  }
};

window.handleLoginGuru = async function(e) {
  e.preventDefault();
  const username = document.getElementById('guruUsername').value.trim();
  const password = document.getElementById('guruPassword').value.trim();

  try {
    const res = await apiFetch('/api.php?action=login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ role: 'guru', username, password })
    });
    const data = await res.json();

    if (data.success) {
      currentUser = { ...data.user, role: 'guru' };
      localStorage.setItem('py_user_session', JSON.stringify(currentUser));
      applyUserSession();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert("Gagal terhubung ke server API!");
  }
};

window.openChangePasswordModal = function() {
  document.getElementById('changePasswordModal').classList.remove('hidden');
};

window.closeChangePasswordModal = function() {
  document.getElementById('changePasswordModal').classList.add('hidden');
};

window.handleChangePassword = async function(e) {
  e.preventDefault();
  const old_password = document.getElementById('oldPasswordInput').value.trim();
  const new_password = document.getElementById('newPasswordInput').value.trim();
  const id = currentUser.role === 'siswa' ? currentUser.nipd : currentUser.username;

  const res = await apiFetch('/api.php?action=change_password', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ role: currentUser.role, id, old_password, new_password })
  });

  const data = await res.json();
  alert(data.message);

  if (data.success) {
    document.getElementById('oldPasswordInput').value = '';
    document.getElementById('newPasswordInput').value = '';
    closeChangePasswordModal();
  }
};

function applyUserSession() {
  document.getElementById('loginModal').classList.add('hidden');
  const userInfoText = document.getElementById('userInfoText');
  const roleBadge = document.getElementById('roleBadge');
  const antiCopyBadge = document.getElementById('antiCopyBadge');
  const teacherNavTabs = document.getElementById('teacherNavTabs');

  if (currentUser.role === 'siswa') {
    roleBadge.textContent = 'Siswa';
    roleBadge.className = 'text-[10px] bg-blue-500/20 text-blue-600 dark:text-blue-300 border border-blue-500/30 px-2 py-0.5 rounded-full uppercase font-mono';
    userInfoText.textContent = `${currentUser.nama} (${currentUser.rombel_saat_ini})`;
    antiCopyBadge.classList.remove('hidden');
    teacherNavTabs.classList.add('hidden');

    document.getElementById('codingWorkspace').classList.remove('hidden');
    document.getElementById('teacherDashboard').classList.add('hidden');
    
    loadUserFilesFromServer();
  } else {
    roleBadge.textContent = 'Guru';
    roleBadge.className = 'text-[10px] bg-purple-500/20 text-purple-600 dark:text-purple-300 border border-purple-500/30 px-2 py-0.5 rounded-full uppercase font-mono';
    userInfoText.textContent = `${currentUser.name}`;
    antiCopyBadge.classList.add('hidden');
    teacherNavTabs.classList.remove('hidden');

    switchTeacherTab('monitoring');
    loadClassesDropdown();
    startTeacherMonitoring();
  }
}

window.switchTeacherTab = function(tab) {
  const navMonitorBtn = document.getElementById('navMonitorBtn');
  const navLabBtn = document.getElementById('navLabBtn');
  const teacherDashboard = document.getElementById('teacherDashboard');
  const codingWorkspace = document.getElementById('codingWorkspace');

  if (tab === 'monitoring') {
    navMonitorBtn.className = "px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 text-white flex items-center gap-1.5 transition";
    navLabBtn.className = "px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition";
    teacherDashboard.classList.remove('hidden');
    codingWorkspace.classList.add('hidden');
  } else {
    navLabBtn.className = "px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 text-white flex items-center gap-1.5 transition";
    navMonitorBtn.className = "px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition";
    teacherDashboard.classList.add('hidden');
    codingWorkspace.classList.remove('hidden');

    loadUserFilesFromServer();
  }
};

window.handleLogout = function() {
  if (confirm("Apakah Anda yakin ingin keluar?")) {
    localStorage.removeItem('py_user_session');
    location.reload();
  }
};

function getLanguage(filename) {
  if (filename.endsWith('.html') || filename.endsWith('.htm')) return 'html';
  if (filename.endsWith('.js')) return 'javascript';
  if (filename.endsWith('.css')) return 'css';
  if (filename.endsWith('.json')) return 'json';
  return 'python';
}

async function loadUserFilesFromServer() {
  try {
    const id = currentUser.role === 'siswa' ? currentUser.nipd : currentUser.username;
    const res = await apiFetch(`/api.php?action=get_files&role=${currentUser.role}&id=${id}`);
    const data = await res.json();
    if (data.success) {
      files = data.files;
      activeFileName = data.active_file || Object.keys(files)[0] || 'main.py';
      updateActiveFileInfo();
      if (editor) {
        editor.setValue(files[activeFileName] || '');
        monaco.editor.setModelLanguage(editor.getModel(), getLanguage(activeFileName));
      }
      renderFileList();
    }
  } catch (e) {}
}

function updateActiveFileInfo() {
  document.getElementById('activeFileNameText').textContent = activeFileName;
  const lang = getLanguage(activeFileName).toUpperCase();
  document.getElementById('langBadge').textContent = lang;
}

let saveTimeout = null;
function debounceSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    document.getElementById('syncStatus').textContent = '• Menyimpan...';
    const id = currentUser.role === 'siswa' ? currentUser.nipd : currentUser.username;
    await apiFetch('/api.php?action=save_file', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        role: currentUser.role,
        id: id,
        filename: activeFileName,
        content: editor.getValue()
      })
    });
    document.getElementById('syncStatus').textContent = '• Tersimpan';
  }, 600);
}

function renderFileList() {
  const container = document.getElementById('fileListContainer');
  container.innerHTML = '';

  Object.keys(files).forEach(fileName => {
    const isActive = fileName === activeFileName;
    const item = document.createElement('div');
    item.className = `flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer group transition ${
      isActive ? 'bg-blue-600/20 text-blue-600 dark:text-blue-300 font-medium border border-blue-500/30' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200'
    }`;
    
    item.innerHTML = `
      <div class="flex items-center gap-2 truncate" onclick="selectFile('${fileName}')">
        <i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-500' : 'text-slate-400'}"></i>
        <span class="truncate">${fileName}</span>
      </div>
      ${Object.keys(files).length > 1 ? `<button onclick="deleteFile('${fileName}')" class="opacity-0 group-hover:opacity-100 p-1 hover:text-red-500"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
    `;
    container.appendChild(item);
  });
  refreshIcons();
}

window.createNewFile = async function() {
  const name = prompt("Nama file baru (Contoh: index.html, script.js, main.py, style.css):", "latihan.py");
  if (!name) return;
  
  let formattedName = name.trim();
  if (!formattedName.includes('.')) formattedName += '.py';

  files[formattedName] = getLanguage(formattedName) === 'html' ? "<!-- Tulis kode HTML -->\n<h1>Halo World</h1>" : "# Kode Baru\n";
  activeFileName = formattedName;
  updateActiveFileInfo();
  if (editor) {
    editor.setValue(files[activeFileName]);
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(formattedName));
  }
  renderFileList();
  debounceSave();
};

window.selectFile = async function(fileName) {
  activeFileName = fileName;
  updateActiveFileInfo();
  if (editor) {
    editor.setValue(files[activeFileName] || '');
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(activeFileName));
  }
  renderFileList();

  const id = currentUser.role === 'siswa' ? currentUser.nipd : currentUser.username;
  await apiFetch('/api.php?action=set_active_file', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ role: currentUser.role, id: id, filename: fileName })
  });
};

window.deleteFile = async function(fileName) {
  if (!confirm(`Hapus ${fileName}?`)) return;

  const id = currentUser.role === 'siswa' ? currentUser.nipd : currentUser.username;
  await apiFetch('/api.php?action=delete_file', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ role: currentUser.role, id: id, filename: fileName })
  });

  delete files[fileName];
  activeFileName = Object.keys(files)[0] || 'main.py';
  updateActiveFileInfo();
  if (editor) {
    editor.setValue(files[activeFileName] || '');
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(activeFileName));
  }
  renderFileList();
};

async function initPyodide() {
  const statusElem = document.getElementById('pyodideStatus');
  try {
    pyodideInstance = await loadPyodide({
      indexURL: PYODIDE_INDEX_URL
    });
    
    pyodideInstance.setStdout({ batched: (msg) => appendConsole(msg) });
    pyodideInstance.setStderr({ batched: (msg) => appendConsole(`[Error] ${msg}`) });

    await pyodideInstance.runPythonAsync(`
import builtins, js
def custom_input(p=""):
    r = js.prompt(str(p) if p else "Input:")
    r = r if r is not None else ""
    print(f"{p}{r}")
    return r
builtins.input = custom_input
    `);

    statusElem.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500"></span><span class="text-emerald-600 dark:text-emerald-400 text-[11px] font-medium">Python Ready</span>`;
  } catch (err) {
    console.error("Error Pyodide:", err);
    statusElem.innerHTML = `<span class="w-2 h-2 rounded-full bg-red-500"></span><span class="text-red-500 text-[11px]">Gagal Pyodide</span>`;
  }
}

window.switchOutputTab = function(tab) {
  const consolePane = document.getElementById('consolePane');
  const previewPane = document.getElementById('previewPane');
  const tabConsoleBtn = document.getElementById('tabConsoleBtn');
  const tabPreviewBtn = document.getElementById('tabPreviewBtn');

  if (tab === 'console') {
    consolePane.classList.remove('hidden');
    previewPane.classList.add('hidden');
    tabConsoleBtn.className = "text-xs font-mono px-2.5 py-1 rounded-md transition bg-blue-600 text-white flex items-center gap-1.5";
    tabPreviewBtn.className = "text-xs font-mono px-2.5 py-1 rounded-md transition text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5";
  } else {
    consolePane.classList.add('hidden');
    previewPane.classList.remove('hidden');
    tabPreviewBtn.className = "text-xs font-mono px-2.5 py-1 rounded-md transition bg-blue-600 text-white flex items-center gap-1.5";
    tabConsoleBtn.className = "text-xs font-mono px-2.5 py-1 rounded-md transition text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5";
  }
};

window.executeCode = async function() {
  const lang = getLanguage(activeFileName);
  const code = editor.getValue();

  if (lang === 'python') {
    window.switchOutputTab('console');
    if (!pyodideInstance) return alert("Pyodide belum siap!");
    document.getElementById('consolePane').textContent = "--- Eksekusi Python ---\n";
    try {
      await pyodideInstance.runPythonAsync(code);
      appendConsole("\n--- Selesai ---");
    } catch (err) {
      appendConsole(`\n[Execution Error]: ${err.message}`);
    }
  } else if (lang === 'html') {
    window.switchOutputTab('preview');
    const iframe = document.getElementById('htmlPreviewIframe');
    iframe.srcdoc = code;
  } else if (lang === 'javascript') {
    window.switchOutputTab('console');
    document.getElementById('consolePane').textContent = "--- Eksekusi JavaScript ---\n";
    try {
      const oldLog = console.log;
      console.log = function(...args) {
        appendConsole(args.join(' '));
        oldLog.apply(console, args);
      };
      eval(code);
      console.log = oldLog;
      appendConsole("\n--- Selesai ---");
    } catch (err) {
      appendConsole(`\n[JS Error]: ${err.message}`);
    }
  } else {
    alert("File ini tidak memiliki runner otomatis.");
  }
};

function appendConsole(text) {
  const consolePane = document.getElementById('consolePane');
  consolePane.textContent += text + "\n";
  consolePane.scrollTop = consolePane.scrollHeight;
}

window.clearConsole = function() {
  document.getElementById('consolePane').textContent = "Console dibersihkan.\n";
  document.getElementById('htmlPreviewIframe').srcdoc = "";
};

function initMonacoEditor() {
  if (editor) return;

  const container = document.getElementById('editorContainer');
  if (!container) return;

  editor = monaco.editor.create(container, {
    value: files[activeFileName] || '# Selamat Datang di PythonLive Studio\nprint("Halo World")',
    language: getLanguage(activeFileName),
    theme: currentTheme === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    contextmenu: false
  });

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyC, () => {
    if (currentUser?.role === 'siswa') alert('⚠️ Dilarang Menyalin (Copy)!');
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyV, () => {
    if (currentUser?.role === 'siswa') alert('⚠️ Dilarang Menempel (Paste)! Kode wajib diketik manual.');
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyX, () => {
    if (currentUser?.role === 'siswa') alert('⚠️ Dilarang Mengubah (Cut)!');
  });

  editor.onDidChangeModelContent(() => {
    files[activeFileName] = editor.getValue();
    debounceSave();
  });
}

async function loadClassesDropdown() {
  try {
    const res = await apiFetch('/api.php?action=get_classes');
    const data = await res.json();
    if (data.success) {
      const select = document.getElementById('classFilterSelect');
      select.innerHTML = '<option value="ALL">Semua Rombel</option>';
      data.classes.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = `Rombel ${c}`;
        select.appendChild(opt);
      });
    }
  } catch(e) {}
}

window.debounceTeacherSearch = function() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(fetchTeacherData, 300);
};

function startTeacherMonitoring() {
  fetchTeacherData();
  if (!teacherInterval) {
    teacherInterval = setInterval(fetchTeacherData, 2000);
  }
}

window.fetchTeacherData = async function() {
  try {
    const selectedClass = document.getElementById('classFilterSelect').value;
    const searchQuery = document.getElementById('searchStudentInput').value.trim();

    const url = `/api.php?action=get_all_students_data&class=${encodeURIComponent(selectedClass)}&search=${encodeURIComponent(searchQuery)}`;
    const res = await apiFetch(url);
    const data = await res.json();
    if (!data.success) return;

    const grid = document.getElementById('studentGrid');
    grid.innerHTML = '';
    
    if (data.students.length === 0) {
      grid.innerHTML = `
        <div class="col-span-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-8 text-center text-slate-500 text-xs">
          <i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2 text-slate-400"></i>
          Tidak ada siswa yang sesuai dengan rombel atau pencarian tersebut.
        </div>
      `;
    } else {
      data.students.forEach(s => {
        const card = document.createElement('div');
        card.className = "bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-col justify-between shadow-lg hover:border-slate-400 dark:hover:border-slate-700 transition";
        
        let filePills = '';
        (s.files || []).forEach(f => {
          const isOpened = f === s.activeFile;
          filePills += `<button onclick="inspectStudentFile('${s.nama}', '${s.nipd}', '${f}')" class="text-[10px] px-2 py-0.5 rounded border transition ${isOpened ? 'bg-blue-600/20 border-blue-500 text-blue-600 dark:text-blue-300 font-bold' : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}">${f}${isOpened ? ' (Sedang Dibuka)' : ''}</button> `;
        });

        card.innerHTML = `
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-bold text-slate-900 dark:text-slate-200">${s.nama} (NIPD: ${s.nipd})</span>
              <span class="text-[10px] bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 px-2 py-0.5 rounded-md font-mono">${s.rombel}</span>
            </div>
            
            <div class="mb-2">
              <p class="text-[11px] text-slate-500 dark:text-slate-400 mb-1 flex items-center gap-1">
                <i data-lucide="folder-open" class="w-3.5 h-3.5 text-blue-500"></i> File Siswa:
              </p>
              <div class="flex flex-wrap gap-1">${filePills || '<span class="text-[10px] text-slate-400">Belum ada file</span>'}</div>
            </div>

            <div class="bg-slate-50 dark:bg-slate-950 p-2.5 rounded-lg border border-slate-200 dark:border-slate-800/80 font-mono text-[11px] text-slate-800 dark:text-slate-300 h-28 overflow-hidden select-text">
              <pre>${escapeHtml(s.code)}</pre>
            </div>
          </div>
        `;
        grid.appendChild(card);
      });
    }

    document.getElementById('displayedStudentCount').textContent = data.filtered_count;
    document.getElementById('totalStudentCount').textContent = data.total;
    refreshIcons();
  } catch(e) {}
};

window.inspectStudentFile = async function(studentName, nipd, fileName) {
  document.getElementById('inspectStudentName').textContent = `Mengintip Kode: ${studentName}`;
  document.getElementById('inspectStudentInfo').textContent = `File: ${fileName} (NIPD: ${nipd})`;
  document.getElementById('inspectorModal').classList.remove('hidden');

  const res = await apiFetch(`/api.php?action=get_student_file_content&nipd=${nipd}&filename=${fileName}`);
  const data = await res.json();
  const code = data.success ? data.code : '# Gagal memuat file';

  if (!inspectorEditor) {
    inspectorEditor = monaco.editor.create(document.getElementById('inspectorEditorContainer'), {
      value: code,
      language: getLanguage(fileName),
      theme: currentTheme === 'dark' ? 'vs-dark' : 'vs',
      readOnly: true,
      automaticLayout: true,
      fontSize: 13
    });
  } else {
    inspectorEditor.setValue(code);
    monaco.editor.setModelLanguage(inspectorEditor.getModel(), getLanguage(fileName));
  }
};

window.closeInspector = function() {
  document.getElementById('inspectorModal').classList.add('hidden');
};

function escapeHtml(str) {
  return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}