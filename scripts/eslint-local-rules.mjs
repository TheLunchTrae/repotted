const objectMutationMethods = new Set([
  'assign',
  'defineProperties',
  'defineProperty',
  'freeze',
  'preventExtensions',
  'seal',
  'setPrototypeOf',
]);
const reflectMutationMethods = new Set([
  'defineProperty',
  'deleteProperty',
  'preventExtensions',
  'set',
  'setPrototypeOf',
]);

function exportedName(node) {
  return node.type === 'Identifier' ? node.name : String(node.value);
}

function unwrapExpression(node) {
  let current = node;
  while (
    current?.type === 'ChainExpression' ||
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSNonNullExpression' ||
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'TSTypeAssertion'
  ) {
    current = current.expression;
  }

  return current;
}

function variableFor(identifier, sourceCode) {
  let scope = sourceCode.getScope(identifier);
  while (scope !== null) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
    scope = scope.upper;
  }

  return undefined;
}

function isUnboundIdentifier(node, name, sourceCode) {
  if (node.type !== 'Identifier' || node.name !== name) {
    return false;
  }

  const variable = variableFor(node, sourceCode);
  return variable === undefined || variable.defs.length === 0;
}

function immutableBinding(identifier, sourceCode) {
  const variable = variableFor(identifier, sourceCode);
  if (variable === undefined || variable.defs.length !== 1) {
    return undefined;
  }

  const [definition] = variable.defs;
  if (definition?.type !== 'Variable' || definition.node.parent?.kind !== 'const') {
    return undefined;
  }

  return { definition, variable };
}

function directInitializer(identifier, sourceCode, seenVariables) {
  const binding = immutableBinding(identifier, sourceCode);
  if (
    binding === undefined ||
    binding.definition.node.id.type !== 'Identifier' ||
    seenVariables.has(binding.variable)
  ) {
    return undefined;
  }

  seenVariables.add(binding.variable);
  return binding.definition.node.init ?? undefined;
}

function staticString(node, sourceCode, seenVariables = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }

  if (expression?.type === 'TemplateLiteral') {
    let value = '';
    for (const [index, quasi] of expression.quasis.entries()) {
      value += quasi.value.cooked ?? quasi.value.raw;
      const substitution = expression.expressions[index];
      if (substitution !== undefined) {
        const resolved = staticString(substitution, sourceCode, new Set(seenVariables));
        if (resolved === undefined) {
          return undefined;
        }
        value += resolved;
      }
    }
    return value;
  }

  if (expression?.type === 'BinaryExpression' && expression.operator === '+') {
    const left = staticString(expression.left, sourceCode, new Set(seenVariables));
    const right = staticString(expression.right, sourceCode, new Set(seenVariables));
    return left === undefined || right === undefined ? undefined : left + right;
  }

  if (expression?.type === 'Identifier') {
    const initializer = directInitializer(expression, sourceCode, seenVariables);
    return initializer === undefined ? undefined : staticString(initializer, sourceCode, seenVariables);
  }

  return undefined;
}

function propertyKeyName(property, sourceCode) {
  return property.computed
    ? staticString(property.key, sourceCode)
    : property.key.type === 'Identifier'
      ? property.key.name
      : String(property.key.value);
}

function memberName(member, sourceCode, seenVariables = new Set()) {
  return member.computed
    ? staticString(member.property, sourceCode, seenVariables)
    : member.property.type === 'Identifier'
      ? member.property.name
      : undefined;
}

function isIntrinsic(node, name, sourceCode, seenVariables = new Set()) {
  const expression = unwrapExpression(node);
  if (
    expression?.type === 'MemberExpression' &&
    memberName(expression, sourceCode, new Set(seenVariables)) === name &&
    isAmbientGlobal(expression.object, sourceCode, new Set(seenVariables))
  ) {
    return true;
  }

  if (expression?.type !== 'Identifier') {
    return false;
  }

  if (isUnboundIdentifier(expression, name, sourceCode)) {
    return true;
  }

  const initializer = directInitializer(expression, sourceCode, seenVariables);
  return initializer === undefined ? false : isIntrinsic(initializer, name, sourceCode, seenVariables);
}

