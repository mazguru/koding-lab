import { loadPyodide } from 'pyodide';

let pyodide;
let inputState;
let inputBytes;
let activeRunId = null;

function readPythonInput(prompt) {
  Atomics.store(inputState, 0, 0);
  Atomics.store(inputState, 1, 0);
  self.postMessage({ type: 'input-request', runId: activeRunId, prompt });
  Atomics.wait(inputState, 0, 0);

  if (Atomics.load(inputState, 0) !== 1) {
    throw new Error('Eksekusi dibatalkan saat menunggu input.');
  }

  const length = Atomics.load(inputState, 1);
  return new TextDecoder().decode(inputBytes.slice(0, length));
}

self.onmessage = async ({ data }) => {
  if (data.type === 'initialize') {
    try {
      inputState = new Int32Array(data.inputBuffer, 0, 2);
      inputBytes = new Uint8Array(data.inputBuffer, 8);
      self.readPythonInput = readPythonInput;
      pyodide = await loadPyodide({
        indexURL: data.indexURL,
        packageBaseUrl: data.packageBaseUrl
      });
      pyodide.setStdout({ batched: (text) => self.postMessage({ type: 'stdout', text }) });
      pyodide.setStderr({ batched: (text) => self.postMessage({ type: 'stderr', text }) });
      await pyodide.runPythonAsync(`
import builtins
from js import readPythonInput

def custom_input(prompt=""):
    return str(readPythonInput(str(prompt)))

builtins.input = custom_input
      `);
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'initialization-error', message: error.message });
    }
    return;
  }

  if (data.type === 'run' && pyodide && activeRunId === null) {
    activeRunId = data.runId;
    try {
      self.postMessage({ type: 'loading-packages', runId: activeRunId });
      await pyodide.loadPackagesFromImports(data.code);
      if (data.code.includes('matplotlib')) {
        await pyodide.runPythonAsync("import matplotlib; matplotlib.use('Agg'); import matplotlib.pyplot as plt; plt.show = lambda *args, **kwargs: None");
      }
      await pyodide.runPythonAsync(data.code);
      const figures = await pyodide.runPythonAsync(`
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
      self.postMessage({ type: 'run-finished', runId: activeRunId, figures: figureData });
    } catch (error) {
      self.postMessage({ type: 'run-finished', runId: activeRunId, error: error.message });
    } finally {
      activeRunId = null;
    }
  }
};
