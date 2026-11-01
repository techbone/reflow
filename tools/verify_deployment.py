#!/usr/bin/env python3
"""Verify a deployed ReflowPools contract against the locally compiled build.

Standard library only; read-only JSON-RPC (eth_chainId, eth_getCode, eth_call).
Checks: chain id, deployed runtime code equals the local artifact's
deployedBytecode once the immutable `usdc` slots are filled with the expected
USDC address (metadata hash included), usdc(), decimals() through that token,
nextPoolId(), and optionally the provider-visible pool fields.

Usage:
  tools/verify_deployment.py --rpc https://rpc.mainnet.arc.io --chain-id 5042 \
      --address 0x... [--pool 1 --artifact-hash 0x... --terms-hash 0x... --price 1200000 --cap 4]
Exit code 0 only if every check passes.
"""
import argparse, json, sys, time, urllib.request

USDC = "0x3600000000000000000000000000000000000000"
import os, shutil
ARTIFACT = next((p for p in ("contracts/out/ReflowPools.sol/ReflowPools.json", "app/contracts/out/ReflowPools.sol/ReflowPools.json") if os.path.exists(p)), "contracts/out/ReflowPools.sol/ReflowPools.json")  # run `forge build` first


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, body, {"content-type": "application/json", "user-agent": "reflow-verify/1.0"})
            j = json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:  # transient network error: retry, then fail closed
            last = e
            time.sleep(2 * (attempt + 1))
            continue
        if "error" in j:
            raise RuntimeError(f"{method}: {j['error']}")
        return j["result"]
    raise SystemExit(f"FAIL  network error talking to {url}: {last}")


def selector(sig):
    import subprocess
    return subprocess.run([shutil.which("cast") or os.path.expanduser("~/.foundry/bin/cast"), "sig", sig], capture_output=True, text=True).stdout.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", required=True)
    ap.add_argument("--chain-id", type=int, required=True)
    ap.add_argument("--address", required=True)
    ap.add_argument("--pool", type=int)
    ap.add_argument("--artifact-hash")
    ap.add_argument("--terms-hash")
    ap.add_argument("--price", type=int)
    ap.add_argument("--cap", type=int)
    a = ap.parse_args()
    ok = True

    def check(name, cond, detail=""):
        nonlocal ok
        ok &= bool(cond)
        print(f"{'PASS' if cond else 'FAIL'}  {name}{(' - ' + str(detail)) if detail else ''}")

    chain = int(rpc(a.rpc, "eth_chainId", []), 16)
    check("chain id", chain == a.chain_id, f"rpc {chain}, expected {a.chain_id}")

    art = json.load(open(ARTIFACT))["deployedBytecode"]
    local = bytearray.fromhex(art["object"][2:])
    deployed = bytearray.fromhex(rpc(a.rpc, "eth_getCode", [a.address, "latest"])[2:])
    check("contract has code", len(deployed) > 0, f"{len(deployed)} bytes")
    word = bytes(12) + bytes.fromhex(USDC[2:])
    for refs in art.get("immutableReferences", {}).values():
        for r in refs:
            local[r["start"]:r["start"] + r["length"]] = word
    check("runtime code identical to local build (immutables = canonical USDC, metadata included)",
          bytes(local) == bytes(deployed), f"local {len(local)} bytes, deployed {len(deployed)} bytes")

    def eth_call(to, data):
        try:
            out = rpc(a.rpc, "eth_call", [{"to": to, "data": data}, "latest"])
        except RuntimeError as e:
            out = "0x"
            print(f"INFO  eth_call to {to} reverted: {e}")
        return out

    usdc_ret = eth_call(a.address, selector("usdc()"))
    check("usdc() is the canonical USDC", len(usdc_ret) >= 66 and usdc_ret[-40:].lower() == USDC[2:].lower(), usdc_ret if len(usdc_ret) < 66 else "0x" + usdc_ret[-40:])
    dec_ret = eth_call(USDC, selector("decimals()"))
    check("USDC decimals() == 6", len(dec_ret) > 2 and int(dec_ret, 16) == 6, dec_ret)
    nxt_ret = eth_call(a.address, selector("nextPoolId()"))
    check("nextPoolId() readable", len(nxt_ret) > 2, nxt_ret)
    if len(nxt_ret) > 2:
        print(f"INFO  nextPoolId() = {int(nxt_ret, 16)}")

    if a.pool is not None:
        raw = eth_call(a.address, selector("pools(uint256)") + f"{a.pool:064x}")[2:]
        if len(raw) < 64 * 8:
            check("pool readable", False, "no pool data returned")
            print("RESULT: FAILED")
            sys.exit(1)
        w = [raw[i:i + 64] for i in range(0, len(raw), 64)]
        provider, price, ah, th, deadline, cap, count, exists = ("0x" + w[0][-40:], int(w[1], 16), "0x" + w[2], "0x" + w[3], int(w[4], 16), int(w[5], 16), int(w[6], 16), int(w[7], 16))
        check("pool exists", exists == 1)
        print(f"INFO  provider {provider}, price {price}, deadline {deadline}, cap {cap}, members {count}")
        if a.price is not None: check("price", price == a.price, price)
        if a.cap is not None: check("cap", cap == a.cap, cap)
        if a.artifact_hash: check("artifactHash", ah.lower() == a.artifact_hash.lower(), ah)
        if a.terms_hash: check("termsHash", th.lower() == a.terms_hash.lower(), th)

    print("RESULT: ALL CHECKS PASSED" if ok else "RESULT: FAILED")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
