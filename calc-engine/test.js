const assert = require('assert');
const {
  evaluate,
  tokenize,
  parse,
  evaluateAST,
  ParseError
} = require('./calc');

console.log('Running calc-engine test suite...');

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    throw err;
  }
}

// ---------------------------------------------------------
// Phase 1: Core Evaluator Engine Regression Tests
// ---------------------------------------------------------
console.log('\n--- Phase 1: Regression Tests ---');
test('Phase 1: Addition (2 + 3 = 5)', () => {
  assert.strictEqual(evaluate('2 + 3'), 5);
});
test('Phase 1: Subtraction (10 - 4 = 6)', () => {
  assert.strictEqual(evaluate('10 - 4'), 6);
});
test('Phase 1: Multiplication (6 * 7 = 42)', () => {
  assert.strictEqual(evaluate('6 * 7'), 42);
});
test('Phase 1: Division (20 / 4 = 5)', () => {
  assert.strictEqual(evaluate('20 / 4'), 5);
});
test('Phase 1: Parentheses ((2 + 3) * 4 = 20)', () => {
  assert.strictEqual(evaluate('(2 + 3) * 4'), 20);
});
test('Phase 1: Invalid character rejection', () => {
  assert.throws(() => evaluate('2 + a'), /Invalid characters in expression/);
});

// ---------------------------------------------------------
// Phase 2: Exponentiation, Modulo & Division by Zero Tests
// ---------------------------------------------------------
console.log('\n--- Phase 2: Exponentiation (^) Tests ---');
test('Basic exponentiation: 2 ^ 3 = 8', () => {
  assert.strictEqual(evaluate('2 ^ 3'), 8);
});
test('Basic exponentiation: 3 ^ 2 = 9', () => {
  assert.strictEqual(evaluate('3 ^ 2'), 9);
});
test('Basic exponentiation: 5 ^ 0 = 1', () => {
  assert.strictEqual(evaluate('5 ^ 0'), 1);
});
test('Chained exponentiation right-associativity: 2 ^ 3 ^ 2 = 512', () => {
  assert.strictEqual(evaluate('2 ^ 3 ^ 2'), 512);
});
test('Parenthesized chained exponentiation: (2 ^ 3) ^ 2 = 64', () => {
  assert.strictEqual(evaluate('(2 ^ 3) ^ 2'), 64);
});
test('Exponentiation combined with multiplication: 2 * 3 ^ 2 = 18', () => {
  assert.strictEqual(evaluate('2 * 3 ^ 2'), 18);
});
test('Exponentiation combined with multiplication: 4 ^ 2 * 3 = 48', () => {
  assert.strictEqual(evaluate('4 ^ 2 * 3'), 48);
});
test('Exponentiation combined with addition: 2 + 3 ^ 2 = 11', () => {
  assert.strictEqual(evaluate('2 + 3 ^ 2'), 11);
});
test('Exponentiation combined with subtraction: 10 - 2 ^ 3 = 2', () => {
  assert.strictEqual(evaluate('10 - 2 ^ 3'), 2);
});
test('Exponentiation with parenthesized base: (2 + 3) ^ 2 = 25', () => {
  assert.strictEqual(evaluate('(2 + 3) ^ 2'), 25);
});
test('Exponentiation with parenthesized exponent: 2 ^ (1 + 2) = 8', () => {
  assert.strictEqual(evaluate('2 ^ (1 + 2)'), 8);
});
test('Exponentiation with parenthesized base and exponent: (2 ^ 2) ^ (2 + 1) = 64', () => {
  assert.strictEqual(evaluate('(2 ^ 2) ^ (2 + 1)'), 64);
});
test('Exponentiation overflow preserves Infinity: 10 ^ 1000 = Infinity', () => {
  assert.strictEqual(evaluate('10 ^ 1000'), Infinity);
});
test('Exponentiation negative base fractional exponent preserves NaN: (-2) ^ 0.5 = NaN', () => {
  assert.ok(Number.isNaN(evaluate('(-2) ^ 0.5')));
});

