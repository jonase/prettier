var assert = require("assert");
var types = require("ast-types");
var n = types.namedTypes;
var Node = n.Node;
var isArray = types.builtInTypes.array;
var isNumber = types.builtInTypes.number;

function FastPath(value) {
  assert.ok(this instanceof FastPath);
  this.stack = [ value ];
}

var FPp = FastPath.prototype;
module.exports = FastPath;

// Static convenience function for coercing a value to a FastPath.
FastPath.from = function(obj) {
  if (obj instanceof FastPath) {
    // Return a defensive copy of any existing FastPath instances.
    return obj.copy();
  }

  if (obj instanceof types.NodePath) {
    // For backwards compatibility, unroll NodePath instances into
    // lightweight FastPath [..., name, value] stacks.
    var copy = Object.create(FastPath.prototype);
    var stack = [ obj.value ];
    for (var pp; pp = obj.parentPath; obj = pp)
      stack.push(obj.name, pp.value);
    copy.stack = stack.reverse();
    return copy;
  }

  // Otherwise use obj as the value of the new FastPath instance.
  return new FastPath(obj);
};

FPp.copy = function copy() {
  var copy = Object.create(FastPath.prototype);
  copy.stack = this.stack.slice(0);
  return copy;
};

// The name of the current property is always the penultimate element of
// this.stack, and always a String.
FPp.getName = function getName() {
  var s = this.stack;
  var len = s.length;
  if (len > 1) {
    return s[len - 2];
  }
  // Since the name is always a string, null is a safe sentinel value to
  // return if we do not know the name of the (root) value.
  return null;
};

// The value of the current property is always the final element of
// this.stack.
FPp.getValue = function getValue() {
  var s = this.stack;
  return s[s.length - 1];
};

function getNodeHelper(path, count) {
  var s = path.stack;

  for (var i = s.length - 1; i >= 0; i -= 2) {
    var value = s[i];
    if (n.Node.check(value) && --count < 0) {
      return value;
    }
  }

  return null;
}

FPp.getNode = function getNode(count) {
  return getNodeHelper(this, ~~count);
};

FPp.getParentNode = function getParentNode(count) {
  return getNodeHelper(this, ~~count + 1);
};

// The length of the stack can be either even or odd, depending on whether
// or not we have a name for the root value. The difference between the
// index of the root value and the index of the final value is always
// even, though, which allows us to return the root value in constant time
// (i.e. without iterating backwards through the stack).
FPp.getRootValue = function getRootValue() {
  var s = this.stack;
  if (s.length % 2 === 0) {
    return s[(1)];
  }
  return s[(0)];
};

// Temporarily push properties named by string arguments given after the
// callback function onto this.stack, then call the callback with a
// reference to this (modified) FastPath object. Note that the stack will
// be restored to its original state after the callback is finished, so it
// is probably a mistake to retain a reference to the path.
FPp.call = function call(callback /*, name1, name2, ... */) {
  var s = this.stack;
  var origLen = s.length;
  var value = s[origLen - 1];
  var argc = arguments.length;
  for (var i = 1; i < argc; ++i) {
    var name = arguments[i];
    value = value[name];
    s.push(name, value);
  }
  var result = callback(this);
  s.length = origLen;
  return result;
};

// Similar to FastPath.prototype.call, except that the value obtained by
// accessing this.getValue()[name1][name2]... should be array-like. The
// callback will be called with a reference to this path object for each
// element of the array.
FPp.each = function each(callback /*, name1, name2, ... */) {
  var s = this.stack;
  var origLen = s.length;
  var value = s[origLen - 1];
  var argc = arguments.length;

  for (var i = 1; i < argc; ++i) {
    var name = arguments[i];
    value = value[name];
    s.push(name, value);
  }

  for (var i = 0; i < value.length; ++i) {
    if (i in value) {
      s.push(i, value[i]);
      // If the callback needs to know the value of i, call
      // path.getName(), assuming path is the parameter name.
      callback(this);
      s.length -= 2;
    }
  }

  s.length = origLen;
};

