import './style.css';
import { createIcons, icons } from 'lucide';
import * as monaco from 'monaco-editor';
import editorWorker from '../node_modules/monaco-editor/esm/vs/editor/editor.worker.js?worker';
import jsonWorker from '../node_modules/monaco-editor/esm/vs/language/json/json.worker.js?worker';
import cssWorker from '../node_modules/monaco-editor/esm/vs/language/css/css.worker.js?worker';
import htmlWorker from '../node_modules/monaco-editor/esm/vs/language/html/html.worker.js?worker';
import tsWorker from '../node_modules/monaco-editor/esm/vs/language/typescript/ts.worker.js?worker';
import { loadPyodide } from 'pyodide';
import { loadPythonPackages } from './python-packages.js';

self.MonacoEnvironment = {
  getWorker: function (_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (['css', 'scss', 'less'].includes(label)) return new cssWorker();
    if (['html', 'handlebars', 'razor'].includes(label)) return new htmlWorker();
    if (['typescript', 'javascript'].includes(label)) return new tsWorker();
    return new editorWorker();
  }
};

const API_BASE = (import.meta.env.VITE_API_BASE_URL || import.meta.env.BASE_URL).replace(/\/$/, '');
const APP_TITLE = import.meta.env.VITE_APP_TITLE || 'Koding LAB SMKN 1 Temon';
const PYODIDE_PACKAGE_BASE_URL = new URL('./pyodide/packages/', document.baseURI).href;

const PYODIDE_INDEX_URL = import.meta.env.DEV
  ? '/node_modules/pyodide/'
  : './pyodide/node_modules/pyodide/';

async function apiFetch(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const headers = new Headers(options.headers || {});
  if (options.method && options.method.toUpperCase() !== 'GET') {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }
  return await fetch(url, { ...options, headers, credentials: 'same-origin' });
}

let currentUser = null;
let pyodideInstance = null;
let pythonWorker = null;
let pythonWorkerReady = false;
let pythonInputBuffer = null;
let pythonInputState = null;
let activePythonRun = null;
let activePythonInput = null;
let pythonRunSequence = 0;
let pythonOutputPaneId = 'consolePane';
let editor = null;
let inspectorEditor = null;
let inspectorFileName = 'main.py';
let inspectorExecutionCleanup = null;
let files = {};
let activeFileName = 'main.py';
let teacherInterval = null;
let searchTimeout = null;
let teacherDataLoaded = false;
let teacherFetchInFlight = false;
let teacherDataHadError = false;
let accountRecords = [];
let shareableStudents = [];
let selectedShareStudentIds = new Set();
let currentTheme = localStorage.getItem('py_theme') || 'dark';

window.addEventListener('DOMContentLoaded', async () => {
  const appTitleHeader = document.getElementById('appTitleHeader');
  const appNavTitle = document.getElementById('appNavTitle');
  document.title = APP_TITLE;
  if (appTitleHeader) appTitleHeader.textContent = APP_TITLE;
  if (appNavTitle) appNavTitle.textContent = APP_TITLE;

  applyTheme(currentTheme);
  refreshIcons();
  setupAccountManagement();
  setupFileSharing();
  setupPythonInput();

  // 1. Inisialisasi Monaco Editor lebih dulu agar elemen siap
  initMonacoEditor();
  setupAntiCopyPaste();

  // 2. Muat Sesi & File Siswa dari Backend
  await checkSavedSession();

  // 3. Muat Pyodide
  await initPyodide();
});

function refreshIcons() {
  createIcons({ icons });
}

function setButtonLoading(button, loading, label) {
  if (!button) return;

  if (loading) {
    if (!button.dataset.originalContent) {
      button.dataset.originalContent = button.innerHTML;
    }
    button.disabled = true;
    button.innerHTML = `<span class="loading-spinner loading-spinner-sm" aria-hidden="true"></span><span>${label}</span>`;
    return;
  }

  button.disabled = false;
  if (button.dataset.originalContent) {
    button.innerHTML = button.dataset.originalContent;
    delete button.dataset.originalContent;
    refreshIcons();
  }
}

function setStartupLoading(loading, message = '') {
  const loader = document.getElementById('startupLoader');
  const messageElement = document.getElementById('startupLoaderMessage');
  if (messageElement && message) messageElement.textContent = message;
  loader?.classList.toggle('hidden', !loading);
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

async function checkSavedSession() {
  localStorage.removeItem('py_user_session');
  try {
    const res = await apiFetch('/api.php?action=session');
    const data = await res.json();
    if (data.success) {
      currentUser = { ...data.user, role: data.role };
      applyUserSession();
      return;
    }
  } catch (err) {
    console.error('Gagal memeriksa sesi login:', err);
    alert('Gagal terhubung ke server. Periksa koneksi dan konfigurasi API.');
  } finally {
    setStartupLoading(false);
  }
  document.getElementById('loginModal').classList.remove('hidden');
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
  const button = document.querySelector('#formSiswa button[type="submit"]');

  setButtonLoading(button, true, 'Memverifikasi...');
  try {
    const res = await apiFetch('/api.php?action=login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ role: 'siswa', nipd, password })
    });
    const data = await res.json();

    if (data.success) {
      currentUser = { ...data.user, role: 'siswa' };
      applyUserSession();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert("Gagal terhubung ke server API!");
  } finally {
    setButtonLoading(button, false);
  }
};

window.handleLoginGuru = async function(e) {
  e.preventDefault();
  const username = document.getElementById('guruUsername').value.trim();
  const password = document.getElementById('guruPassword').value.trim();
  const button = document.querySelector('#formGuru button[type="submit"]');

  setButtonLoading(button, true, 'Memverifikasi...');
  try {
    const res = await apiFetch('/api.php?action=login', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ role: 'guru', username, password })
    });
    const data = await res.json();

    if (data.success) {
      currentUser = { ...data.user, role: 'guru' };
      applyUserSession();
    } else {
      alert(data.message);
    }
  } catch (err) {
    alert("Gagal terhubung ke server API!");
  } finally {
    setButtonLoading(button, false);
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
  const res = await apiFetch('/api.php?action=change_password', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ old_password, new_password })
  });

  const data = await res.json();
  alert(data.message);

  if (data.success) {
    document.getElementById('oldPasswordInput').value = '';
    document.getElementById('newPasswordInput').value = '';
    closeChangePasswordModal();
    alert('Silakan login kembali dengan password baru.');
    location.reload();
  }
};

