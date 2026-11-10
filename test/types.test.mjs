import test from "node:test"
import assert from "node:assert/strict"
import ts from "typescript"
import { fileURLToPath } from "node:url"

test("public types preserve real OpenAI overloads and accept Orlune metadata", () => {
  const file = fileURLToPath(new URL("./types/openai-compatibility.ts", import.meta.url))
  const program = ts.createProgram([file], { noEmit: true, strict: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext })
  const errors = ts.getPreEmitDiagnostics(program)
  assert.equal(errors.length, 0, ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => process.cwd(), getCanonicalFileName: name => name, getNewLine: () => "\n",
  }))
})
