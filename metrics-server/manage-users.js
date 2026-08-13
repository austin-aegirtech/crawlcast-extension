#!/usr/bin/env node
/**
 * Himitsu test-group user management.
 *
 * Adds, removes, and lists the accounts allowed to log into the extension
 * during the private test period. Passwords are hashed with scrypt (Node's
 * built-in crypto — no extra dependency) before they ever touch disk;
 * plaintext is never logged or written anywhere, including to users.json.
 *
 * Usage:
 *   node manage-users.js add <username>      (prompts for a password)
 *   node manage-users.js remove <username>
 *   node manage-users.js list
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const USERS_FILE = path.join(__dirname, 'users.json');

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

/** Prompt for a password without echoing it to the terminal. */
function promptPassword(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('Not running in a terminal — cannot prompt for a password.'));
      return;
    }

    process.stdout.write(question);
    let password = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const onData = (char) => {
      char = char.toString();
      if (char === '\n' || char === '\r' || char === '\u0004') {
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        stdin.pause();
        process.stdout.write('\n');
        resolve(password);
      } else if (char === '\u0003') { // Ctrl+C
        process.stdout.write('\n');
        process.exit(1);
      } else if (char === '\u007f' || char === '\b') { // backspace
        password = password.slice(0, -1);
      } else {
        password += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const [, , cmd, username] = process.argv;

  if (cmd === 'list') {
    const names = Object.keys(loadUsers());
    console.log(names.length ? names.join('\n') : '(no users yet)');
    return;
  }

  if (cmd === 'remove') {
    if (!username) {
      console.error('Usage: node manage-users.js remove <username>');
      process.exitCode = 1;
      return;
    }
    const users = loadUsers();
    if (!users[username]) {
      console.error(`No such user: ${username}`);
      process.exitCode = 1;
      return;
    }
    delete users[username];
    saveUsers(users);
    console.log(`Removed ${username}`);
    return;
  }

  if (cmd === 'add') {
    if (!username) {
      console.error('Usage: node manage-users.js add <username>');
      process.exitCode = 1;
      return;
    }
    const users = loadUsers();
    if (users[username]) {
      console.error(`${username} already exists. Remove it first to reset the password.`);
      process.exitCode = 1;
      return;
    }

    let password;
    try {
      password = await promptPassword(`Password for ${username}: `);
    } catch (e) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    if (!password) {
      console.error('Password cannot be empty.');
      process.exitCode = 1;
      return;
    }

    users[username] = hashPassword(password);
    saveUsers(users);
    console.log(`Added ${username}`);
    return;
  }

  console.log(
    'Usage:\n' +
    '  node manage-users.js add <username>\n' +
    '  node manage-users.js remove <username>\n' +
    '  node manage-users.js list'
  );
}

main();