function applyUserSession() {
  document.getElementById('loginModal').classList.add('hidden');
  const userInfoText = document.getElementById('userInfoText');
  const roleBadge = document.getElementById('roleBadge');
  const antiCopyBadge = document.getElementById('antiCopyBadge');
  const teacherNavTabs = document.getElementById('teacherNavTabs');
  document.getElementById('shareFileButton').classList.toggle('hidden', currentUser.role !== 'guru');

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
  const navAccountsBtn = document.getElementById('navAccountsBtn');
  const teacherDashboard = document.getElementById('teacherDashboard');
  const teacherAccounts = document.getElementById('teacherAccounts');
  const codingWorkspace = document.getElementById('codingWorkspace');
  const activeClass = 'px-3 py-1.5 text-xs font-semibold rounded-lg bg-purple-600 text-white flex items-center gap-1.5 transition';
  const inactiveClass = 'px-3 py-1.5 text-xs font-semibold rounded-lg text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white flex items-center gap-1.5 transition';
  const isMonitoring = tab === 'monitoring';
  const isAccounts = tab === 'accounts';

  navMonitorBtn.className = isMonitoring ? activeClass : inactiveClass;
  navLabBtn.className = !isMonitoring && !isAccounts ? activeClass : inactiveClass;
  navAccountsBtn.className = isAccounts ? activeClass : inactiveClass;
  teacherDashboard.classList.toggle('hidden', !isMonitoring);
  teacherAccounts.classList.toggle('hidden', !isAccounts);
  codingWorkspace.classList.toggle('hidden', isMonitoring || isAccounts);

  if (isAccounts) {
    loadAccounts();
  } else if (!isMonitoring) {
    loadUserFilesFromServer();
    requestAnimationFrame(() => editor?.layout());
  }
};

function setupAccountManagement() {
  const roleSelect = document.getElementById('newAccountRole');
  roleSelect.addEventListener('change', updateNewAccountFields);
  document.getElementById('createAccountForm').addEventListener('submit', createAccount);
  document.getElementById('resetAccountPasswordForm').addEventListener('submit', resetAccountPassword);
  document.getElementById('accountSearchInput').addEventListener('input', renderAccountList);
  updateNewAccountFields();
}

function setupFileSharing() {
  document.getElementById('shareFileForm').addEventListener('submit', shareActiveFile);
  document.getElementById('shareStudentsSearch').addEventListener('input', renderShareStudents);
}

function updateNewAccountFields() {
  const isStudent = document.getElementById('newAccountRole').value === 'siswa';
  document.getElementById('newAccountIdentifierLabel').textContent = isStudent ? 'NIPD' : 'Username';
  document.getElementById('newAccountNameLabel').textContent = isStudent ? 'Nama siswa' : 'Nama guru';
  document.getElementById('newStudentFields').classList.toggle('hidden', !isStudent);
  document.getElementById('newAccountClass').required = isStudent;
}

function setAccountFormMessage(elementId, message, isError = false) {
  const element = document.getElementById(elementId);
  element.textContent = message;
  element.classList.remove('hidden', 'text-red-600', 'dark:text-red-400', 'text-emerald-600', 'dark:text-emerald-400');
  element.classList.add(isError ? 'text-red-600' : 'text-emerald-600');
  element.classList.add(isError ? 'dark:text-red-400' : 'dark:text-emerald-400');
}

window.loadAccounts = async function() {
  if (currentUser?.role !== 'guru') return;
  const container = document.getElementById('accountList');
  const count = document.getElementById('accountCount');
  container.innerHTML = '<div class="loading-placeholder"><span class="loading-spinner loading-spinner-sm"></span><span>Memuat akun...</span></div>';
  try {
    const response = await apiFetch('/api.php?action=get_accounts');
    const data = await response.json();
    if (!response.ok || !data.success || !Array.isArray(data.accounts)) throw new Error(data.message || 'Gagal memuat akun.');
    accountRecords = data.accounts;
    renderAccountList();
  } catch (error) {
    console.error('Gagal memuat daftar akun:', error);
    count.textContent = 'Daftar akun gagal dimuat';
    container.replaceChildren();
    const message = document.createElement('p');
    message.className = 'py-6 text-center text-sm text-red-600 dark:text-red-400';
    message.textContent = error.message || 'Terjadi kesalahan saat memuat akun.';
    container.appendChild(message);
  }
};

function renderAccountList() {
  const container = document.getElementById('accountList');
  const count = document.getElementById('accountCount');
  const query = document.getElementById('accountSearchInput').value.trim().toLowerCase();
  const filteredAccounts = accountRecords.filter((account) => {
    const searchableText = [
      account.name,
      account.identifier,
      account.class,
      account.role === 'siswa' ? 'siswa' : 'guru pengajar'
    ].join(' ').toLowerCase();
    return searchableText.includes(query);
  });

  count.textContent = query
    ? `Menampilkan ${filteredAccounts.length} dari ${accountRecords.length} akun`
    : `${accountRecords.length} akun`;
  container.replaceChildren();
  if (filteredAccounts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'py-8 text-center text-sm text-slate-500 dark:text-slate-400';
    empty.textContent = accountRecords.length === 0
      ? 'Belum ada akun.'
      : 'Akun yang cocok tidak ditemukan.';
    container.appendChild(empty);
    return;
  }

  filteredAccounts.forEach((account) => {
    const row = document.createElement('div');
    row.className = 'flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-4';

    const details = document.createElement('div');
    details.className = 'min-w-0';
    const title = document.createElement('p');
    title.className = 'truncate text-sm font-semibold text-slate-900 dark:text-white';
    title.textContent = account.name || '(Nama belum diatur)';
    const subtitle = document.createElement('p');
    subtitle.className = 'mt-0.5 text-xs text-slate-500 dark:text-slate-400';
    const roleLabel = account.role === 'siswa' ? `Siswa · NIPD ${account.identifier}` : `Guru · ${account.identifier}`;
    subtitle.textContent = account.class ? `${roleLabel} · ${account.class}` : roleLabel;
    details.append(title, subtitle);

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'shrink-0 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-300';
    resetButton.textContent = account.role === 'guru' && account.identifier === currentUser.username
      ? 'Akun Anda'
      : 'Reset password';
    resetButton.disabled = account.role === 'guru' && account.identifier === currentUser.username;
    resetButton.title = resetButton.disabled ? 'Gunakan menu Password untuk mengganti password sendiri.' : '';
    resetButton.addEventListener('click', () => openResetAccountPassword(account));
    row.append(details, resetButton);
    container.appendChild(row);
  });
}

