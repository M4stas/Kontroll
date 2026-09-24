import { mkdir, readFile, writeFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../src/features/offline/service-worker.ts", import.meta.url), "utf8");
const result = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true },
  reportDiagnostics: true,
});
if (result.diagnostics?.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics, {
  getCanonicalFileName: (name) => name,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n",
}));
await mkdir(new URL("../public/", import.meta.url), { recursive: true });
await writeFile(new URL("../public/sw.js", import.meta.url), result.outputText);
