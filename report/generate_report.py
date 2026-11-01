#!/usr/bin/env python3
"""Generate the Reflow "Arc activity report" from a fixed Arc Testnet block range.

Standard library only. Reads public JSON-RPC; writes nothing outside --out.
The block range is closed and historical, so re-running with the same range and
an honest RPC reproduces the same data section (generatedAt differs).

Facts only: counts and sums read directly from blocks and USDC Transfer logs.
It does not infer success rates, intent, or quality.
"""
import argparse, concurrent.futures as cf, hashlib, json, sys, time, urllib.request
from collections import Counter

RPC_DEFAULT = "https://rpc.testnet.arc.io"
CHAIN_ID = 5042002
USDC = "0x3600000000000000000000000000000000000000"
TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
SCHEMA = "reflow.arc-activity-report/1"
GENERATOR = "reflow-report-generator/1.0"


class Rpc:
    def __init__(self, url):
        self.url = url

    def post(self, payload, tries=6):
        body = json.dumps(payload).encode()
        for i in range(tries):
            try:
                req = urllib.request.Request(
                    self.url, body,
                    {"content-type": "application/json", "user-agent": "reflow-report/1.0"})
                return json.load(urllib.request.urlopen(req, timeout=90))
            except Exception:
                if i == tries - 1:
                    raise
                time.sleep(1.5 * (i + 1))

    def call(self, method, params):
        r = self.post({"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
        if "error" in r:
            raise RuntimeError(f"{method}: {r['error']}")
        return r["result"]

    def blocks(self, start, end):
        """Full blocks start..end inclusive; retries rate-limited items with backoff."""
        got = {}
        want = list(range(start, end + 1))
        for attempt in range(12):
            batch = [{"jsonrpc": "2.0", "id": n, "method": "eth_getBlockByNumber",
                      "params": [hex(n), True]} for n in want]
            res = self.post(batch)
            for r in res if isinstance(res, list) else []:
                if r.get("result"):
                    got[r["id"]] = r["result"]
            want = [n for n in want if n not in got]
            if not want:
                return [got[n] for n in range(start, end + 1)]
            time.sleep(min(2 * (attempt + 1), 20))
        raise RuntimeError(f"blocks still unavailable after retries: {want[:5]}...")

    def logs(self, start, end):
        for attempt in range(8):
            try:
                return self.call("eth_getLogs", [{"fromBlock": hex(start), "toBlock": hex(end),
                                                  "address": USDC, "topics": [TRANSFER_TOPIC]}])
            except RuntimeError as e:
                if "rate limit" in str(e):
                    time.sleep(2 * (attempt + 1))
                    continue
                if start == end:
                    raise
                mid = (start + end) // 2
                return self.logs(start, mid) + self.logs(mid + 1, end)
        raise RuntimeError("eth_getLogs rate-limited after retries")


def addr(topic):
    return "0x" + topic[-40:]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rpc", default=RPC_DEFAULT)
    ap.add_argument("--from-block", type=int, required=True)
    ap.add_argument("--to-block", type=int, required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--workers", type=int, default=3)
    a = ap.parse_args()
    rpc = Rpc(a.rpc)

    chain = int(rpc.call("eth_chainId", []), 16)
    if chain != CHAIN_ID:
        sys.exit(f"RPC chain id {chain} != {CHAIN_ID}")
    head = int(rpc.call("eth_blockNumber", []), 16)
    if a.to_block > head - 1000:
        sys.exit(f"to-block {a.to_block} is too close to head {head}")

    # ---- blocks -------------------------------------------------------------
    chunks = [(s, min(s + 24, a.to_block)) for s in range(a.from_block, a.to_block + 1, 25)]
    hourly = {}
    senders, recipients = set(), set()
    recip_count = Counter()
    tx_total = creations = gas_used = 0
    first_ts = last_ts = None
    done = 0

    def fetch(c):
        return c, rpc.blocks(*c)

    with cf.ThreadPoolExecutor(a.workers) as ex:
        results = {}
        for c, blks in ex.map(fetch, chunks):
            results[c] = blks
            done += 1
            if done % 200 == 0:
                print(f"blocks {done}/{len(chunks)} chunks", file=sys.stderr)
    expected = a.from_block
    for c in chunks:
        for b in results[c]:
            n = int(b["number"], 16)
            assert n == expected, (n, expected)
            expected += 1
            ts = int(b["timestamp"], 16)
            first_ts = ts if first_ts is None else first_ts
            last_ts = ts
            h = ts - ts % 3600
            row = hourly.setdefault(h, {"blocks": 0, "txs": 0, "gasUsed": 0,
                                        "usdcTransfers": 0, "usdcVolumeMicro": 0})
            row["blocks"] += 1
            g = int(b["gasUsed"], 16)
            row["gasUsed"] += g
            gas_used += g
            for t in b["transactions"]:
                row["txs"] += 1
                tx_total += 1
                senders.add(t["from"].lower())
                if t["to"] is None:
                    creations += 1
                else:
                    recipients.add(t["to"].lower())
                    recip_count[t["to"].lower()] += 1
    assert expected == a.to_block + 1

    # ---- USDC token-emitter transfers (6-decimal logs only) --------------------
    log_ranges = [(s, min(s + 4999, a.to_block)) for s in range(a.from_block, a.to_block + 1, 5000)]
    xfers = 0
    vol = 0
    t_send, t_recv = set(), set()
    largest = 0
    # block timestamp lookup for hourly bucketing of logs
    ts_by_block = {}
    for c in chunks:
        for b in results[c]:
            ts_by_block[int(b["number"], 16)] = int(b["timestamp"], 16)
    for s, e in log_ranges:
        for lg in rpc.logs(s, e):
            if lg["address"].lower() != USDC or len(lg["topics"]) != 3:
                continue
            value = int(lg["data"], 16)
            xfers += 1
            vol += value
            largest = max(largest, value)
            t_send.add(addr(lg["topics"][1]))
            t_recv.add(addr(lg["topics"][2]))
            h = ts_by_block[int(lg["blockNumber"], 16)]
            h -= h % 3600
            hourly[h]["usdcTransfers"] += 1
            hourly[h]["usdcVolumeMicro"] += value

    blocks = a.to_block - a.from_block + 1
    report = {
        "schema": SCHEMA,
        "title": "Arc Testnet activity report",
        "version": "1.0.0",
        "source": {
            "network": "Arc Testnet", "chainId": CHAIN_ID, "rpc": a.rpc,
            "fromBlock": a.from_block, "toBlock": a.to_block, "blockCount": blocks,
            "fromTimestamp": first_ts, "toTimestamp": last_ts,
            "fromUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(first_ts)),
            "toUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_ts)),
            "headAtGeneration": head,
        },
        "methodology": [
            "Every block in the closed range was read with eth_getBlockByNumber (full transactions).",
            "Transaction counts, senders and recipients come from those transaction objects. A contract creation is a transaction whose `to` is null.",
            "Gas used is the sum of each block's gasUsed field.",
            f"USDC transfers are ERC-20 Transfer logs emitted by the USDC token contract {USDC} (6 decimals) read with eth_getLogs. Arc's separate 18-decimal system logs are not counted, to avoid double counting.",
            "Amounts are integers in micro-USDC (1 USDC = 1,000,000). Hourly buckets use block timestamps in UTC.",
        ],
        "totals": {
            "blocks": blocks,
            "transactions": tx_total,
            "contractCreations": creations,
            "uniqueSenders": len(senders),
            "uniqueRecipientAddresses": len(recipients),
            "gasUsed": str(gas_used),
            "averageSecondsPerBlock": f"{(last_ts - first_ts) / (blocks - 1):.3f}",
            "averageTransactionsPerBlock": f"{tx_total / blocks:.3f}",
        },
        "usdcTransfers": {
            "emitter": USDC,
            "transferCount": xfers,
            "totalVolumeMicroUsdc": str(vol),
            "uniqueSenders": len(t_send),
            "uniqueReceivers": len(t_recv),
            "largestTransferMicroUsdc": str(largest),
        },
        "topRecipients": [
            {"address": ad, "transactions": n,
             "note": "USDC token contract" if ad == USDC else ""}
            for ad, n in sorted(recip_count.items(), key=lambda kv: (-kv[1], kv[0]))[:15]
        ],
        "hourly": [
            {"hourStartUtc": time.strftime("%Y-%m-%dT%H:00:00Z", time.gmtime(h)), **hourly[h]}
            for h in sorted(hourly)
        ],
        "limitations": [
            "Counts describe testnet activity only; Arc Testnet usage is not a proxy for mainnet activity.",
            "Transaction success or failure is not reported; receipts were not read.",
            "Addresses are not labelled or attributed to people or organisations.",
            "The first and last hourly rows are partial hours.",
            "Provider has no affiliation with Circle or Arc; this is an independent data summary.",
        ],
        "generator": {
            "name": GENERATOR,
            "scriptSha256": hashlib.sha256(open(__file__, "rb").read()).hexdigest(),
        },
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, sort_keys=True, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {a.out}: {blocks} blocks, {tx_total} txs, {xfers} usdc transfers", file=sys.stderr)


if __name__ == "__main__":
    main()