async function createAccount(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  document.getElementById('createAccountMessage').classList.add('hidden');
  const role = document.getElementById('newAccountRole').value;
  const body = {
    role,
    identifier: document.getElementById('newAccountIdentifier').value.trim(),
    name: document.getElementById('newAccountName').value.trim(),
    password: document.getElementById('newAccountPassword').value.trim()
  };
  if (role === 'siswa') {
    body.rombel = document.getElementById('newAccountClass').value.trim();
    body.gender = document.getElementById('newAccountGender').value;
  }

  setButtonLoading(submitButton, true, 'Menyimpan...');
  try {
    const response = await apiFetch('/api.php?action=create_account', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal menambahkan akun.');

    form.reset();
    updateNewAccountFields();
    setAccountFormMessage('createAccountMessage', data.message);
    await Promise.all([loadAccounts(), loadClassesDropdown()]);
  } catch (error) {
    console.error('Gagal menambahkan akun:', error);
    setAccountFormMessage('createAccountMessage', error.message || 'Terjadi kesalahan saat menambahkan akun.', true);
  } finally {
    setButtonLoading(submitButton, false);
  }
}

function openResetAccountPassword(account) {
  if (account.role === 'guru' && account.identifier === currentUser?.username) return;
  const modal = document.getElementById('resetAccountPasswordModal');
  const form = document.getElementById('resetAccountPasswordForm');
  form.dataset.role = account.role;
  form.dataset.identifier = account.identifier;
  document.getElementById('resetAccountDescription').textContent = `${account.name} · ${account.role === 'siswa' ? 'NIPD' : 'Username'} ${account.identifier}`;
  document.getElementById('resetAccountMessage').classList.add('hidden');
  document.getElementById('resetAccountPassword').value = '';
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  document.getElementById('resetAccountPassword').focus();
}

window.closeResetAccountPassword = function() {
  const modal = document.getElementById('resetAccountPasswordModal');
  modal.classList.add('hidden');
  modal.classList.remove('flex');
  document.getElementById('resetAccountPasswordForm').reset();
};

async function resetAccountPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  document.getElementById('resetAccountMessage').classList.add('hidden');
  setButtonLoading(submitButton, true, 'Menyimpan...');
  try {
    const response = await apiFetch('/api.php?action=reset_account_password', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        role: form.dataset.role,
        identifier: form.dataset.identifier,
        password: document.getElementById('resetAccountPassword').value.trim()
      })
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.message || 'Gagal mereset password.');
    window.closeResetAccountPassword();
    alert(data.message);
  } catch (error) {
    console.error('Gagal mereset password akun:', error);
    setAccountFormMessage('resetAccountMessage', error.message || 'Terjadi kesalahan saat mereset password.', true);
  } finally {
    setButtonLoading(submitButton, false);
  }
}

window.handleLogout = async function() {
  if (confirm("Apakah Anda yakin ingin keluar?")) {
    try {
      const res = await apiFetch('/api.php?action=logout', { method: 'POST' });
      const data = await res.json();
      if (!data.success) {
        alert(data.message || 'Gagal mengakhiri sesi.');
        return;
      }
      location.reload();
    } catch (err) {
      console.error('Gagal logout:', err);
      alert('Gagal terhubung ke server saat logout.');
    }
  }
};

function getLanguage(filename) {
  const normalizedFilename = filename.toLowerCase();
  if (normalizedFilename.endsWith('.html') || normalizedFilename.endsWith('.htm')) return 'html';
  if (normalizedFilename.endsWith('.js')) return 'javascript';
  if (normalizedFilename.endsWith('.css')) return 'css';
  if (normalizedFilename.endsWith('.json')) return 'json';
  if (normalizedFilename.endsWith('.txt')) return 'plaintext';
  return 'python';
}

async function loadUserFilesFromServer() {
  const container = document.getElementById('fileListContainer');
  container.innerHTML = '<div class="loading-placeholder"><span class="loading-spinner loading-spinner-sm"></span><span>Memuat file...</span></div>';
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
    } else {
      throw new Error(data.message || 'Gagal memuat file.');
    }
  } catch (err) {
    console.error('Gagal memuat file workspace:', err);
    container.innerHTML = '<div class="loading-error">File gagal dimuat. Muat ulang atau periksa koneksi.</div>';
  }
}

function updateActiveFileInfo() {
  document.getElementById('activeFileNameText').textContent = activeFileName;
  const lang = getLanguage(activeFileName).toUpperCase();
  document.getElementById('langBadge').textContent = lang;
  const runButton = document.getElementById('runCodeButton');
  const label = runButton?.querySelector('[data-run-label]');
  const labels = {
    python: 'Jalankan Python',
    html: 'Preview HTML',
    javascript: 'Jalankan JavaScript',
    css: 'Preview CSS'
  };
  if (label) label.textContent = labels[getLanguage(activeFileName)] || 'Tidak ada runner';
  if (runButton) {
    runButton.disabled = !labels[getLanguage(activeFileName)];
    runButton.title = labels[getLanguage(activeFileName)] || 'Tipe file ini tidak mendukung preview atau runner.';
  }
}

let saveTimeout = null;
function debounceSave() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(async () => {
    const status = document.getElementById('syncStatus');
    status.textContent = '• Menyimpan...';
    status.classList.add('sync-saving');
    try {
      const res = await apiFetch('/api.php?action=save_file', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          filename: activeFileName,
          content: editor.getValue()
        })
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || 'Gagal menyimpan file.');
      }
      status.textContent = '• Tersimpan';
      status.classList.remove('sync-error');
    } catch (err) {
      console.error('Gagal menyimpan file:', err);
      status.textContent = '• Gagal menyimpan';
      status.classList.add('sync-error');
    } finally {
      status.classList.remove('sync-saving');
    }
  }, 600);
}

function renderFileList() {
  const container = document.getElementById('fileListContainer');
  container.innerHTML = '';

  Object.keys(files).forEach(fileName => {
    const isActive = fileName === activeFileName;
    const item = document.createElement('div');
    item.className = `min-w-36 md:min-w-0 shrink-0 flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs cursor-pointer group transition ${
      isActive ? 'bg-blue-600/20 text-blue-600 dark:text-blue-300 font-medium border border-blue-500/30' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-200'
    }`;
    
    item.innerHTML = `
      <div class="flex items-center gap-2 truncate" onclick="selectFile('${fileName}')">
        <i data-lucide="file-text" class="w-3.5 h-3.5 shrink-0 ${isActive ? 'text-blue-500' : 'text-slate-400'}"></i>
        <span class="truncate">${fileName}</span>
      </div>
      ${Object.keys(files).length > 1 ? `<button onclick="deleteFile('${fileName}')" class="p-1 opacity-100 hover:text-red-500 md:opacity-0 md:group-hover:opacity-100"><i data-lucide="trash-2" class="w-3 h-3"></i></button>` : ''}
    `;
    container.appendChild(item);
  });
  refreshIcons();
}

window.createNewFile = async function() {
  const name = prompt("Nama file baru (Contoh: main.py, index.html, data.json, catatan.txt):", "latihan.py");
  if (!name) return;
  
  let formattedName = name.trim();
  if (!formattedName.includes('.')) formattedName += '.py';
  if (formattedName.toLowerCase() === 'status.json') {
    alert('Nama status.json dipakai oleh sistem dan tidak dapat digunakan sebagai file workspace.');
    return;
  }

  const language = getLanguage(formattedName);
  const templates = {
    html: "<!-- Tulis kode HTML -->\n<h1>Halo World</h1>",
    json: "{\n  \n}\n",
    python: "# Kode Baru\n"
  };
  files[formattedName] = templates[language] || '';
  activeFileName = formattedName;
  updateActiveFileInfo();
  if (editor) {
    editor.setValue(files[activeFileName]);
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(formattedName));
  }
  renderFileList();
  debounceSave();
};

