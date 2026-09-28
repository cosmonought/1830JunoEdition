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
/* ==================================================================
    APP-TEST-0A: THE SHELL READERS RESOLVE TOO
   ==================================================================
   `readShell()` is `App.tsx` plus every `shell/**` source file (tests, `.d.ts` and `__fixtures__` excluded),
   sorted, each stripped -- the same set `sourceScan.ts` builds. Without this the ~170 suites migrated to it
   would drop out of the sweep's accounting, which is #1096's invisible-file failure at scale. The per-file
   markers are left out: the sweep only asks "is the literal there", which a marker cannot change. */
const SHELL = "<shell>";
function shellFiles(){
  const out=[];
  (function walk(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
    if(e.isDirectory())walk(p);else if(/\.(ts|tsx)$/.test(e.name)&&!/\.test\.tsx?$/.test(e.name)&&!/\.d\.ts$/.test(e.name)&&!/(^|[\\/])__(fixtures|mocks|tests)__([\\/]|$)/.test(p))out.push(p.split(path.sep).join("/"));}})("shell");
  return ["App.tsx",...out.sort((a,b)=>(a<b?-1:a>b?1:0))];
}
function content(rel,stripped){
  const key=rel+"|"+stripped;
  if(!(key in cache)){
    try{
      const files=rel===SHELL?shellFiles():[rel];
      cache[key]=files.map((f)=>{const raw=fs.readFileSync(path.join(".",f),"utf8").replace(/\r\n?/g,"\n");return stripped?strip(raw):raw;}).join("\n");
    }catch{cache[key]=null;}
  }
  return cache[key];
}
const files=[];
(function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);
 if(e.isDirectory())walk(p);else if(/\.test\.tsx?$/.test(e.name))files.push(p);}})(".");
