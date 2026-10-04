#!/usr/bin/env python3
"""Phase-3 reconciliation accounting check (documentation tooling only; no runtime code).

Usage (from the repository root):
    python3 docs/phase3/check_phase3_accounting.py
    python3 docs/phase3/check_phase3_accounting.py --drift <sha>   # OD-0 / P0 drift check

Checks:
  1. every row key is unique and has exactly one disposition in A-G;
  2. the preserved audit's bullets (sections 1-21) are exactly the bullets in the bullet map;
  3. every AUD-* / VF/* row is reached from at least one audit bullet or item-bearing statement;
  4. every ID-like token in the audit appears in at least one row (ids / ref / item / notes / src);
  5. the VF rows equal the PLAYTEST / OWNER DECISION / OPEN entries of VISUAL_FLOURISH_BACKLOG.md
     (at the planning snapshot: 47 / 21 / 23);
  6. every slice and owner decision named by a row is defined in PHASE3_EXECUTION_PLAN.md;
  7. PHASE3_AUDIT_RECONCILIATION.md carries every row exactly once with the JSON's disposition;
  8. progress (added at the Wave-1 integration): every `slice_status` names a defined slice with a known state; every row
     `status` is a known state that agrees with the row's disposition; a COMPLETE slice has no A/B row left
     unimplemented; an IMPLEMENTED row names no slice that is NOT STARTED;
  9. the matrix's Totals table equals the dispositions counted from the JSON;
 10. every recorded `owner_rulings` entry is a defined OD, is marked RULED in the plan's owner-decision table, and has
     its section in the plan's §7.3.
With --drift: lists the files cited as source evidence that differ between the planning snapshot and <sha>.
"""
import json, os, re, subprocess, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
HERE = os.path.join(ROOT, 'docs', 'phase3')
acc = json.load(open(os.path.join(HERE, 'phase3_accounting.json'), encoding='utf-8'))
rows = acc['rows']
errors = []

# 1. keys / dispositions
keys = [r['key'] for r in rows]
dups = {k for k in keys if keys.count(k) > 1}
if dups:
    errors.append(f'duplicate row keys: {sorted(dups)}')
for r in rows:
    if r['disp'] not in 'ABCDEFG' or len(r['disp']) != 1:
        errors.append(f"{r['key']}: bad disposition {r['disp']!r}")
bykey = {r['key']: r for r in rows}

# 2. audit bullets
audit = open(os.path.join(ROOT, acc['audit_file']), encoding='utf-8').read().splitlines()
parsed, sec, k = [], None, 0
for line in audit:
    m = re.match(r'^\*\*(\d+)\. ', line)
    if m:
        sec, k = int(m.group(1)), 0
        continue
    if line.startswith('**Gate item') or line.startswith('**Highest-risk'):
        sec = None
    if sec and re.match(r'^\s*- ', line):
        k += 1
        parsed.append(f'{sec}.{k}')
mapped = list(acc['bullets'].keys())
if parsed != mapped:
    errors.append(f'bullet map != audit bullets: missing {sorted(set(parsed) - set(mapped))}, extra {sorted(set(mapped) - set(parsed))}')
for b, ks in list(acc['bullets'].items()) + list(acc['other_statements'].items()):
    for x in ks:
        if x not in bykey:
            errors.append(f'{b}: unknown row {x}')

# 3. reachability
reached = {x for ks in list(acc['bullets'].values()) + list(acc['other_statements'].values()) for x in ks}
for r in rows:
    if r['key'].startswith(('AUD-', 'VF/')) and r['key'] not in reached:
        errors.append(f"{r['key']}: not reached from any audit statement")

# 4. ID coverage
# item-bearing text starts at section 1 (the Scope / Key header names documents read, not items)
start = next(i for i, line in enumerate(audit) if line.startswith('**1. '))
body = '\n'.join(audit[start:])
ID_RE = r'\b(?:U-\d+|K-\d+|A-\d+|H-\d+|H5|RR-\d+|SBS-\d+|DA6-[A-Za-z0-9]+|I-\d+|S10-\d+|S6-\d+|UR-F\d+|DH-\d+|GR-\d+|ING-\d+|SI-H01|D-\d+|R4|S-4|E-\d|B-3|JX-\d[A-Z])\b'
text = ' '.join(' '.join(str(r.get(f, '')) for f in ('ids', 'ref', 'item', 'notes', 'src')) for r in rows)
text += ' ' + ' '.join(k.replace('VF/', '') for k in keys)
for tok in sorted(set(re.findall(r'(?<!OD-)' + ID_RE, body))):
    if not re.search(r'(?<![\w-])' + re.escape(tok) + r'(?![\w])', text):
        errors.append(f'audit ID {tok} appears in no row')