window.openShareFileModal = async function() {
  if (currentUser?.role !== 'guru') return;
  document.getElementById('shareFileName').textContent = activeFileName;
  document.getElementById('shareStudentsSearch').value = '';
  document.getElementById('shareStudentsMessage').textContent = 'Memuat daftar siswa...';
  document.getElementById('shareStudentsList').replaceChildren();
  document.getElementById('shareFileModal').classList.remove('hidden');
  document.getElementById('shareFileModal').classList.add('flex');
  selectedShareStudentIds = new Set();

  try {
    const response = await apiFetch('/api.php?action=get_accounts');
    const data = await response.json();
    if (!response.ok || !data.success || !Array.isArray(data.accounts)) {
      throw new Error(data.message || 'Gagal memuat daftar siswa.');
    }
    shareableStudents = data.accounts.filter((account) => account.role === 'siswa');
    renderShareStudents();
  } catch (error) {
    console.error('Gagal memuat daftar siswa untuk berbagi file:', error);
    document.getElementById('shareStudentsMessage').textContent =
      error.message || 'Gagal memuat daftar siswa.';
  }
};

window.closeShareFileModal = function() {
  document.getElementById('shareFileModal').classList.add('hidden');
  document.getElementById('shareFileModal').classList.remove('flex');
};

function renderShareStudents() {
  const container = document.getElementById('shareStudentsList');
  const message = document.getElementById('shareStudentsMessage');
  const query = document.getElementById('shareStudentsSearch').value.trim().toLowerCase();
  const students = shareableStudents.filter((student) =>
    `${student.name} ${student.identifier} ${student.class}`.toLowerCase().includes(query)
  );
  container.replaceChildren();
  message.textContent = shareableStudents.length === 0
    ? 'Belum ada akun siswa.'
    : students.length === 0 ? 'Siswa yang cocok tidak ditemukan.' : '';

  students.forEach((student) => {
    const label = document.createElement('label');
    label.className = 'flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm dark:border-slate-800 dark:bg-slate-950';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = student.identifier;
    checkbox.checked = selectedShareStudentIds.has(student.identifier);
    checkbox.className = 'h-4 w-4 accent-blue-600';
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedShareStudentIds.add(student.identifier);
      else selectedShareStudentIds.delete(student.identifier);
      document.getElementById('shareSelectedCount').textContent =
        `${selectedShareStudentIds.size} siswa dipilih`;
    });
    const details = document.createElement('span');
    details.className = 'min-w-0 flex-1';
    const name = document.createElement('span');
    name.className = 'block truncate font-medium text-slate-900 dark:text-white';
    name.textContent = student.name || '(Nama belum diatur)';
    const meta = document.createElement('span');
    meta.className = 'block truncate text-xs text-slate-500 dark:text-slate-400';
    meta.textContent = `NIPD ${student.identifier}${student.class ? ` · ${student.class}` : ''}`;
    details.append(name, meta);
    label.append(checkbox, details);
    container.appendChild(label);
  });
  document.getElementById('shareSelectedCount').textContent =
    `${selectedShareStudentIds.size} siswa dipilih`;
}

async function shareActiveFile(event) {
  event.preventDefault();
  if (selectedShareStudentIds.size === 0) {
    document.getElementById('shareStudentsMessage').textContent = 'Pilih minimal satu siswa.';
    return;
  }
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  setButtonLoading(submitButton, true, 'Membagikan...');
  try {
    const saveResponse = await apiFetch('/api.php?action=save_file', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ filename: activeFileName, content: editor.getValue() })
    });
    const saveData = await saveResponse.json();
    if (!saveResponse.ok || !saveData.success) {
      throw new Error(saveData.message || 'Gagal menyimpan file sebelum dibagikan.');
    }

    const response = await apiFetch('/api.php?action=share_file', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        filename: activeFileName,
        recipients: [...selectedShareStudentIds]
      })
    });
    const data = await response.json();
    if (!response.ok || !data.success) {
      const completed = Array.isArray(data.shared) ? data.shared.length : 0;
      const failedStudents = Array.isArray(data.failed)
        ? data.failed.map((student) => student.name || student.nipd).join(', ')
        : '';
      throw new Error(
        completed
          ? `${data.message || 'Sebagian file gagal dibagikan.'} Berhasil: ${completed} siswa.${failedStudents ? ` Gagal: ${failedStudents}.` : ''}`
          : data.message || 'Gagal membagikan file.'
      );
    }
    const summary = data.shared.map((student) => `${student.name}: ${student.filename}`).join('\n');
    closeShareFileModal();
    alert(`File ${activeFileName} berhasil dibagikan sebagai salinan:\n${summary}`);
    await loadUserFilesFromServer();
  } catch (error) {
    console.error('Gagal membagikan file:', error);
    document.getElementById('shareStudentsMessage').textContent =
      error.message || 'Terjadi kesalahan saat membagikan file.';
  } finally {
    setButtonLoading(submitButton, false);
  }
}

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
  setPythonRuntimeStatus('loading');
  try {
    if (self.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined') {
      await initPythonWorker();
      setPythonRuntimeStatus('ready', 'Python berjalan di worker; input tersedia di panel Console.');
      return;
    }

    pyodideInstance = await loadPyodide({
      indexURL: PYODIDE_INDEX_URL,
      packageBaseUrl: PYODIDE_PACKAGE_BASE_URL
    });
    
    pyodideInstance.setStdout({ batched: (msg) => appendConsole(msg, pythonOutputPaneId) });
    pyodideInstance.setStderr({ batched: (msg) => appendConsole(`[Error] ${msg}`, pythonOutputPaneId) });

    await pyodideInstance.runPythonAsync(`
import builtins, js
def custom_input(p=""):
    r = js.prompt(str(p) if p else "Input:")
    r = r if r is not None else ""
    print(f"{p}{r}")
    return r
builtins.input = custom_input
    `);

    setPythonRuntimeStatus('ready', 'Input memakai dialog bawaan browser. Aktifkan header COOP/COEP untuk input Console.');
  } catch (err) {
    console.error("Error Pyodide:", err);
    setPythonRuntimeStatus('error', err.message || 'Runtime Python gagal dimuat.');
  }
}