// APP-TEST-0A: `\uXXXX` too -- "House rules \u00b7 ..." was reported missing because it was compared escaped.
// ONE PASS, so an escaped backslash before a `u` (`"\\u25B2"`, a literal backslash-u) stays a backslash-u.
const UNESC={'"':'"',"'":"'",n:"\n",t:"\t","\\":"\\"};
const unesc=s=>s.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/g,(m,e)=>e.length===5?String.fromCharCode(parseInt(e.slice(1),16)):e in UNESC?UNESC[e]:m);
let checked=0,sliced=0,skipped=0,unresolved=0,ordering=0,unresolvedConcat=0; const bad=[];
for(const f of files){
  /* APP-TEST-0A: the harness's own suites hold the shapes they test as string FIXTURES -- `'const APP =
     readShell(); ...'` -- which this script would read as live declarations. They test the helpers, not the
     source tree, so they are not source scans. */
  if(/(^|[\\/])utils[\\/](sourceScan|sourceGuards)\.test\.ts$/.test(f)) continue;
  /* THE TEST FILE IS STRIPPED TOO. Several suites quote a retired assertion inside a design note --
     "IT READ, on one line per #814: expect(APP).toContain(...)" -- and scanning the raw text reports
     those as live assertions that no longer hold. #490a's rule, applied to the scanner itself. */
  const src=strip(fs.readFileSync(f,"utf8"));
  // every declaration, with its offset, so the nearest preceding one wins
  const decls=[];
  for(const m of src.matchAll(/const\s+(\w+)\s*=\s*(?:stripComments\(\s*)?(readStripped|readSource)\(\s*"([^"]+)"\s*\)/g)){
    decls.push({at:m.index,name:m[1],rel:m[3],stripped:m[2]==="readStripped"||m[0].includes("stripComments(")});
  }
  /* APP-TEST-0A: `readShell()` / `readShellRaw()` are the whole shell; `readAppRoot(why)` is `App.tsx` alone. */
  for(const m of src.matchAll(/const\s+(\w+)\s*=\s*(readShell|readShellRaw|readAppRoot|readAppRootRaw)\s*\(/g)){
    const shell=m[2].startsWith("readShell");
    decls.push({at:m.index,name:m[1],rel:shell?SHELL:"App.tsx",stripped:!m[2].endsWith("Raw")});
  }
  // "Nearest preceding" is by offset, so the two declaration passes are merged into offset order.
  decls.sort((a,b)=>a.at-b.at);
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
  /* APP-TEST-0A: `sliceFrom(NAME, "a")` / `sliceFrom(NAME, "a", { length: N })` / `sliceBefore(NAME, "a", N)`,
     the guarded replacements for `S.slice(S.indexOf(a))` and its windows, resolve the same way -- one level,
     literal arguments only. */
  const fileNames2=[...new Set(decls.map(d=>d.name))].join("|");
  const fromRe=new RegExp(
    `const\\s+(\\w+)\\s*=\\s*(sliceFrom|sliceBefore)\\(\\s*(${fileNames2})\\s*,\\s*(['"])((?:\\\\.|(?!\\4).)*)\\4\\s*` +
    `(?:,\\s*(?:\\{\\s*length:\\s*(\\d+)\\s*\\}|(\\d+))\\s*)?\\)`,"g");
  for(const m of src.matchAll(fromRe)){
    const near=decls.filter(d=>d.name===m[3]&&d.at<m.index).pop();
    if(!near||near.opaque) continue;
    const body=near.text!==undefined?near.text:content(near.rel,near.stripped);
    if(body===null) continue;
    const anchor=unesc(m[5]), len=m[6]!==undefined?+m[6]:m[7]!==undefined?+m[7]:undefined;
    const at=body.indexOf(anchor);
    if(at===-1){bad.push(`${f}\n     ${m[2]} anchor gone from ${near.rel}: ${JSON.stringify(anchor)}`);continue;}
    const text=m[2]==="sliceFrom"?body.slice(at,len===undefined?body.length:at+len):body.slice(Math.max(0,at-(len??0)),at);
    decls.push({at:m.index,name:m[1],rel:`${near.rel} [${m[2]} ${JSON.stringify(anchor)}]`,stripped:near.stripped,text});
    sliced++;
  }
  /* AND A NAME RE-DECLARED FROM SOMETHING THIS SCRIPT CANNOT EVALUATE SHADOWS THE EARLIER ONE. Without this,
     `const body = sliceFrom(APP, a, { length: f(x) })` in one case resolved `body` to the previous case's
     slice, and reported that region's literals as missing -- the tool asserting about the wrong region, which
     is the vacuity it exists to catch. Assertions on an opaque name are counted as not checked. */
  const known=new Set(decls.map(d=>d.name));
  for(const m of src.matchAll(/(?:const|let)\s+(\w+)\s*(?::[^=]+)?=/g)){
    if(known.has(m[1])&&!decls.some(d=>d.at===m.index)) decls.push({at:m.index,name:m[1],opaque:true});
  }
  decls.sort((a,b)=>a.at-b.at);

  const names=[...new Set(decls.map(d=>d.name))].join("|");
  const re=new RegExp(`expect\\(\\s*(${names})\\s*\\)\\s*\\.(not\\.)?toContain\\(\\s*(['"])((?:\\\\.|(?!\\3).)*)\\3(\\s*[+,)])`,"g");
  for(const m of src.matchAll(re)){
    /* ==================================================================
        DESIGN NOTE 1097: A CONCATENATED EXPECTATION IS NOT THE LITERAL IT STARTS WITH
       ==================================================================
       `expect(PANEL).toContain("-train" + dollar + "{quantity...}")` MATCHED AND WAS CHECKED AGAINST "-train"
       ALONE -- which holds trivially in any file that mentions a train, while the sentence the case is
       actually about might be long gone. A pass reported about a fragment of an assertion is worse than no
       pass at all, and it is the same vacuity class as #1078's slices and #1090's ordering anchors: the tool
       answering a question narrower than the one it appears to answer.
       COUNTED AS UNRESOLVED rather than guessed at. Joining the pieces means evaluating an expression, which
       is where this stops being a script that reads files -- #1078's line, drawn again. */
    if (m[5].trim().startsWith("+")) { unresolvedConcat++; continue; }
    const near=decls.filter(d=>d.name===m[1]&&d.at<m.index).pop();
    if(!near){skipped++;continue;}
    if(near.opaque){unresolved++;continue;}
    const body=near.text!==undefined?near.text:content(near.rel,near.stripped);
    if(body===null){bad.push(`${f}: cannot read ${near.rel}`);continue;}
    checked++;
    const lit=unesc(m[4]), present=body.includes(lit), negated=Boolean(m[2]);
    if(!negated&&!present) bad.push(`${f}\n     toContain MISSING in ${near.rel}: ${JSON.stringify(lit)}`);
    if(negated&&present)   bad.push(`${f}\n     not.toContain PRESENT in ${near.rel}: ${JSON.stringify(lit)}`);
  }

  /* ==================================================================
      DESIGN NOTE 1090: ORDERING ASSERTIONS, WHICH GO VACUOUS THE SAME WAY
     ==================================================================
     `expect(A.indexOf(x)).toBeLessThan(A.indexOf(y))` IS THE OTHER SHAPE #886 WARNS ABOUT. When an anchor
     rots, `indexOf` returns -1, and -1 is less than every real index -- so the assertion passes for an `x`
     that is not there, or fails with "expected < -1", a message that tells you nothing about which anchor
     went missing. `anchorIndex` exists to throw instead, and twenty assertions across this suite predate it.
     FOUND THE WAY THEY ALWAYS ARE: one of them failed with "Expected: < -1" and the number had to be reverse
     engineered into a cause. Checked here so the next one names itself. */
  /* APP-TEST-0A: `expectOrder(NAME, "a", "b", ...)` names its anchors as literals; each is checked like an
     `indexOf` anchor (the helper throws on a miss at runtime; the sweep says which one before you run it). */
  for (const m of src.matchAll(/expectOrder\(\s*(\w+)\s*,([^;]*?)\)\s*;/g)) {
    const near = decls.filter((d) => d.name === m[1] && d.at < m.index).pop();
    if (!near || near.opaque) continue;
    const body = near.text !== undefined ? near.text : content(near.rel, near.stripped);
    if (body === null) continue;
    for (const a of m[2].matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
      ordering += 1;
      if (!body.includes(unesc(a[2]))) {
        bad.push(`${f}\n     expectOrder ANCHOR MISSING in ${near.rel}: ${JSON.stringify(unesc(a[2]))}`);
      }
    }
  }
  for (const m of src.matchAll(/(\w+)\.indexOf\(\s*(['"`])((?:\\.|(?!\2).)*)\2\s*\)/g)) {
    const near = decls.filter((d) => d.name === m[1] && d.at < m.index).pop();
    if (!near || near.opaque) continue;
    const body = near.text !== undefined ? near.text : content(near.rel, near.stripped);
    if (body === null) continue;
    ordering += 1;
    if (!body.includes(unesc(m[3]))) {
      bad.push(`${f}\n     indexOf ANCHOR MISSING in ${near.rel}: ${JSON.stringify(unesc(m[3]))}\n     (an ordering assertion on a missing anchor compares against -1 -- see #886)`);
    }
  }

  /* ==================================================================
      DESIGN NOTE 1096: A FILE THAT READS SOURCE BY HAND IS INVISIBLE HERE
     ==================================================================
     `phaseEraToast.test.ts` DEFINED ITS OWN `read()` -- `readFileSync` plus a comment-strip, which is
     `readStripped` rewritten -- and four of its cases went stale when the era toast moved out of its render
     effect. This tool reported a clean run over the whole suite while they sat red, because its declaration
     regex only knows `readStripped` and `readSource`. Not merely unchecked: NOT EVEN COUNTED in the
     "not checked" total below, which is the worse failure of the two -- an absence you can see is a lead, and
     an absence you cannot is a clean bill of health that means nothing.
     WARNED, NOT PARSED. Teaching this script to follow an arbitrary hand-rolled reader means interpreting the
     file rather than reading it, which is the line #1078 drew for slice resolution and the same answer holds:
     name the file, let a person convert it to `readStripped`, and the assertions come inside the fence for
     free. One warning is cheap; a second parser is a second thing to be wrong. */
  /* THE FIRST DRAFT FLAGGED ANY `readFileSync` beside any `toContain`, and reported `batch60` -- which reads
     MP4 BYTES to check a duration constant against its own file, exactly the kind of test this project wants
     more of. The signal is not "reads a file"; it is "asserts on something this tool cannot resolve, in a
     file that reads files by hand". Both halves, or the warning cries wolf on the good case. */
  /* AND A NAME THAT IS ASSIGNED FROM `readStripped` AT ALL IS NOT THE PROBLEM THIS WARNS ABOUT, even when
     the path is a variable and this tool therefore cannot resolve it. `batch60` does
     `const source = readStripped(file)` inside a loop over four filenames -- unchecked, yes, and already
     counted in the "not checked" total below, but it is playing by the rules. The warning is for files that
     BYPASS the helper, because those are the ones that vanish from the accounting entirely. */
  const viaHelper = new Set(
    [...src.matchAll(/const\s+(\w+)\s*=\s*(?:readStripped|readSource|readShell|readShellRaw|readAppRoot|readAppRootRaw)\s*\(/g)].map((m) => m[1]),
  );
  const unresolvedHere = [...src.matchAll(/expect\(\s*(\w+)\s*\)\s*\.(?:not\.)?toContain\(/g)]
    .filter((m) => !decls.some((d) => d.name === m[1] && d.at < m.index))
    .filter((m) => !viaHelper.has(m[1]))
    .map((m) => m[1]);
  if (/readFileSync\s*\(/.test(src) && unresolvedHere.length) {
    const names = [...new Set(unresolvedHere)].join(", ");
    bad.push(`${f}\n     READS SOURCE BY HAND and asserts on it -- ${unresolvedHere.length} toContain(s) on ${names}\n     are invisible to this sweep. Use readStripped() so they are checked.`);
  }

  /* WHAT THIS TOOL STILL CANNOT SEE, counted rather than left silent -- a sweep that reports only what it
     managed to check invites exactly the confidence that let #1078's two anchors through. Slices of slices,
     slices built from a template literal, and anchors held in a variable all land here. */
  for(const m of src.matchAll(/expect\(\s*(\w+)\s*\)\s*\.(?:not\.)?toContain\(/g)){
    if(!decls.some(d=>d.name===m[1]&&d.at<m.index)) unresolved++;
  }
}
console.log(`source-scan assertions checked: ${checked}  (${sliced} slice regions resolved; ${skipped} with no preceding declaration)`);
console.log(`ordering anchors checked: ${ordering}`);
if(unresolved) console.log(`NOT CHECKED -- target is not a file or a one-level slice of one: ${unresolved}`);
if(unresolvedConcat) console.log(`NOT CHECKED -- expectation is a concatenation, not one literal: ${unresolvedConcat}`);
console.log(bad.length?"PROBLEMS:\n  - "+bad.join("\n  - "):"every one holds");
