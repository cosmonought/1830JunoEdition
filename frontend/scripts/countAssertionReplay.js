// Every `expect(FILE.match(/re/g).length).toBe(n)` in the suite, replayed against the live source.
// Design note #1097: these are `.toBe(n)` on a computed value -- exactly what `sourceScanSweep.js` cannot
// see and what broke `revenueFlashWiring` two batches ago. Extracted from the files, not from memory.
const fs=require("fs"),path=require("path");
const strip=s=>s.replace(/\{\/\*[\s\S]*?\*\/\}/g,"").replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
const cache={};
const read=r=>cache[r]??(cache[r]=strip(fs.readFileSync(path.join("src",r),"utf8")));
const FILES=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory())walk(p);else if(/\.test\.tsx?$/.test(e.name))FILES.push(path.relative("src",p));}})("src");
let n=0; const bad=[];
for(const f of FILES){
  const src=strip(fs.readFileSync(path.join("src",f),"utf8"));
  // which source file each top-level const reads
  const decls={};
  for(const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:stripComments\(\s*)?(?:readStripped|readSource)\(\s*"([^"]+)"\s*\)/g))
    decls[m[1]]=m[2];
  // expect(X.match(/re/g)?.length ?? 0).toBe(n)   /  expect((X.match(/re/g) ?? []).length).toBe(n)
  const re=/expect\(\s*\(?\s*(\w+)\.match\(\/((?:\\.|[^/])+)\/g\)\s*(?:\?\?\s*\[\])?\s*\)?(?:\?)?\.length\s*(?:\?\?\s*0\s*)?\)\s*\.toBe\((\d+)\)/g;
  for(const m of src.matchAll(re)){
    const [_,varName,pattern,want]=m;
    const rel=decls[varName]; if(!rel) continue;
    const got=(read(rel).match(new RegExp(pattern,"g"))||[]).length;
    n++;
    if(got!==Number(want)) bad.push(`${f}\n     ${varName} =~ /${pattern}/g  expected ${want}, got ${got}   (${rel})`);
  }
  // expect(X.match(/re/g) ?? []).toHaveLength(n)
  const re2=/expect\(\s*(\w+)\.match\(\/((?:\\.|[^/])+)\/g\)\s*(?:\?\?\s*\[\])?\s*\)\s*\.toHaveLength\((\d+)\)/g;
  for(const m of src.matchAll(re2)){
    const [_,varName,pattern,want]=m;
    const rel=decls[varName]; if(!rel) continue;
    const got=(read(rel).match(new RegExp(pattern,"g"))||[]).length;
    n++;
    if(got!==Number(want)) bad.push(`${f}\n     ${varName} =~ /${pattern}/g  expected ${want}, got ${got}   (${rel})`);
  }
}
console.log(`count assertions replayed: ${n}  (${FILES.length} files scanned)`);
if(!n){console.log("PROBLEM: nothing was replayed -- an all-clear over an empty set is not an all-clear.");process.exit(1);}
console.log(bad.length?"PROBLEMS:\n  - "+bad.join("\n  - "):"every one holds");