console.log('\n--- Phase 2: Modulo (%) Tests ---');
test('Basic modulo: 10 % 3 = 1', () => {
  assert.strictEqual(evaluate('10 % 3'), 1);
});
test('Basic modulo: 15 % 4 = 3', () => {
  assert.strictEqual(evaluate('15 % 4'), 3);
});
test('Basic modulo with zero remainder: 20 % 5 = 0', () => {
  assert.strictEqual(evaluate('20 % 5'), 0);
});
test('Modulo combined with addition: 10 + 7 % 4 = 13', () => {
  assert.strictEqual(evaluate('10 + 7 % 4'), 13);
});
test('Modulo combined with division: 20 / 2 % 3 = 1', () => {
  assert.strictEqual(evaluate('20 / 2 % 3'), 1);
});
test('Modulo combined with multiplication: 20 % 3 * 2 = 4', () => {
  assert.strictEqual(evaluate('20 % 3 * 2'), 4);
});
test('Modulo combined with exponentiation: 2 ^ 3 % 5 = 3', () => {
  assert.strictEqual(evaluate('2 ^ 3 % 5'), 3);
});
test('Exponentiation precedence over modulo: 10 % 3 ^ 2 = 1', () => {
  assert.strictEqual(evaluate('10 % 3 ^ 2'), 1);
});

console.log('\n--- Phase 2: Division & Modulo by Zero Error Handling ---');
test('Division by zero throws descriptive error: 10 / 0', () => {
  assert.throws(() => evaluate('10 / 0'), { message: 'Division by zero' });
});
test('Division by zero with zero numerator: 0 / 0', () => {
  assert.throws(() => evaluate('0 / 0'), { message: 'Division by zero' });
});
test('Modulo by zero: 10 % 0 throws descriptive error "Division by zero"', () => {
  assert.throws(() => evaluate('10 % 0'), { message: 'Division by zero' });
});
test('Division by zero inside addition: 5 + 10 / 0', () => {
  assert.throws(() => evaluate('5 + 10 / 0'), { message: 'Division by zero' });
});
test('Division by zero with dynamic divisor: 20 / (2 - 2)', () => {
  assert.throws(() => evaluate('20 / (2 - 2)'), { message: 'Division by zero' });
});
test('Division by zero in complex expression: (2 + 3) / (2 - 2) + 7', () => {
  assert.throws(() => evaluate('(2 + 3) / (2 - 2) + 7'), { message: 'Division by zero' });
});
test('Division by zero in parenthesized subexpression: 10 + (20 / (5 - 5))', () => {
  assert.throws(() => evaluate('10 + (20 / (5 - 5))'), { message: 'Division by zero' });
});
test('Division by zero inside multiplication: (10 / 0) * 4', () => {
  assert.throws(() => evaluate('(10 / 0) * 4'), { message: 'Division by zero' });
});
test('Division by unary negative zero: 10 / -0', () => {
  assert.throws(() => evaluate('10 / -0'), { message: 'Division by zero' });
});
test('Division with unary negative divisor: 20 / -4 = -5', () => {
  assert.strictEqual(evaluate('20 / -4'), -5);
});
test('Division with unary positive divisor: 20 / +4 = 5', () => {
  assert.strictEqual(evaluate('20 / +4'), 5);
});
test('Division with unary power in divisor: 10 / 2 ^ +2 = 2.5', () => {
  assert.strictEqual(evaluate('10 / 2 ^ +2'), 2.5);
});

console.log('\n--- Phase 2: Intermediate Zero Divisor Regression Tests ---');
test('Intermediate division by zero unmasked by outer division: 1 / (1 / (2 - 2))', () => {
  assert.throws(() => evaluate('1 / (1 / (2 - 2))'), { message: 'Division by zero' });
});
test('Intermediate division by zero in outer addition: 5 + 1 / (1 / (2 - 2))', () => {
  assert.throws(() => evaluate('5 + 1 / (1 / (2 - 2))'), { message: 'Division by zero' });
});
test('Intermediate modulo by zero unmasked by outer modulo: 10 % (10 % (2 - 2))', () => {
  assert.throws(() => evaluate('10 % (10 % (2 - 2))'), { message: 'Division by zero' });
});
test('Intermediate modulo by zero in outer exponentiation: 1 ^ (10 % (2 - 2))', () => {
  assert.throws(() => evaluate('1 ^ (10 % (2 - 2))'), { message: 'Division by zero' });
});

