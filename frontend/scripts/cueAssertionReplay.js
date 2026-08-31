// Every `expect(cue(LINE, BUCKET).audio).toBe(...)` in the suite, replayed against the live keyword table.
//
// ==================================================================
//  DESIGN NOTE 1087: BUILT AFTER MISSING THE SAME FAILURE THREE TIMES
// ==================================================================
//
// `sourceScanSweep.js` CANNOT SEE THESE. It checks `toContain` against file TEXT; these are `toBe` against a
// value a function returns, and no amount of reading the source will tell you what `variantCueFor` does with
// a sentence. So every change to `SFX_KEYWORDS` or `BUCKET_FALLBACK` has been verified by me deciding which
// assertions it touched -- and that decision was wrong three times in a row:
//
//   #1081  `BUCKET_FALLBACK.unchanged` went null. I patched the sibling case I had read and missed the
//          table-wide one forty lines below it.
//   #1087  Four entries were added. I replayed the assertions I remembered and missed "The books balanced
//          beautifully", which had been an example of a line NOTHING matches and had quietly become one that
//          does.
//
// EACH TIME THE FIX WAS ONE COMMAND I DID NOT RUN. This is that command, made permanent: it extracts the
// assertions from the file rather than from my memory of the file.
//
// USAGE, from `frontend/`:  node scripts/cueAssertionReplay.js utils/batch46.test.ts utils/batch58.test.ts
//
// WHAT IT CANNOT DO: expectations it cannot resolve statically -- a variable, a computed name -- are skipped
// rather than guessed, and the count it prints is what it actually checked. A tool that silently skipped
// would be the vacuity these suites exist to catch, one level up.
const ts=require(process.cwd()+"/node_modules/typescript");
const fs=require("fs"),path=require("path"),Module=require("module");
const orig=Module.prototype.require;
Module.prototype.require=function(r){if(r.startsWith(".")){const b=path.resolve(path.dirname(this.filename),r);
 for(const e of [".ts",".tsx"]) if(fs.existsSync(b+e)) return load(path.relative(path.join(process.cwd(),"src"),b+e));}
 return orig.apply(this,arguments);};
const cache={};function load(rel){if(cache[rel])return cache[rel];
 const file=path.join("src",rel),src=fs.readFileSync(file,"utf8");
 const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2019,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
 const m=new Module(rel,null);m.filename=path.resolve(file);m.paths=Module._nodeModulePaths(path.dirname(m.filename));
 cache[rel]=m.exports;m._compile(js,m.filename);cache[rel]=m.exports;return m.exports;}
const S=load("utils/variantSfx.ts");
const cue=(l,b)=>S.variantCueFor({line:l,bucket:b}).audio;

/* ==================================================================
    DESIGN NOTE 1092: IT ANSWERED "every one holds" ABOUT NOTHING
   ==================================================================
   RUN WITH NO ARGUMENTS it replayed zero assertions and printed the all-clear, which is precisely the
   vacuity it was built to catch, one level up in the tool that catches it. Found by running it that way.
   SO IT FINDS ITS OWN FILES when given none, and REFUSES to report success on an empty set. */
let files=process.argv.slice(2);
if(!files.length){
  const found=[];
  (function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
   if(e.isDirectory())walk(p);
   else if(/\.test\.tsx?$/.test(e.name)&&/expect\(\s*cue\(/.test(fs.readFileSync(p,"utf8")))
     found.push(path.relative("src",p));}})("src");
  files=found;
}
let checked=0; const bad=[];
for(const f of files){
  const src=fs.readFileSync(path.join("src",f),"utf8")
    .replace(/\/\*[\s\S]*?\*\//g,"").replace(/^\s*\/\/.*$/gm,"");
  // expect(cue("LINE", "bucket").audio).toBe(EXPECTED)  /  .toBeNull()
  const re=/expect\(\s*cue\(\s*(["'])((?:\\.|(?!\1).)*)\1\s*,\s*"(\w+)"\s*\)\s*\.audio\s*\)\s*\n?\s*\.?(not\.)?(toBe|toBeNull)\(\s*(?:(["'])((?:\\.|(?!\6).)*)\6|BUCKET_FALLBACK\.(\w+)|BUCKET_FALLBACK\[(\w+)\])?\s*\)/g;
  for(const m of src.matchAll(re)){
    const line=m[2].replace(/\\"/g,'"').replace(/\\'/g,"'").replace(/\\\\/g,"\\");
    const bucket=m[3], negated=Boolean(m[4]), kind=m[5];
    let want;
    if(kind==="toBeNull") want=null;
    else if(m[7]!==undefined) want=m[7];
    else if(m[8]!==undefined) want=S.BUCKET_FALLBACK[m[8]];
    else continue;                      // dynamic expectation we cannot resolve
    const got=cue(line,bucket); checked++;
    const holds = negated ? got!==want : got===want;
    if(!holds) bad.push(`${f}\n     [${bucket}] ${line}\n     expected ${negated?"NOT ":""}${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
}
console.log(`cue assertions replayed: ${checked}  (${files.length} file${files.length===1?"":"s"})`);
if(!checked){console.log("PROBLEM: nothing was replayed -- an all-clear over an empty set is not an all-clear.");process.exit(1);}
console.log(bad.length?"PROBLEMS:\n  - "+bad.join("\n  - "):"every one holds");