# 5. VF rows vs ledger
want = {}
for line in open(os.path.join(ROOT, 'VISUAL_FLOURISH_BACKLOG.md'), encoding='utf-8'):
    m = re.match(r'^### ([A-Z]+-\d+) · `([A-Z ]+)`', line)
    if m and m.group(2) in ('PLAYTEST', 'OWNER DECISION', 'OPEN'):
        want['VF/' + m.group(1)] = m.group(2)
have = {r['key']: r for r in rows if r['key'].startswith('VF/')}
if set(want) != set(have):
    errors.append(f'VF rows differ from ledger: missing {sorted(set(want) - set(have))}, extra {sorted(set(have) - set(want))}')
for k2, st in want.items():
    r = have.get(k2)
    if r and st == 'PLAYTEST' and r['disp'] != 'D':
        errors.append(f'{k2}: PLAYTEST must be D')
    if r and st == 'OWNER DECISION' and r['disp'] != 'F':
        errors.append(f'{k2}: OWNER DECISION must be F')
    if r and st == 'OPEN' and r['disp'] not in 'BC':
        errors.append(f'{k2}: OPEN must be B or C')

# 6. slices / ODs defined in the plan
plan = open(os.path.join(HERE, 'PHASE3_EXECUTION_PLAN.md'), encoding='utf-8').read()
defined = set(re.findall(r'^#### (W[123]-[A-Z])\b', plan, re.M)) | ({'P0'} if re.search(r'^#### P0\b', plan, re.M) else set())
ods = set(re.findall(r'^\| \*\*(OD-\d+)\*\*', plan, re.M))
for r in rows:
    for s in re.findall(r'\b(W[123]-[A-Z]|P0)\b', r['slice']):
        if s not in defined:
            errors.append(f"{r['key']}: slice {s} not defined in the plan")
    for o in re.findall(r'\bOD-\d+\b', r['od'] + ' ' + r['notes']):
        if o not in ods:
            errors.append(f"{r['key']}: {o} not defined in the plan's owner-decision table")

# 7. the human-readable matrix agrees with the JSON (key present, same disposition)
md = open(os.path.join(HERE, 'PHASE3_AUDIT_RECONCILIATION.md'), encoding='utf-8').read().splitlines()
for r in rows:
    lines = [l for l in md if l.startswith('| **' + r['key'] + '** ·')]
    if len(lines) != 1:
        errors.append(f"{r['key']}: appears {len(lines)} times in the matrix MD")
    elif ('| **' + r['disp'] + '** |') not in lines[0]:
        errors.append(f"{r['key']}: MD disposition differs from JSON ({r['disp']})")

# 8. progress: slice and row statuses
SLICE_STATES = ('COMPLETE', 'PARTIAL', 'NOT STARTED', 'IN PROGRESS')
ROW_STATES = {  # state -> dispositions it may sit on
    'IMPLEMENTED': 'AB',
    'PRE-WORK DONE': 'D',
    'OPEN': 'ABC',
    'NOT STARTED': 'AB',
    'RULED': 'ABC',
    'NEEDS PRECISE REPRODUCTION / CLARIFICATION': 'G',
}
state_of = lambda text, states: next((st for st in sorted(states, key=len, reverse=True) if text == st or text.startswith(st + ' ')), None)
slice_status = acc.get('slice_status', {})
for sl, text in slice_status.items():
    if sl not in defined:
        errors.append(f'slice_status: {sl} is not a slice defined in the plan')
    if state_of(text, SLICE_STATES) is None:
        errors.append(f'slice_status: {sl} has an unknown state {text[:40]!r}')
