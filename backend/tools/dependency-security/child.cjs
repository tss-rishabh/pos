'use strict';
// Every potentially expensive regex runs here, behind the parent's deadline.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
const pm = require(request.module);
const start = performance.now();
if (request.action === 'match') {
  const expression = pm.makeRe(request.pattern, request.options);
  const result = pm.isMatch(request.subject, request.pattern, request.options);
  process.stdout.write(
    JSON.stringify({
      result,
      regexResult: expression.test(request.subject),
      source: expression.source,
      milliseconds: performance.now() - start,
    }),
  );
} else if (request.action === 'matrix') {
  const other = require(request.other);
  let pairs = 0,
    sources = 0;
  const differences = [];
  for (const options of request.options)
    for (const pattern of request.patterns) {
      const left = pm.makeRe(pattern, options),
        right = other.makeRe(pattern, options);
      if (request.sourceEquality !== false && left.source !== right.source)
        differences.push({ kind: 'source', pattern, options });
      const leftMatcher = pm(pattern, options),
        rightMatcher = other(pattern, options);
      sources++;
      for (const subject of request.subjects) {
        if (leftMatcher(subject) !== rightMatcher(subject)) {
          differences.push({ kind: 'match', pattern, options, subject });
        }
        pairs++;
        if (differences.length >= 10) break;
      }
      if (differences.length >= 10) break;
    }
  process.stdout.write(
    JSON.stringify({ sources, pairs, differences, milliseconds: performance.now() - start }),
  );
} else throw new Error('Unknown isolated dependency check');
