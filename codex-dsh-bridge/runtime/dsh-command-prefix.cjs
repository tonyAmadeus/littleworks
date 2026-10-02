'use strict';
require('./config.cjs').applyEnvironment();

// Outbound addressing only: this module neither sends messages nor chooses a
// DSH session. Address aliases never become part of the forwarded task text.
const MAX_TASK_CHARACTERS = 12000;
const TARGET = '(?:(?:DeepSeek\\s+Harness|DeepSeek(?!\\s+Harness[A-Za-z0-9_])|DSH)(?![A-Za-z0-9_])|大肥鱼|鲸鱼娘)';
const VERBAL_ADDRESS = '(?:(?:给|告诉|发给|转给|让)\\s*' + TARGET
  + '|(?:对|跟)\\s*' + TARGET + '\\s*说)';
const VERBAL_PREFIX = new RegExp('^\\s*(?:请\\s*)?' + VERBAL_ADDRESS + '(?:\\s*[:：])?', 'i');
const BARE_PREFIX = new RegExp('^\\s*(?:请\\s*)?' + TARGET + '\\s*[:：]', 'i');

function addressLength(text) {
  const match = VERBAL_PREFIX.exec(text) || BARE_PREFIX.exec(text);
  return match ? match[0].length : null;
}

function completeOuterClosing(text) {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '【') depth++;
    else if (text[index] === '】') {
      depth--;
      if (depth === 0) return index;
    }
  }
  return null;
}

function parseDSHCommand(text) {
  if (typeof text !== 'string') return null;
  let input = text.trimStart();
  // An optional request word can precede a wrapper too. Its inner address
  // still obeys the same finite set of verbs and exact target names.
  if (/^请\s*【/.test(input)) input = input.replace(/^请\s*/, '');

  let body;
  if (input.startsWith('【')) {
    const inside = input.slice(1);
    const prefixLength = addressLength(inside);
    if (prefixLength === null) return null;
    const remainder = inside.slice(prefixLength);
    const markerClosing = /^\s*】/.exec(remainder);
    if (markerClosing) {
      // Marker-only wrapper: all following characters belong to the task,
      // including normal brackets, leading indentation and trailing spaces.
      body = remainder.slice(markerClosing[0].length);
    } else {
      const closing = completeOuterClosing(input);
      if (closing === null || input.slice(closing + 1).trim()) return null;
      body = input.slice(1 + prefixLength, closing);
    }
  } else {
    const prefixLength = addressLength(input);
    if (prefixLength === null) return null;
    body = input.slice(prefixLength);
  }

  // Use trim only for the emptiness check: never normalize forwarded text.
  if (!body.trim()) return null;
  if (body.length > MAX_TASK_CHARACTERS) {
    throw Error('DSH command exceeds 12000 characters');
  }
  return { text: body };
}

module.exports = { parseDSHCommand };