// ---------------------------------------------------------
// Phase 3 Semantic Boundaries (Instruction 3)
// ---------------------------------------------------------
console.log('\n--- Phase 3: Semantic Boundaries ---');
test('Semantic boundary: right-associative exponentiation 2 ^ 3 ^ 2 = 512', () => {
  assert.strictEqual(evaluate('2 ^ 3 ^ 2'), 512);
});
test('Semantic boundary: parenthesized negative base (-2) ^ 2 = 4', () => {
  assert.strictEqual(evaluate('(-2) ^ 2'), 4);
});
test('Semantic boundary: explicitly parenthesized negated power -(2 ^ 2) = -4', () => {
  assert.strictEqual(evaluate('-(2 ^ 2)'), -4);
});
test('Semantic boundary: interaction between unary minus and exponentiation - -2 ^ 2 requires parentheses for disambiguation', () => {
  assert.throws(() => evaluate('-2 ^ 2'), {
    name: 'ParseError',
    column: 1
  });
});
test('Semantic boundary: exponentiation with unary negative exponent 2 ^ -2 = 0.25', () => {
  assert.strictEqual(evaluate('2 ^ -2'), 0.25);
  const ast = parse(tokenize('2 ^ -2'));
  assert.strictEqual(ast.type, 'BinaryExpression');
  assert.strictEqual(ast.operator, '^');
  assert.strictEqual(ast.left.value, 2);
  assert.strictEqual(ast.right.type, 'UnaryExpression');
  assert.strictEqual(ast.right.operator, '-');
  assert.strictEqual(ast.right.argument.value, 2);
});
test('Semantic boundary: division by direct and computed zero divisors', () => {
  assert.throws(() => evaluate('100 / 0'), { message: 'Division by zero' });
  assert.throws(() => evaluate('100 / (10 - 10)'), { message: 'Division by zero' });
});
test('Semantic boundary: modulo by zero explicitly throws "Division by zero"', () => {
  assert.throws(() => evaluate('50 % 0'), { message: 'Division by zero' });
  assert.throws(() => evaluate('50 % (5 - 5)'), { message: 'Division by zero' });
});
test('Semantic boundary: legitimate Infinity and NaN are not classified as Division by zero', () => {
  assert.strictEqual(evaluate('2 ^ 1024'), Infinity);
  assert.ok(Number.isNaN(evaluate('(-4) ^ 0.5')));
});

// ---------------------------------------------------------
// Phase 3: Tokenizer Unit Tests (Instruction 4 & 7)
// ---------------------------------------------------------
console.log('\n--- Phase 3: Tokenizer Tests ---');
test('Tokenizer: generates tokens with accurate 1-indexed column numbers', () => {
  const tokens = tokenize('12.5 + 3 * (4 - 2)');
  assert.deepStrictEqual(tokens.map(t => ({ type: t.type, val: t.value, col: t.column })), [
    { type: 'NUMBER', val: 12.5, col: 1 },
    { type: 'PLUS', val: '+', col: 6 },
    { type: 'NUMBER', val: 3, col: 8 },
    { type: 'STAR', val: '*', col: 10 },
    { type: 'LPAREN', val: '(', col: 12 },
    { type: 'NUMBER', val: 4, col: 13 },
    { type: 'MINUS', val: '-', col: 15 },
    { type: 'NUMBER', val: 2, col: 17 },
    { type: 'RPAREN', val: ')', col: 18 },
    { type: 'EOF', val: null, col: 19 }
  ]);
});
test('Tokenizer: supports leading decimal point (.5)', () => {
  const tokens = tokenize('.5 + 0.25');
  assert.strictEqual(tokens[0].type, 'NUMBER');
  assert.strictEqual(tokens[0].value, 0.5);
  assert.strictEqual(tokens[0].column, 1);
});
test('Tokenizer: supports exponentiation (^) and modulo (%) tokens', () => {
  const tokens = tokenize('2 ^ 3 % 4');
  assert.strictEqual(tokens[1].type, 'CARET');
  assert.strictEqual(tokens[1].column, 3);
  assert.strictEqual(tokens[3].type, 'PERCENT');
  assert.strictEqual(tokens[3].column, 7);
});
test('Tokenizer: throws on invalid characters with exact column position', () => {
  assert.throws(() => tokenize('2 + $ * 3'), (err) => {
    return err instanceof ParseError && err.column === 5 && /unexpected character '\$' at column 5/.test(err.message);
  });
});
test('Tokenizer: throws if expression is not a string', () => {
  assert.throws(() => tokenize(123), /Expression must be a string/);
});