function isAmbientGlobal(node, sourceCode, seenVariables = new Set()) {
  const expression = unwrapExpression(node);
  if (
    isIntrinsic(expression, 'globalThis', sourceCode, new Set(seenVariables)) ||
    isIntrinsic(expression, 'global', sourceCode, new Set(seenVariables))
  ) {
    return true;
  }

  return (
    expression?.type === 'MemberExpression' &&
    ['global', 'globalThis'].includes(memberName(expression, sourceCode, seenVariables)) &&
    isAmbientGlobal(expression.object, sourceCode, seenVariables)
  );
}

function isAmbientGlobalRooted(node, sourceCode) {
  const expression = unwrapExpression(node);
  return (
    isAmbientGlobal(expression, sourceCode) ||
    (expression?.type === 'MemberExpression' && isAmbientGlobalRooted(expression.object, sourceCode))
  );
}

function mutatesAmbientGlobal(node, sourceCode) {
  const target = unwrapExpression(node);
  if (target?.type === 'Identifier') {
    return isAmbientGlobal(target, sourceCode);
  }
  if (target?.type === 'MemberExpression') {
    return isAmbientGlobalRooted(target.object, sourceCode);
  }
  if (target?.type === 'AssignmentPattern' || target?.type === 'RestElement') {
    return mutatesAmbientGlobal(target.left ?? target.argument, sourceCode);
  }
  if (target?.type === 'ArrayPattern') {
    return target.elements.some((element) => element !== null && mutatesAmbientGlobal(element, sourceCode));
  }
  if (target?.type === 'ObjectPattern') {
    return target.properties.some((property) =>
      mutatesAmbientGlobal(property.type === 'Property' ? property.value : property.argument, sourceCode),
    );
  }

  return false;
}

function destructuredMember(identifier, sourceCode, seenVariables) {
  const binding = immutableBinding(identifier, sourceCode);
  const pattern = binding?.definition.node.id;
  if (binding === undefined || pattern?.type !== 'ObjectPattern' || seenVariables.has(binding.variable)) {
    return undefined;
  }

  seenVariables.add(binding.variable);
  const property = pattern.properties.find((candidate) => {
    if (candidate.type !== 'Property') {
      return false;
    }
    const value = candidate.value.type === 'AssignmentPattern' ? candidate.value.left : candidate.value;
    return value.type === 'Identifier' && value.name === identifier.name;
  });
  if (property?.type !== 'Property') {
    return undefined;
  }

  const name = propertyKeyName(property, sourceCode);
  return name === undefined ? undefined : { name, owner: binding.definition.node.init };
}

function destructuredMutationMethod(identifier, sourceCode, seenVariables) {
  const member = destructuredMember(identifier, sourceCode, seenVariables);
  if (member === undefined) {
    return undefined;
  }

  if (isIntrinsic(member.owner, 'Object', sourceCode, new Set(seenVariables))) {
    return objectMutationMethods.has(member.name) ? member.name : undefined;
  }
  if (isIntrinsic(member.owner, 'Reflect', sourceCode, new Set(seenVariables))) {
    return reflectMutationMethods.has(member.name) ? member.name : undefined;
  }

  return undefined;
}

function mutationMethod(node, sourceCode, seenVariables = new Set()) {
  const expression = unwrapExpression(node);
  if (expression?.type === 'MemberExpression') {
    const method = memberName(expression, sourceCode, new Set(seenVariables));
    if (method !== undefined && isIntrinsic(expression.object, 'Object', sourceCode, new Set(seenVariables))) {
      return objectMutationMethods.has(method) ? method : undefined;
    }
    if (method !== undefined && isIntrinsic(expression.object, 'Reflect', sourceCode, new Set(seenVariables))) {
      return reflectMutationMethods.has(method) ? method : undefined;
    }
  }

  if (expression?.type === 'Identifier') {
    const destructured = destructuredMutationMethod(expression, sourceCode, seenVariables);
    if (destructured !== undefined) {
      return destructured;
    }
    const initializer = directInitializer(expression, sourceCode, seenVariables);
    return initializer === undefined ? undefined : mutationMethod(initializer, sourceCode, seenVariables);
  }

  return undefined;
}

function mutationTarget(call, sourceCode) {
  if (mutationMethod(call.callee, sourceCode) !== undefined) {
    return call.arguments[0];
  }

  const callee = unwrapExpression(call.callee);
  if (
    callee?.type === 'MemberExpression' &&
    memberName(callee, sourceCode) === 'call' &&
    mutationMethod(callee.object, sourceCode) !== undefined
  ) {
    return call.arguments[1];
  }

  return undefined;
}

