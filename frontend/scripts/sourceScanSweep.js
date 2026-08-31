// Every source-scan assertion in the whole suite, checked against the text it actually scans.
// A name can be re-declared per describe, so each assertion resolves to the NEAREST PRECEDING declaration.
//
// ==================================================================
//  DESIGN NOTE 1078: SLICE VARIABLES WERE A HOLE IN THIS TOOL
// ==================================================================
//
// IT CHECKED ONLY `expect(FILE).toContain(...)`, where FILE came straight from `readStripped`. Two stale
// anchors in `audioHeader.test.ts` sailed through a clean sweep and were caught by the runner instead --
// both written as `expect(GROUP).toContain(...)`, where GROUP is a `sliceBetween` of the file. The sweep
// said "every one holds" about assertions it had never looked at, which is the vacuity these tests exist to
// catch, one level up in the tool that checks them.
//
// SO SLICES RESOLVE TOO, one level deep: `const G = sliceBetween(BAR, "a", "b")` is evaluated against BAR
// and its assertions checked against the result. ONE LEVEL, not recursive -- a slice of a slice is rare and
// resolving arbitrary depth means interpreting the file rather than reading it, which is the point at which
// this stops being a 40-line script.
//
// A SLICE WHOSE ANCHORS ARE GONE IS REPORTED, not skipped. That is the failure `sliceBetween` throws for at
// runtime (`sourceScan.ts` #886), and a sweep that quietly ignored it would be hiding the loudest signal it
// has: an anchor that no longer exists means the test is asserting about a region that no longer exists.
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
let checked=0,sliced=0,skipped=0,unresolved=0; const bad=[];
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

  /* ---- one level of `sliceBetween`, per design note #1078 ---------------------------------------- */
  const fileNames=[...new Set(decls.map(d=>d.name))].join("|");
  const sliceRe=new RegExp(
    `const\\s+(\\w+)\\s*=\\s*sliceBetween\\(\\s*(${fileNames})\\s*,\\s*` +
    `(['"])((?:\\\\.|(?!\\3).)*)\\3\\s*,\\s*(['"])((?:\\\\.|(?!\\5).)*)\\5\\s*\\)`,"g");
  for(const m of src.matchAll(sliceRe)){
    const near=decls.filter(d=>d.name===m[2]&&d.at<m.index).pop();
    if(!near) continue;
    const body=content(near.rel,near.stripped);
    if(body===null) continue;
    const start=unesc(m[4]), end=unesc(m[6]);
    const from=body.indexOf(start);
    if(from===-1){
      bad.push(`${f}\n     slice START anchor gone from ${near.rel}: ${JSON.stringify(start)}`);
      continue;
    }
    const to=body.indexOf(end,from+start.length);
    if(to===-1){
      bad.push(`${f}\n     slice END anchor gone from ${near.rel} after start: ${JSON.stringify(end)}`);
      continue;
    }
    /* `rel` names the SLICE for the report, so a failure says which region it was about rather than just
       naming a 9,000-line file the reader then has to search. `stripped` is already applied. */
    decls.push({at:m.index,name:m[1],rel:`${near.rel} [${JSON.stringify(start)}..]`,stripped:near.stripped,
                text:body.slice(from,to)});
    sliced++;
  }

  const names=[...new Set(decls.map(d=>d.name))].join("|");
  const re=new RegExp(`expect\\(\\s*(${names})\\s*\\)\\s*\\.(not\\.)?toContain\\(\\s*(['"])((?:\\\\.|(?!\\3).)*)\\3`,"g");
  for(const m of src.matchAll(re)){
    const near=decls.filter(d=>d.name===m[1]&&d.at<m.index).pop();
    if(!near){skipped++;continue;}
    const body=near.text!==undefined?near.text:content(near.rel,near.stripped);
    if(body===null){bad.push(`${f}: cannot read ${near.rel}`);continue;}
    checked++;
    const lit=unesc(m[4]), present=body.includes(lit), negated=Boolean(m[2]);
    if(!negated&&!present) bad.push(`${f}\n     toContain MISSING in ${near.rel}: ${JSON.stringify(lit)}`);
    if(negated&&present)   bad.push(`${f}\n     not.toContain PRESENT in ${near.rel}: ${JSON.stringify(lit)}`);
  }

  /* WHAT THIS TOOL STILL CANNOT SEE, counted rather than left silent -- a sweep that reports only what it
     managed to check invites exactly the confidence that let #1078's two anchors through. Slices of slices,
     slices built from a template literal, and anchors held in a variable all land here. */
  for(const m of src.matchAll(/expect\(\s*(\w+)\s*\)\s*\.(?:not\.)?toContain\(/g)){
    if(!decls.some(d=>d.name===m[1]&&d.at<m.index)) unresolved++;
  }
}
console.log(`source-scan assertions checked: ${checked}  (${sliced} slice regions resolved; ${skipped} with no preceding declaration)`);
if(unresolved) console.log(`NOT CHECKED -- target is not a file or a one-level slice of one: ${unresolved}`);
console.log(bad.length?"PROBLEMS:\n  - "+bad.join("\n  - "):"every one holds");