// ---------------------------------------------------------
// Phase 3: AST Parser & Structure Tests (Instruction 5 & 7)
// ---------------------------------------------------------
console.log('\n--- Phase 3: AST Parser Tests ---');
test('AST Parser: constructs AST without evaluating expressions', () => {
  const tokens = tokenize('2 + 3 * 4');
  const ast = parse(tokens);
  assert.strictEqual(ast.type, 'BinaryExpression');
  assert.strictEqual(ast.operator, '+');
  assert.strictEqual(ast.left.type, 'Literal');
  assert.strictEqual(ast.left.value, 2);
  assert.strictEqual(ast.right.type, 'BinaryExpression');
  assert.strictEqual(ast.right.operator, '*');
  assert.strictEqual(ast.right.left.value, 3);
  assert.strictEqual(ast.right.right.value, 4);
});
test('AST Parser: preserves right-associative AST for exponentiation', () => {
  const tokens = tokenize('2 ^ 3 ^ 4');
  const ast = parse(tokens);
  assert.strictEqual(ast.type, 'BinaryExpression');
  assert.strictEqual(ast.operator, '^');
  assert.strictEqual(ast.left.value, 2);
  assert.strictEqual(ast.right.type, 'BinaryExpression');
  assert.strictEqual(ast.right.operator, '^');
  assert.strictEqual(ast.right.left.value, 3);
  assert.strictEqual(ast.right.right.value, 4);
});
test('AST Parser: supports UnaryExpression (+ and -)', () => {
  const tokens = tokenize('-5 + +3');
  const ast = parse(tokens);
  assert.strictEqual(ast.type, 'BinaryExpression');
  assert.strictEqual(ast.left.type, 'UnaryExpression');
  assert.strictEqual(ast.left.operator, '-');
  assert.strictEqual(ast.left.argument.value, 5);
  assert.strictEqual(ast.right.type, 'UnaryExpression');
  assert.strictEqual(ast.right.operator, '+');
  assert.strictEqual(ast.right.argument.value, 3);
});
test('AST Parser: evaluateAST independently evaluates pre-parsed AST', () => {
  const tokens = tokenize('(10 - 2) * 3');
  const ast = parse(tokens);
  const result = evaluateAST(ast);
  assert.strictEqual(result, 24);
});

