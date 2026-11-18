/** Read-only installed graph/source/artifact inventory. Prints metadata only. */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const project = resolve(process.argv[2] ?? join(here, '../../..'));
const tracked = execFileSync('git', ['-C', project, 'ls-files', '-z'], {
  encoding: 'utf8',
  maxBuffer: 4000000,
})
  .split('\0')
  .filter(Boolean);
const sourceImports = [],
  sourceGlobImports = [];
const ts = createRequire(join(project, 'backend/package.json'))('typescript');
const packagePattern =
  /^(?:picomatch|tinyglobby|fdir|micromatch|vite|vitest|typescript-eslint|electron-builder|node-gyp)(?:\/|$)/;
for (const path of tracked.filter((name) =>
  /^(?:backend\/src|frontend\/(?:src|electron))\/.+\.[cm]?[jt]sx?$/.test(name),
)) {
  const value = readFileSync(join(project, path), 'utf8');
  const source = ts.createSourceFile(path, value, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly)
    )
      specifier = node.moduleSpecifier;
    else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    )
      specifier = node.arguments[0];
    if (specifier && ts.isStringLiteralLike(specifier) && packagePattern.test(specifier.text))
      sourceImports.push({ path, module: specifier.text });
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (/import\.meta\.glob\s*\(/.test(value)) sourceGlobImports.push(path);
}
const packages = [];
for (const name of ['backend', 'frontend']) {
  const directory = join(project, name);
  const explained = JSON.parse(
    execFileSync('npm', ['explain', 'picomatch', '--json'], {
      cwd: directory,
      encoding: 'utf8',
      maxBuffer: 1000000,
    }),
  );
  const dependencyPaths = new Set();
  function walk(value, suffix) {
    if (!value.name) {
      dependencyPaths.add(suffix.join(' → '));
      return;
    }
    const label = `${value.name}@${value.version}`;
    if (suffix.includes(label)) return;
    for (const dependent of value.dependents ?? []) walk(dependent.from, [label, ...suffix]);
  }
  explained.forEach((value) => walk(value, []));
  const listing = spawnSync('npm', ['ls', 'picomatch', '--omit=dev', '--all', '--json'], {
    cwd: directory,
    encoding: 'utf8',
    maxBuffer: 1000000,
  });
  const production = JSON.parse(listing.stdout);
  if (
    listing.status !== 0 &&
    !(
      listing.status === 1 &&
      listing.stderr === '' &&
      Object.keys(production).every((key) => ['name', 'version'].includes(key))
    )
  ) {
    throw new Error('Production dependency inventory failed');
  }
  const lock = readFileSync(join(directory, 'package-lock.json'));
  const lockValue = JSON.parse(lock);
  const directConsumers = Object.entries(lockValue.packages).flatMap(([location, pkg]) =>
    ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((kind) =>
      pkg[kind]?.picomatch
        ? [
            {
              package: location.replace(/^node_modules\//, ''),
              version: pkg.version,
              kind,
              range: pkg[kind].picomatch,
              development: pkg.dev === true,
            },
          ]
        : [],
    ),
  );
  packages.push({
    project: name,
    lockSha256: createHash('sha256').update(lock).digest('hex'),
    installedPicomatch: explained.map(({ version, dev, location }) => ({ version, dev, location })),
    directConsumers,
    dependencyPaths: [...dependencyPaths].sort(),
    productionDependencyPresent: !!production.dependencies?.picomatch,
  });
}
// Snapshot only existing JS; do not invoke or regenerate a build during the
// parent's frozen verifier. Public parser option names survive normal minify.
const artifact = {
  exists: false,
  javascriptFiles: 0,
  parserMarkers: [],
  exhaustiveModuleGraph: false,
};
function inspect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) inspect(path);
    else if (/\.(?:[cm]?js)$/.test(entry.name) && statSync(path).size <= 50000000) {
      artifact.javascriptFiles++;
      const text = readFileSync(path, 'utf8');
      if (/analyzeRepeatedExtglob|maxExtglobRecursion|picomatch/.test(text))
        artifact.parserMarkers.push(path.slice(project.length + 1));
    }
  }
}
try {
  readdirSync(join(project, 'frontend/dist'));
  artifact.exists = true;
  inspect(join(project, 'frontend/dist'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}
const frontend = JSON.parse(readFileSync(join(project, 'frontend/package.json'), 'utf8'));
process.stdout.write(
  `${JSON.stringify(
    {
      contract: 'pos-development-glob-exposure-v1',
      sourceHead: execFileSync('git', ['-C', project, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).trim(),
      packages,
      sourceImports,
      sourceGlobImports,
      existingFrontendArtifact: artifact,
      frontendDevCommand: frontend.scripts.dev,
      frontendPreviewCommand: frontend.scripts.preview,
      desktopBuildFiles: frontend.build?.files ?? null,
    },
    null,
    2,
  )}\n`,
);
