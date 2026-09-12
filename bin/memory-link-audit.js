const fs = require('fs');
process.chdir('C:/Users/Cory/.claude/agent-memory/project-lead');
const files = fs.readdirSync('.').filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
const slugs = new Set();
for (const f of files) {
  const m = fs.readFileSync(f, 'utf8').match(/^name:\s*(.+)$/m);
  if (m) slugs.add(m[1].trim());
}
// Explicit remaps for links whose target is a SECTION inside another memory
// rather than a memory of its own. Guessing these would create a new falsehood.
const MANUAL = {
  'review-a-sufficient-explanation-is-not-the-correct-one': 'absence-reading-as-success',
};
let fixed = 0;
const unresolved = [];
for (const f of files) {
  const before = fs.readFileSync(f, 'utf8');
  const after = before.replace(/\[\[([^\]]+)\]\]/g, (whole, link) => {
    if (slugs.has(link)) return whole;
    if (MANUAL[link] && slugs.has(MANUAL[link])) { fixed++; return '[[' + MANUAL[link] + ']]'; }
    const stripped = link.replace(/^(review|feedback)-/, '');
    if (slugs.has(stripped)) { fixed++; return '[[' + stripped + ']]'; }
    unresolved.push(f + ' -> [[' + link + ']]');
    return whole;
  });
  if (after !== before) fs.writeFileSync(f, after, 'utf8');
}
console.log('  rewrote ' + fixed + ' link(s)');
console.log('  unresolved: ' + (unresolved.length ? unresolved.join('; ') : 'none'));
