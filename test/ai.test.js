// Pure helpers behind the Ollama integration. The network parts are not
// exercised here: Ollama is optional, and a suite that needs it would fail on
// every machine that has not installed it.
const path = require('path');
const { pickDefault, trimOverlap, tidy } = require(path.join(__dirname, '..', 'src', 'ai'));

const MODELS = [
  { name: 'deepseek-ocr:3b', size: 6.7e9 },
  { name: 'qwen2.5-coder:14b', size: 9.0e9 },
  { name: 'gpt-oss:20b', size: 13.8e9 },
];

const checks = [
  // The setting is a model name; returning the object silently broke every
  // completion request, because Ollama was sent {name, size} as its model.
  ['default is a string, not an object', typeof pickDefault(MODELS) === 'string'],
  ['prefers a coder model', pickDefault(MODELS) === 'qwen2.5-coder:14b'],
  ['falls back to the smallest when no coder model',
    pickDefault([{ name: 'b:70b', size: 40e9 }, { name: 'a:3b', size: 2e9 }]) === 'a:3b'],
  ['copes with nothing installed', pickDefault([]) === ''],

  // Models like to repeat the line they were asked to continue.
  ['drops a repeated bullet', trimOverlap('- milk\n- eggs\n- ', '- bread') === 'bread'],
  ['drops a repeated word', trimOverlap('the quick ', 'quick brown fox') === 'brown fox'],
  ['leaves a clean completion alone',
    trimOverlap('The derivative of $x^2$ is ', '$2x$.') === '$2x$.'],
  ['leaves an unrelated completion alone', trimOverlap('hello ', 'world') === 'world'],
  ['copes with an empty completion', trimOverlap('anything', '') === ''],

  // A completion should stop at the end of a thought, not ramble on.
  ['ends at the first sentence',
    tidy('james. i am a developer. i love coding', 'my name is ', false) === 'james.'],
  ['keeps maths intact',
    tidy('$2x$. This is a fundamental result', 'the derivative is ', false) === '$2x$.'],
  ['does not mistake a decimal point for a full stop',
    tidy('3.14 is close enough', 'pi is ', false) === '3.14 is close enough'],
  ['keeps a complete last word when the model finished',
    tidy('the value of pi and more text here', 'x is ', false)
      === 'the value of pi and more text here'],
  ['drops a half-finished word when the model was cut off',
    tidy('the value of pi and more text her', 'x is ', true)
      === 'the value of pi and more text'],
  ['leaves a one-word completion alone', tidy('bread', '- eggs\n- ', false) === 'bread'],
];

let bad = 0;
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(bad ? `\n${bad} failing` : `\nall ${checks.length} passing`);
process.exit(bad ? 1 : 0);
