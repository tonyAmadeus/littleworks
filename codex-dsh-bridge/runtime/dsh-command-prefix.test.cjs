'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseDSHCommand } = require('./dsh-command-prefix.cjs');

function expectTask(input, text) {
  assert.deepEqual(parseDSHCommand(input), { text }, input);
}

test('every target alias accepts all explicit addressing verbs', () => {
  for (const target of ['DeepSeek', 'DeepSeek Harness', 'DSH', '大肥鱼', '鲸鱼娘']) {
    for (const verb of ['给', '告诉', '发给', '转给', '让']) {
      expectTask(verb + target + '：检查文件', '检查文件');
      expectTask(verb + target + '检查文件', '检查文件');
    }
    for (const verb of ['对', '跟']) {
      expectTask(verb + target + '说：检查文件', '检查文件');
      expectTask(verb + target + '说检查文件', '检查文件');
    }
    expectTask(target + ':检查文件', '检查文件');
  }
});

test('English aliases ignore case and allow whitespace in address syntax', () => {
  expectTask('  告诉  dSh  :\n  检查文件\n', '\n  检查文件\n');
  expectTask('请转给 DEEPSEEK：检查文件', '检查文件');
  expectTask('跟\tdeepseek\tHARNESS\t说\t:检查文件', '检查文件');
  expectTask('请 告诉 DSH 检查文件', ' 检查文件');
  expectTask('告诉DSH run the agreed test', ' run the agreed test');
});

test('both wrappers work with and without a colon for verbal addresses', () => {
  for (const target of ['DeepSeek', 'DeepSeek Harness', 'DSH', '大肥鱼', '鲸鱼娘']) {
    expectTask('【告诉' + target + '：】检查文件', '检查文件');
    expectTask('【告诉' + target + '】检查文件', '检查文件');
    expectTask('【告诉' + target + '：检查文件】', '检查文件');
    expectTask('【告诉' + target + '检查文件】', '检查文件');
    expectTask('【' + target + ':】检查文件', '检查文件');
    expectTask('【' + target + ':检查文件】', '检查文件');
  }
  expectTask('请【告诉DSH：】检查文件', '检查文件');
  expectTask('【请 告诉 DSH：检查文件】', '检查文件');
});

test('normal task brackets and all task whitespace remain exact', () => {
  const task = '\n  先读【甲】。\n\n再保留  两个空格，输出【嵌套【完成】】。  \n';
  expectTask('告诉DSH：' + task, task);
  expectTask('【告诉大肥鱼：】' + task, task);
  expectTask('【告诉鲸鱼娘：' + task + '】', task);
  expectTask('【告诉DSH：】任务最后一个字符是】', '任务最后一个字符是】');
});

test('address aliases are removed rather than added to forwarded salutations', () => {
  expectTask('告诉大肥鱼：请查一下资料。', '请查一下资料。');
  expectTask('让鲸鱼娘检查文件', '检查文件');
  expectTask('告诉DSH：告诉DeepSeek：这段是任务正文', '告诉DeepSeek：这段是任务正文');
});

test('target prefix lookalikes and ordinary or mid-message mentions are rejected', () => {
  for (const input of [
    'DSH可以检查文件吗', '我想告诉DSH检查文件', '我提到了DeepSeek。',
    '先检查\n告诉DSH：这个文件', '引用【告诉DSH：】检查文件',
    '“告诉DSH：检查文件”', '请问DSH能否检查文件',
    '告诉DSHutdown检查文件', '告诉DSH2：检查文件', '给DSH_worker：检查文件',
    '告诉DeepSeekFoo：检查文件', '告诉DeepSeek Harnessing检查文件',
    '转给DeepSeek Harness2：检查文件', 'DSHutdown:检查文件',
    '告诉GPT：检查文件', '告诉鲸鱼：检查文件',
    '对DSH：检查文件', '跟DeepSeek：检查文件',
    'DSH检查文件', 'DeepSeek Harness 检查文件', '【DSH】检查文件',
    '【大肥鱼检查文件】',
  ]) assert.equal(parseDSHCommand(input), null, input);
});

test('empty tasks and malformed wrappers do not become outbound requests', () => {
  for (const input of [
    '', '   ', '告诉DSH', '告诉DSH：', '让大肥鱼  ', 'DSH:',
    '【告诉DSH】', '【告诉DSH：】\n\t', '【告诉DSH：  】',
    '【告诉DSH：正文', '【告诉DSH：正文【内层】',
    '【告诉DSH：正文】多余内容', '【告诉DSH：正文【内层】】多余内容',
    '【DSH】', null, undefined, {}, 42,
  ]) assert.equal(parseDSHCommand(input), null, String(input));
});

test('12000-character limit applies to the exact forwarded body', () => {
  const boundary = '甲'.repeat(12000);
  expectTask('告诉DSH：' + boundary, boundary);
  expectTask('【告诉DSH：' + boundary + '】', boundary);
  for (const input of [
    '告诉DSH：' + boundary + '乙',
    '【告诉DSH：】' + boundary + '乙',
    '【告诉DSH：' + boundary + '乙】',
    '告诉DSH： ' + boundary,
  ]) assert.throws(() => parseDSHCommand(input), /DSH command exceeds 12000 characters/);
});
