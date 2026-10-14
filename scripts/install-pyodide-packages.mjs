import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pyodideRoot = resolve(projectRoot, 'node_modules', 'pyodide');
const packageDirectory = resolve(projectRoot, 'src', 'public', 'pyodide', 'packages');
const packagesBaseUrl = 'https://cdn.jsdelivr.net/pyodide';
const downloadConcurrency = 8;
const additionalPackages = [
  {
    file_name: 'seaborn-0.13.2-py3-none-any.whl',
    sha256: '636f8336facf092165e27924f223d3c62ca560b1f2bb5dff7ab7fad265361987',
    url: 'https://files.pythonhosted.org/packages/83/11/00d3c3dfc25ad54e731d91449895a79e4bf2384dc3ac01809010ba88f6d5/seaborn-0.13.2-py3-none-any.whl'
  }
];

const lockfile = JSON.parse(await readFile(resolve(pyodideRoot, 'pyodide-lock.json'), 'utf8'));
const pyodideVersion = JSON.parse(await readFile(resolve(pyodideRoot, 'package.json'), 'utf8')).version;
const packages = [
  ...Object.values(lockfile.packages).filter((packageInfo) =>
    packageInfo.package_type === 'package' || packageInfo.package_type === 'shared_library'
  ),
  ...additionalPackages
];
await mkdir(packageDirectory, { recursive: true });
const previousFiles = (await readdir(packageDirectory)).filter((name) => /^[\w.+-]+\.(?:whl|zip)$/.test(name));

let nextPackageIndex = 0;
let completedPackages = 0;
const downloadedPackages = await Promise.all(Array.from(
  { length: Math.min(downloadConcurrency, packages.length) },
  async () => {
    const downloadedByWorker = [];
    while (nextPackageIndex < packages.length) {
      const packageInfo = packages[nextPackageIndex++];
      downloadedByWorker.push(await downloadPackage(packageInfo));
      completedPackages++;
      if (completedPackages % 25 === 0 || completedPackages === packages.length) {
        console.log(`Paket Pyodide tersimpan: ${completedPackages}/${packages.length}`);
      }
    }
    return downloadedByWorker;
  }
)).then((results) => results.flat());

async function downloadPackage(packageInfo) {
  const targetPath = resolve(packageDirectory, packageInfo.file_name);

  try {
    const existingFile = await readFile(targetPath);
    const existingHash = createHash('sha256').update(existingFile).digest('hex');
    if (existingHash === packageInfo.sha256) return packageInfo.file_name;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const packageUrl = packageInfo.url ||
    `${packagesBaseUrl}/v${pyodideVersion}/full/${packageInfo.file_name}`;
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
  return packageInfo.file_name;
}

const currentFiles = new Set(downloadedPackages);
for (const previousFile of previousFiles) {
  if (!currentFiles.has(previousFile)) {
    await rm(resolve(packageDirectory, previousFile), { force: true });
  }
}

console.log(`${downloadedPackages.length} paket/komponen Pyodide siap untuk penggunaan offline.`);
