import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pyodideRoot = resolve(projectRoot, 'node_modules', 'pyodide');
const packageDirectory = resolve(projectRoot, 'src', 'public', 'pyodide', 'packages');
const packagesBaseUrl = 'https://cdn.jsdelivr.net/pyodide';
const requestedPackages = ['numpy', 'matplotlib'];

const lockfile = JSON.parse(await readFile(resolve(pyodideRoot, 'pyodide-lock.json'), 'utf8'));
const pyodideVersion = JSON.parse(await readFile(resolve(pyodideRoot, 'package.json'), 'utf8')).version;
const packageNames = new Set();

function addPackageAndDependencies(name) {
  if (packageNames.has(name)) return;
  const packageInfo = lockfile.packages[name];
  if (!packageInfo) throw new Error(`Package "${name}" tidak tersedia di lockfile Pyodide.`);
  packageNames.add(name);
  packageInfo.depends.forEach(addPackageAndDependencies);
}

requestedPackages.forEach(addPackageAndDependencies);
await mkdir(packageDirectory, { recursive: true });
const previousFiles = (await readdir(packageDirectory)).filter((name) => /^[\w.+-]+\.whl$/.test(name));

const downloadedPackages = await Promise.all([...packageNames].map(async (name) => {
  const packageInfo = lockfile.packages[name];
  const targetPath = resolve(packageDirectory, packageInfo.file_name);

  try {
    const existingFile = await readFile(targetPath);
    const existingHash = createHash('sha256').update(existingFile).digest('hex');
    if (existingHash === packageInfo.sha256) return packageInfo.file_name;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const packageUrl = `${packagesBaseUrl}/v${pyodideVersion}/full/${packageInfo.file_name}`;
  const response = await fetch(packageUrl);
  if (!response.ok) {
    throw new Error(`Gagal mengunduh ${packageInfo.file_name}: HTTP ${response.status} dari ${packageUrl}`);
  }

  const content = Buffer.from(await response.arrayBuffer());
  const actualHash = createHash('sha256').update(content).digest('hex');
  if (actualHash !== packageInfo.sha256) {
    throw new Error(`SHA-256 ${packageInfo.file_name} tidak sesuai dengan lockfile Pyodide.`);
  }

  await writeFile(targetPath, content);
  console.log(`Paket Pyodide tersimpan: ${name} ${packageInfo.version}`);
  return packageInfo.file_name;
}));

const currentFiles = new Set(downloadedPackages);
for (const previousFile of previousFiles) {
  if (!currentFiles.has(previousFile)) {
    await rm(resolve(packageDirectory, previousFile), { force: true });
  }
}

console.log(`Paket NumPy/Matplotlib dan ${downloadedPackages.length - requestedPackages.length} dependensi siap untuk penggunaan offline.`);
