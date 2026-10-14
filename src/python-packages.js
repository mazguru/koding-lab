const SEABORN_IMPORT_PATTERN = /^\s*(?:import\s+seaborn\b|from\s+seaborn\b)/m;

export async function loadPythonPackages(pyodide, code, packageBaseUrl) {
  await pyodide.loadPackagesFromImports(code);

  if (SEABORN_IMPORT_PATTERN.test(code)) {
    await pyodide.loadPackage(['micropip', 'matplotlib', 'numpy', 'pandas', 'packaging', 'scipy']);
    const isSeabornInstalled = await pyodide.runPythonAsync(
      "import importlib.util; importlib.util.find_spec('seaborn') is not None"
    );
    if (!isSeabornInstalled) {
      const seabornWheelUrl = new URL(
        'seaborn-0.13.2-py3-none-any.whl',
        packageBaseUrl
      ).href;
      await pyodide.runPythonAsync(`
import micropip
await micropip.install(${JSON.stringify(seabornWheelUrl)}, deps=False)
      `);
    }
  }
}
