/*
 * Bundles the app into one self-contained HTML file.
 *
 * The multi-file version needs its assets/ folder alongside it. The bundle is
 * a single file that can be emailed, dropped on a desktop, or opened from a
 * USB stick with nothing else present.
 *
 *   node build.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

/* A literal </script> inside the inlined JS would close the tag early. None
 * exists today; this keeps that from silently breaking the bundle later. */
const safe = (js) => js.replace(/<\/script>/gi, '<\\/script>');

let html = read('index.html');

/* Always replace via a function. The inlined JS contains `$'` (from the "-$"
 * in the money formatter), which as a replacement *string* is the special
 * pattern meaning "everything after the match" and would duplicate the rest
 * of the document into the bundle. */
const inline = (source, pattern, text) => {
  if (!pattern.test(source)) { throw new Error('Could not find ' + pattern); }
  return source.replace(pattern, () => text);
};

html = inline(
  html,
  /[ \t]*<link rel="stylesheet" href="assets\/styles\.css">\r?\n/,
  '  <style>\n' + read('assets/styles.css') + '  </style>\n'
);

for (const file of ['assets/rules.js', 'assets/app.js']) {
  const tag = new RegExp('[ \\t]*<script src="' + file.replace(/[.\/]/g, '\\$&') + '"></script>\\r?\\n');
  html = inline(html, tag, '<script>\n' + safe(read(file)) + '</script>\n');
}

if (/<(link|script)[^>]+(href|src)="assets\//.test(html)) {
  throw new Error('Bundle still references an external asset');
}

const out = 'commission-calculator.html';
fs.writeFileSync(path.join(root, out), html);
console.log(out + ' — ' + (fs.statSync(path.join(root, out)).size / 1024).toFixed(0) + ' KB, no external files needed');
