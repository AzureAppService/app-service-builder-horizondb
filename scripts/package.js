'use strict';

const fs = require('node:fs');
const path = require('node:path');

const destination = process.env.DESTINATION_DIR;
if (!destination || !path.isAbsolute(destination)) {
  throw new Error('DESTINATION_DIR must be an absolute output directory.');
}

fs.mkdirSync(destination, { recursive: true });
const source = fs.realpathSync(process.cwd());
const target = fs.realpathSync(destination);
if (target === source || target.startsWith(`${source}${path.sep}`)) {
  throw new Error('DESTINATION_DIR must be outside the source directory.');
}

for (const name of ['server', 'public', 'node_modules', 'package.json', 'package-lock.json']) {
  fs.cpSync(path.join(source, name), path.join(target, name), { recursive: true });
}
