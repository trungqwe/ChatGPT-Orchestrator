class ParseError extends Error {
  constructor(message, column) {
    super(message);
    this.name = 'ParseError';
    this.column = column;
  }
}

function tokenize(input) {
  if (typeof input !== 'string') {
    throw new TypeError('Expression must be a string');
  }

  const tokens = [];
  let i = 0;
  let lastTokenType = null;

  while (i < input.length) {
    const ch = input[i];
    const col = i + 1;

    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    const isDigit = ch >= '0' && ch <= '9';
    const isLeadingDotNumber = ch === '.' && lastTokenType !== 'NUMBER' && i + 1 < input.length && input[i + 1] >= '0' && input[i + 1] <= '9';

    if (isDigit || isLeadingDotNumber) {
      let numStr = '';
      const startCol = col;
      while (i < input.length && ((input[i] >= '0' && input[i] <= '9') || input[i] === '.')) {
        if (input[i] === '.' && numStr.includes('.')) {
          break;
        }
        numStr += input[i++];
      }
      tokens.push({
        type: 'NUMBER',
        value: parseFloat(numStr),
        raw: numStr,
        column: startCol
      });
      lastTokenType = 'NUMBER';
      continue;
    }

    switch (ch) {
      case '+':
        tokens.push({ type: 'PLUS', value: '+', column: col });
        lastTokenType = 'PLUS';
        i++;
        break;
      case '-':
        tokens.push({ type: 'MINUS', value: '-', column: col });
        lastTokenType = 'MINUS';
        i++;
        break;
      case '*':
        tokens.push({ type: 'STAR', value: '*', column: col });
        lastTokenType = 'STAR';
        i++;
        break;
      case '/':
        tokens.push({ type: 'SLASH', value: '/', column: col });
        lastTokenType = 'SLASH';
        i++;
        break;
      case '%':
        tokens.push({ type: 'PERCENT', value: '%', column: col });
        lastTokenType = 'PERCENT';
        i++;
        break;
      case '^':
        tokens.push({ type: 'CARET', value: '^', column: col });
        lastTokenType = 'CARET';
        i++;
        break;
      case '(':
        tokens.push({ type: 'LPAREN', value: '(', column: col });
        lastTokenType = 'LPAREN';
        i++;
        break;
      case ')':
        tokens.push({ type: 'RPAREN', value: ')', column: col });
        lastTokenType = 'RPAREN';
        i++;
        break;
      case '.':
        tokens.push({ type: 'DOT', value: '.', column: col });
        lastTokenType = 'DOT';
        i++;
        break;
      default:
        throw new ParseError("Invalid characters in expression: unexpected character '" + ch + "' at column " + col, col);
    }
  }

  tokens.push({
    type: 'EOF',
    value: null,
    column: input.length + 1
  });

  return tokens;
}

