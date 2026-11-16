'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ts = require('../../../node_modules/typescript');
const source = fs.readFileSync(path.join(__dirname, 'feedback-client.ts'), 'utf8');
process.stdout.write(
  ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, strict: true },
  }).outputText,
);