// Similar to FastPath.prototype.each, except that the results of the
// callback function invocations are stored in an array and returned at
// the end of the iteration.
FPp.map = function map(callback /*, name1, name2, ... */) {
  var s = this.stack;
  var origLen = s.length;
  var value = s[origLen - 1];
  var argc = arguments.length;

  for (var i = 1; i < argc; ++i) {
    var name = arguments[i];
    value = value[name];
    s.push(name, value);
  }

  var result = new Array(value.length);

  for (var i = 0; i < value.length; ++i) {
    if (i in value) {
      s.push(i, value[i]);
      result[i] = callback(this, i);
      s.length -= 2;
    }
  }

  s.length = origLen;

  return result;
};

// Inspired by require("ast-types").NodePath.prototype.needsParens, but
// more efficient because we're iterating backwards through a stack.
FPp.needsParens = function(assumeExpressionContext) {
  var parent = this.getParentNode();
  if (!parent) {
    return false;
  }

  var name = this.getName();
  var node = this.getNode();

  // If the value of this path is some child of a Node and not a Node
  // itself, then it doesn't need parentheses. Only Node objects (in
  // fact, only Expression nodes) need parentheses.
  if (this.getValue() !== node) {
    return false;
  }

  // Only statements don't need parentheses.
  if (n.Statement.check(node)) {
    return false;
  }

  // Identifiers never need parentheses.
  if (node.type === "Identifier") {
    return false;
  }

  if (parent.type === "ParenthesizedExpression") {
    return false;
  }

  // Add parens around a `class` that extends an expression (it should
  // parse correctly, even if it's invalid)
  if (
    parent.type === "ClassDeclaration" && parent.superClass === node &&
      node.type === "AwaitExpression"
  ) {
    return true;
  }

  // The left-hand side of the ** exponentiation operator must always
  // be parenthesized unless it's an ident or literal
  if (
    parent.type === "BinaryExpression" && parent.operator === "**" &&
      parent.left === node &&
      node.type !== "Identifier" &&
      node.type !== "Literal"
  ) {
    return true;
  }

  switch (node.type) {
    case "UnaryExpression":
    case "SpreadElement":
    case "SpreadProperty":
      return parent.type === "MemberExpression" && name === "object" &&
        parent.object === node;

    case "BinaryExpression":
    case "LogicalExpression":
      switch (parent.type) {
        case "CallExpression":
          return name === "callee" && parent.callee === node;

        case "UnaryExpression":
        case "SpreadElement":
        case "SpreadProperty":
          return true;

        case "MemberExpression":
          return name === "object" && parent.object === node;

        case "BinaryExpression":
        case "LogicalExpression":
          var po = parent.operator;
          var pp = PRECEDENCE[po];
          var no = node.operator;
          var np = PRECEDENCE[no];

          if (pp > np) {
            return true;
          }

          if (pp === np && name === "right") {
            assert.strictEqual(parent.right, node);
            return true;
          }

        default:
          return false;
      }

    case "SequenceExpression":
      switch (parent.type) {
        case "ReturnStatement":
          return false;

        case "ForStatement":
          // Although parentheses wouldn't hurt around sequence
          // expressions in the head of for loops, traditional style
          // dictates that e.g. i++, j++ should not be wrapped with
          // parentheses.
          return false;

        case "ExpressionStatement":
          return name !== "expression";

        default:
          // Otherwise err on the side of overparenthesization, adding
          // explicit exceptions above if this proves overzealous.
          return true;
      }

    case "YieldExpression":
      switch (parent.type) {
        case "BinaryExpression":
        case "LogicalExpression":
        case "UnaryExpression":
        case "SpreadElement":
        case "SpreadProperty":
        case "CallExpression":
        case "MemberExpression":
        case "NewExpression":
        case "ConditionalExpression":
        case "YieldExpression":
          return true;

        default:
          return false;
      }

    case "ArrayTypeAnnotation":
      return parent.type === "NullableTypeAnnotation";

    case "IntersectionTypeAnnotation":
    case "UnionTypeAnnotation":
      return parent.type === "NullableTypeAnnotation" ||
        parent.type === "IntersectionTypeAnnotation" ||
        parent.type === "UnionTypeAnnotation";

    case "NullableTypeAnnotation":
      return parent.type === "ArrayTypeAnnotation";

    case "FunctionTypeAnnotation":
      return parent.type === "UnionTypeAnnotation" ||
        parent.type === "IntersectionTypeAnnotation";

    case "Literal":
      return parent.type === "MemberExpression" && isNumber.check(node.value) &&
        name === "object" &&
        parent.object === node;

    case "NumericLiteral":
      return parent.type === "MemberExpression";

    case "AssignmentExpression":
    case "ConditionalExpression":
      switch (parent.type) {
        case "UnaryExpression":
        case "SpreadElement":
        case "SpreadProperty":
        case "BinaryExpression":
        case "LogicalExpression":
          return true;

        case "CallExpression":
          return name === "callee" && parent.callee === node;

        case "ConditionalExpression":
          return name === "test" && parent.test === node;

        case "MemberExpression":
          return name === "object" && parent.object === node;

        default:
          return n.ObjectPattern.check(node.left) && this.firstInStatement();
      }

    case "ArrowFunctionExpression":
      if (parent.type === "CallExpression" && name === "callee") {
        return true;
      }

      return isBinary(parent);

    case "ClassExpression":
      return parent.type === "ExpressionStatement";

    case "ObjectExpression":
      if (parent.type === "ArrowFunctionExpression" && name === "body") {
        return true;
      }

    default:
      if (
        parent.type === "NewExpression" && name === "callee" &&
          parent.callee === node
      ) {
        return containsCallExpression(node);
      }
  }

  if (
    assumeExpressionContext !== true && !this.canBeFirstInStatement() &&
      this.firstInStatement()
  )
    return true;

  return false;
};

