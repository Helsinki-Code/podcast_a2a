import { build } from 'esbuild';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const clerkSource = path.join(root, 'node_modules/@clerk/clerk-js/dist');
const clerkUiSource = path.join(root, 'node_modules/@clerk/ui/dist');
const clerkTarget = path.join(root, 'public/clerk-runtime');

await Promise.all([
  build({
    entryPoints: [path.join(root, 'client/blob-upload.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: path.join(root, 'public/blob-upload.bundle.js'),
  }),
  build({
    entryPoints: [path.join(root, 'client/clerk.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    outfile: path.join(root, 'public/clerk.bundle.js'),
  }),
]);

await rm(clerkTarget, { recursive: true, force: true });
await mkdir(clerkTarget, { recursive: true });

const clerkFiles = (await readdir(clerkSource)).filter(
  name => name === 'clerk.browser.js' || /_clerk\.browser_.*\.js$/.test(name),
);
const clerkUiFiles = (await readdir(clerkUiSource)).filter(
  name => name === 'ui.browser.js' || /_ui_de828c_.*\.js$/.test(name),
);

if (!clerkFiles.includes('clerk.browser.js') || !clerkUiFiles.includes('ui.browser.js')) {
  throw new Error('Clerk browser or UI runtime was not found.');
}

await Promise.all(
  [
    ...clerkFiles.map(name => [clerkSource, name]),
    ...clerkUiFiles.map(name => [clerkUiSource, name]),
  ].map(([source, name]) => copyFile(path.join(source, name), path.join(clerkTarget, name))),
);

console.log(
  `Copied Clerk browser runtime, ${clerkFiles.length - 1} session chunks, and ${clerkUiFiles.length - 1} UI chunks.`,
);