function initPythonWorker() {
  pythonInputBuffer = new SharedArrayBuffer(8 + 65536);
  pythonInputState = new Int32Array(pythonInputBuffer, 0, 2);
  pythonWorker = new Worker(new URL('./python.worker.js', import.meta.url), { type: 'module' });
  pythonWorker.addEventListener('message', handlePythonWorkerMessage);
  pythonWorker.addEventListener('error', handlePythonWorkerError);

  return new Promise((resolve, reject) => {
    const handleInitialization = ({ data }) => {
      if (data.type === 'ready') {
        pythonWorkerReady = true;
        pythonWorker.removeEventListener('message', handleInitialization);
        pythonWorker.removeEventListener('error', handleInitializationError);
        resolve();
      } else if (data.type === 'initialization-error') {
        pythonWorker.removeEventListener('message', handleInitialization);
        pythonWorker.removeEventListener('error', handleInitializationError);
        reject(new Error(data.message || 'Runtime Python gagal dimuat.'));
      }
    };

    const handleInitializationError = (event) => {
      pythonWorker.removeEventListener('message', handleInitialization);
      reject(new Error(event.message || 'Worker Python gagal dijalankan.'));
    };

    pythonWorker.addEventListener('message', handleInitialization);
    pythonWorker.addEventListener('error', handleInitializationError);
    pythonWorker.postMessage({
      type: 'initialize',
      indexURL: new URL(PYODIDE_INDEX_URL, document.baseURI).href,
      packageBaseUrl: PYODIDE_PACKAGE_BASE_URL,
      inputBuffer: pythonInputBuffer
    });
  });
}

function handlePythonWorkerError(event) {
  const message = event.message || 'Worker Python gagal dijalankan.';
  pythonWorkerReady = false;
  setPythonRuntimeStatus('error', message);
  if (activePythonRun) {
    const { outputPaneId, reject } = activePythonRun;
    hidePythonInput(outputPaneId);
    activePythonRun = null;
    reject(new Error(message));
  }
}

function handlePythonWorkerMessage({ data }) {
  if (data.type === 'stdout' || data.type === 'stderr') {
    appendConsole(data.type === 'stderr' ? `[Error] ${data.text}` : data.text, pythonOutputPaneId);
    return;
  }

  if (data.type === 'input-request') {
    if (!activePythonRun || data.runId !== activePythonRun.id) return;
    showPythonInput(data.prompt, activePythonRun.outputPaneId);
    if (activePythonRun.outputPaneId === 'inspectorConsolePane') {
      setInspectorRunStatus('Program menunggu input Anda...');
    }
    return;
  }

  if (data.type === 'loading-packages' && activePythonRun?.id === data.runId) {
    appendConsole('[Memuat paket Python yang diperlukan...]', activePythonRun.outputPaneId);
    return;
  }

  if (data.type === 'run-finished' && activePythonRun?.id === data.runId) {
    hidePythonInput(activePythonRun.outputPaneId);
    const { resolve, reject } = activePythonRun;
    activePythonRun = null;
    if (data.error) reject(new Error(data.error));
    else resolve(Array.isArray(data.figures) ? data.figures : []);
  }
}

function setupPythonInput() {
  document.getElementById('pythonInputForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitPythonInput('consolePane');
  });
  document.getElementById('inspectorPythonInputForm').addEventListener('submit', (event) => {
    event.preventDefault();
    submitPythonInput('inspectorConsolePane');
  });
  document.getElementById('cancelPythonInput').addEventListener('click', () => cancelPythonInput('consolePane'));
  document.getElementById('cancelInspectorPythonInput').addEventListener('click', () => cancelPythonInput('inspectorConsolePane'));
}

function showPythonInput(prompt, paneId) {
  activePythonInput = { prompt: String(prompt || ''), paneId };
  const isInspector = paneId === 'inspectorConsolePane';
  const form = document.getElementById(isInspector ? 'inspectorPythonInputForm' : 'pythonInputForm');
  const label = document.getElementById(isInspector ? 'inspectorPythonInputPrompt' : 'pythonInputPrompt');
  const input = document.getElementById(isInspector ? 'inspectorPythonInputValue' : 'pythonInputValue');
  label.textContent = activePythonInput.prompt || 'Input:';
  input.value = '';
  form.classList.remove('hidden');
  form.classList.add('flex');
  requestAnimationFrame(() => input.focus());
}

function hidePythonInput(paneId) {
  const isInspector = paneId === 'inspectorConsolePane';
  const form = document.getElementById(isInspector ? 'inspectorPythonInputForm' : 'pythonInputForm');
  const input = document.getElementById(isInspector ? 'inspectorPythonInputValue' : 'pythonInputValue');
  form.classList.add('hidden');
  form.classList.remove('flex');
  input.value = '';
  if (activePythonInput?.paneId === paneId) activePythonInput = null;
}

function submitPythonInput(paneId) {
  if (!activePythonInput || activePythonInput.paneId !== paneId || !pythonInputState) return;

  const isInspector = paneId === 'inspectorConsolePane';
  const input = document.getElementById(isInspector ? 'inspectorPythonInputValue' : 'pythonInputValue');
  const value = input.value;
  const encoded = new TextEncoder().encode(value);
  const capacity = pythonInputBuffer.byteLength - 8;
  if (encoded.length > capacity) {
    input.setCustomValidity('Input terlalu panjang.');
    input.reportValidity();
    input.setCustomValidity('');
    return;
  }

  new Uint8Array(pythonInputBuffer, 8, encoded.length).set(encoded);
  Atomics.store(pythonInputState, 1, encoded.length);
  Atomics.store(pythonInputState, 0, 1);
  Atomics.notify(pythonInputState, 0);
  appendConsole(`${activePythonInput.prompt}${value}`, paneId);
  if (paneId === 'inspectorConsolePane') setInspectorRunStatus('Input dikirim; kode sedang dijalankan...');
  hidePythonInput(paneId);
}

function cancelPythonInput(paneId) {
  if (!activePythonInput || activePythonInput.paneId !== paneId || !pythonInputState) return;
  Atomics.store(pythonInputState, 1, 0);
  Atomics.store(pythonInputState, 0, 2);
  Atomics.notify(pythonInputState, 0);
  hidePythonInput(paneId);
}

function runPythonCode(code, paneId) {
  pythonOutputPaneId = paneId;
  if (pyodideInstance) return runPythonCodeOnMainThread(code);
  if (!pythonWorkerReady || !pythonWorker) {
    throw new Error('Runtime Python belum siap. Tunggu hingga status Python Ready.');
  }
  if (activePythonRun) {
    throw new Error('Program Python lain masih berjalan. Tunggu hingga selesai.');
  }

  const runId = ++pythonRunSequence;
  return new Promise((resolve, reject) => {
    activePythonRun = { id: runId, outputPaneId: paneId, resolve, reject };
    pythonWorker.postMessage({ type: 'run', runId, code });
  });
}

async function runPythonCodeOnMainThread(code) {
  appendConsole('[Memuat paket Python yang diperlukan...]', pythonOutputPaneId);
  await loadPythonPackages(pyodideInstance, code, PYODIDE_PACKAGE_BASE_URL);
  if (code.includes('matplotlib')) {
    await pyodideInstance.runPythonAsync("import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.show = lambda *args, **kwargs: None");
  }
  await pyodideInstance.runPythonAsync(code);
  const figures = await pyodideInstance.runPythonAsync(`
import base64
import io
import sys

def _export_matplotlib_figures():
    if "matplotlib.pyplot" not in sys.modules:
        return []
    import matplotlib.pyplot as plt
    figures = []
    for _figure_number in plt.get_fignums():
        _buffer = io.BytesIO()
        plt.figure(_figure_number).savefig(_buffer, format="png", bbox_inches="tight")
        figures.append(base64.b64encode(_buffer.getvalue()).decode("ascii"))
        plt.close(_figure_number)
    return figures

_export_matplotlib_figures()
  `);
  const figureData = figures.toJs();
  figures.destroy();
  return figureData;
}

