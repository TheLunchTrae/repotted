function exportedName(node) {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

const noDefaultExport = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      defaultExport: 'Use a named export so imports and refactors keep one stable symbol name.',
    },
  },
  create(context) {
    const report = (node) => context.report({ node, messageId: 'defaultExport' });

    return {
      ExportAllDeclaration(node) {
        if (node.exported !== null && exportedName(node.exported) === 'default') {
          report(node);
        }
      },
      ExportDefaultDeclaration: report,
      ExportNamedDeclaration(node) {
        if (node.specifiers.some((specifier) => exportedName(specifier.exported) === 'default')) {
          report(node);
        }
      },
    };
  },
};

const noModuleMutableBinding = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      module:
        'Module-scope mutable binding is ambient shared state. Put the value on the owning service or root model, or use Ref inside Effect.',
      exported:
        'Exported mutable binding is a global mutable singleton. Export a constructor or provide the value as a layer instead.',
    },
  },
  create(context) {
    return {
      VariableDeclaration(node) {
        if (node.kind === 'const') {
          return;
        }

        if (node.parent.type === 'Program') {
          context.report({ node, messageId: 'module' });
        } else if (node.parent.type === 'ExportNamedDeclaration' && node.parent.parent.type === 'Program') {
          context.report({ node, messageId: 'exported' });
        }
      },
    };
  },
};

// erasableSyntaxOnly already rejects enums that emit code. This rule reports
// every enum, so it also covers `declare enum` and enums in declaration files.
const noEnum = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { enum: 'Do not use TypeScript enums. Use as const objects plus union types.' },
  },
  create(context) {
    return {
      TSEnumDeclaration(node) {
        context.report({ node, messageId: 'enum' });
      },
    };
  },
};

// typescript/no-namespace and erasableSyntaxOnly both allow `declare global {}`
// and string-named `declare module 'x' {}`, so package source reports every
// module declaration here and ambient ones live in *.d.ts files.
const noModuleDeclaration = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      module:
        'Do not declare namespaces, modules or globals in application or test code. Put ambient declarations in *.d.ts files and use ES modules for runtime namespacing.',
    },
  },
  create(context) {
    return {
      TSModuleDeclaration(node) {
        if (node.parent.type !== 'TSModuleDeclaration') {
          context.report({ node, messageId: 'module' });
        }
      },
    };
  },
};

const typeScriptSourceOnly = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      source: 'First-party application source must use .ts, .mts, .cts, or .tsx so the strict compiler gate owns it.',
    },
  },
  create(context) {
    return {
      Program(node) {
        context.report({ node, messageId: 'source' });
      },
    };
  },
};

const standardsPlugin = {
  meta: { name: 'standards-local', version: '1.0.0' },
  rules: {
    'no-default-export': noDefaultExport,
    'no-enum': noEnum,
    'no-module-declaration': noModuleDeclaration,
    'no-module-mutable-binding': noModuleMutableBinding,
    'typescript-source-only': typeScriptSourceOnly,
  },
};

/** @public Oxlint loads this plugin through `jsPlugins` in .oxlintrc.json, which knip reports as unused. */
// eslint-disable-next-line standards/no-default-export -- Oxlint loads this one plugin object through a default export.
export default standardsPlugin;