const noGlobalMutation = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      alias:
        'Destructured, mutable, or default-parameter aliases of the ambient global object escape static ownership tracking. Use the needed global API directly.',
      mutation:
        'Mutating the ambient global object creates ambient state. Thread the value through a service or the root model.',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const report = (node) => context.report({ node, messageId: 'mutation' });

    return {
      AssignmentExpression(node) {
        if (mutatesAmbientGlobal(node.left, sourceCode)) {
          report(node);
        } else if (
          (node.left.type === 'Identifier' || node.left.type === 'ObjectPattern') &&
          isAmbientGlobal(node.right, sourceCode)
        ) {
          context.report({ node, messageId: 'alias' });
        }
      },
      AssignmentPattern(node) {
        if (isAmbientGlobal(node.right, sourceCode)) {
          context.report({ node, messageId: 'alias' });
        }
      },
      CallExpression(node) {
        if (isAmbientGlobalRooted(mutationTarget(node, sourceCode), sourceCode)) {
          report(node);
        }
      },
      ForInStatement(node) {
        if (node.left.type !== 'VariableDeclaration' && mutatesAmbientGlobal(node.left, sourceCode)) {
          report(node);
        }
      },
      ForOfStatement(node) {
        if (node.left.type !== 'VariableDeclaration' && mutatesAmbientGlobal(node.left, sourceCode)) {
          report(node);
        }
      },
      UnaryExpression(node) {
        if (
          node.operator === 'delete' &&
          node.argument.type === 'MemberExpression' &&
          isAmbientGlobalRooted(node.argument.object, sourceCode)
        ) {
          report(node);
        }
      },
      UpdateExpression(node) {
        if (node.argument.type === 'MemberExpression' && isAmbientGlobalRooted(node.argument.object, sourceCode)) {
          report(node);
        }
      },
      VariableDeclarator(node) {
        if (
          (node.id.type === 'ObjectPattern' || node.parent.kind !== 'const') &&
          isAmbientGlobal(node.init, sourceCode)
        ) {
          context.report({ node, messageId: 'alias' });
        }
      },
    };
  },
};

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

const noTypeScriptEmitSyntax = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: { allowNamespaces: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
    messages: {
      enum: 'Do not use TypeScript enums. Use as const objects plus union types.',
      exportAssignment: 'Do not use export =. Use ES exports.',
      importEquals: 'Do not use import =. Use standard ES imports.',
      namespace:
        'Do not use TypeScript namespaces in application or test code. Put ambient declarations in *.d.ts files and use ES modules for runtime namespacing.',
      parameterProperty: 'Do not use parameter properties. Declare fields explicitly.',
    },
  },
  create(context) {
    const allowNamespaces = context.options[0]?.allowNamespaces === true;
    const report = (node, messageId) => context.report({ node, messageId });

    return {
      TSEnumDeclaration: (node) => report(node, 'enum'),
      TSExportAssignment: (node) => report(node, 'exportAssignment'),
      TSImportEqualsDeclaration: (node) => report(node, 'importEquals'),
      TSModuleDeclaration(node) {
        if (!allowNamespaces) {
          report(node, 'namespace');
        }
      },
      TSParameterProperty: (node) => report(node, 'parameterProperty'),
    };
  },
};

const esmOnly = {
  meta: {
    type: 'problem',
    schema: [],
    messages: { commonjs: 'Do not use CommonJS module syntax. Use ES imports and exports.' },
  },
  create(context) {
    const { sourceCode } = context;
    const report = (node) => context.report({ node, messageId: 'commonjs' });

    return {
      CallExpression(node) {
        if (isUnboundIdentifier(node.callee, 'require', sourceCode)) {
          report(node);
        }
      },
      MemberExpression(node) {
        if (
          isUnboundIdentifier(node.object, 'exports', sourceCode) ||
          (isUnboundIdentifier(node.object, 'module', sourceCode) && memberName(node, sourceCode) === 'exports')
        ) {
          report(node);
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
    'esm-only': esmOnly,
    'no-default-export': noDefaultExport,
    'no-global-mutation': noGlobalMutation,
    'no-module-mutable-binding': noModuleMutableBinding,
    'no-typescript-emit-syntax': noTypeScriptEmitSyntax,
    'typescript-source-only': typeScriptSourceOnly,
  },
};

/** @public Oxlint loads this plugin through `jsPlugins` in .oxlintrc.json, which knip reports as unused. */
// eslint-disable-next-line standards/no-default-export -- Oxlint loads this one plugin object through a default export.
export default standardsPlugin;
