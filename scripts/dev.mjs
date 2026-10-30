import { spawn } from 'node:child_process';

const tasks = [
  { name: 'server', color: '\u001b[36m', script: 'dev:server' },
  { name: 'web   ', color: '\u001b[35m', script: 'dev:web' },
];

const children = [];
let shuttingDown = false;

function prefixStream(stream, label, color, target) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      target.write(`${color}[${label}]\u001b[0m ${line}\n`);
    }
  });
}

for (const task of tasks) {
  const child = spawn('npm', ['run', task.script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: process.env,
  });
  prefixStream(child.stdout, task.name, task.color, process.stdout);
  prefixStream(child.stderr, task.name, task.color, process.stderr);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`${task.color}[${task.name}]\u001b[0m 退出（code ${code}），正在停止其它进程`);
      shutdown();
    }
  });
  children.push(child);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
