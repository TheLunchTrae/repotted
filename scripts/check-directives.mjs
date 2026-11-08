import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { argv, cwd, exit, stderr } from 'node:process';

import ts from 'typescript';

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

// Lists every comment by asking TypeScript's scanner for the comments around
// each token of the parsed file. Parsing first keeps the text of strings,
// templates, and regular expressions out of the result. The walk skips JSDoc
// nodes, whose tags sit inside a comment it already finds, and drops what the
// scanner reads as comments inside JSX text, which is not trivia.
function commentRanges(sourceFile) {
  const { text } = sourceFile;
  const comments = new Map();
  const jsxText = [];
  const add = (ranges) => {
    for (const range of ranges ?? []) {
      comments.set(range.pos, range);
    }
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) {
      jsxText.push(node);
    } else if (ts.isTokenKind(node.kind)) {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
    } else if (!ts.isJSDoc(node)) {
      for (const child of node.getChildren(sourceFile)) {
        visit(child);
      }
    }
  };
  visit(sourceFile);

  return [...comments.values()]
    .filter((comment) => !jsxText.some((node) => comment.pos >= node.pos && comment.pos < node.end))
    .sort((left, right) => left.pos - right.pos);
}

function violationsFor(source, fileName) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations = [];

  for (const comment of commentRanges(sourceFile)) {
    const violation = directiveViolation(source.slice(comment.pos, comment.end));
    if (violation !== undefined) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(comment.pos);
      violations.push(`${fileName}:${String(line + 1)}: ${violation}`);
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
