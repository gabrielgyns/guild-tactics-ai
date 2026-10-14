// Turns the single-file Vite build into a page body for publishing as a claude.ai Artifact
// (the host supplies <!doctype>, <html>, <head> and <body>; we provide the content).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync('dist/index.html', 'utf8');
const head = html.match(/<head>([\s\S]*?)<\/head>/i)?.[1] ?? '';
const body = html.match(/<body>([\s\S]*?)<\/body>/i)?.[1] ?? '';

const pick = (re) => [...head.matchAll(re)].map((m) => m[0]);
const title = pick(/<title>[\s\S]*?<\/title>/gi);
const metas = pick(/<meta name="claude:[^>]*>/gi);
const links = pick(/<link [^>]*>/gi);
const styles = pick(/<style[^>]*>[\s\S]*?<\/style>/gi);
const scripts = pick(/<script[^>]*>[\s\S]*?<\/script>/gi);
const bodyWithoutScripts = body.replace(/<script[^>]*src="\/src[^"]*"[^>]*><\/script>/gi, '');

const out = [...title, ...metas, ...links, ...styles, bodyWithoutScripts.trim(), ...scripts].join('\n');
mkdirSync('artifact', { recursive: true });
writeFileSync('artifact/guild-tactics.html', out);
console.log(`artifact/guild-tactics.html ${(out.length / 1024).toFixed(0)} kB`);