// ---------------------------------------------------------
// Phase 3: Syntax Validation with Column Errors (Instruction 6 & 7)
// ---------------------------------------------------------
console.log('\n--- Phase 3: Syntax Error Column Tests ---');
test('Syntax Error 1: Unexpected character with exact column', () => {
  try {
    evaluate('12 + @');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 6);
    assert.match(err.message, /unexpected character '@' at column 6/);
  }
});
test('Syntax Error 2: Missing operand - empty expression', () => {
  try {
    evaluate('');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 1);
    assert.match(err.message, /Missing operand: empty expression at column 1/);
  }
});
test('Syntax Error 2: Missing operand - whitespace only expression', () => {
  try {
    evaluate('   ');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 1);
    assert.match(err.message, /Missing operand: empty expression at column 1/);
  }
});
test('Syntax Error 2: Missing operand after binary operator (+)', () => {
  try {
    evaluate('2 +');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 4);
    assert.match(err.message, /Missing operand after operator '\+' at column 3/);
  }
});
test('Syntax Error 2: Missing operand after binary operator (*)', () => {
  try {
    evaluate('5 *');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 4);
    assert.match(err.message, /Missing operand after operator '\*' at column 3/);
  }
});
test('Syntax Error 2: Missing operand after binary operator (^)', () => {
  try {
    evaluate('2 ^');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 4);
    assert.match(err.message, /Missing operand after operator '\^' at column 3/);
  }
});
test('Syntax Error 2: Missing operand after unary operator (-)', () => {
  try {
    evaluate('2 * -');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 6);
    assert.match(err.message, /Missing operand after operator '-' at column 5/);
  }
});
test('Syntax Error 2: Missing operand inside empty parentheses ()', () => {
  try {
    evaluate('()');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 2);
    assert.match(err.message, /Missing operand inside parentheses at column 2/);
  }
});
test('Syntax Error 3: Unexpected operator at start of expression (* 5)', () => {
  try {
    evaluate('* 5');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 1);
    assert.match(err.message, /Unexpected operator '\*' at column 1/);
  }
});
test('Syntax Error 3: Unexpected consecutive operator (2 + * 3)', () => {
  try {
    evaluate('2 + * 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 5);
    assert.match(err.message, /Unexpected operator '\*' at column 5/);
  }
});
test('Syntax Error 3: Unexpected operator after multiplication (2 * * 3)', () => {
  try {
    evaluate('2 * * 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 5);
    assert.match(err.message, /Unexpected operator '\*' at column 5/);
  }
});
test('Syntax Error 3: Unexpected operator after unary operator (- * 3)', () => {
  try {
    evaluate('- * 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 3);
    assert.match(err.message, /Unexpected operator '\*' at column 3/);
  }
});
test('Syntax Error 3: Unexpected operator after exponentiation (2 ^ / 3)', () => {
  try {
    evaluate('2 ^ / 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 5);
    assert.match(err.message, /Unexpected operator '\/' at column 5/);
  }
});
test('Syntax Error 3: Multiple decimal points in number (1.2.3)', () => {
  try {
    evaluate('1.2.3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 4);
    assert.match(err.message, /Unexpected operator '\.' at column 4/);
  }
});
test('Syntax Error 4: Unmatched opening parenthesis ((2 + 3)', () => {
  try {
    evaluate('((2 + 3)');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 1);
    assert.match(err.message, /Unmatched opening parenthesis '\(' at column 1/);
  }
});
test('Syntax Error 5: Unexpected closing parenthesis at expression start () 2 + 3)', () => {
  try {
    evaluate(') 2 + 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 1);
    assert.match(err.message, /Unexpected closing parenthesis '\)' at column 1/);
  }
});
test('Syntax Error 5: Unexpected closing parenthesis at expression end (2 + 3))', () => {
  try {
    evaluate('2 + 3)');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 6);
    assert.match(err.message, /Unexpected closing parenthesis '\)' at column 6/);
  }
});
test('Syntax Error 6: Unexpected trailing input token ((2 + 3) 4)', () => {
  try {
    evaluate('(2 + 3) 4');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 9);
    assert.match(err.message, /Unexpected trailing input '4' at column 9/);
  }
});
test('Syntax Error 6: Unexpected trailing input token (2 3)', () => {
  try {
    evaluate('2 3');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 3);
    assert.match(err.message, /Unexpected trailing input '3' at column 3/);
  }
});
test('Syntax Error 6: Unexpected trailing input non-number token ((2 + 3) ()', () => {
  try {
    evaluate('(2 + 3) (');
    assert.fail('Should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParseError);
    assert.strictEqual(err.column, 9);
    assert.match(err.message, /Unexpected trailing input '\(' at column 9/);
  }
});

// ---------------------------------------------------------
// Internal Defensive Error Handling Tests
// ---------------------------------------------------------
console.log('\n--- Internal Defensive Tests ---');
test('Defensive: evaluateAST throws on unknown AST node type', () => {
  assert.throws(() => evaluateAST({ type: 'UnknownType' }), /Unknown AST node type 'UnknownType'/);
});
test('Defensive: evaluateAST throws on unknown binary operator', () => {
  assert.throws(() => evaluateAST({ type: 'BinaryExpression', operator: '&', left: { type: 'Literal', value: 1 }, right: { type: 'Literal', value: 2 } }), /Unknown operator '&'/);
});

console.log(`\n✓ All ${passed} of ${total} expression evaluator tests passed cleanly!`);
