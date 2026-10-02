'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseUserCommand, isUserCommand } = require('./command-prefix.cjs');

function expectTask(input, expectedText) {
  assert.equal(isUserCommand(input), true, input);
  assert.deepEqual(parseUserCommand(input), [{
    kind: 'task',
    text: expectedText,
    authorizationRef: 'User command submitted through the designated DSH chat',
    origin: 'user-window',
  }], input);
}

test('original prefixes preserve case, colon and whitespace compatibility', () => {
  for (const input of [
    '给Codex：检查这个文件',
    '给codex:检查这个文件',
    'CODEX：检查这个文件',
    'Codex: 检查这个文件',
    '  给  cOdEx  ：  检查这个文件  ',
    '\n\t给\tCodex\t:\n检查这个文件\n',
  ]) expectTask(input, '检查这个文件');
});

test('each supported target and address verb is recognized', () => {
  for (const target of ['Codex', 'GPT', 'ChatGPT']) {
    for (const verb of ['给', '告诉', '发给', '转给']) {
      expectTask(verb + target + '：检查这个文件', '检查这个文件');
      expectTask('  ' + verb + '  ' + target.toLowerCase() + '  :\n检查这个文件  ', '检查这个文件');
    }
    for (const verb of ['对', '跟']) {
      expectTask(verb + target + '说：检查这个文件', '检查这个文件');
      expectTask(verb + '\t' + target.toUpperCase() + '\t说\t: 检查这个文件', '检查这个文件');
    }
    expectTask(target + ': 检查这个文件', '检查这个文件');
    expectTask('\n' + target.toLowerCase() + ' ： 检查这个文件\n', '检查这个文件');
  }
});

test('alias address classes also accept both bracket wrappers', () => {
  const addresses = [
    '告诉GPT', '发给ChatGPT', '转给codex',
    '给gPt', '对GPT说', '跟 ChatGPT 说', 'GPT', 'chatgpt',
  ];
  for (const address of addresses) {
    expectTask('【' + address + '：】保留【任务正文】', '保留【任务正文】');
    expectTask('【 ' + address + ' : 保留【任务正文】 】', '保留【任务正文】');
  }
});

test('bracketed marker forwards only its following task text', () => {
  for (const input of [
    '【给codex：】检查这个文件',
    '【Codex:】检查这个文件',
    '\n【 给  CODEX  ： 】\n检查这个文件\n',
  ]) expectTask(input, '检查这个文件');
});

test('whole command wrapper removes exactly its own closing bracket', () => {
  expectTask('【给codex：检查这个文件】', '检查这个文件');
  expectTask('  【 Codex : \n检查这个文件\n 】  ', '检查这个文件');
  expectTask('【给Codex：保留【动作】和【表情】】', '保留【动作】和【表情】');
  expectTask('【给codex：仅输出【完成】】', '仅输出【完成】');
});

test('normal brackets and internal whitespace in task text are preserved', () => {
  const task = '先读【甲】。\n\n再保留  两个空格。\n最后输出【完成】';
  expectTask('给codex：' + task, task);
  expectTask('【给codex：】' + task, task);
  expectTask('【给codex：' + task + '】', task);
  expectTask('【给codex：】任务最后一个字符是】', '任务最后一个字符是】');
  expectTask('【给codex：】保留【嵌套【括号】】', '保留【嵌套【括号】】');
});

test('empty tasks, quoted markers and mid-message addresses are rejected', () => {
  for (const input of [
    '', '   ', '给codex：', 'Codex: \n\t',
    '【给codex：】', '【给codex：】 \n', '【给codex：  】',
    '他说：给codex：检查这个文件',
    '请执行\n给codex：检查这个文件',
    '引用【给codex：】检查这个文件',
    '“给codex：检查这个文件”',
    '【Codex 回执｜abc】已完成',
    '【给codex：缺少闭合括号',
    '【给codex：正文】尾随普通消息',
    '给codex检查这个文件', '给DSH：检查这个文件',
    null, undefined, {}, 42,
  ]) {
    assert.equal(isUserCommand(input), false, String(input));
    assert.deepEqual(parseUserCommand(input), [], String(input));
  }
});

test('ordinary GPT mentions and incomplete alias addresses do not trigger routing', () => {
  for (const input of [
    'GPT可以帮忙检查吗？', '我想告诉GPT这件事。', '告诉GPT检查这个文件',
    '给 GPT 检查这个文件', '对GPT说检查这个文件', '跟ChatGPT说这件事',
    '这句正文中有 GPT: 检查这个文件',
    '先讨论一下\n告诉GPT：检查这个文件',
    '“告诉GPT：检查这个文件”', '引用【GPT：】检查这个文件',
    '告诉DSH：检查这个文件', '给GPT4：检查这个文件',
    'GPT助手：检查这个文件', '请告诉GPT：检查这个文件',
    '对GPT：检查这个文件', '跟GPT：检查这个文件',
    'GPT:', 'ChatGPT： \n', '告诉GPT：', '【GPT：】',
    '【告诉GPT： \t 】', '【对GPT说：】', '【跟GPT说：正文',
  ]) {
    assert.equal(isUserCommand(input), false, input);
    assert.deepEqual(parseUserCommand(input), [], input);
  }
});

test('import size limit matches the original parser without breaking recognition', () => {
  const boundary = '甲'.repeat(12000);
  expectTask('给codex：' + boundary, boundary);
  expectTask('【给codex：' + boundary + '】', boundary);
  for (const prefix of ['给codex：', '【给codex：】']) {
    const oversized = prefix + boundary + '乙';
    assert.equal(isUserCommand(oversized), true);
    assert.throws(() => parseUserCommand(oversized), /User command exceeds 12000 characters/);
  }
});

test('ordinary task text is transported without evaluation or nested re-parsing', () => {
  const task = '给Codex：这只是正文\n$(不要执行)\n```codex-inbox\n{}\n```';
  expectTask('【给codex：】' + task, task);
});