function renderPythonFigures(figures, paneId) {
  if (!figures.length) return;
  const output = document.getElementById(paneId === 'inspectorConsolePane' ? 'inspectorPythonFigures' : 'pythonFigures');
  output.replaceChildren();
  figures.forEach((base64, index) => {
    const figure = document.createElement('figure');
    figure.className = 'my-3 rounded-lg border border-slate-200 bg-white p-2 dark:border-slate-700';
    const image = document.createElement('img');
    image.src = `data:image/png;base64,${base64}`;
    image.alt = `Grafik Python ${index + 1}`;
    image.className = 'mx-auto h-auto max-w-full';
    figure.appendChild(image);
    output.appendChild(figure);
  });
}

function setPythonConsoleOutput(paneId, text) {
  const isInspector = paneId === 'inspectorConsolePane';
  document.getElementById(isInspector ? 'inspectorConsoleText' : 'consoleText').textContent = text;
  document.getElementById(isInspector ? 'inspectorPythonFigures' : 'pythonFigures').replaceChildren();
}

function setPythonRuntimeStatus(state, detail = '') {
  const statusElement = document.getElementById('pythonRuntimeStatus');
  if (!statusElement) return;
  const markup = state === 'ready'
    ? '<span class="status-indicator status-indicator-ready" aria-hidden="true"></span><span class="text-emerald-700 dark:text-emerald-400 font-medium">Python Ready</span>'
    : state === 'error'
      ? '<span class="status-indicator status-indicator-error" aria-hidden="true"></span><span class="text-red-600 dark:text-red-400 font-medium">Python gagal dimuat</span>'
      : '<span class="loading-spinner loading-spinner-sm" aria-hidden="true"></span><span class="text-slate-600 dark:text-slate-300">Menyiapkan Python...</span>';

  statusElement.innerHTML = markup;
  statusElement.title = detail;
  statusElement.classList.toggle('runtime-error', state === 'error');
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
  const button = document.getElementById('runCodeButton');

  if (lang === 'python') {
    window.switchOutputTab('console');
    if (!pyodideInstance && !pythonWorkerReady) return alert("Python masih disiapkan. Silakan coba kembali setelah status Python Ready.");
    setPythonConsoleOutput('consolePane', "--- Eksekusi Python ---\n");
    setButtonLoading(button, true, 'Menjalankan...');
    try {
      const figures = await runPythonCode(code, 'consolePane');
      appendConsole("\n--- Selesai ---");
      renderPythonFigures(figures, 'consolePane');
    } catch (err) {
      appendConsole(`\n[Execution Error]: ${err.message}`);
    } finally {
      setButtonLoading(button, false);
    }
  } else if (lang === 'html') {
    window.switchOutputTab('preview');
    const iframe = document.getElementById('htmlPreviewIframe');
    iframe.srcdoc = code;
  } else if (lang === 'css') {
    window.switchOutputTab('preview');
    const iframe = document.getElementById('htmlPreviewIframe');
    iframe.srcdoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,sans-serif;padding:2rem;color:#334155} .preview-sample{padding:1rem;border:1px solid #cbd5e1;border-radius:.75rem} ${code}</style></head><body><h2>Preview CSS</h2><div class="preview-sample"><h3>Contoh elemen</h3><p>Gunakan selector seperti <code>body</code>, <code>h3</code>, atau <code>.preview-sample</code>.</p><button>Contoh tombol</button></div></body></html>`;
  } else if (lang === 'javascript') {
    window.switchOutputTab('console');
    setPythonConsoleOutput('consolePane', "--- Eksekusi JavaScript ---\n");
    setButtonLoading(button, true, 'Menjalankan...');
    const oldLog = console.log;
    try {
      console.log = function(...args) {
        appendConsole(args.join(' '));
        oldLog.apply(console, args);
      };
      eval(code);
      appendConsole("\n--- Selesai ---");
    } catch (err) {
      appendConsole(`\n[JS Error]: ${err.message}`);
    } finally {
      console.log = oldLog;
      setButtonLoading(button, false);
    }
  } else {
    alert("File ini tidak memiliki runner otomatis.");
  }
};

function appendConsole(text, paneId = 'consolePane') {
  const consolePane = document.getElementById(paneId);
  if (!consolePane) return;
  const output = document.getElementById(paneId === 'inspectorConsolePane' ? 'inspectorConsoleText' : 'consoleText');
  output.textContent += text + "\n";
  consolePane.scrollTop = consolePane.scrollHeight;
}

window.clearConsole = function() {
  setPythonConsoleOutput('consolePane', "Console dibersihkan.\n");
  document.getElementById('htmlPreviewIframe').srcdoc = "";
};

function initMonacoEditor() {
  if (editor) return;

  const container = document.getElementById('editorContainer');
  if (!container) return;

  editor = monaco.editor.create(container, {
    value: files[activeFileName] || '# Selamat Datang di Koding LAB SMKN 1 Temon\nprint("Halo World")',
    language: getLanguage(activeFileName),
    theme: currentTheme === 'dark' ? 'vs-dark' : 'vs',
    automaticLayout: true,
    fontSize: 14,
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
    if (!res.ok || !data.success || !Array.isArray(data.classes)) {
      throw new Error(data.message || 'Gagal memuat daftar rombel.');
    }

    const select = document.getElementById('classFilterSelect');
    select.innerHTML = '<option value="ALL">Semua Rombel</option>';
    data.classes.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `Rombel ${c}`;
      select.appendChild(opt);
    });
    select.disabled = false;
    select.title = '';
  } catch (error) {
    console.error('Gagal memuat daftar rombel:', error);
    const select = document.getElementById('classFilterSelect');
    select.disabled = true;
    select.title = 'Daftar rombel gagal dimuat. Periksa koneksi dan muat ulang halaman.';
  }
}

window.debounceTeacherSearch = function() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => fetchTeacherData({ showLoading: true }), 300);
};

function startTeacherMonitoring() {
  fetchTeacherData({ showLoading: true });
  if (!teacherInterval) {
    teacherInterval = setInterval(() => fetchTeacherData({ silent: true }), 2000);
  }
}

