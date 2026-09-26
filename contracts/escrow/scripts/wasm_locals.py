#!/usr/bin/env python3
"""Per-function local counts of a wasm module (standard library only).

CosmWasm VM 2.2.9 / 3.0.9 (wasmvm v2.2.8 / v3.0.7) refuse to store a contract
with a function that declares more than 100 locals (parameters excluded). This
tool reads the code section directly, the same way the VM counts, and fails
when the largest function exceeds `--max`.

    wasm_locals.py artifact.wasm [--max 90] [--top 10]

Exit status: 0 = within the limit, 1 = over the limit, 2 = unreadable input.
Function names are shown when the module has a `name` section (unstripped
builds; the optimizer's output has none).
"""
import argparse
import sys


def leb_u(data, pos):
    result = shift = 0
    while True:
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, pos


def parse(data):
    if data[:4] != b"\0asm":
        raise ValueError("not a wasm module")
    pos = 8
    imported_funcs = 0
    bodies = []  # (declared locals, body size)
    names = {}
    while pos < len(data):
        sid = data[pos]
        size, pos = leb_u(data, pos + 1)
        end = pos + size
        if sid == 2:  # imports: count imported functions (they shift indices)
            n, p = leb_u(data, pos)
            for _ in range(n):
                for _ in range(2):  # module name, field name
                    ln, p = leb_u(data, p)
                    p += ln
                kind = data[p]
                p += 1
                if kind == 0:
                    imported_funcs += 1
                    _, p = leb_u(data, p)
                elif kind == 1:  # table: reftype + limits
                    p += 1
                    flags, p = leb_u(data, p)
                    _, p = leb_u(data, p)
                    if flags & 1:
                        _, p = leb_u(data, p)
                elif kind == 2:  # memory: limits
                    flags, p = leb_u(data, p)
                    _, p = leb_u(data, p)
                    if flags & 1:
                        _, p = leb_u(data, p)
                elif kind == 3:  # global: valtype + mut
                    p += 2
                else:
                    raise ValueError(f"unknown import kind {kind}")
        elif sid == 10:  # code
            n, p = leb_u(data, pos)
            for _ in range(n):
                body_size, p = leb_u(data, p)
                body_end = p + body_size
                groups, q = leb_u(data, p)
                count = 0
                for _ in range(groups):
                    c, q = leb_u(data, q)
                    q += 1  # value type
                    count += c
                bodies.append((count, body_size))
                p = body_end
        elif sid == 0:  # custom: look for the name section
            ln, p = leb_u(data, pos)
            if data[p:p + ln] == b"name":
                p += ln
                while p < end:
                    sub = data[p]
                    sub_size, p = leb_u(data, p + 1)
                    sub_end = p + sub_size
                    if sub == 1:
                        cnt, q = leb_u(data, p)
                        for _ in range(cnt):
                            idx, q = leb_u(data, q)
                            nl, q = leb_u(data, q)
                            names[idx] = data[q:q + nl].decode("utf-8", "replace")
                            q += nl
                    p = sub_end
        pos = end
    return imported_funcs, bodies, names


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("wasm")
    ap.add_argument("--max", type=int, default=90, help="fail above this many locals (default 90)")
    ap.add_argument("--top", type=int, default=10)
    args = ap.parse_args()
    try:
        with open(args.wasm, "rb") as f:
            data = f.read()
        imported, bodies, names = parse(data)
    except (OSError, ValueError, IndexError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
    ranked = sorted(
        ((locals_, imported + i, size) for i, (locals_, size) in enumerate(bodies)),
        key=lambda t: (-t[0], t[1]),
    )
    worst = ranked[0][0] if ranked else 0
    total = sum(b[0] for b in bodies)
    print(f"{args.wasm}: {len(bodies)} functions, {total} locals in total, max {worst} (limit {args.max})")
    for locals_, idx, size in ranked[: args.top]:
        name = names.get(idx, "")
        print(f"  {locals_:4d} locals  func {idx:5d}  {size:7d} B  {name[:160]}")
    if worst > args.max:
        print(f"FAIL: a function declares {worst} locals (> {args.max})")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