function isBinary(node) {
  return n.BinaryExpression.check(node) || n.LogicalExpression.check(node);
}

function isUnaryLike(node) {
  return // I considered making SpreadElement and SpreadProperty subtypes
  // of UnaryExpression, but they're not really Expression nodes.
  n.UnaryExpression.check(
    node
  ) || n.SpreadElement && n.SpreadElement.check(node) || n.SpreadProperty && n.SpreadProperty.check(node);
}

var PRECEDENCE = {};
[
  [ "||" ],
  [ "&&" ],
  [ "|" ],
  [ "^" ],
  [ "&" ],
  [ "==", "===", "!=", "!==" ],
  [ "<", ">", "<=", ">=", "in", "instanceof" ],
  [ ">>", "<<", ">>>" ],
  [ "+", "-" ],
  [ "*", "/", "%", "**" ]
].forEach(function(tier, i) {
  tier.forEach(function(op) {
    PRECEDENCE[op] = i;
  });
});

function containsCallExpression(node) {
  if (n.CallExpression.check(node)) {
    return true;
  }

  if (isArray.check(node)) {
    return node.some(containsCallExpression);
  }

  if (n.Node.check(node)) {
    return types.someField(node, function(name, child) {
      return containsCallExpression(child);
    });
  }

  return false;
}

FPp.canBeFirstInStatement = function() {
  var node = this.getNode();
  return !n.FunctionExpression.check(node) && !n.ObjectExpression.check(node) &&
    !n.ClassExpression.check(node) &&
    !(n.AssignmentExpression.check(node) && n.ObjectPattern.check(node.left));
};

FPp.firstInStatement = function() {
  var s = this.stack;
  var parentName, parent;
  var childName, child;

  for (var i = s.length - 1; i >= 0; i -= 2) {
    if (n.Node.check(s[i])) {
      childName = parentName;
      child = parent;
      parentName = s[i - 1];
      parent = s[i];
    }

    if (!parent || !child) {
      continue;
    }

    if (
      n.BlockStatement.check(parent) && parentName === "body" && childName === 0
    ) {
      assert.strictEqual(parent.body[(0)], child);
      return true;
    }

    if (n.ExpressionStatement.check(parent) && childName === "expression") {
      assert.strictEqual(parent.expression, child);
      return true;
    }

    if (
      n.SequenceExpression.check(parent) && parentName === "expressions" &&
        childName === 0
    ) {
      assert.strictEqual(parent.expressions[(0)], child);
      continue;
    }

    if (n.CallExpression.check(parent) && childName === "callee") {
      assert.strictEqual(parent.callee, child);
      continue;
    }

    if (n.MemberExpression.check(parent) && childName === "object") {
      assert.strictEqual(parent.object, child);
      continue;
    }

    if (n.ConditionalExpression.check(parent) && childName === "test") {
      assert.strictEqual(parent.test, child);
      continue;
    }

    if (isBinary(parent) && childName === "left") {
      assert.strictEqual(parent.left, child);
      continue;
    }

    if (
      n.UnaryExpression.check(parent) && !parent.prefix &&
        childName === "argument"
    ) {
      assert.strictEqual(parent.argument, child);
      continue;
    }

    return false;
  }

  return true;
};
