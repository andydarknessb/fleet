const fs = require('fs');
const p = 'C:\\Users\\Cory\\fleet\\state\\skip\\endzone.json';

const raw = fs.readFileSync(p);
const hadBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
const body = hadBom ? raw.slice(3) : raw;
const highBefore = [...body].filter((b) => b > 127).length;
console.log('BOM present before        :', hadBom);
console.log('non-ASCII beyond BOM before:', highBefore);

const d = JSON.parse(body.toString('utf8'));
console.log('issue keys before:', Object.keys(d.issues).sort().join(', '));

if (!Object.prototype.hasOwnProperty.call(d.issues, '617')) {
  console.log('617 ABSENT - nothing to remove, aborting without write');
  process.exit(1);
}
delete d.issues['617'];
console.log('issue keys after :', Object.keys(d.issues).sort().join(', '));

const out = JSON.stringify(d, null, 2);
const nonAscii = [...out].filter((c) => c.charCodeAt(0) > 127);
if (nonAscii.length) {
  console.log('REFUSING: serialized output has', nonAscii.length, 'non-ASCII chars');
  process.exit(2);
}
fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(out, 'ascii')]));

// verify by re-reading the way a consumer would
const raw2 = fs.readFileSync(p);
const bom2 = raw2[0] === 0xef && raw2[1] === 0xbb && raw2[2] === 0xbf;
const d2 = JSON.parse(raw2.slice(3).toString('utf8'));
console.log('BOM present after         :', bom2);
console.log('non-ASCII beyond BOM after:', [...raw2.slice(3)].filter((b) => b > 127).length);
console.log('reparsed issue keys       :', Object.keys(d2.issues).sort().join(', '));
console.log('prs key intact            :', 'prs' in d2, JSON.stringify(d2.prs));
console.log('ledger entries intact     :', Object.keys(d2.migrationPrefixes || {}).length);
console.log('note key intact           :', typeof d2.note === 'string' && d2.note.length > 0);
