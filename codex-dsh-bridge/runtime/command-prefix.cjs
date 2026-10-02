'use strict';
require('./config.cjs').applyEnvironment();

// Shared, side-effect-free parser for explicitly addressed DSH user commands.
// Whitespace outside the task is trimmed, as in the original mailbox parser;
// the task's internal whitespace and brackets are otherwise preserved.
const MAX_TASK_CHARACTERS = 12000;
const AUTHORIZATION_REF = 'User command submitted through the designated DSH chat';
const TARGET = '(?:Codex|GPT|ChatGPT)';
const ADDRESS = '(?:(?:给|告诉|发给|转给)\\s*' + TARGET
  + '|(?:对|跟)\\s*' + TARGET + '\\s*说|' + TARGET + ')';
// An address must start the message and end with a colon. Merely mentioning
// an alias in ordinary conversation is never enough to route a command.
const PLAIN_PREFIX = new RegExp('^\\s*' + ADDRESS + '\\s*[:：]([\\s\\S]*)$', 'i');
const BRACKETED_MARKER = new RegExp('^\\s*【\\s*' + ADDRESS + '\\s*[:：]\\s*】([\\s\\S]*)$', 'i');
const BRACKETED_COMMAND = new RegExp('^\\s*【\\s*' + ADDRESS + '\\s*[:：]([\\s\\S]*)】\\s*$', 'i');

function commandText(text) {
  if (typeof text !== 'string') return null;

  // Prefer a marker-only wrapper. Any brackets following that marker belong
  // to the task and must not be removed, including a final closing bracket.
  const match = PLAIN_PREFIX.exec(text)
    || BRACKETED_MARKER.exec(text)
    || BRACKETED_COMMAND.exec(text);
  if (!match) return null;
  const task = match[1].trim();
  return task || null;
}

function isUserCommand(text) {
  // Recognition stays boolean even for an oversized addressed task. The
  // importer enforces its size limit; routing can still suppress reply echoes.
  return commandText(text) !== null;
}

function parseUserCommand(text) {
  const task = commandText(text);
  if (task === null) return [];
  if (task.length > MAX_TASK_CHARACTERS) {
    throw Error('User command exceeds 12000 characters');
  }
  return [{
    kind: 'task',
    text: task,
    authorizationRef: AUTHORIZATION_REF,
    origin: 'user-window',
  }];
}

module.exports = { parseUserCommand, isUserCommand };