function parse(tokens) {
  let pos = 0;

  function peek() {
    return tokens[pos];
  }

  function parseExpression() {
    return parseAdditive();
  }

  function parseAdditive() {
    let left = parseMultiplicative();
    while (peek().type === 'PLUS' || peek().type === 'MINUS') {
      const opToken = peek();
      pos++;
      if (peek().type === 'EOF') {
        throw new ParseError("Missing operand after operator '" + opToken.value + "' at column " + opToken.column, peek().column);
      }
      const right = parseMultiplicative();
      left = {
        type: 'BinaryExpression',
        operator: opToken.value,
        left: left,
        right: right,
        column: opToken.column
      };
    }
    return left;
  }

  function parseMultiplicative() {
    let left = parseUnary();
    while (peek().type === 'STAR' || peek().type === 'SLASH' || peek().type === 'PERCENT') {
      const opToken = peek();
      pos++;
      if (peek().type === 'EOF') {
        throw new ParseError("Missing operand after operator '" + opToken.value + "' at column " + opToken.column, peek().column);
      }
      const right = parseUnary();
      left = {
        type: 'BinaryExpression',
        operator: opToken.value,
        left: left,
        right: right,
        column: opToken.column
      };
    }
    return left;
  }

  function parseUnary() {
    const token = peek();
    if (token.type === 'PLUS' || token.type === 'MINUS') {
      const unaryToken = token;
      pos++;
      if (peek().type === 'EOF') {
        throw new ParseError("Missing operand after operator '" + unaryToken.value + "' at column " + unaryToken.column, peek().column);
      }
      if (peek().type === 'NUMBER' && tokens[pos + 1] && tokens[pos + 1].type === 'CARET') {
        throw new ParseError("Unary operator used immediately before exponentiation expression requires parentheses at column " + unaryToken.column, unaryToken.column);
      }
      const argument = parseUnary();
      return {
        type: 'UnaryExpression',
        operator: unaryToken.value,
        argument: argument,
        column: unaryToken.column
      };
    }
    return parsePower();
  }

  function parsePower() {
    let left = parsePrimary();
    if (peek().type === 'CARET') {
      const opToken = peek();
      pos++;
      if (peek().type === 'EOF') {
        throw new ParseError("Missing operand after operator '" + opToken.value + "' at column " + opToken.column, peek().column);
      }
      const right = parseUnary();
      return {
        type: 'BinaryExpression',
        operator: '^',
        left: left,
        right: right,
        column: opToken.column
      };
    }
    return left;
  }

  function parsePrimary() {
    const token = peek();

    if (token.type === 'NUMBER') {
      pos++;
      return {
        type: 'Literal',
        value: token.value,
        raw: token.raw,
        column: token.column
      };
    }

    if (token.type === 'LPAREN') {
      const openParen = token;
      pos++;
      if (peek().type === 'RPAREN') {
        throw new ParseError("Missing operand inside parentheses at column " + peek().column, peek().column);
      }
      const expr = parseExpression();
      if (peek().type !== 'RPAREN') {
        throw new ParseError("Unmatched opening parenthesis '(' at column " + openParen.column, openParen.column);
      }
      pos++;
      return expr;
    }

    if (token.type === 'RPAREN') {
      throw new ParseError("Unexpected closing parenthesis ')' at column " + token.column, token.column);
    }

    throw new ParseError("Unexpected operator '" + token.value + "' at column " + token.column, token.column);
  }

  if (tokens[0].type === 'EOF') {
    throw new ParseError("Missing operand: empty expression at column 1", 1);
  }

  const ast = parseExpression();

  if (peek().type === 'RPAREN') {
    throw new ParseError("Unexpected closing parenthesis ')' at column " + peek().column, peek().column);
  }

  if (peek().type === 'DOT') {
    throw new ParseError("Unexpected operator '.' at column " + peek().column, peek().column);
  }

  if (peek().type !== 'EOF') {
    const trailingVal = peek().raw !== undefined ? peek().raw : peek().value;
    throw new ParseError("Unexpected trailing input '" + trailingVal + "' at column " + peek().column, peek().column);
  }

  return ast;
}

function evaluateAST(node) {
  if (node.type === 'Literal') {
    return node.value;
  }

  if (node.type === 'UnaryExpression') {
    const val = evaluateAST(node.argument);
    return node.operator === '+' ? val : -val;
  }

  if (node.type === 'BinaryExpression') {
    const left = evaluateAST(node.left);
    const right = evaluateAST(node.right);

    switch (node.operator) {
      case '+':
        return left + right;
      case '-':
        return left - right;
      case '*':
        return left * right;
      case '/':
        if (right === 0) {
          throw new Error('Division by zero');
        }
        return left / right;
      case '%':
        if (right === 0) {
          throw new Error('Division by zero');
        }
        return left % right;
      case '^':
        return Math.pow(left, right);
      default:
        throw new Error("Unknown operator '" + node.operator + "'");
    }
  }

  throw new Error("Unknown AST node type '" + node.type + "'");
}

function evaluate(expr) {
  const tokens = tokenize(expr);
  const ast = parse(tokens);
  return evaluateAST(ast);
}

module.exports = {
  tokenize,
  parse,
  evaluateAST,
  evaluate,
  ParseError
};
