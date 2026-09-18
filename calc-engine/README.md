# Calc Engine

A mathematical expression evaluator engine in JavaScript featuring a lexical tokenizer, abstract syntax tree (AST) parser, syntax validator with column-specific error reporting, and AST evaluator.

## Features

### Phase 1: Core Evaluator Engine
- Basic arithmetic operations: `+`, `-`, `*`, `/`
- Parentheses evaluation: `(2 + 3) * 4 = 20`
- 100% test coverage

### Phase 2: Advanced Operators & Edge Case Handling
- Exponentiation (`^`): Right-associative (`2 ^ 3 ^ 2 = 512`), with higher precedence than multiplication and addition.
- Modulo operator (`%`): Same precedence as multiplication and division.
- Division by Zero handling: Throws descriptive `Error('Division by zero')` for both literal and dynamic zero divisors.
- Legitimate `Infinity` (overflow) and `NaN` (negative fractional powers) are preserved and distinguished from zero division.

### Phase 3: AST Expression Parser
- **Lexical Tokenizer**: Generates structured tokens with exact 1-indexed source column tracking.
- **AST Parser**: Constructs an explicit Abstract Syntax Tree (`BinaryExpression`, `UnaryExpression`, `Literal`) without evaluating during parsing.
- **Operator Precedence & Associativity**: Standard mathematical precedence with right-associative exponentiation and explicit disambiguation for unary minus before exponentiation.
- **Syntax Validator**: Deterministic, column-specific syntax error reporting covering:
  - Unexpected/invalid characters
  - Missing operands (at expression level, after operators, inside empty parentheses)
  - Unexpected operators (at start of expression, consecutive operators, invalid sequences)
  - Unmatched opening parentheses
  - Unexpected closing parentheses
  - Unexpected trailing input tokens
- **Independent AST Evaluation**: Clean traversal and evaluation of pre-constructed AST nodes.

## API Usage

```javascript
const { evaluate, tokenize, parse, evaluateAST, ParseError } = require('./calc');

// Direct evaluation
console.log(evaluate('2 + 3 * 4'));        // 14
console.log(evaluate('2 ^ 3 ^ 2'));        // 512
console.log(evaluate('10 % 3'));           // 1
console.log(evaluate('(2 + 3) * 4'));      // 20

// Tokenize and parse into AST
const tokens = tokenize('2 + 3 * 4');
const ast = parse(tokens);
const result = evaluateAST(ast);          // 14

// Syntax error handling with column numbers
try {
  evaluate('2 + * 3');
} catch (err) {
  if (err instanceof ParseError) {
    console.error(`${err.message} (col: ${err.column})`);
    // Output: Unexpected operator '*' at column 5 (col: 5)
  }
}
```

## Running Tests

```bash
node test.js
```

Or with built-in coverage:

```bash
node --test --experimental-test-coverage test.js
```
