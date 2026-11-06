import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { argv, cwd, exit, stderr } from 'node:process';

import tseslint from 'typescript-eslint';

const sourceExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const ignoredDirectories = new Set(['.git', 'build', 'coverage', 'dist', 'node_modules', 'out']);

async function sourceFiles(target) {
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        files.push(...(await sourceFiles(entryPath)));
      }
    } else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(entryPath);
    }
  }

  return files;
}

function directiveViolation(comment) {
  const isLineComment = comment.startsWith('//');
  const body = (isLineComment ? comment.slice(2) : comment.slice(2, -2)).trim();
  const isOxlintDirective = /^oxlint-(?:disable(?:-line|-next-line)?|enable)(?=\s|$)/u.test(body);
  const isEslintDirective = isLineComment
    ? /^eslint-(?:disable(?:-line|-next-line)?|enable)(?=\s|$)/u.test(body)
    : /^(?:eslint-(?:disable(?:-line|-next-line)?|enable|env)|exported|globals?)(?=\s|$)/u.test(body) ||
      /^eslint\s+[^\s,:]+(?:\s*,\s*[^\s,:]+)*\s*:/u.test(body);

  if (isOxlintDirective) {
    return 'use the shared // eslint-disable-next-line <rule>[, <rule>] -- <reason> form';
  }

  if (isEslintDirective) {
    const match = isLineComment
      ? /^eslint-disable-next-line\s+([^\s,]+(?:\s*,\s*[^\s,]+)*)\s+--\s+(\S.*)$/u.exec(body)
      : null;
    if (match === null) {
      return 'use only // eslint-disable-next-line <rule>[, <rule>] -- <reason>';
    }

    const rules = match[1]?.split(',').map((rule) => rule.trim()) ?? [];
    if (rules.some((rule) => rule.startsWith('@eslint-community/eslint-comments/'))) {
      return 'the exception-protocol rules cannot suppress themselves';
    }

    return undefined;
  }

  if (body.startsWith('@ts-')) {
    return isLineComment && /^@ts-expect-error\s+--\s+\S.*$/u.test(body)
      ? undefined
      : 'use only // @ts-expect-error -- <reason>';
  }

  return undefined;
}

function violationsFor(source, fileName) {
  const { ast } = tseslint.parser.parseForESLint(source, {
    comment: true,
    filePath: fileName,
    loc: true,
    range: true,
    sourceType: 'module',
  });
  const violations = [];

  for (const comment of ast.comments) {
    const violation = directiveViolation(source.slice(comment.range[0], comment.range[1]));
    if (violation !== undefined) {
      violations.push(`${fileName}:${String(comment.loc.start.line)}: ${violation}`);
    }
  }

  return violations;
}

const arguments_ = argv.slice(2);
const targets = arguments_.length === 0 ? [cwd()] : arguments_.map((target) => path.resolve(target));
const files = [];

for (const target of targets) {
  const stats = await stat(target);
  files.push(...(stats.isDirectory() ? await sourceFiles(target) : [target]));
}

const violations = [];
for (const file of files.sort()) {
  violations.push(...violationsFor(await readFile(file, 'utf8'), path.relative(cwd(), file) || file));
}

if (violations.length > 0) {
  stderr.write(`${violations.join('\n')}\n`);
  exit(1);
}