function setTeacherDataStatus(state, message) {
  const status = document.getElementById('teacherDataStatus');
  if (!status) return;
  status.classList.remove('teacher-status-error', 'teacher-status-ready');
  if (state === 'loading') {
    status.innerHTML = '<span class="loading-spinner loading-spinner-sm" aria-hidden="true"></span><span></span>';
    status.lastElementChild.textContent = message;
    return;
  }
  if (state === 'error') {
    status.innerHTML = '<span class="status-indicator status-indicator-error" aria-hidden="true"></span><span></span>';
    status.lastElementChild.textContent = message;
    status.classList.add('teacher-status-error');
    return;
  }
  status.innerHTML = '<span class="status-indicator status-indicator-ready" aria-hidden="true"></span><span></span>';
  status.lastElementChild.textContent = message;
  status.classList.add('teacher-status-ready');
}

function renderTeacherLoadingCards() {
  const grid = document.getElementById('studentGrid');
  grid.innerHTML = Array.from({ length: 3 }, () => `
    <div class="student-skeleton rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4" aria-hidden="true">
      <div class="skeleton-line w-2/3"></div>
      <div class="skeleton-line mt-4 w-1/3"></div>
      <div class="skeleton-block mt-3 h-24"></div>
    </div>
  `).join('');
}

window.fetchTeacherData = async function(options = {}) {
  if (teacherFetchInFlight) return;
  const { silent = false, showLoading = false } = options;
  teacherFetchInFlight = true;
  if (!teacherDataLoaded) {
    renderTeacherLoadingCards();
    setTeacherDataStatus('loading', 'Mengambil data dan file siswa...');
  } else if (showLoading) {
    setTeacherDataStatus('loading', 'Memperbarui data siswa...');
  }

  try {
    const selectedClass = document.getElementById('classFilterSelect').value;
    const searchQuery = document.getElementById('searchStudentInput').value.trim();

    const url = `/api.php?action=get_all_students_data&class=${encodeURIComponent(selectedClass)}&search=${encodeURIComponent(searchQuery)}`;
    const res = await apiFetch(url);
    const data = await res.json();
    if (!res.ok || !data.success || !Array.isArray(data.students)) {
      throw new Error(data.message || 'Server tidak dapat memuat data siswa.');
    }

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
        card.className = "student-card bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 flex flex-col justify-between shadow-lg hover:border-slate-400 dark:hover:border-slate-700 transition";

        card.innerHTML = `
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="student-name text-sm font-bold text-slate-900 dark:text-slate-200">${escapeHtml(s.nama)} <span class="font-normal text-slate-500 dark:text-slate-400">(NIPD: ${escapeHtml(s.nipd)})</span></span>
              <span class="student-class text-xs bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20 px-2.5 py-1 rounded-lg font-mono">${escapeHtml(s.rombel)}</span>
            </div>
            
            <div class="mb-2">
              <p class="student-files-label text-xs text-slate-600 dark:text-slate-300 mb-1.5 flex items-center gap-1">
                <i data-lucide="folder-open" class="w-3.5 h-3.5 text-blue-500"></i> File Siswa:
              </p>
              <div class="student-file-list flex flex-wrap gap-2"></div>
            </div>

            <div class="student-code-preview bg-slate-50 dark:bg-slate-950 p-3 rounded-xl border border-slate-200 dark:border-slate-800/80 font-mono text-xs text-slate-800 dark:text-slate-300 h-32 overflow-auto select-text">
              <pre>${escapeHtml(s.code)}</pre>
            </div>
          </div>
        `;
        const fileList = card.querySelector('.student-file-list');
        if (Array.isArray(s.files) && s.files.length > 0) {
          s.files.forEach((fileName) => {
            const isOpened = fileName === s.activeFile;
            const fileButton = document.createElement('button');
            fileButton.type = 'button';
            fileButton.className = `student-file-chip text-[13px] px-3 py-1.5 rounded-lg border transition ${isOpened ? 'bg-blue-600/20 border-blue-500 text-blue-600 dark:text-blue-300 font-bold' : 'bg-slate-100 dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'}`;
            fileButton.textContent = `${fileName}${isOpened ? ' (Sedang Dibuka)' : ''}`;
            fileButton.addEventListener('click', () => window.inspectStudentFile(s.nama, s.nipd, fileName));
            fileList.appendChild(fileButton);
          });
        } else {
          const emptyFiles = document.createElement('span');
          emptyFiles.className = 'text-sm text-slate-500 dark:text-slate-400';
          emptyFiles.textContent = 'Belum ada file';
          fileList.appendChild(emptyFiles);
        }
        grid.appendChild(card);
      });
    }

    document.getElementById('displayedStudentCount').textContent = data.filtered_count;
    document.getElementById('totalStudentCount').textContent = data.total;
    teacherDataLoaded = true;
    if (!silent || teacherDataHadError) {
      const recoveryMessage = teacherDataHadError ? 'Koneksi pulih · ' : '';
      setTeacherDataStatus('ready', `${recoveryMessage}Data diperbarui ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`);
    }
    teacherDataHadError = false;
    refreshIcons();
  } catch (error) {
    if (!silent) console.error('Gagal memuat data pemantauan siswa:', error);
    teacherDataHadError = true;
    if (!teacherDataLoaded) {
      const grid = document.getElementById('studentGrid');
      grid.innerHTML = '<div class="col-span-full rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300">Data siswa belum dapat dimuat. Periksa koneksi lalu coba lagi.</div>';
      setTeacherDataStatus('error', 'Gagal memuat data siswa');
    } else {
      setTeacherDataStatus('error', 'Gagal memperbarui data; menampilkan data sebelumnya');
    }
  } finally {
    teacherFetchInFlight = false;
  }
};

window.inspectStudentFile = async function(studentName, nipd, fileName) {
  document.getElementById('inspectStudentName').textContent = `Mengintip Kode: ${studentName}`;
  document.getElementById('inspectStudentInfo').textContent = `File: ${fileName} (NIPD: ${nipd})`;
  document.getElementById('inspectorModal').classList.remove('hidden');
  inspectorFileName = fileName;
  setInspectorRunStatus('Memuat kode siswa...');
  setPythonConsoleOutput('inspectorConsolePane', 'Hasil pengujian kode siswa akan tampil di sini.');
  switchInspectorOutputTab('console');

  let code;
  try {
    const query = new URLSearchParams({ action: 'get_student_file_content', nipd, filename: fileName });
    const res = await apiFetch(`/api.php?${query}`);
    const data = await res.json();
    if (!res.ok || !data.success || typeof data.code !== 'string') {
      throw new Error(data.message || 'Gagal memuat kode siswa.');
    }
    code = data.code;
    setInspectorRunStatus('Kode siswa hanya dibaca; pengujian tidak mengubah file siswa.');
  } catch (error) {
    console.error('Gagal memuat kode siswa untuk inspeksi:', error);
    code = '# Gagal memuat kode siswa.';
    setInspectorRunStatus(error.message || 'Gagal memuat kode siswa.', true);
  }

  if (!inspectorEditor) {
    inspectorEditor = monaco.editor.create(document.getElementById('inspectorEditorContainer'), {
      value: code,
      language: getLanguage(fileName),
      theme: currentTheme === 'dark' ? 'vs-dark' : 'vs',
      readOnly: true,
      automaticLayout: true,
      fontSize: 14
    });
  } else {
    inspectorEditor.setValue(code);
    monaco.editor.setModelLanguage(inspectorEditor.getModel(), getLanguage(fileName));
  }
  updateInspectorRunButton();
  requestAnimationFrame(() => inspectorEditor?.layout());
};

