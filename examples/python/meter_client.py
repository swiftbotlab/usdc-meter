#!/usr/bin/env python3
"""Headless USDC Meter client/provider for scripts, backends and agents (Arc, native USDC, 18 decimals).

Requires: pip install eth-account==0.13.7 eth-abi eth-utils
Environment:
  METER_ADDRESS   UsdcMeter contract address
  ARC_NETWORK     testnet (default) | mainnet
  CLIENT_PK       client key  (deposit, sign, request-withdraw, complete-withdraw)
  PROVIDER_PK     provider key (redeem) - any funded key can submit a redeem; funds always go to the voucher's provider

  meter_client.py deposit PROVIDER AMOUNT_USDC
  meter_client.py sign PROVIDER CUMULATIVE_USDC            > voucher.json   (off-chain, no gas)
  meter_client.py verify voucher.json                      provider-side check before serving a call
  meter_client.py redeem voucher.json
  meter_client.py channel CLIENT PROVIDER
  meter_client.py request-withdraw PROVIDER | cancel-withdraw PROVIDER | complete-withdraw PROVIDER

Keys are read from the environment only and never printed.
"""
import json, os, sys, time, urllib.request
from decimal import Decimal
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_abi import encode, decode
from eth_utils import keccak, to_checksum_address

NETWORKS = {
    "testnet": {"rpc": "https://rpc.testnet.arc.io", "chain": 5042002, "explorer": "https://testnet.arcscan.app"},
    "mainnet": {"rpc": "https://rpc.mainnet.arc.io", "chain": 5042, "explorer": "https://explorer.arc.io"},
}
NET = NETWORKS[os.environ.get("ARC_NETWORK", "testnet")]
METER = to_checksum_address(os.environ["METER_ADDRESS"])
FEE_FLOOR = 20 * 10**9  # Arc rejects maxFeePerGas below 20 gwei


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(NET["rpc"], data=body, headers={"content-type": "application/json",
                                                                 "user-agent": "usdc-meter-client/1.0"})
    r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    if "error" in r:
        raise SystemExit(f"{method}: {r['error']}")
    return r["result"]


def selector_call(sig, types, args):
    return keccak(text=sig)[:4] + encode(types, args)


def wei(usdc):
    return int(Decimal(usdc) * 10**18)


def typed(client, provider, cumulative):
    return {
        "types": {
            "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                             {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
            "Voucher": [{"name": "client", "type": "address"}, {"name": "provider", "type": "address"},
                        {"name": "cumulativeAmount", "type": "uint256"}],
        },
        "primaryType": "Voucher",
        "domain": {"name": "USDC Meter", "version": "1", "chainId": NET["chain"], "verifyingContract": METER},
        "message": {"client": client, "provider": provider, "cumulativeAmount": cumulative},
    }


def channel(client, provider):
    data = selector_call("getChannel(address,address)", ["address", "address"], [client, provider])
    out = rpc("eth_call", [{"to": METER, "data": "0x" + data.hex()}, "latest"])
    dep, wd, red, ready, avail = decode(["uint128", "uint128", "uint128", "uint64", "uint256"], bytes.fromhex(out[2:]))
    return {"deposited": dep, "withdrawn": wd, "redeemed": red, "withdrawReadyAt": ready, "available": avail}


def send(pk_env, data, value=0):
    acct = Account.from_key(os.environ[pk_env])
    base = int(rpc("eth_getBlockByNumber", ["latest", False])["baseFeePerGas"], 16)
    call = {"from": acct.address, "to": METER, "data": "0x" + data.hex(), "value": hex(value)}
    gas = int(int(rpc("eth_estimateGas", [call]), 16) * 1.25) + 10000
    tx = {"chainId": NET["chain"], "nonce": int(rpc("eth_getTransactionCount", [acct.address, "pending"]), 16),
          "to": METER, "value": value, "data": data, "gas": gas, "type": 2,
          "maxFeePerGas": max(2 * base + 10**9, FEE_FLOOR), "maxPriorityFeePerGas": 10**9}
    raw = acct.sign_transaction(tx).raw_transaction.hex().removeprefix("0x")
    h = rpc("eth_sendRawTransaction", ["0x" + raw])
    for _ in range(60):
        rc = rpc("eth_getTransactionReceipt", [h])
        if rc:
            print(json.dumps({"tx": h, "status": int(rc["status"], 16), "explorer": f"{NET['explorer']}/tx/{h}"}))
            return
        time.sleep(1)
    print(json.dumps({"tx": h, "status": "pending"}))


def verify(v):
    """What a provider runs before serving a paid call: signer, provider, monotonic amount, funded."""
    msg = encode_typed_data(full_message=typed(v["client"], v["provider"], int(v["cumulativeAmount"])))
    signer = Account.recover_message(msg, signature=v["signature"])
    ch = channel(v["client"], v["provider"])
    cum = int(v["cumulativeAmount"])
    ok = signer.lower() == v["client"].lower() and cum > ch["redeemed"] and cum - ch["redeemed"] <= ch["available"]
    return {"ok": ok, "signer": signer, "owed": str(cum - ch["redeemed"]), "available": str(ch["available"])}


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    cmd = a.pop(0)
    if cmd == "deposit":
        send("CLIENT_PK", selector_call("deposit(address)", ["address"], [to_checksum_address(a[0])]), wei(a[1]))
    elif cmd == "sign":
        acct = Account.from_key(os.environ["CLIENT_PK"])
        provider, cum = to_checksum_address(a[0]), wei(a[1])
        sig = acct.sign_message(encode_typed_data(full_message=typed(acct.address, provider, cum))).signature
        print(json.dumps({"client": acct.address, "provider": provider, "cumulativeAmount": str(cum),
                          "signature": "0x" + sig.hex().removeprefix("0x")}))
    elif cmd == "verify":
        print(json.dumps(verify(json.load(open(a[0])))))
    elif cmd == "redeem":
        v = json.load(open(a[0]))
        data = selector_call("redeem(address,address,uint256,bytes)", ["address", "address", "uint256", "bytes"],
                             [to_checksum_address(v["client"]), to_checksum_address(v["provider"]),
                              int(v["cumulativeAmount"]), bytes.fromhex(v["signature"].removeprefix("0x"))])
        send("PROVIDER_PK", data)
    elif cmd == "channel":
        ch = channel(to_checksum_address(a[0]), to_checksum_address(a[1]))
        print(json.dumps({k: (str(Decimal(v) / 10**18) if k != "withdrawReadyAt" else v) for k, v in ch.items()}))
    elif cmd in ("request-withdraw", "cancel-withdraw", "complete-withdraw"):
        fn = {"request-withdraw": "requestWithdraw", "cancel-withdraw": "cancelWithdraw",
              "complete-withdraw": "completeWithdraw"}[cmd]
        send("CLIENT_PK", selector_call(f"{fn}(address)", ["address"], [to_checksum_address(a[0])]))
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