slice_state = {sl: state_of(text, SLICE_STATES) for sl, text in slice_status.items()}
for r in rows:
    st = r.get('status')
    if st is None:
        continue
    state = state_of(st, ROW_STATES)
    if state is None:
        errors.append(f"{r['key']}: unknown status {st[:40]!r}")
        continue
    if r['disp'] not in ROW_STATES[state]:
        errors.append(f"{r['key']}: status {state} cannot sit on disposition {r['disp']}")
    named = set(re.findall(r'\b(W[123]-[A-Z]|P0)\b', r['slice']))
    if state == 'IMPLEMENTED':
        for sl in named:
            if slice_state.get(sl, 'NOT STARTED') == 'NOT STARTED':
                errors.append(f"{r['key']}: IMPLEMENTED, but its slice {sl} is NOT STARTED")
for sl, state in slice_state.items():
    if state != 'COMPLETE':
        continue
    for r in rows:
        if r['disp'] not in 'AB' or not re.search(r'\b' + re.escape(sl) + r'\b', r['slice']):
            continue
        if not r.get('status', '').startswith('IMPLEMENTED'):
            errors.append(f"{sl} is COMPLETE but {r['key']} (disposition {r['disp']}) is not IMPLEMENTED")

# 9. the matrix's Totals table equals the JSON's dispositions
def tally(prefixes):
    found = [r['disp'] for r in rows if r['key'].startswith(prefixes)]
    return len(found), ' · '.join(f'{d} {found.count(d)}' for d in 'ABCDEFG')
md_text = '\n'.join(md)
for label, prefixes in (('Audit items (`AUD-*`)', ('AUD-',)), ('Flourish-ledger items', ('VF/',)),
                        ('**Substantive audit items, total**', ('AUD-', 'VF/')), ('Execution-map-only', ('P3-N',))):
    n, dist = tally(prefixes)
    line = next((l for l in md if l.startswith('| ' + label)), None)
    if line is None:
        errors.append(f'Totals: no row for {label}')
    elif not line.rstrip().endswith(f'| {dist} |') or (f'| {n} |' not in line and f'| **{n}** |' not in line):
        errors.append(f'Totals: {label} should read {n} rows, {dist}')

# 10. recorded owner rulings are defined, marked RULED in the OD table, and written out in section 7.3
for od in acc.get('owner_rulings', {}):
    if od not in ods:
        errors.append(f'owner_rulings: {od} is not defined in the plan')
        continue
    row = next(l for l in plan.splitlines() if l.startswith('| **' + od + '**'))
    if 'RULED' not in row:
        errors.append(f'owner_rulings: {od} is not marked RULED in the plan\'s owner-decision table')
    if not re.search(r'^\*\*' + re.escape(od) + r' — ', plan, re.M):
        errors.append(f'owner_rulings: {od} has no section in the plan\'s 7.3')

if '--drift' in sys.argv:
    sha = sys.argv[sys.argv.index('--drift') + 1]
    cited = set()
    for r in rows:
        for p in re.findall(r'`([\w./-]+\.(?:tsx?|md|json))`', r['src'] + ' ' + r['notes']):
            cited.add(p)
    changed = subprocess.run(['git', '-C', ROOT, 'diff', '--name-only', acc['planning_snapshot'], sha],
                             capture_output=True, text=True, check=True).stdout.split()
    hits = sorted({c for c in changed for p in cited if c.endswith(p) or c.endswith('/' + p.split('/')[-1])})
    print(f'drift {acc["planning_snapshot"][:7]}..{sha[:7]}: {len(changed)} files changed; cited files changed: {len(hits)}')
    for h in hits:
        print('  ', h)
    fe = [c for c in changed if c.startswith('frontend/src/') and '.test.' not in c]
    print(f'production frontend/src files changed: {len(fe)}')

n_aud = sum(1 for r in rows if r['key'].startswith(('AUD-', 'VF/')))
n_new = sum(1 for r in rows if r['key'].startswith('P3-N'))
print(f'rows: {len(rows)} (audit items {n_aud}, new-source findings {n_new}); audit bullets {len(parsed)}')
if slice_status:
    print('slices: ' + ', '.join(f'{st} {sum(1 for v in slice_state.values() if v == st)}' for st in SLICE_STATES if any(v == st for v in slice_state.values()))
          + f"; rows with a status: {sum(1 for r in rows if 'status' in r)}; owner rulings recorded: {', '.join(acc.get('owner_rulings', {})) or 'none'}")
if errors:
    print('FAIL')
    for e in errors:
        print(' -', e)
    sys.exit(1)
print('PASS: every audit item accounted exactly once; no orphan; no contradictory duplicate')