function updateInspectorRunButton() {
  const button = document.getElementById('inspectorRunButton');
  const label = button?.querySelector('[data-inspector-run-label]');
  const language = getLanguage(inspectorFileName);
  const labels = {
    python: 'Jalankan Python',
    javascript: 'Jalankan JavaScript',
    html: 'Preview HTML',
    css: 'Preview CSS'
  };
  if (label) label.textContent = labels[language] || 'Tidak didukung';
  if (button) {
    button.disabled = !labels[language];
    button.title = labels[language] || 'Tipe file ini tidak mendukung preview atau runner.';
  }
}

function setInspectorRunStatus(message, isError = false) {
  const status = document.getElementById('inspectorRunStatus');
  status.textContent = message;
  status.classList.toggle('text-red-600', isError);
  status.classList.toggle('dark:text-red-400', isError);
  status.classList.toggle('text-slate-500', !isError);
  status.classList.toggle('dark:text-slate-400', !isError);
}

window.switchInspectorOutputTab = function(tab) {
  const showPreview = tab === 'preview';
  document.getElementById('inspectorConsolePane').classList.toggle('hidden', showPreview);
  document.getElementById('inspectorPreviewFrame').classList.toggle('hidden', !showPreview);
  const activeClass = 'rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white';
  const inactiveClass = 'rounded-md px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-200 dark:text-slate-300 dark:hover:bg-slate-800';
  document.getElementById('inspectorConsoleTab').className = showPreview ? inactiveClass : activeClass;
  document.getElementById('inspectorPreviewTab').className = showPreview ? activeClass : inactiveClass;
};

window.runInspectorCode = async function() {
  if (!inspectorEditor) return;
  const code = inspectorEditor.getValue();
  const language = getLanguage(inspectorFileName);
  const button = document.getElementById('inspectorRunButton');
  const consolePane = document.getElementById('inspectorConsolePane');
  const previewFrame = document.getElementById('inspectorPreviewFrame');

  if (language === 'html') {
    previewFrame.srcdoc = code;
    window.switchInspectorOutputTab('preview');
    setInspectorRunStatus('Preview HTML siswa ditampilkan dalam sandbox.');
    return;
  }
  if (language === 'css') {
    const safeCss = code.replace(/<\/style/gi, '<\\/style');
    previewFrame.srcdoc = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{font-family:system-ui,sans-serif;padding:1.5rem;color:#334155}.preview-sample{padding:1rem;border:1px solid #cbd5e1;border-radius:.75rem}${safeCss}</style></head><body><h2>Preview CSS Siswa</h2><div class="preview-sample"><h3>Contoh elemen</h3><p>Area contoh untuk menguji style siswa.</p><button>Contoh tombol</button></div></body></html>`;
    window.switchInspectorOutputTab('preview');
    setInspectorRunStatus('Preview CSS ditampilkan dalam sandbox.');
    return;
  }

  if (language === 'python') {
    if (!pyodideInstance && !pythonWorkerReady) {
      setInspectorRunStatus('Runtime Python belum siap. Tunggu hingga status Python Ready.', true);
      window.switchInspectorOutputTab('console');
      return;
    }
    window.switchInspectorOutputTab('console');
    setPythonConsoleOutput('inspectorConsolePane', '--- Uji kode Python siswa ---\n');
    setButtonLoading(button, true, 'Menjalankan...');
    pythonOutputPaneId = 'inspectorConsolePane';
    setInspectorRunStatus('Kode Python sedang dijalankan...');
    try {
      const figures = await runPythonCode(code, 'inspectorConsolePane');
      appendConsole('--- Selesai ---', 'inspectorConsolePane');
      renderPythonFigures(figures, 'inspectorConsolePane');
      setInspectorRunStatus('Pengujian Python selesai. File siswa tidak diubah.');
    } catch (error) {
      appendConsole(`[Execution Error]: ${error.message}`, 'inspectorConsolePane');
      setInspectorRunStatus('Pengujian selesai dengan error. Lihat Console.', true);
    } finally {
      pythonOutputPaneId = 'consolePane';
      setButtonLoading(button, false);
    }
    return;
  }

  if (language === 'javascript') {
    window.switchInspectorOutputTab('console');
    setPythonConsoleOutput('inspectorConsolePane', '--- Uji JavaScript siswa ---\n');
    setButtonLoading(button, true, 'Menjalankan...');
    setInspectorRunStatus('Kode JavaScript berjalan di sandbox...');
    const token = crypto.randomUUID();
    let finished = false;
    let timeoutId;
    const finish = (message, isError = false) => {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener('message', onMessage);
      inspectorExecutionCleanup = null;
      setButtonLoading(button, false);
      setInspectorRunStatus(message, isError);
    };
    const onMessage = (event) => {
      if (event.source !== previewFrame.contentWindow
        || event.data?.type !== 'inspector-console'
        || event.data?.token !== token
        || !Array.isArray(event.data?.values)) return;
      appendConsole(event.data.values.join(' '), 'inspectorConsolePane');
      const output = event.data.values[0];
      if (output === '--- Selesai ---') {
        finish('JavaScript selesai dijalankan dalam sandbox.');
      } else if (output === '[JS Error]') {
        finish('Pengujian selesai dengan error. Lihat Console.', true);
      }
    };
    window.addEventListener('message', onMessage);
    inspectorExecutionCleanup = () => finish('Pengujian JavaScript dihentikan.', true);
    timeoutId = window.setTimeout(() => {
      finish('Pengujian melebihi 30 detik. Hentikan dengan menutup dialog.', true);
    }, 30000);
    const safeCode = code.replace(/<\/script/gi, '<\\/script');
    previewFrame.srcdoc = `<!doctype html><meta charset="utf-8"><script>
      const token=${JSON.stringify(token)};
      const send=(...values)=>parent.postMessage({type:'inspector-console',token,values:values.map(value=>String(value))},'*');
      console.log=(...values)=>send(...values);
      console.error=(...values)=>send('[Error]',...values);
      try { Promise.resolve((async()=>{${safeCode}\n})()).then(()=>send('--- Selesai ---')).catch(error=>send('[JS Error]',error.message)); }
      catch(error) { send('[JS Error]',error.message); }
    <\/script>`;
    setInspectorRunStatus('JavaScript berjalan dalam iframe sandbox dengan akses halaman induk dibatasi.');
  }
};

window.closeInspector = function() {
  cancelPythonInput('inspectorConsolePane');
  inspectorExecutionCleanup?.();
  document.getElementById('inspectorModal').classList.add('hidden');
  document.getElementById('inspectorPreviewFrame').srcdoc = '';
};

function escapeHtml(str) {
  return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}