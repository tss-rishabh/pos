
    // Local reviewed mitigation for GHSA-fc5q-39xc-vjpf. The single simple
    // wildcard rewrite follows upstream PR254's absorption argument. Each
    // fixed token must stay within a default wildcard's path segment; bracket,
    // slash, escaped, Bash-dot-star and nested/regex bodies are not qualified.
    // Preserve existing safe character-class rewrites. Other unsupported
    // repeated bodies use the parser's existing literal fallback, including
    // callers that try to disable maxExtglobRecursion safety checks.
    const repeated = token.type === 'plus' || token.type === 'star';
    const bodyTokens = tokens.slice(token.tokensIndex + 2);
    const branches = splitTopLevel(body);
    const plain = branches.map(normalizeSimpleBranch);
    const prefixFree = plain.length <= 128 && plain.every(Boolean) && plain.every((branch, i) =>
      plain.every((other, j) => i === j || (!branch.startsWith(other) && !other.startsWith(branch))));
    const singleWildcard = repeated && !analysis.risky && opts.bash !== true &&
      branches.length === 1 && bodyTokens.filter(part => part.type === 'star' && !part.extglob).length === 1 &&
      bodyTokens.every(part => !part.extglob && !part.suffix &&
        (part.type === 'star' || part.type === 'qmark' ||
          (part.type === 'text' && !/[\/\\\n\r\u2028\u2029]/.test(part.value))));

    if (repeated && !analysis.risky && !prefixFree && !singleWildcard) {
      analysis.risky = true;
    }
