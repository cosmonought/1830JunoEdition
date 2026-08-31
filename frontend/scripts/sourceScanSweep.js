// Every source-scan assertion in the whole suite, checked against the file it actually scans.
// A name can be re-declared per describe, so each assertion resolves to the NEAREST PRECEDING declaration.
const fs=require("fs"),path=require("path");
const strip=s=>s.replace(/\{\/\*[\s\S]*?\*\/\}/g,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
const cache={};
function content(rel,stripped){
  const key=rel+"|"+stripped;
  if(!(key in cache)){
    try{const raw=fs.readFileSync(path.join(".",rel),"utf8");cache[key]=stripped?strip(raw):raw;}catch{cache[key]=null;}
  }
  return cache[key];
}
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory())walk(p);else if(/\.test\.tsx?$/.test(e.name))files.push(p);}})(".");
const unesc=s=>s.replace(/\\"/g,'"').replace(/\\'/g,"'").replace(/\\n/g,"\n").replace(/\\t/g,"\t").replace(/\\\\/g,"\\");
let checked=0,skipped=0; const bad=[];
for(const f of files){
  /* THE TEST FILE IS STRIPPED TOO. Several suites quote a retired assertion inside a design note --
     "IT READ, on one line per #814: expect(APP).toContain(...)" -- and scanning the raw text reports
     those as live assertions that no longer hold. #490a's rule, applied to the scanner itself. */
  const src=strip(fs.readFileSync(f,"utf8"));
  // every declaration, with its offset, so the nearest preceding one wins
  const decls=[];
  for(const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:stripComments\(\s*)?(readStripped|readSource)\(\s*"([^"]+)"\s*\)/g)){
    decls.push({at:m.index,name:m[1],rel:m[3],stripped:m[2]==="readStripped"||m[0].includes("stripComments(")});
  }
  if(!decls.length) continue;
  const names=[...new Set(decls.map(d=>d.name))].join("|");
  const re=new RegExp(`expect\\(\\s*(${names})\\s*\\)\\s*\\.(not\\.)?toContain\\(\\s*(['"])((?:\\\\.|(?!\\3).)*)\\3`,"g");
  for(const m of src.matchAll(re)){
    const near=decls.filter(d=>d.name===m[1]&&d.at<m.index).pop();
    if(!near){skipped++;continue;}
    const body=content(near.rel,near.stripped);
    if(body===null){bad.push(`${f}: cannot read ${near.rel}`);continue;}
    checked++;
    const lit=unesc(m[4]), present=body.includes(lit), negated=Boolean(m[2]);
    if(!negated&&!present) bad.push(`${f}\n     toContain MISSING in ${near.rel}: ${JSON.stringify(lit)}`);
    if(negated&&present)   bad.push(`${f}\n     not.toContain PRESENT in ${near.rel}: ${JSON.stringify(lit)}`);
  }
}
console.log(`source-scan assertions checked: ${checked}  (skipped, no preceding declaration: ${skipped})`);
console.log(bad.length?"PROBLEMS:\n  - "+bad.join("\n  - "):"every one holds");
