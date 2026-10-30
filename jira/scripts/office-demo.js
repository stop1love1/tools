'use strict';

// Builds the 3D office as a static demo (made-up team, no server, no Jira) into dist/office-demo/, for a static host:
//   node scripts/office-demo.js && npx vercel deploy dist/office-demo
// The page is office-scene.html with relative paths, demo.js before app.js, and no live reload.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pub = path.join(root, 'public');
const out = path.join(root, 'dist', 'office-demo');

fs.rmSync(out, { recursive: true, force: true });
const copy = (rel) => {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.copyFileSync(path.join(pub, rel), path.join(out, rel));
};
['css/base.css', 'css/office.css', 'vendor/three-r128.js', ...fs.readdirSync(path.join(pub, 'js', 'office')).map((f) => `js/office/${f}`)].forEach(copy);

const html = fs
  .readFileSync(path.join(pub, 'office-scene.html'), 'utf8')
  .replace('<title>My Jira — 3D office scene</title>', '<title>3D office (demo)</title>')
  .replace(/\s*<script src="\/js\/livereload\.js[^"]*"><\/script>/, '')
  .replace(/(href|src)="\/(css|vendor|js)\//g, '$1="$2/')
  .replace('<script src="js/office/app.js"></script>', '<script src="js/office/demo.js"></script>\n    <script src="js/office/app.js"></script>');
if (!html.includes('js/office/demo.js') || html.includes('="/') || html.includes('livereload')) throw new Error('office-scene.html changed: update scripts/office-demo.js');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`3D office demo built in ${path.relative(root, out)}/`);
