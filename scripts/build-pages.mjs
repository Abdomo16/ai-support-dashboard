import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const output = join(root, 'dist');

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

const copy = async (relativePath) => {
  const source = join(root, relativePath);
  const destination = join(output, relativePath);
  await mkdir(join(destination, '..'), { recursive: true });
  await copyFile(source, destination);
};

await copy('index.html');
await copy('src/main.js');
await copy('runtime-config.js');

const copyDirectory = async (relativePath) => {
  const sourceDirectory = join(root, relativePath);
  const entries = await readdir(sourceDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const childPath = join(relativePath, entry.name);
    if (entry.isDirectory()) await copyDirectory(childPath);
    else await copy(childPath);
  }
};

await copyDirectory('src');